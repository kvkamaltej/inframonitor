# Troubleshooting

## First: which profile are you on?

```bash
docker compose ps          # one container = lite, seven = full
```

Almost every full-mode problem is a wrong `-f` list. **Every** Compose command in full mode needs both
files, or use the wrapper:

```bash
scripts/stack.sh full ps
scripts/stack.sh full logs
```

In lite there is one container, so most problems are visible in one place:

```bash
docker compose ps
docker compose logs --tail=100 app
docker compose logs -f app
```

Health, which really does check the database:

```bash
curl -fsS http://localhost:8088/health
# healthy: {"status":"ok","service":"inframonitor-backend","database":"ok"}
# broken:  HTTP 503 {"status":"degraded",...,"database":"unavailable"}

bash scripts/healthcheck.sh
```

## `docker compose up` fails immediately with a JWT_SECRET error

Expected. `JWT_SECRET` is required and has no default:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
# put the value in .env as JWT_SECRET=...
```

If you already have a database, use the **same** secret it was created with — it is the key for the
stored SSH credentials. A new secret makes them permanently undecryptable
([BackupRecovery.md](BackupRecovery.md)).

## Full mode: the app is running but its database is empty

The classic wrong-`-f` symptom. If you ran `docker compose up -d` (or forgot
`-f docker-compose.full.yml`, or put it first), Compose starts the `app` service from the base file only,
so `DATABASE_URL` is still SQLite. You get a working-looking app on an empty SQLite database while
Postgres also runs, untouched. Nothing errors.

Check what the app is actually configured with, before starting anything:

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml config | grep -A3 DATABASE_URL
# expect a postgresql+psycopg:// DSN, not sqlite:///
```

`docker-compose.full.yml` is an **overlay**. It is not valid alone, and the order matters: base file
first. Use `scripts/stack.sh full up` and this cannot happen.

## Full mode: `/metrics` returns an HTML page

You are in lite, or the overlay was not applied. The route is **registered only when
`METRICS_ENABLED=true`**, so in lite it does not exist and the request falls through to the static UI
mount — hence HTML instead of JSON or an exposition format.

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml config | grep METRICS_ENABLED
curl -fsS http://localhost:8088/metrics | head -3
```

## Full mode: Prometheus shows the app target down

In order:

1. `curl -fsS http://localhost:8088/metrics | head` — if it is HTML, see the section above.
2. Prometheus scrapes `app:8000` by **Compose service name on the Compose network**, not the host's
   published `8088`. If you edited the scrape config to a host port, that is the bug.
3. `curl -s http://localhost:19090/api/v1/targets | jq '.data.activeTargets[] | {job:.labels.job, health, lastError}'`
   — `lastError` usually names the problem outright.

