# Infra Monitor

Infra Monitor is an internal operations control plane for a fleet of Linux servers. You register a server
once with its SSH credentials, and Infra Monitor discovers and then keeps showing you what is actually on it:
OS flavour, Docker/Podman containers, databases, systemd services, Tomcat instances, database log
files, and filesystem usage. Operators read logs, deploy WARs, restart things and — for admins — open
interactive shells and transfer, delete or browse files over SFTP through the UI without ever holding the
SSH password themselves.

It installs in one of **two profiles from this one repository**, chosen by a Compose argument. Nothing
is a different build: the same image and the same code run in both.

## Pick a profile

| | **Lite** (default) | **Full** |
| --- | --- | --- |
| Containers | **1** — `app` | **7** — `app` + Postgres + 5 monitoring services |
| Database | SQLite file on the `inframonitor_data` volume | PostgreSQL 16-alpine on `inframonitor_postgres_data` |
| Monitoring | none | Prometheus, Grafana, Loki, Promtail, Alertmanager |
| `/metrics` endpoint | **not registered at all** | registered (`METRICS_ENABLED=true`) |
| Alert receiving | none | `POST /api/alerts/webhook` fed by Alertmanager |
| Published host ports | 1 | 6 |
| Rough resource budget | ~1 vCPU, 256 MB RAM | ~2 vCPU, ~2 GB RAM, plus disk for metrics and logs |
| Start command | `docker compose up -d` | `docker compose -f docker-compose.yml -f docker-compose.full.yml up -d` |
| Backup | SQLite `VACUUM INTO` (`scripts/backup.sh`) | `pg_dump` — the shipped scripts are SQLite-only |

**Choose lite** unless you have a concrete reason not to. It is the whole product: every feature in
this documentation — inventory, discovery, vitals, storage, services, containers, logs, Tomcat, WAR
deployment, the interactive shell, RBAC, CSV import — works identically in lite. Full mode adds **nothing
to the application's capabilities**. It adds a metrics/logs/alerting stack around it and swaps SQLite for
Postgres.

**Choose full** if you specifically want Infra Monitor's own request metrics scraped and graphed, its container
logs shipped to a log store and queryable in Grafana, alert rules with an Alertmanager receiver, or a
client-server database because more than one thing needs to reach the data.

The resource figures above are **planning estimates, not measurements**. Lite's 1 vCPU / 256 MB has
been the working figure for the single container; the full-mode figure is an ordinary expectation for
Postgres plus a Prometheus/Grafana/Loki set at small scale and will grow with retention and how many
targets you scrape.

### What is deliberately in neither profile

- **Redis.** No module under `backend/app` has ever imported it. In the previous stack it was a
  container with a volume and a `service_healthy` gate on the backend, doing nothing. It is not coming
  back.
- **Nginx.** The app serves its own UI now, so a proxy in front of it would only forward to it. The
  old config's `/grafana/` sub-path route was also broken — it needed
  `GF_SERVER_SERVE_FROM_SUB_PATH`, which was never set. In full mode Grafana is reached directly on
  its own port. If you want TLS, add your own reverse proxy deliberately (see
  [docs/Security.md](docs/Security.md)) rather than resurrecting a config that never worked.

Because there is no reverse proxy in **either** profile, **TLS is the operator's responsibility.** That
matters most for the interactive shell: without a proxy in front, a terminal session — keystrokes and all —
crosses the network as plaintext `ws://`. See [docs/Security.md](docs/Security.md).

## Topology

Lite:

```
                    ┌────────────────────── inframonitor (one container) ───────┐
browser ──:8088──▶  │  uvicorn → FastAPI                                │
                    │    /api/*   → REST API                            │
                    │    /health  → liveness (verifies the database)    │
                    │    /docs    → Swagger UI                          │
                    │    /*       → the static UI (Next.js export)      │
                    │  SQLite at ./data/inframonitor.db  (volume inframonitor_data)     │
                    └───────────────────────────────────────────────────┘
                                        │ SSH
                                        ▼
                                 managed servers
```

