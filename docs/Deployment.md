# Deployment

Two install profiles, one repository, one image. **Lite** is the default and needs no flags. **Full**
is the same thing plus Postgres and a monitoring stack, selected by adding an overlay Compose file.

## Choosing

| | **Lite** (default) | **Full** |
| --- | --- | --- |
| Services | `app` | `app`, `postgres`, `prometheus`, `grafana`, `loki`, `promtail`, `alertmanager` |
| Containers | 1 | 7 |
| Database | SQLite at `./data/inframonitor.db` on volume `inframonitor_data` | PostgreSQL 16-alpine on volume `inframonitor_postgres_data` |
| `/metrics` | **not registered** | registered |
| `POST /api/alerts/webhook` | present but nothing posts to it | Alertmanager posts to it |
| Log shipping | none — logs are read on demand over SSH | container logs → Promtail → Loki |
| Published ports | 1 | 6 |
| Compose files | `docker-compose.yml` | `docker-compose.yml` **+** `docker-compose.full.yml` |
| Wrapper | `scripts/stack.sh lite up` | `scripts/stack.sh full up` |

**The application behaves identically in both.** Every feature — discovery, storage, services,
containers, logs, Tomcat, WAR deployment, RBAC, CSV import — is in lite. Full mode does not unlock
anything; it observes the app from the outside and changes where the data is stored.

Pick lite unless you want Infra Monitor's own metrics scraped and graphed, its container logs in a queryable
store, alert rules with a receiver, or a client-server database.

### Resource expectations

| | Lite | Full |
| --- | --- | --- |
| vCPU | ~1 | ~2 |
| RAM | ~256 MB | ~2 GB across all seven containers |
| Disk, steady state | the SQLite file — megabytes | Postgres + Prometheus TSDB + Loki chunks — grows with retention |

Treat the full-mode numbers as a **planning estimate, not a measurement.** Lite's 1 vCPU / 256 MB is
the established figure for the single container. Full mode's real footprint depends on how many
targets Prometheus scrapes, how much the app logs, and the retention you configure (Loki defaults to
168h here — see [Monitoring.md](Monitoring.md)).

### Not in either profile

- **Redis** — no module under `backend/app` imports it, and none ever did. Previously it was a
  container with a volume and a `service_healthy` gate on the backend, doing nothing.
- **Nginx** — the app serves its own UI, so a proxy would only forward to it, and the old config's
  `/grafana/` sub-path route was broken anyway (it needed `GF_SERVER_SERVE_FROM_SUB_PATH`, never set).
  In full mode Grafana is on its own port.
- **`database/init.sql`** — it created a decoy `schema_migrations` table and zero real tables. The
  schema is created by the app at startup.

