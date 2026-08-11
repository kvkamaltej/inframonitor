# Monitoring

**This page applies to the full profile only.** In lite there is no monitoring stack, no `/metrics`
endpoint, no scraper and no log shipper — see [Deployment.md](Deployment.md#choosing).

Full mode adds five containers around the unchanged application:

```
  app:8000/metrics ──scrape──▶ prometheus ──evaluates alerts──▶ alertmanager
                                    │                                │
  app container logs ──▶ promtail ──▶ loki                            │ webhook
                                    │                                ▼
                              grafana ◀── queries both      POST /api/alerts/webhook
```

Nothing here changes what the application does. It observes it.

**It observes the application, not your fleet.** Prometheus scrapes Infra Monitor's own request metrics and
Promtail ships Infra Monitor's own container logs. Nothing in this stack scrapes a managed server: there is
no node exporter deployed, no per-host time series, and no alerting on managed-host conditions.

That is also the distinction to keep in mind about the inventory's **vitals** columns (uptime, load, CPU %,
RAM, process count). Those are a **point-in-time SSH probe** taken during discovery or when an operator
presses *Refresh vitals*, stamped with `vitals_checked_at` — a single sample stored on the server row, not a
series. They are not fed to Prometheus, are not retained as history, and nothing evaluates a threshold
against them. If you want continuous monitoring of managed hosts, you need host-level exporters and scrape
targets of your own; this stack does not provide them in either profile.

## `/metrics` exists only in full mode

The route is gated on the `metrics_enabled` setting (`METRICS_ENABLED`, default `false`). When it is
false the route is **not registered at all** — the app has no `/metrics`, so a request falls through to
the static UI mount and you get the UI's 404 page, not a JSON 404 from the API. The full overlay sets
`METRICS_ENABLED=true`, which is what makes the endpoint appear.

That is the check to run first if Prometheus shows the app target down in full mode:

```bash
curl -fsS http://localhost:8088/metrics | head
```

If that returns HTML, you are running lite, or the overlay was not applied.

The endpoint is unauthenticated, like `/health`. It is intended to be reachable from Prometheus on the
Compose network and not from the internet.

### What is instrumented

- **Request count and latency**, from an ASGI middleware, labelled by method, **route template** and
  status code. The label is the template (`/api/servers/{server_id}/tomcat`), not the raw path —
  raw paths carry server UUIDs and would explode label cardinality.
- **A servers-total gauge**, computed with a `select(func.count())` aggregate.

This is a deliberate rebuild. The previous version defined its two metrics and then incremented the
counter *only inside `/health` and `/metrics`*, so it measured nothing but its own health probes, and
neither metric was referenced by any alert or dashboard panel.

## Configuration files

All of it lives under `monitoring/` and is mounted into the containers:

```
monitoring/
  prometheus/prometheus.yml
  prometheus/alerts.yml
  alertmanager/alertmanager.yml
  loki/loki.yml
  promtail/promtail.yml
  grafana/provisioning/datasources/datasources.yml
  grafana/provisioning/dashboards/dashboards.yml
  grafana/dashboards/inframonitor-overview.json
```

Edit a file, then restart just that container:

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml restart prometheus
```

Prometheus and Alertmanager also reload without a restart if you have their lifecycle API enabled;
a restart is the reliable option and costs only the scrape gap.

## Prometheus

### Scrape targets

| Job | Target | What it gives you |
| --- | --- | --- |
| `inframonitor-backend` | `app:8000/metrics` | request rate, latency and status codes by route template, plus the servers gauge |
| `prometheus` | itself | scrape health, rule evaluation timing |

Targets are addressed by **Compose service name** on the Compose network, not by host port, so
`app:8000` is correct even though the host publishes `8088`.

Check what it actually has:

```bash
curl -s http://localhost:19090/api/v1/targets | jq '.data.activeTargets[] | {job:.labels.job, health, lastError}'
```

Or the UI: `http://<host>:19090` → **Status → Targets**.

**There is no `node-exporters` job.** The previous config had one using `file_sd_configs` against
`/etc/prometheus/targets/*.json` — a path that was never mounted, so the job had zero targets forever
while looking configured. A job pointing at nothing is worse than no job: it makes "no data" look like
a data problem instead of a configuration one. If you want host-level metrics, deploy node_exporter on
the managed hosts and add a job with real targets, or mount a real directory for file-based discovery.