Full adds, alongside the same `app` container:

```
  app ──DATABASE_URL──▶ postgres:16-alpine        (127.0.0.1:15432)
  app ──/metrics────◀── prometheus               (:19090) ──▶ alertmanager (:19093)
  app  container logs ─▶ promtail ──▶ loki       (:13100)        │
                                       ▲                          └─▶ POST /api/alerts/webhook
                          grafana (:13000) ──┘ queries Prometheus + Loki
```

There is still **one port for the application** in both profiles. The UI, the API and the Swagger docs
are same-origin on it, so the browser calls a relative `/api` and nothing has a host address baked
into it — the same image works on `localhost`, on a LAN IP, or behind a hostname with no rebuild.

Node.js is a build-time dependency only. It compiles the UI during the image build and is not present
in the runtime image.

## Quick start — lite

```bash
cp .env.example .env

# JWT_SECRET is required and has no default. Generate one:
python -c "import secrets; print(secrets.token_urlsafe(48))"
# then put it in .env as JWT_SECRET=...

bash scripts/preflight.sh
docker compose up -d --build
```

Then open `http://localhost:8088` (or `http://<host>:8088`).

## Quick start — full

Same `.env` preparation, then add the full-mode block from `.env.example` (Postgres password, Grafana
password, the extra ports) and start with both files:

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml up -d --build
```

The `-f` order matters: `docker-compose.full.yml` is an **overlay**, not a standalone file. It is what
rewrites the `app` service's environment to point at Postgres and to switch the monitoring URLs and
`METRICS_ENABLED` on. Running it alone, or first, will not work.

### The wrapper, so nobody has to remember that

```bash
scripts/stack.sh lite up
scripts/stack.sh full up
scripts/stack.sh full logs
scripts/stack.sh lite down
```

`scripts/stack.sh <lite|full> <up|down|restart|ps|logs|pull>` resolves the `-f` list for you, checks
that `.env` exists and that `JWT_SECRET` is set and is not the placeholder, prints which mode it is
starting, and for `full` also prints the extra ports. It works from any working directory.

## Where things are

Lite:

| Thing | Where |
| --- | --- |
| App UI | `http://<host>:8088` |
| REST API | `http://<host>:8088/api` |
| Swagger UI / OpenAPI | `http://<host>:8088/docs`, `http://<host>:8088/openapi.json` |
| Health probe | `http://<host>:8088/health` |

Full adds:

| Thing | Where | Default port |
| --- | --- | ---: |
| App `/metrics` | `http://<host>:8088/metrics` | — |
| PostgreSQL | `127.0.0.1:15432` (localhost only, on purpose) | `POSTGRES_PORT` 15432 |
| Prometheus | `http://<host>:19090` | `PROMETHEUS_PORT` 19090 |
| Grafana | `http://<host>:13000` | `GRAFANA_PORT` 13000 |
| Loki | `http://<host>:13100` | `LOKI_PORT` 13100 |
| Alertmanager | `http://<host>:19093` | `ALERTMANAGER_PORT` 19093 |

The `1` prefixes are not decoration: the intended host also runs ELK on 9200/5601/5044, so the
monitoring ports are deliberately shifted out of the way.

`APP_PORT` in `.env` changes the published application port (default `8088`); inside the container the
app always listens on `8000`.

> **`JWT_SECRET` is not just the token signing key.** It is also the key that encrypts every stored
> SSH credential. Compose refuses to start without it, on purpose. Set it once, back it up with the
> database, and do not rotate it casually — see [docs/BackupRecovery.md](docs/BackupRecovery.md).

## First login — the default administrator

Both profiles seed one administrator on first boot:

| | |
| --- | --- |
| **URL** | `http://<host>:8088` |
| **Email** | `admin@inframonitor.local` |
| **Password** | `ChangeMe123!` |