More checks in [Monitoring.md](Monitoring.md#verifying-a-full-mode-install).

## Full mode: Grafana panels are empty but everything is "healthy"

A mis-provisioned datasource UID. The datasources declare explicit `uid`s (`prometheus`, `loki`) and the
dashboard JSON must reference **those**, not the datasource *name*. A dashboard exported from the UI with
`"uid": "Prometheus"` resolves to nothing while Grafana reports itself perfectly healthy.

Also: **Save in the Grafana UI will not work.** `allowUiUpdates: false` is set and the dashboard
directory is mounted read-only. Edit the JSON in `monitoring/grafana/dashboards/` and let provisioning
pick it up. (Previously this was combined with `disableDeletion: false`, so the UI offered saving, then
errored and reverted within ~30s, which looked like data loss.)

## Full mode: alerts fired but `/api/alerts/recent` is empty

Expected after any restart. That endpoint reads an **in-memory ring buffer of the last 100 alerts**, and
it is lost completely whenever the `app` container restarts or is redeployed. There is no database table
behind it. It is not an alert history — check Alertmanager at port 19093 for current state, and send
Alertmanager somewhere durable if you need a record ([Monitoring.md](Monitoring.md)).

An always-empty buffer with the app up is different: check that Alertmanager's receiver points at
`http://app:8000/api/alerts/webhook` and that rules are actually firing
(`curl -s http://localhost:19090/api/v1/alerts`).

## Full mode: `loki_data` is filling the disk

Retention is configured — a compactor with a `retention_period` defaulting to 168h — but it is enforced
on a schedule, so usage falls sometime after the cutoff rather than at the instant a line ages out. If it
grows without bound, check that the compactor is actually running in `monitoring/loki/loki.yml`; the
previous config had neither a compactor nor a retention period, which is exactly how this volume used to
fill up.

## Port 8088 is already in use

Set `APP_PORT` in `.env` to a free port and `docker compose up -d` again. Nothing else needs changing:
the UI calls a relative `/api`, so there is no baked-in URL to update.

`scripts/preflight.sh` checks that one port and skips the check when the listener is our own
container, so a running Infra Monitor is not reported as a conflict.

In full mode there are five more ports (`POSTGRES_PORT` 15432, `PROMETHEUS_PORT` 19090, `GRAFANA_PORT`
13000, `LOKI_PORT` 13100, `ALERTMANAGER_PORT` 19093), each settable in `.env`. **`preflight.sh` does not
check these** — it was written for the single-port lite case. Check them yourself:

```bash
ss -ltnp | grep -E ':(15432|19090|13000|13100|19093)'
```

The `1` prefixes are deliberate: the intended host also runs ELK on 9200/5601/5044.

## `/health` returns 503, or the container restarts in a loop

The database is unreachable. Almost always a permissions problem on the volume — the container runs as
a non-root user and needs write access to `/app/data`:

```bash
docker compose exec app ls -la /app/data
docker compose exec app python -c "import sqlite3; sqlite3.connect('/app/data/inframonitor.db').execute('select 1')"
```

If the volume was created by an older root-owned container, the simplest fix is to back up the file,
`docker compose down`, remove the volume, bring it up again, and restore.

**In full mode** the same 503 usually means something else: either the `app` container came up before
Postgres was ready to accept connections (it should recover on the healthcheck retries — watch
`scripts/stack.sh full logs`), or the overlay was not applied and the app is looking at SQLite. Check
Postgres directly:

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml exec postgres pg_isready -U inframonitor
```

## "database is locked"

Lite only — this is a SQLite error. SQLite has one writer. WAL and a 5-second busy timeout normally absorb this, so seeing it means
something held a write transaction for a long time. Check whether a second process is using the same
file — a stray `uvicorn` on the host pointed at the same `data/inframonitor.db`, or `--workers` added to the
command. The app is designed for a **single worker**; do not add more.

## I get a 404 HTML page instead of a JSON response

You are hitting the static UI. `/api/*`, `/health`, `/docs` and `/openapi.json` are handled by the app
(plus `/metrics` in full mode); everything else falls through to the UI export. Check for a typo, and
remember the prefix is `/api` (`/api/servers`, not `/servers`).

This is also why `/metrics` returns HTML in lite: the route is not registered, so it falls through.

## The UI loads but every request fails with 401

The token expired — the default lifetime is 480 minutes and there is no refresh token. Sign in again.
If it happens immediately after a restart with a changed `JWT_SECRET`, all previously issued tokens
are invalid; sign in again to get one signed with the new secret.

## The page is blank, or a route 404s

The UI is a static export, and its routes use trailing slashes. The server detail page is
`/server/?id=<public_id>` — the old `/servers/<id>` path no longer exists, so an old bookmark 404s.
Navigate from the inventory table instead.

If every page is blank, the image may have been built without a UI: the static mount is skipped when
the directory is missing, and the API still works. Check `docker compose logs app` and rebuild with
`docker compose up -d --build`.

## Server operations fail: containers, logs, Tomcat, restart

Work down this list:

1. **No credentials stored.** `"No stored credentials for this server. Ask an admin to save
   credentials."` — an admin must save an SSH password or key on the server detail page.
2. **Wrong credentials, or the host is unreachable from the container.** Use **Test Connection** on the
   detail page. Remember the SSH connection originates in the *container*, not on your laptop, so the
   container's network must reach the host and port.
3. **`JWT_SECRET` changed.** Stored credentials were encrypted with the old value and cannot be
   decrypted. Test Connection fails while the host is plainly reachable. Restore the old secret, or
   re-enter credentials for every server.
4. **Discovery never ran.** Container listing and log reading need discovery to have populated the
   server's known log sources. Imported servers land with status `unknown` — run discovery on each.
5. **`Log path is not a discovered log source for this server.`** Only paths discovery actually found
   are readable, by design. Re-run discovery if the file is new.
6. **Sudo.** Service restart and Tomcat actions need root. A 200 with
   `needs_sudo_password: true` is a prompt, not an error — enter the sudo password and retry.
   `Sudo authentication failed` means the password was wrong.
7. **403 `"Server is not assigned to this user"`.** A per-server ACL. Grant the server to the user
   directly or through an access policy.
8. **403 `"Admin role required"`.** The action is admin-only. Note container restart also accepts
   `developer`, but service restart and Tomcat actions do not.

## A server detail page is missing its Tomcat, Containers or Database Logs tab

Those three tabs are **conditional**: they render only when the stored discovery snapshot shows that
capability. A missing tab means *discovery has not seen the software*, not that the tab is broken.

1. **Run discovery.** As an admin on the detail page: `Show Admin Tools` → `Operations` →
   `Discover Services/Storage`, then reload. Servers created by **CSV import never had discovery run** —
   they land with status `unknown` and show none of the three tabs. Same for a server whose credentials were
   added after it was created.
2. **Check what the condition actually is.** Database Logs needs either a `database_logs` entry or a
   discovered service classified as type `database`; Containers needs a Docker/Podman version or a service
   of type `container`; Tomcat needs an instance in the snapshot or a service whose name starts with
   `tomcat`. The full table is in [Usage.md](Usage.md#what-makes-a-conditional-tab-appear).
3. **The engine or its log path may be outside what discovery probes.** The probed unit patterns, binaries
   and log paths are listed in [Usage.md](Usage.md#database-detection). **Oracle and Db2 are the weak
   spots** — Oracle is only found under `/opt/oracle` or `/u01/app/oracle` with the default `diag` layout,
   and Db2 only at the default `db2inst1` diagnostic path. A custom `DIAGNOSTIC_DEST` or `DIAGPATH`, or a
   differently named Db2 instance owner, will not be detected.
4. **Check readability.** Discovery only reports a log path the SSH user can `ls`. An unreadable directory
   is indistinguishable from a missing one. Try the path by hand as that user.
5. **The tab was there and vanished.** If a re-run of discovery no longer detects the capability, the page
   deliberately falls back to **Overview** rather than showing an empty panel. That is the guard working,
   not a crash.

Note separately that the **admin tools pane starts collapsed** — `Show Admin Tools` is a button, not a
missing feature.

## Vitals columns are empty, stale, or show `-`

The Uptime / CPU / RAM / Procs columns are a **point-in-time SSH probe**. Nothing samples them on a timer,
so they are only as fresh as `vitals_checked_at`.

- **`-` in the CPU column means never sampled** (`cpu_percent` is `-1`), which is deliberately *not*
  rendered as `0%`. Run discovery or press **Refresh vitals**.
- **Numbers that look old are old.** They do not expire or grey out. Compare against `vitals_checked_at` on
  the server record before drawing a conclusion.
- **Refresh vitals did not update some rows.** A host with no stored credentials cannot be probed at all,
  and an unreachable host keeps its previous numbers and its previous `vitals_checked_at` rather than
  zeroing them — so an unchanged timestamp on one row is the signal that its probe failed.
- **It feels slow.** Expect roughly **2 seconds per host**, at **4 hosts concurrently**. Most of the 2 s is
  a deliberate 1-second gap between two `/proc/stat` reads — that file is cumulative since boot, so a single
  read would report the average since boot instead of the load now. This is not a hang.
- **There is no continuous monitoring here.** If you want time series and alerting on managed hosts, that is
  not what these columns are; full mode's Prometheus scrapes *this application*, not your fleet.

## The interactive shell will not open

The Shell button is **admin-only** and disabled when the server has no stored credentials. Beyond that, the
socket closes with one of the product's own codes, and the close reason carries the message:

| Code | Cause |
| --- | --- |
| `4401` | No handshake within 10 s, or a missing/invalid/expired token. Sign in again. |
| `4403` | Valid token, but the role is not `admin`. Developer and support cannot open a shell. |
| `4404` | Server not found, blocked by the per-server ACL, or no stored credentials. |
| `4429` | A concurrency cap is reached. **Read the close reason** — see below, the two cases need different actions. |
| `4500` | The SSH connection or PTY could not be opened — the reason has the underlying error. Test Connection first. |

**`4429` is two different problems.** There are two caps — sessions per user (`SHELL_MAX_SESSIONS_PER_USER`,
default **8**) and sessions across the whole application (`SHELL_MAX_SESSIONS`, default **24**) — and the
close reason says which one you hit:

- *"You already have N shell sessions open"* — this is **your own** tabs. Close one. Nothing anybody else
  does will free capacity for you, and waiting will not help.
- *"Server is at capacity"* — the application-wide limit is reached across all users. Your tabs are not the
  cause; closing them is not the fix. Wait for someone else to disconnect, or find out who is holding
  sessions open.

Treating the first as the second (or vice versa) is the usual reason this feels unfixable, which is why the
reason string spells it out.

There is a third `4429`: *"Interactive shell is disabled (SHELL_MAX_SESSIONS=0)"*, or the same with
`SHELL_MAX_SESSIONS_PER_USER`. That is not a capacity problem and waiting will never clear it — the shell has
been **switched off by configuration** on this install. Unlike the time caps, `0` on a session *count* means
zero sessions allowed, not unlimited. Ask whoever owns the deployment; nothing you do in the UI will change
it.

If the terminal never connects at all and you run a **reverse proxy**, the proxy is the first thing to
check: it must forward WebSocket upgrades (`Upgrade` / `Connection` headers) to the app, and many default
configurations do not. Without a proxy the socket is plain `ws://` on the app port and needs nothing special.

Switching to another tab does **not** disconnect anything — hidden tabs stay connected and keep their
scrollback, and neither does entering or leaving split view or fullscreen. Only closing a tab, or closing the
workspace, closes sockets.

## A shell session ended on its own

**Read the close reason first — it names the limit that fired.** That is the whole diagnosis in most cases,
and it distinguishes the two time limits from each other and from a network drop.

| Close reason | Limit | Setting | Default |
| --- | --- | --- | --- |
| `absolute session limit reached (SHELL_MAX_MINUTES=…)` | Total time open, however busy | `SHELL_MAX_MINUTES` | `480` minutes (8 hours) |
| `idle limit reached (SHELL_IDLE_MINUTES=…)` | Time with no traffic either way | `SHELL_IDLE_MINUTES` | `30` minutes |

The reason includes the value that was in force, so it tells you both which cap fired and what it was set
to — you do not have to go and read the configuration to interpret it. Both caps are configurable and
**`0` disables either one**, so on a customised install the defaults above are not necessarily what you hit.

The caps are checked every 5 seconds, so a session ends within a few seconds of crossing one rather than
exactly on it.

If the session died with **no product close reason at all**, it was not one of these caps. Look at:

- **A reverse proxy's read/idle timeout.** This is the most common cause of an unexplained mid-session drop.
  If the proxy times out an idle WebSocket sooner than `SHELL_IDLE_MINUTES`, the proxy is the effective cap
  and raising the app's setting changes nothing. Sessions dying at a suspiciously round interval that
  matches no app setting are almost always this.
- **The remote shell exiting.** Typing `exit`, or the remote host closing the connection, ends the session
  normally.
- **The app process restarting.** Every session lives in the API process; a restart or redeploy drops all of
  them.
- **The network path.** A laptop suspending, a VPN reconnecting or a Wi-Fi handover kills the socket.

Note that **an expiring login token does not end a running session.** The token is validated once, at the
handshake, and is never re-checked, so an expired token is never the reason a live terminal closed — but it
is also why `SHELL_MAX_MINUTES=0` lets a session outlive its credential indefinitely. See
[Deployment.md](Deployment.md#shell-session-limits).

## The tab menu, split view or fullscreen misbehaves

- **Right-click on a tab chip shows the browser's menu instead of the app's.** The suppression is scoped to
  the chip deliberately, so check you are on the chip itself and not the strip beside it. Either way, the
  same menu is on the chip's **`⋯` button**, which also works from the keyboard (`Shift+F10` or the
  `Menu` key while the chip is focused).
- **Fullscreen fills the browser window but not the screen.** The browser refused the Fullscreen API
  request and the workspace fell back to the in-page overlay. Common causes: the browser requires the
  request to come from a user gesture, fullscreen is disabled by enterprise policy, or the page is inside an
  iframe without `allow="fullscreen"`. The fallback is deliberate — the alternative was a button claiming a
  state the page was not in. Check the browser console for the rejection.
- **A terminal in split view renders with corrupted or overlapping output.** It is sized to a geometry it no
  longer has. Both panes are re-fitted on entering, leaving and resizing; if one still looks wrong, switch
  tabs and back, or resize the window, to force a re-fit. Note that a background browser tab suspends the
  animation frames a re-fit rides on, so a workspace that was in a hidden tab during a layout change may
  need one interaction to settle.

## The shell 404s instead of connecting

A **bare HTTP 404** on `WS /api/servers/{id}/shell` — no close code, no reason, no message — usually means
the `websockets` package is missing from the backend environment. **Plain `uvicorn` ships no WebSocket
protocol implementation**, so without it the route is simply not served and the upgrade falls through to a
404. It is not an authentication, ACL or credential problem, and no amount of checking the server record
will find it.

```bash
python -c "import websockets; print(websockets.__version__)"
```

A `ModuleNotFoundError` is the answer: `websockets` is a required entry in `backend/requirements.txt`
(pinned, listed separately from `uvicorn`) and something has installed a trimmed dependency set.
Reinstall from `requirements.txt`.

If you instead get one of the product's own close codes (`4401`, `4403`, `4404`, `4429`, `4500`), the route
*is* being served — use the table above.

## An SFTP download, upload or delete is rejected

The file pane in the shell workspace is admin-only and subject to the same per-server ACL as the shell, so
a non-admin gets **403** and an inaccessible server **404**. Beyond that:

- **413 on download** — the file is larger than `MAX_DOWNLOAD_MB` (default **200** MB). The size is checked
  against the remote `stat` before anything is read, so this fails immediately rather than part-way.
- **413 on upload** — over `MAX_WAR_MB` (default **512** MB); uploads share the WAR cap.
- **A directory looks incomplete** — listings are capped at **2000 entries** and the pane says when it
  truncated one. The rest of the directory is on the host; it was not returned. Narrow the path.
- **No rename or chmod** exists — those are not missing buttons, they were not built. Browse, download,
  upload and delete is the whole set.

Note there is no path restriction to run into: the pane reaches anywhere the stored SSH user can, by design
(see [Security.md](Security.md#the-sftp-file-pane-is-the-same-privilege-in-a-file-browser)). A permission
error is the remote host's, not the product's.

Delete has refusals of its own, and they are **400s with the reason in the message** — read it rather than
retrying:

| Message says | What happened |
| --- | --- |
| *"is a directory holding N entries. Pass recursive=true…"* | The target is a directory with contents and the request did not set `recursive`. In the pane, that is the extra acknowledgement on the confirm dialog. An **empty** directory does not need it. |
| *"Refusing to delete the filesystem root (/)"* | Exactly that, recursive or not. |
| *"a top-level path is too broad"* | A `recursive` delete of a path with fewer than two components — `/etc`, `/var`, `/opt`, `/home`. These cannot be removed through the pane at all; this is a deliberate guard against a mis-click and no confirmation unlocks it. |
| *"Refusing a recursive delete of the SSH user's home directory"* | The target resolved to the stored SSH user's own home. |
| *"Stopped after removing N entries"* | The tree was larger than the per-request bound of **5000 entries** (or deeper than **32 levels**). **The first N entries are gone** — this is not a rollback. Re-run to continue. |
| permission denied | The **remote host** refused it. The stored SSH user does not have write permission on the parent directory. Nothing in Infra Monitor can override that; escalate on the host, or use a shell tab with `sudo`. |
| no such file | The path is gone, or the listing was stale. Refresh the directory. |
| *"the directory may not be empty, or the remote refused to remove it"* | `rmdir` failed and the SFTP protocol gave no specific reason. SFTP v3 has no "not empty" status code, so OpenSSH answers with a bare `Failure` — the message says the most likely cause rather than echoing that. |

If a **symlink** delete left its target in place, that is correct and deliberate — the link is unlinked and
the target is never followed. To remove the target, delete the target's own path.

Deletes cannot be undone and Infra Monitor keeps no copy. If a delete succeeded and should not have, the
`audit_logs` row (`sftp.delete`) records the path, what it was, whether it was recursive, and how many
entries went — it does **not** record their names, so it tells you the scope of what happened and not the
contents. Recovery is a host-side restore question. Note also that only **successful** deletes are recorded,
so a refused one leaves nothing to look at.

## The dashboard has no monitoring panel

**In lite this is correct.** Prometheus, Grafana, Loki and Alertmanager are not part of that profile, and
`GET /api/integrations` returns an empty list when no monitoring URL is configured, so the panel hides
itself. Set `PROMETHEUS_URL`, `GRAFANA_URL`, `LOKI_URL` or `ALERTMANAGER_URL` if you run one of those
yourself, or install the full profile.

**In full mode it means the overlay was not applied**, since the overlay is what sets those four URLs.
See [the empty-database section](#full-mode-the-app-is-running-but-its-database-is-empty).

Note the panel is a reachability probe (2.5s timeout each, concurrent). A `healthy` Prometheus there
still tells you nothing about whether it has targets — see
[Monitoring.md](Monitoring.md#verifying-a-full-mode-install).

## A WAR deploy failed

The symptom-to-cause table is in
[TomcatDeployment.md](TomcatDeployment.md#troubleshooting-a-deploy). The three that are not obvious:

- **Deployed, but the old version still serves** — the stale unpacked directory. Tomcat will not
  necessarily re-expand a WAR when `<name>/` already exists. Stop Tomcat, remove the directory, restart.
- **Deployed, but nothing happens and no log entry appears** — ownership. A `root:root` WAR in a
  Tomcat-owned webapps directory is silently ignored. `ls -la` and `chown` to the Tomcat user.
- **`ok: true` with `restarted: false` and `needs_sudo_password: true`** — this is not a failure. The WAR
  is in place; retry the **restart** only. Re-uploading creates a second `.bak` containing the WAR you
  just deployed, which destroys your rollback point.

A WAR that deploys and then will not start is usually a Java version mismatch — check the instance's
**Prerequisites** block for a `java` chip reading `unsupported`, then `catalina.out`.

## Docker needs sudo

Add the `ems` user to the `docker` group (`sudo usermod -aG docker ems`, then log out and back in), or
run the compose commands with sudo.

## Forgot the admin password

There is no reset endpoint. Either use another admin account to create a new user, or reset the hash
directly (substitute your `ADMIN_EMAIL` if you changed it from the default):

```bash
docker compose exec app python -c "
from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models.entities import User
from sqlalchemy import select
db = SessionLocal()
u = db.scalar(select(User).where(User.email=='admin@inframonitor.local'))
u.password_hash = hash_password('NewPassword123!')
db.commit()
print('ok')"
```

Setting `ADMIN_PASSWORD` in `.env` does **not** reset an existing account — the seed only runs when the
user does not already exist. Those variables only matter before the first boot.

## `ADMIN_EMAIL` / `ADMIN_PASSWORD` had no effect

Same cause. The first-boot seed creates the administrator only if that email is not already in the
database. On an install that has already booted, change the password on the Profile page (or with the
snippet above), and create additional users through **Users**.

Conversely, changing `ADMIN_EMAIL` on an existing install and restarting will **seed a second
administrator** under the new address with the default password — while the original account still
exists. Check **Users** if you did that.

## The default-password banner will not go away

It is driven by `GET /api/auth/me` returning `using_default_password: true`, which is computed by
verifying `settings.admin_password` against **your** stored hash. So it means exactly what it says: the
account you are signed in as still has that password. Change it on the **Profile** page. The startup log
banner clears on the next restart. Neither is dismissible on purpose.

If you changed `ADMIN_PASSWORD` in `.env` to match a password you had already set manually, the banner
will appear again — the check compares against whatever that setting currently holds.

## Starting completely over

Lite:

```bash
docker compose down -v   # destroys the inframonitor_data volume and everything in it
docker compose up -d --build
```

Full — the same `-f` list, or `down` will only see the lite service and leave the rest running:

```bash
docker compose -f docker-compose.yml -f docker-compose.full.yml down -v
docker compose -f docker-compose.yml -f docker-compose.full.yml up -d --build
```

`-v` deletes every server record and every stored credential — and in full mode the Postgres, Prometheus,
Grafana and Loki volumes too. Take a backup first unless that is exactly what you want
([BackupRecovery.md](BackupRecovery.md)).