### Alert rules

`monitoring/prometheus/alerts.yml`. Rules cover the backend being down, an elevated 5xx rate, and
request latency; the file itself is the authority on thresholds and `for:` durations — read it rather
than trusting a copy of the numbers here, because thresholds get tuned and this page will go stale.

List what is loaded and what is firing:

```bash
curl -s http://localhost:19090/api/v1/rules | jq '.data.groups[].rules[] | {name, state}'
curl -s http://localhost:19090/api/v1/alerts | jq '.data.alerts[] | {alertname:.labels.alertname, state}'
```

**Alert overlap is handled by an inhibit rule.** `PrometheusTargetDown` (`up == 0`) is a strict
superset of the backend-down condition, so previously a single backend outage fired both alerts with no
`inhibit_rules` in Alertmanager — two notifications, one incident. The current config suppresses the
broader alert when the specific one is already firing (or scopes the second rule so they cannot
overlap). If you add an alert, check it against this: a new rule that is a superset of an existing one
needs the same treatment.

## Alertmanager

`monitoring/alertmanager/alertmanager.yml`. Its receiver posts to the application:

```
POST http://app:8000/api/alerts/webhook
```

### The alert buffer is in-memory and lost on restart

This is the single most important caveat on this page.

`POST /api/alerts/webhook` accepts the Alertmanager payload and keeps the **most recent 100 alerts** —
alertname, severity, status, instance, summary and start time — in an **in-process ring buffer**.
`GET /api/alerts/recent` (any authenticated user) reads it back.

- It is **not persisted.** There is no database table. Restarting or redeploying the `app` container
  empties it, silently and completely.
- It holds **100 entries.** The 101st alert evicts the oldest.
- It is per-process. It is not shared, replicated or backed up.

This is a **visibility improvement, not durable alert storage.** It exists so an operator can see what
recently fired without opening Alertmanager. If you need an alert history you can rely on — for
incident review, for reporting, for anything with consequences — send Alertmanager to a real
destination as well (email, chat, a paging service, or your own store). Do not build a process around
querying `/api/alerts/recent`.

The previous version of this endpoint was worse in two specific ways, both fixed: it called
`len(payload.get("alerts", []))` on an unvalidated dict, so a payload where `alerts` was a number
raised `TypeError` and became an unhandled 500; and it **discarded everything it received**, so alerts
arrived and vanished with no record at all.

## Loki and Promtail

Promtail tails the Docker container logs on the host and ships them to Loki. Loki is the store and the
query API; you read it through Grafana, or directly:

```bash
curl -s -G http://localhost:13100/loki/api/v1/labels
curl -s -G 'http://localhost:13100/loki/api/v1/query_range' \
  --data-urlencode 'query={job="containerlogs"}' --data-urlencode 'limit=20'
```

### Label scheme

Keep this small. Every distinct combination of label values is a separate stream in Loki, and high
cardinality is the standard way to make it slow and expensive.

| Label | Source | Example |
| --- | --- | --- |
| `job` | static, set by the scrape config | `containerlogs` |
| `container` | Docker container name | `inframonitor` |
| `stream` | Docker's stdout/stderr designation | `stdout` |
| `compose_service` | Compose service label on the container | `app` |

`monitoring/promtail/promtail.yml` is the authority on the exact set. The rule when adding one: a label
is for something you **filter streams by** and that has a small, bounded set of values. Anything
per-request, per-user or per-server-id belongs in the log **line**, where LogQL can still match it,
not in a label.

### Retention is configured

Loki runs with a **compactor and a `retention_period`, defaulting to 168h (7 days).** This is a fix,
not a feature: the previous config had neither, so `loki_data` grew without bound until something on
the host filled up. If you raise the retention, size the volume for it.

Retention is enforced by the compactor on a schedule, so disk usage falls sometime after the cutoff,
not at the instant a log ages out.

## Grafana

`http://<host>:13000`.

### Credentials