Override them **before the first boot** — the seed only runs when the user does not already exist:

```bash
# .env
ADMIN_EMAIL=ops@example.internal
ADMIN_PASSWORD=a-long-random-string-you-generated
```

Setting these after the admin row already exists changes nothing; use the Profile page instead.

While the seeded admin's password is still the default, **the app prints a banner to stdout on every
boot** naming the email, the password and the URL, and telling you to change it. See it with
`docker compose logs app`. It is repeated every boot on purpose, so it stays visible until fixed, and
it stops appearing once the password has been changed. The UI also shows a warning banner to any account
still on the default. That banner can be dismissed, but the dismissal expires — it **comes back after 24
hours and on a fresh sign-in**, so it cannot be silenced without changing the password.

**Change this password on first use** — the **Profile** page in the sidebar, or
`POST /api/auth/change-password`. `ChangeMe123!` is a published default; anyone who can reach the port
knows it.

## Usage

Sign in, then add servers from the Server Management page — one at a time, or in bulk with
**Import from CSV** (see [docs/CsvImport.md](docs/CsvImport.md)). The Add Server form takes an SSH
password or a private key, stores it encrypted, and uses it to discover OS flavour, Docker, Podman,
databases, services, Tomcat instances, database log sources, and storage usage.

The inventory table shows **Host, IP, OS, Uptime, CPU, RAM, Procs, Type, Environment, Status** and, for
admins, per-row actions. You can filter it by server type and environment (both populated from the values
actually in your inventory) and sort by IP address — numerically per octet, so `10.0.0.9` sorts before
`10.0.0.10`.

**Vitals are a point-in-time SSH probe, not continuous monitoring.** Uptime, load average, CPU %, RAM used
and process count are sampled when discovery runs or when you press **Refresh vitals**, and
`vitals_checked_at` records when. Nothing re-probes on a timer and no history is kept, so a figure is only
as current as its timestamp. A CPU reading of `-` means the host has never been sampled — not 0%. A refresh
costs about **2 seconds per host** (the CPU figure needs two `/proc/stat` reads a second apart) and runs at
most **4 hosts concurrently**.

Click a hostname to open its detail page (`/server/?id=<id>`). **Overview**, **Storage**, **Services** and
**Log Window** are always there; **Tomcat**, **Containers** and **Database Logs** appear only when
discovery detected that capability, so hosts do not carry empty tabs:

- **Overview** — host facts, distribution, package manager, kernel, discovery timestamp
- **Storage** — a usage bar chart per filesystem plus the `df` table, with sizes in GB
- **Services** — Docker, Podman, databases, web servers and app runtimes; journal logs per systemd
  unit, and restart for admins
- **Tomcat** *(when detected)* — discovered instances with version detail, Java prerequisites, webapps, log
  files, start / stop / restart, and **WAR deployment** for admins
- **Containers** *(when detected)* — live `docker ps` / `podman ps`, and container logs
- **Database Logs** *(when detected)* — the database log files discovery found
- **Log Window** — the log output pane the other tabs write into

Detection reads the stored discovery snapshot, so **a missing tab usually means discovery has not seen that
software yet** — run discovery and reload. The admin tools pane on this page starts collapsed; click
`Show Admin Tools` for credentials, discovery and the operations controls.

Developer and support users read logs, list containers and refresh vitals through the backend without
knowing the SSH password; developers can also restart containers. Only admins can save credentials, run
discovery, restart services, act on Tomcat instances, deploy a WAR, or open a shell.

### The shell workspace is admin-only, and it is the sharpest tool here

The **Shell** action in the inventory opens a terminal workspace on the host in the browser. Each tab is a
**PTY as the stored SSH user, with that user's full privileges and no command filtering** — anyone who can
open it can do anything that SSH account can do, `sudo` included. It is admin-only and subject to the same
per-server ACL as everything else.