Consequence: **there is no TLS terminator in either profile.** See [Exposure](#exposure).

## Requirements

- Docker with the Compose plugin (`docker compose`, not `docker-compose`).
- Outbound SSH from the `app` container to every host you intend to manage.
- Lite: nothing else. No database server, cache or monitoring stack to provision.
- Full: enough headroom for seven containers, and the five extra host ports free.

Node.js is needed only during `docker build`, inside the builder stage. It is not in the runtime image
and you do not need it on the host.

## Install — lite

```bash
cd /home/ems/inframonitor
cp .env.example .env

# JWT_SECRET has no default. Generate one and put it in .env:
python -c "import secrets; print(secrets.token_urlsafe(48))"

bash scripts/preflight.sh
docker compose up -d --build
```

The build compiles the UI to a static export in one stage and copies it into a Python image in the
next, so the first build takes a few minutes. Then:

```bash
curl -fsS http://localhost:8088/health
# {"status":"ok","service":"inframonitor-backend","database":"ok"}
```

## Install — full

Prepare `.env` exactly as above, then fill in the full-mode block from `.env.example` (`.env.example`
is sectioned, with a note that lite only needs the first block): the Postgres credentials, the Grafana
admin password, and the extra ports if the defaults clash.

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml up -d --build
```

**The `-f` order is not optional.** `docker-compose.full.yml` is an *overlay*. On its own it is not a
valid stack; its job is to merge over `docker-compose.yml` and rewrite the `app` service's environment
— `DATABASE_URL` to the Postgres DSN, the four monitoring URLs, and `METRICS_ENABLED=true`.

Verify the merge before you start anything, which is cheap and catches a wrong `-f` order immediately:

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml config | grep -A3 DATABASE_URL
```

### Why an overlay file and not Compose `profiles:`

Because the `app` service's *environment* has to differ between modes: Postgres DSN plus four
monitoring URLs plus `METRICS_ENABLED=true` in full, SQLite plus empty strings in lite. Compose
`profiles:` can gate **whether a service runs**; it cannot vary **another service's environment**. The
overlay is the mechanism that actually expresses the difference, so this repo does not use `profiles:`.

## The `stack.sh` wrapper

```bash
scripts/stack.sh lite up
scripts/stack.sh full up
scripts/stack.sh full ps
scripts/stack.sh full logs
scripts/stack.sh lite down
```

`scripts/stack.sh <lite|full> <up|down|restart|ps|logs|pull>` resolves the `-f` list, verifies `.env`
exists and that `JWT_SECRET` is set and is not the placeholder, prints which mode it is starting, and
for `full` also prints the extra ports. It works from any working directory, so you can call it by
absolute path from a cron job or a systemd unit.

Use it in preference to raw `docker compose` for anything full-mode. Getting the `-f` list wrong is the
single most likely full-mode mistake, and it fails in a confusing way: the app comes up on SQLite while
Postgres also runs, so you get a working-looking app with an empty database.

## First login

Both profiles seed one administrator on first boot:

- Email: `admin@inframonitor.local`
- Password: `ChangeMe123!`

Override with `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` **before the first boot** — the seed only
creates the row when it does not already exist, so setting them later has no effect on an existing
install.

While that password is still the default, the app logs a multi-line banner to stdout **on every boot**
with the email, the password and the URL, plus a line telling you to change it (`docker compose logs
app`). It is deliberately repeated rather than printed once, so it cannot scroll away and be forgotten.
Once the password has been changed it stops appearing. The UI shows a matching persistent banner.

Change it on the **Profile** page, or with `POST /api/auth/change-password`.

## Configuration

Everything is in `.env`. Compose reads it; there are no other config files for the app.

### Both profiles

| Variable | Required | Default | Meaning |
| --- | :---: | --- | --- |
| `JWT_SECRET` | **yes** | *none* | Signs JWTs **and** encrypts stored SSH credentials. Compose refuses to start without it. |
| `APP_PORT` | no | `8088` | Host port published to the container's `8000`. |
| `DATABASE_URL` | no | `sqlite:///./data/inframonitor.db` | Relative on purpose — resolves under `/app` in the container and under the checkout locally. The full overlay replaces it. |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | no | `480` | Token lifetime. There is no refresh token; the client re-logs in. |
| `CORS_ORIGINS` | no | empty | Comma-separated. Leave empty for the normal same-origin deployment; CORS middleware is only added when it is non-empty. |
| `ADMIN_EMAIL` | no | `admin@inframonitor.local` | Email of the first-boot seeded administrator. |
| `ADMIN_PASSWORD` | no | `ChangeMe123!` | Password of the first-boot seeded administrator. Also what the startup banner and the UI warning compare against. |
| `PUBLIC_URL` | no | `http://localhost:8088` | Used **only** in the default-credentials startup banner, so it tells the operator the right address to log in at. Set it if you reach Infra Monitor by a hostname or a non-default port. It does not affect routing or CORS. |
| `MAX_WAR_MB` | no | `512` | Upload cap in MB, shared by WAR deployment **and** SFTP uploads. Over it → 413. See [TomcatDeployment.md](TomcatDeployment.md). |
| `MAX_DOWNLOAD_MB` | no | `200` | Cap in MB for SFTP downloads from the shell workspace's file pane. Checked against the remote file's size before any bytes are read; over it → 413. |
| `SHELL_MAX_MINUTES` | no | `480` | Absolute cap on one shell session's duration. **`0` disables the cap** — read [Shell session limits](#shell-session-limits) before you do that. |
| `SHELL_IDLE_MINUTES` | no | `30` | Idle cap on one shell session. **`0` disables the cap.** |
| `SHELL_MAX_SESSIONS` | no | `24` | Concurrent shell sessions application-wide. Beyond it the socket closes with `4429`. **`0` here means zero sessions allowed** — it disables the shell. |
| `SHELL_MAX_SESSIONS_PER_USER` | no | `8` | Concurrent shell sessions one user may hold. Beyond it the socket closes with `4429` and a different reason. `0` likewise disables the shell. |
| `METRICS_ENABLED` | no | `false` | When false the `/metrics` route is **not registered**. The full overlay sets it true. |

### Full mode only

| Variable | Default | Meaning |
| --- | --- | --- |
| `POSTGRES_PORT` | `15432` | Host port for Postgres, bound to `127.0.0.1` only. |
| `PROMETHEUS_PORT` | `19090` | Prometheus UI. |
| `GRAFANA_PORT` | `13000` | Grafana UI. |
| `LOKI_PORT` | `13100` | Loki HTTP API. |
| `ALERTMANAGER_PORT` | `19093` | Alertmanager UI. |
| `PROMETHEUS_URL` / `GRAFANA_URL` / `LOKI_URL` / `ALERTMANAGER_URL` | set by the overlay | Only used by `GET /api/integrations`, which probes each configured URL and returns `[]` when none is set. |

The Postgres and Grafana credentials also live in the full-mode block of `.env.example`. Set real
values — do not ship the examples.

### Shell session limits

**Can a shell session run for longer than an hour?** Yes. Every limit on the interactive shell is a
setting; none of them is compiled in.

| Variable | Default | What it limits | `0` |
| --- | --- | --- | --- |
| `SHELL_MAX_MINUTES` | `480` (8 hours) | Total session duration, however busy the session is | **disables the cap** |
| `SHELL_IDLE_MINUTES` | `30` | Time with no traffic in either direction | **disables the cap** |
| `SHELL_MAX_SESSIONS` | `24` | Sessions open across the whole application | **allows no sessions** — disables the shell |
| `SHELL_MAX_SESSIONS_PER_USER` | `8` | Sessions one operator may hold at once | **allows no sessions** — disables the shell |

Duration and idle time are checked by a supervisor task **every 5 seconds**, and when one fires the session
is closed with a reason that **names the setting** — `idle limit reached (SHELL_IDLE_MINUTES=30)` or
`absolute session limit reached (SHELL_MAX_MINUTES=480)` — so an operator whose terminal disappeared can
tell which cap they hit and which variable to change.

**`0` on a time cap genuinely disables it.** The check is skipped, not run with a zero threshold; a `0` left
in place as a threshold would make `now - last_activity > 0` true on the first tick and kill every session
within seconds, which is the opposite of what setting it to `0` asks for. With both time caps at `0` the
supervisor has nothing to enforce and simply parks.

**`0` on a concurrency setting means the opposite: zero sessions permitted.** These are counts, not
thresholds, so `SHELL_MAX_SESSIONS=0` or `SHELL_MAX_SESSIONS_PER_USER=0` refuses **every** shell session
with `4429` and a reason that names the setting (`Interactive shell is disabled (SHELL_MAX_SESSIONS=0)`).
That is a usable way to turn the interactive shell off on an install that should not have it, short of
removing the admin role.

Two defensive behaviours worth knowing: a **negative** value is treated as `0` for all four, and a value
that cannot be read as an integer falls back to the shipped default rather than taking the shell endpoint
down.

Raise the duration cap for what you actually do. A long `dnf upgrade`, a database migration or a `rsync`
of a large tree can legitimately outlive eight hours; a session that is killed mid-migration is worse than
a session that lived too long.

#### Why the default is 480, and what `SHELL_MAX_MINUTES=0` accepts

480 is not a round number picked for comfort. It is the same as the default
`ACCESS_TOKEN_EXPIRE_MINUTES`, and the two are matched deliberately:

**The WebSocket token is validated only once, at the handshake, and is never re-checked afterwards.** There
is no periodic revalidation of the token on a live socket, and no refresh token in this product at all.
Once the handshake is accepted, the session's continued existence does not depend on the token still being
valid.

So the absolute cap is the only thing tying a session's lifetime to the credential that authorised it.
With `SHELL_MAX_MINUTES=0`:

- A session opened with a valid token keeps running **indefinitely** after that token expires — as long as
  the browser tab stays open and the SSH connection stays up. Days, if nothing interrupts it.
- Deleting or demoting the operator's account, or changing their password, **does not close it.** Those
  checks happen at login and at the handshake; there is no mechanism that reaches into an established
  session and revokes it.
- The remaining way to end it is for someone to close the tab, for the network or the remote host to drop
  the connection, or for the app process to restart.

That is a real, and sometimes acceptable, trade — an air-gapped host with two trusted operators is not the
same risk as a shared install. But it should be a decision, not a surprise. If what you want is *longer*
rather than *unbounded*, raise `SHELL_MAX_MINUTES` and raise `ACCESS_TOKEN_EXPIRE_MINUTES` to match, so
the session and its credential still expire together.

`SHELL_IDLE_MINUTES=0` is a smaller decision but not a free one: idle sessions hold a slot against both
concurrency caps and keep an SSH connection open on the managed host until something else closes them.

`JWT_SECRET` being mandatory is a deliberate change. The previous stack defaulted it to a committed
constant that was simultaneously the JWT signing key and the credential-encryption key, so a default
install shipped with a publicly known key protecting real SSH passwords. There is now no fallback in
Compose.

If you run the app outside Compose — bare `uvicorn` — there is no fallback either:
`backend/app/core/config.py` declares `jwt_secret` with no default and validates it, rejecting an empty
value, a known placeholder (`change_this_secret_before_production`, `changeme`, `secret`) and anything
shorter than 32 characters. The app will not start until you set a real one.

One dependency note for running outside Compose: **install from `backend/requirements.txt`, not a hand-picked
subset.** `websockets` is required — plain `uvicorn` ships no WebSocket protocol implementation, and without
it `WS /api/servers/{id}/shell` is not served at all and every shell connection fails with a bare HTTP 404.
See [DeveloperGuide.md](DeveloperGuide.md#the-shell-needs-the-websockets-package).

## Ports

Lite:

| What | Port |
| --- | ---: |
| Everything — UI, `/api`, `/docs`, `/health` | `APP_PORT`, default `8088` |

Full, additionally:

| What | Variable | Default | Bind |
| --- | --- | ---: | --- |
| PostgreSQL | `POSTGRES_PORT` | `15432` | **`127.0.0.1` only** |
| Prometheus | `PROMETHEUS_PORT` | `19090` | all interfaces |
| Grafana | `GRAFANA_PORT` | `13000` | all interfaces |
| Loki | `LOKI_PORT` | `13100` | all interfaces |
| Alertmanager | `ALERTMANAGER_PORT` | `19093` | all interfaces |

Inside the container uvicorn always binds `8000`; `APP_PORT` only changes the host side of the
published mapping. If a port is taken, change the variable in `.env` and re-run the up command.

Postgres is bound to `127.0.0.1` on purpose. In the previous stack it was published on all interfaces
with a committed default password.

The `1` prefixes exist because the intended host also runs ELK on 9200/5601/5044.

**`scripts/preflight.sh` checks `APP_PORT` only.** It was written for the single-port lite case; it
reads `APP_PORT` from `.env`, checks that one port, and ignores the case where the listener is our own
container so a running Infra Monitor is not reported as a conflict. It does **not** check the five full-mode
ports — check those yourself before a first full start (`ss -ltnp | grep -E ':(15432|19090|13000|13100|19093)'`).

## Storage and volumes

Lite: one volume.

```yaml
volumes: ["inframonitor_data:/app/data"]
```

Full: `inframonitor_data` is still mounted (the app's working data directory), plus a volume for Postgres and
one each for Prometheus, Grafana and Loki data.

`docker compose down` keeps volumes; `docker compose down -v` **destroys them**, along with every
server record and every encrypted credential. In full mode, run `down` with the same `-f` list you
brought the stack up with, or Compose will only see the lite service and leave the rest running.

The container runs as a non-root user and `/app/data` is owned by that user so SQLite can write to it.

The `.env` file is the other half of your state, because it holds the key that decrypts what is in
the database. Back up both together — see [BackupRecovery.md](BackupRecovery.md).

## Operating it

Lite:

```bash
docker compose ps
docker compose logs -f app
docker compose restart app
```

Full — always with both files, or use the wrapper:

```bash
scripts/stack.sh full ps
scripts/stack.sh full logs
docker compose -f docker-compose.yml -f docker-compose.full.yml restart app
```

Scripts in `scripts/`:

| Script | What it does | Profile |
| --- | --- | --- |
| `stack.sh` | Resolves the `-f` list for a mode and runs a Compose subcommand. | both |
| `preflight.sh` | Checks the single `APP_PORT` from `.env` before a first start. | lite (see above) |
| `deploy.sh` | Brings the stack up. It will not silently create a `.env` for you — with a required `JWT_SECRET` that would only fail confusingly later; it generates a secret on first run or stops with instructions. | lite |
| `healthcheck.sh` | Probes `/health` only. It deliberately does not touch an authenticated endpoint. | both |
| `backup.sh` | Consistent hot copy of the **SQLite** database plus `.env`. Refuses to run against a non-SQLite `DATABASE_URL`. | lite |
| `restore.sh` | Restores a SQLite backup. Verifies the source really is a SQLite database and refuses to overwrite without an explicit confirmation flag. Also refuses a non-SQLite `DATABASE_URL`. | lite |
| `upgrade.sh` | Takes a backup first, then pulls and rebuilds. | lite |

`backup.sh` and `restore.sh` read `DATABASE_URL` and **exit with an error rather than guessing** if it
is not a SQLite URL. In full mode they will refuse; use `pg_dump`. See
[BackupRecovery.md](BackupRecovery.md).

## Upgrading

Lite:

```bash
bash scripts/upgrade.sh
```

Or by hand:

```bash
bash scripts/backup.sh
git pull
docker compose up -d --build
```

Full:

```bash
# take your own pg_dump first -- upgrade.sh is SQLite-only
git pull
docker compose -f docker-compose.yml -f docker-compose.full.yml up -d --build
```

Schema changes are applied on startup in both profiles: missing tables are created and missing
`servers` columns are added by an inspector-driven `ALTER TABLE` loop, so an existing database is
upgraded in place. Keep the same `JWT_SECRET` across the upgrade or the stored SSH credentials become
unreadable.

## Switching profiles

There is **no migration path between the two databases.** Lite's data lives in a SQLite file, full's in
Postgres. Bringing up the full overlay against an existing lite install does not copy anything — the
app starts against an empty Postgres, runs its startup schema creation, and seeds a fresh default
admin. Your lite inventory is still safely in `inframonitor_data`, but the full stack will not see it.

If you need the data in the other profile, move it yourself with a tool of your choice, and remember
that the encrypted credential columns only decrypt under the **same `JWT_SECRET`** — so carry `.env`
across unchanged, or plan to re-enter credentials for every server.

To go back to lite, `down` with both files and `up` with just `docker-compose.yml`. The SQLite file is
untouched and comes back as it was.

## Exposure

The process serves plain HTTP and **neither profile contains a reverse proxy or TLS terminator**. If
this is reachable from anywhere but a trusted network, put your own reverse proxy in front of it, give
it a certificate, and point it at `APP_PORT`.

Two things to get right in that proxy:

- **Forward WebSocket upgrades.** The interactive shell is a WebSocket on the same port
  (`/api/servers/{id}/shell`). A proxy that does not pass the `Upgrade` and `Connection` headers through
  will serve the whole UI correctly and then fail only the terminal. Give it a read timeout at least as
  long as `SHELL_IDLE_MINUTES` (default **30**) — a shell session can legitimately sit idle for that long,
  and a proxy that times out sooner becomes the shortest cap in the stack, killing sessions the app was
  happy to keep. If you raise `SHELL_IDLE_MINUTES`, or set it to `0`, raise the proxy timeout too;
  otherwise the app's setting has no effect. If the terminal still 404s after the proxy is right, check
  that the `websockets` package is installed in the backend environment — without it the app does not serve
  the route at all, and the proxy is not the problem.
- **Understand what you are protecting.** Without TLS the shell carries an entire terminal session,
  keystrokes included, in clear text — a far larger exposure than any single REST call. The same applies to
  the workspace's SFTP pane: file contents pulled off a managed host cross the network in the clear too, and
  a delete issued through it is an unencrypted request to destroy data on a managed host. See
  [Security.md](Security.md#the-interactive-shell-is-the-highest-privilege-feature).

In full mode this applies to the monitoring ports too. Prometheus and Alertmanager have no
authentication of their own; Grafana has a login, and Prometheus's UI will happily show whoever reaches
19090 your alert rules and every metric label. Bind them to a trusted interface or firewall them. See
[Security.md](Security.md) and [Monitoring.md](Monitoring.md).