The admin user and password come from the full-mode block in `.env` (Grafana's own
`GF_SECURITY_ADMIN_USER` / `GF_SECURITY_ADMIN_PASSWORD`). **Set a real password there before the first
start** — `.env.example` ships an example value, and Grafana at 13000 has no other protection. Changing
it after first start needs Grafana's own user management, not just the environment variable, because the
password is by then in Grafana's database.

Grafana is a **separate account system from Infra Monitor's.** Your `admin@inframonitor.local` login does not work here
and Infra Monitor's RBAC does not apply. Anyone with the Grafana password can read every metric and log the
stack has collected.

### Provisioning

Datasources and dashboards are provisioned from files, not clicked in:

- `provisioning/datasources/datasources.yml` — Prometheus and Loki, with **explicit `uid`s**
  (`prometheus`, `loki`).
- `provisioning/dashboards/dashboards.yml` — points at `monitoring/grafana/dashboards/`.
- `grafana/dashboards/inframonitor-overview.json` — the shipped dashboard.

Two fixes worth knowing, because both produced confusing symptoms before:

1. **The datasource has an explicit `uid` and the dashboard references that `uid`.** The old dashboard
   panel used `"uid": "Prometheus"` — a datasource *name* in a field that takes a UID, against a
   datasource that declared no `uid` at all. Panels resolved to nothing on a fresh install. When you
   export a dashboard from the Grafana UI to commit it, check the `datasource.uid` fields say
   `prometheus` / `loki`.
2. **Dashboards are read-only, consistently.** `allowUiUpdates: false` is set. The dashboard directory
   is mounted read-only, and previously that was combined with `disableDeletion: false`, so the UI
   *offered* saving, then errored, and any change reverted at the next provisioning poll (~30s) — it
   looked like data loss. Now the UI declines the edit up front.

**So: to change a dashboard, edit the JSON in `monitoring/grafana/dashboards/` and let provisioning
pick it up.** Use the UI to explore and to build a panel, then copy the JSON out — do not expect
**Save** to work.

## Verifying a full-mode install

```bash
# 1. the app exposes metrics at all
curl -fsS http://localhost:8088/metrics | head -5

# 2. prometheus is scraping it successfully
curl -s http://localhost:19090/api/v1/targets \
  | jq -r '.data.activeTargets[] | "\(.labels.job) \(.health) \(.lastError)"'

# 3. rules loaded
curl -s http://localhost:19090/api/v1/rules | jq '.data.groups | length'

# 4. loki is ready and has streams
curl -fsS http://localhost:13100/ready
curl -s -G http://localhost:13100/loki/api/v1/labels | jq .

# 5. alertmanager is up
curl -fsS http://localhost:19093/-/ready

# 6. grafana is up (then log in and check a panel actually renders)
curl -fsS http://localhost:13000/api/health
```

Step 6's last clause matters: a healthy Grafana with a mis-provisioned datasource UID renders empty
panels and reports itself perfectly fine.

## The integrations panel

`GET /api/integrations` probes only the monitoring URLs that are configured — `PROMETHEUS_URL`,
`GRAFANA_URL`, `LOKI_URL`, `ALERTMANAGER_URL` — with a 2.5-second timeout each, concurrently, and
reports `healthy`, `warning` or `offline`. The full overlay sets all four, so the dashboard's monitoring
panel appears. In lite all four are empty, the endpoint returns `[]`, and the panel hides itself.

This is a reachability probe only. It does not check that Prometheus has targets, that rules loaded, or
that Grafana's datasources resolve — for that, run the verification block above.

## Security notes specific to full mode

- **Prometheus and Alertmanager have no authentication.** Whoever reaches 19090 or 19093 can read your
  alert rules, every metric label, and the current alert state, and can silence alerts in Alertmanager.
- **Grafana has a login and it is only as good as the password you set in `.env`.**
- **Postgres is bound to `127.0.0.1`**, unlike the monitoring ports. That is deliberate; the previous
  stack published it on all interfaces with a committed default password.
- `/metrics` is unauthenticated. Route templates and status codes are not secrets, but they do disclose
  your endpoint surface and traffic shape.
- None of these ports are behind TLS, because there is no reverse proxy in either profile.

Firewall the monitoring ports to your operators' network, or bind them to a trusted interface.