It is a **tabbed workspace**, not a single panel: several sessions run at once, to the same host or to
different hosts, each tab showing its own connection state. Switching tabs does not disconnect anything —
hidden sessions stay live with their scrollback intact — and only closing a tab closes its socket.

Each tab chip has a **context menu** — **Duplicate tab**, **Split with this tab**, **Close tab**, **Close
other tabs** — reachable by right-click *and* from a `⋯` button on the chip, so it is not mouse-only.
**Split view** shows two sessions side by side (stacked on a narrow screen) with the focused one marked,
because keystrokes still only go to one of them.

Fullscreen uses the browser's **Fullscreen API**, so the workspace covers the **screen** rather than the
page: no browser chrome, no leftover page margin. If the browser refuses the request it falls back to the
previous in-page overlay instead of leaving the button lying about the state. `Esc` exits either way.

Two things share the workspace's side pane, shown one at a time:

- **Favorite commands** — named commands saved **per user**, stored exactly as typed with no rewriting or
  validation. Clicking one **inserts it into the terminal without running it**; you press Enter. A
  mis-click in a list must not be able to execute something destructive on a production host.
- **A file pane (SFTP)** — browse, download, upload **and delete** files. Understand what this is:
  **arbitrary filesystem access as the stored SSH user, not restricted to any subdirectory.** It is
  admin-only and ACL-checked, every transfer and every delete is audited with the path, downloads are
  capped by `MAX_DOWNLOAD_MB` (default 200) and uploads by `MAX_WAR_MB`. It is deliberately not
  path-jailed, because the same admin already has a full PTY on the same host one tab over — a path
  restriction would be theatre, not a control.

  Rows sort by **name**, **size** or **modified**, ascending or descending, with dirs-first as a toggle
  you control rather than something the sort silently overrides. **There is no sort by creation time,
  because SFTP cannot provide one** — see below.

**Delete removes data from a managed host**, which nothing else in this product does, so it is fenced:
admin-only and ACL-checked like the rest of the pane, a confirm dialog showing the full absolute path,
**typing the directory's name** before any directory can be removed, a refusal for `/`, for shallow paths
like `/etc` and for the SSH user's home, and a symlink is unlinked without touching whatever it points at.
There is no trash and no undo.

Audit records cover shell sessions (open and close, with actor, server, duration and bytes each way), SFTP
downloads and uploads (one row each, with path and byte count) and SFTP deletes (path, whether recursive,
and how many entries were removed). **The commands typed inside a session are not recorded** — the record
is that a session happened, not what was done in it. **Nothing else in the product writes audit records at
all**: WAR deploys, service and Tomcat actions, credential changes and server or user edits leave no trace,
and that list is still longer than the audited one. There is no UI for reading the table.

#### Can a shell session run longer than an hour? Yes — every limit is configurable

All four session limits are settings, not constants:

| Setting | Env | Default | Meaning |
| --- | --- | --- | --- |
| `shell_max_minutes` | `SHELL_MAX_MINUTES` | `480` (8 h) | Absolute session cap. **`0` disables it.** |
| `shell_idle_minutes` | `SHELL_IDLE_MINUTES` | `30` | Idle cap. **`0` disables it.** |
| `shell_max_sessions` | `SHELL_MAX_SESSIONS` | `24` | Concurrent sessions application-wide. `0` here means **no sessions allowed** — it turns the shell off |
| `shell_max_sessions_per_user` | `SHELL_MAX_SESSIONS_PER_USER` | `8` | Concurrent sessions per user. `0` likewise turns the shell off |

The close reason names the setting that fired, so a session that vanished on its own is identifiable rather
than a mystery. The two concurrency refusals stay distinguishable too: hitting your own per-user limit
means close a tab, hitting the application-wide limit means wait for capacity, and only the first is yours
to fix. Note the asymmetry in `0`: on a *time* cap it removes the limit, on a *session count* it permits
nothing, because one is a threshold and the other is a count.

**Before setting `SHELL_MAX_MINUTES=0`, understand what the cap is for.** The default of 480 minutes is not
an arbitrary round number: it matches `ACCESS_TOKEN_EXPIRE_MINUTES`, whose default is also 480. The
WebSocket token is validated **once, at the handshake, and never re-checked** for the life of the socket.
With no absolute cap, a session opened with a valid token keeps running long after that token has expired —
indefinitely, for as long as the browser tab and the SSH connection stay up. The cap is what keeps a
session's lifetime bounded by the credential that authorised it. Setting `0` means accepting a PTY on a
managed host that can outlive its own authentication, with no point at which the operator has to prove
they are still allowed to hold it. If you want longer sessions rather than unlimited ones, raise
`SHELL_MAX_MINUTES` and raise `ACCESS_TOKEN_EXPIRE_MINUTES` to match, so the two stay aligned.

See [docs/Deployment.md](docs/Deployment.md#shell-session-limits) for the configuration detail.

#### Sorting by creation time is not possible over SFTP

The file pane sorts by name, size and modified time only. Creation time is **not available**, and this is a
limit of the protocol rather than a missing feature: an SFTP file attribute set carries **modification
time, access time, size, permissions and ownership, and no birth time at all**. There is nothing to read
and nothing to sort on, so the pane says so where a "created" column would have been instead of showing
modified time under a "created" heading. Modified time is not a stand-in for it: a file created last year
and edited this morning sorts as new. If you need creation timestamps, get them on the host, from a shell
tab, with whatever your filesystem actually records.

Because neither profile terminates TLS, an unproxied install carries the whole session in clear text. Read
[docs/Security.md](docs/Security.md) before granting anyone `admin`.

## API example

Every endpoint except `POST /api/auth/login` requires a bearer token, and `POST /api/servers` is
admin-only. Because the API is same-origin, `/api/...` is relative — these examples just need the
one port.

```bash
TOKEN=$(curl -s -X POST http://localhost:8088/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@inframonitor.local","password":"ChangeMe123!"}' | jq -r .access_token)
```

```bash
curl -X POST http://localhost:8088/api/servers \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"hostname":"app-01","ip_address":"192.168.1.20","username":"ems","ssh_port":22,"environment":"Production","tags":["application","docker"]}'
```

The full endpoint table is in [docs/API.md](docs/API.md), or browse it interactively at
`http://<host>:8088/docs`.

Two endpoints do not fit the pattern above. `POST /api/servers/{id}/vitals` takes **no body** — it always
uses the stored credentials — and returns the refreshed server. `WS /api/servers/{id}/shell` is a WebSocket,
so it cannot carry an `Authorization` header; the token goes in the first frame instead of the URL, where it
would end up in access logs. That WebSocket route also needs the `websockets` package installed — plain
`uvicorn` has no WebSocket implementation, and without it every shell connection gets a bare HTTP 404.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/Deployment.md](docs/Deployment.md) | **Both install profiles**, configuration, volumes, the scripts |
| [docs/Architecture.md](docs/Architecture.md) | Process topology per profile, data flows, RBAC |
| [docs/Monitoring.md](docs/Monitoring.md) | Full mode only: Prometheus, Grafana, Loki, Alertmanager |
| [docs/API.md](docs/API.md) | Complete endpoint reference |
| [docs/Usage.md](docs/Usage.md) | Operator walkthrough of every tab |
| [docs/TomcatDeployment.md](docs/TomcatDeployment.md) | WAR deployment runbook, prerequisites, rollback |
| [docs/CsvImport.md](docs/CsvImport.md) | Bulk server onboarding from CSV |
| [docs/Security.md](docs/Security.md) | What is protected, and what is not |
| [docs/BackupRecovery.md](docs/BackupRecovery.md) | Backing up the database **and** `.env`, per profile |
| [docs/Troubleshooting.md](docs/Troubleshooting.md) | When it will not start or will not connect |
| [docs/DeveloperGuide.md](docs/DeveloperGuide.md) | Local dev loop, layout, tests |
