# API

The router is mounted with the prefix `/api`, plus the unprefixed app-level route `/health` and
FastAPI's own `/docs` and `/openapi.json`.

## Base URL

Everything is on **one origin and one port** — the same process serves the API, the Swagger docs and
the UI, so there is no separate backend port any more.

| What | URL |
| --- | --- |
| REST API | `http://<host>:<APP_PORT>/api/...` |
| Swagger UI | `http://<host>:<APP_PORT>/docs` |
| OpenAPI schema | `http://<host>:<APP_PORT>/openapi.json` |
| Health probe | `http://<host>:<APP_PORT>/health` |
| Metrics | `http://<host>:<APP_PORT>/metrics` — **full profile only** |

`APP_PORT` defaults to `8088`. Inside the container uvicorn binds `8000`.

The API is **identical in both install profiles** with one exception: `/metrics` is only registered when
`METRICS_ENABLED=true`, which the full overlay sets. Everything else — including
`POST /api/alerts/webhook` — exists in lite too; in lite nothing posts to the webhook because there is no
Alertmanager. See [Deployment.md](Deployment.md#choosing).

Because the UI is served by the same process, the browser calls a **relative** `/api` — see
`frontend/lib/api.ts`, where `API_URL` is `process.env.NEXT_PUBLIC_API_URL ?? "/api"`. There is no
host address baked into the build, so the same image works on `localhost`, a LAN IP or a hostname.

The static UI is mounted at `/` **after** the router, so `/api/*`, `/health`, `/docs` and
`/openapi.json` always win over the static files; any other path falls through to the UI export.

CORS is only relevant if you front the API separately: the middleware is installed only when
`CORS_ORIGINS` is non-empty.

## Authentication

Every endpoint requires a JWT bearer token **except** `POST /api/auth/login`.

The one exception to the *mechanism* is the WebSocket shell, `WS /api/servers/{server_id}/shell`: it
still requires a token, but sends it in the first frame rather than a header, because browsers cannot set
headers on a WebSocket. See [Interactive shell (WebSocket)](#interactive-shell-websocket).

1. `POST /api/auth/login` with `{"email": "...", "password": "..."}` returns
   `{"access_token": "...", "token_type": "bearer"}`.
2. Send that token on every subsequent request:

```
Authorization: Bearer <access_token>
```

Token details, from `backend/app/core/security.py` and `backend/app/core/config.py`:

- HS256, signed with `JWT_SECRET`, which is required and has no default in Compose.
- Claims are `sub` (the user's email) and `role`.
- Lifetime is `ACCESS_TOKEN_EXPIRE_MINUTES`, default **480 minutes (8 hours)**. There is no refresh
  token — the client re-logs in.
- A missing header returns **401** `"Missing access token"`; a bad or expired one returns **401**
  `"Invalid access token"`.
- Wrong email or password returns **401** `"Invalid credentials"`. There is no rate limit on this
  endpoint.

### Roles

Three roles exist: `admin`, `developer`, `support`. The `administrator` value stored in the database is
normalized to `admin` in both the token and `GET /api/auth/me`, so clients only ever see `admin`.

The dependency used by each route determines the requirement:

| Dependency | Accepts | Failure |
|---|---|---|
| `require_user` | any valid token | 401 |
| `require_admin_or_developer` | `admin`, `developer` | 403 `"Admin or developer role required"` |
| `require_admin` | `admin` only | 403 `"Admin role required"` |

### Per-server access control (ACL)

Routes marked **+ ACL** below resolve the server through `_server_or_404(db, server_id, claims)`:

- Admins reach every server.
- A non-admin reaches only servers granted to them, either directly
  (`PUT /api/users/{id}/server-access`) or by a matching access policy (`/api/policies`) on
  environment, server type, tag, or explicit server id.
- Not granted → **403** `"Server is not assigned to this user"`. Unknown id → **404**
  `"Server not found"`.

`{server_id}` accepts the server's `public_id` (a UUID) or its numeric primary key.

Note that `GET /api/servers` and `GET /api/dashboard/summary` are not 403-gated — they silently
*filter* to the caller's accessible servers instead.

## Endpoints

Bodies are JSON; schema names refer to `backend/app/schemas/contracts.py`.

### Auth

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| POST | `/api/auth/login` | none | `LoginRequest` | `TokenResponse` |
| GET | `/api/auth/me` | `require_user` | — | `{email, role, using_default_password}` |
| POST | `/api/auth/change-password` | `require_user` | `PasswordChange` | `ConnectionResult` |

`PasswordChange.new_password` has a minimum length of 8. A wrong `current_password` returns 400.

`using_default_password` is computed by verifying `settings.admin_password` (`ADMIN_PASSWORD`, default
`ChangeMe123!`) against the **current user's** stored hash. The UI turns `true` into a persistent
warning banner linking to `/profile`. It goes false as soon as the password is changed — nothing needs
resetting.

### Users

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| GET | `/api/users` | admin | — | `list[UserRead]` |
| POST | `/api/users` | admin | `UserCreate` | `UserRead` (201) |
| DELETE | `/api/users/{user_id}` | admin | — | 204 |
| GET | `/api/users/{user_id}/server-access` | admin | — | `UserServerAccessRead` |
| PUT | `/api/users/{user_id}/server-access` | admin | `ServerAccessUpdate` | `UserServerAccessRead` |

`{user_id}` here is the numeric user id. Duplicate email → 409. Deleting your own user → 400.
`ServerAccessUpdate.server_ids` holds server `public_id` values and replaces the whole grant list;
an unknown id → 400.

### Access policies

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| GET | `/api/policies` | admin | — | `list[AccessPolicyRead]` |
| POST | `/api/policies` | admin | `AccessPolicyCreate` | `AccessPolicyRead` (201) |
| PUT | `/api/policies/{policy_id}/users` | admin | `PolicyAssignmentUpdate` | `AccessPolicyRead` |

Duplicate policy name → 409. Policy match is an **OR** across `server_ids`, `environments`,
`server_types` and `tags`, not an AND.

### Settings / dropdown options

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| GET | `/api/settings/options` | `require_user` | — | `OptionList` |
| POST | `/api/settings/environments` | admin | `OptionCreate` | `OptionList` |
| POST | `/api/settings/server-types` | admin | `OptionCreate` | `OptionList` |
| POST | `/api/settings/application-types` | admin | `OptionCreate` | `OptionList` |
| DELETE | `/api/settings/environments/{value}` | admin | — | `OptionList` |
| DELETE | `/api/settings/server-types/{value}` | admin | — | `OptionList` |
| DELETE | `/api/settings/application-types/{value}` | admin | — | `OptionList` |

All three lists are stored lowercased and de-duplicated.

### Servers

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| GET | `/api/servers` | `require_user` (filtered) | — | `list[ServerRead]` |
| POST | `/api/servers` | admin | `ServerCreate` | `ServerRead` (201) |
| POST | `/api/servers/import` | admin | `ServerImportRequest` | `ServerImportResult` |
| GET | `/api/servers/{server_id}` | `require_user` + ACL | — | `ServerRead` |
| DELETE | `/api/servers/{server_id}` | admin | — | 204 |
| PUT | `/api/servers/{server_id}/credentials` | admin | `CredentialPayload` | `ConnectionResult` |
| POST | `/api/servers/{server_id}/test-connection` | `require_user` + ACL | `CredentialPayload` | `ConnectionResult` |
| POST | `/api/servers/{server_id}/discover` | admin | `CredentialPayload` | `ConnectionResult` |
| POST | `/api/servers/{server_id}/vitals` | `require_user` + ACL | — | `ServerRead` |

`POST /api/servers` stores any supplied `password`/`private_key` Fernet-encrypted and then runs SSH
discovery inline; if discovery fails the record is still saved and the call returns 400
`"Server saved, but discovery failed: ..."`.

`POST /api/servers/import` bulk-creates from a CSV and does **not** run discovery — see
[CsvImport.md](CsvImport.md). It returns 200, not 201. Whole-request 400s (nothing is written) come
from an empty body, an unparseable file, a header row missing `hostname`/`ip_address`/`username`, or
more than 1000 data rows. Per-row problems are reported inside `ServerImportResult.rows` instead.
`csv_text` is capped at 4,000,000 characters by the schema.

Passing an empty `CredentialPayload` to `test-connection`/`discover` reuses the stored, encrypted
credentials. With none stored, the call returns 400
`"No stored credentials for this server. Ask an admin to save credentials."`

`ServerRead` carries the OS flavour fields `os_family` (`rhel | debian | suse | alpine | unknown`),
`os_distro`, `os_version`, `package_manager` (`dnf | yum | apt | zypper | apk`), plus `discovered_services`,
`storage`, `database_logs` and `tomcat` snapshots. All are empty until discovery runs.

#### Vitals

`POST /api/servers/{server_id}/vitals` opens **one SSH connection**, runs a single batched POSIX `sh`
probe, stores the result on the server row and returns the whole updated `ServerRead`. It takes no body
and always uses the **stored** credentials, so a server with none returns 400
`"No stored credentials for this server. Ask an admin to save credentials."`; any other SSH failure is
also 400 with the underlying message. Unlike discovery it is **not** admin-only — `require_user` plus the
per-server ACL, so developer and support users can refresh vitals on servers they can reach.

It costs roughly **two seconds per host**: the probe deliberately sleeps 1 s between two `/proc/stat`
reads, because that file is cumulative since boot and a single read would yield the average since boot
rather than the load right now. On top of that sits the SSH connection setup.

The fields it populates on `ServerRead`:

| Field | Type | Meaning |
|---|---|---|
| `uptime_seconds` | int | Host uptime from `/proc/uptime`, truncated to whole seconds |
| `load_average` | string | The first three fields of `/proc/loadavg`, space-separated, e.g. `"0.09 0.12 0.10"` — a string, not a number |
| `cpu_percent` | int | Whole-percent busy time across the 1 s sampling window. **`-1` means never sampled** |
| `ram_used_mb` | int | `MemTotal - MemAvailable` from `/proc/meminfo`, in MB |
| `process_count` | int | Rows from `ps -e`, minus the header |
| `vitals_checked_at` | datetime \| null | When the sample was taken; `null` before the first one |

**`cpu_percent = -1` is the "never sampled" sentinel and must never be rendered as a healthy `0%`.** It
is also what the field falls back to if a probe runs but the CPU calculation yields nothing, so treat it
as "no reading" rather than "old reading". The other numeric fields keep their previous value when a
probe cannot produce a new one, which is why `vitals_checked_at` is the only trustworthy indication of
freshness.

The probe also returns `RAM_TOTAL_MB` and `CPU_CORES`; total RAM overwrites `ram_mb` when it is non-zero,
so `ram_used_mb` and `ram_mb` are consistent for a percentage. Cores stay as discovery's `cpu` value.

`POST /api/servers/{server_id}/discover` folds a vitals sample in as well — it already holds a working
connection, so a discovery run populates these fields without a second call. **Nothing samples them on a
timer**: they are as stale as `vitals_checked_at` says.

### Containers and logs

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| POST | `/api/servers/{server_id}/containers/{runtime}` | `require_user` + ACL | `CredentialPayload` | `list[ContainerRead]` |
| POST | `/api/servers/{server_id}/logs/{runtime}/{container}` | `require_user` + ACL | `CredentialPayload` | `LogResponse` |
| POST | `/api/servers/{server_id}/logs/service` | `require_user` + ACL | `ServiceLogRequest` | `LogResponse` |
| POST | `/api/servers/{server_id}/container-restart` | admin or developer + ACL | `OperationRequest` | `ConnectionResult` |
| POST | `/api/servers/{server_id}/services/restart` | admin | `ServiceRestartRequest` | `PrivilegedOperationResult` |

`{runtime}` must be `docker` or `podman`; anything else → 400. `CredentialPayload.tail` (default 200)
controls how many container log lines come back.

These read a managed host live over SSH on every call, as do the Tomcat routes below,
`test-connection` / `discover` / `vitals`, and the WebSocket shell (which holds a connection open for the
life of the session). Nothing is polled in the background.

`ServiceLogRequest` is `{source, name_or_path, tail}`. `source="journal"` reads a systemd unit via
`journalctl`; any other source `tail`s a file path. `name_or_path` is validated before the SSH call:

- `source="journal"` — must match `^[A-Za-z0-9@._:-]{1,128}$`, else 400
  `"Journal unit name contains unsupported characters"`.
- any other source — the path must be a member of that server's **discovered** log paths (every
  `path` in `database_logs`, plus every `log_files[].path` across the Tomcat snapshot), else 400
  `"Log path is not a discovered log source for this server. Run discovery first."`

`POST /api/servers/{server_id}/services/restart` responds with `PrivilegedOperationResult`, and its
request body (`ServiceRestartRequest`) accepts an optional `sudo_password`. See *Sudo password flow*
below.

### Tomcat

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| POST | `/api/servers/{server_id}/tomcat` | `require_user` + ACL | `CredentialPayload` | `list[TomcatInstance]` |
| POST | `/api/servers/{server_id}/tomcat/logs` | `require_user` + ACL | `TomcatLogRequest` | `LogResponse` |
| POST | `/api/servers/{server_id}/tomcat/action` | admin + ACL | `TomcatActionRequest` | `PrivilegedOperationResult` |
| POST | `/api/servers/{server_id}/tomcat/deploy` | admin + ACL | **`multipart/form-data`** | `WarDeployResult` |

`POST .../tomcat` live-probes the host over SSH and also persists the snapshot to the server row, so
later page loads can render from `ServerRead.tomcat` without an SSH round trip. `name` is the identifier
the log, action and deploy endpoints take.

Each `TomcatInstance` carries:

| Group | Fields |
| --- | --- |
| Identity / process | `name`, `unit`, `source` (`systemd` \| `process`), `status`, `enabled`, `pid`, `catalina_base`, `catalina_home`, `ports` |
| Version | `version`, `server_number`, `jvm_version`, `jvm_vendor`, `os_name`, `java`, `java_home` |
| Logs | `log_dir`, `configured_log_dir`, `configured_log_prefix`, `primary_log_file`, `log_files[]` |
| Contents | `webapps[]`, `prerequisites[]` |

- `server_number` (e.g. `10.1.55.0`), `jvm_version`, `jvm_vendor` and `os_name` come from `version.sh`.
- `java_home` is resolved **per instance** — from the systemd unit's environment, `/etc/default/<unit>`,
  or the running process's environment. Two Tomcats on one host can be on different JVMs.
- `configured_log_dir` / `configured_log_prefix` are parsed from
  `<catalina_base>/conf/logging.properties` (`1catalina.org.apache.juli.*FileHandler.directory` and
  `.prefix`, with `${catalina.base}` resolved). **`catalina.out` is not produced by
  `logging.properties`** — it is the shell redirect in `catalina.sh` or the systemd unit's
  `StandardOutput`. `primary_log_file` prefers `catalina.out` when it exists, else the newest file
  matching the configured prefix.
- `log_files[]` is `{name, path, size_bytes, modified}` and is the **allowlist** the log endpoints check
  against. `primary_log_file` and the configured-prefix matches are included in it.
- `webapps[]` is `{name, path, type: war|dir, size_bytes, modified}` under `<catalina_base>/webapps`.
- `prerequisites[]` is `{name, required, detected, status}` with `status` ∈
  `ok | missing | unsupported | unknown`. A `java` entry is always present; the required minimum is
  derived from the Tomcat major version (8.5→Java 7+, 9.0→8+, 10.0→8+, 10.1→11+, 11.0→17+).
  `unknown` means the Tomcat version could not be determined, so no requirement was inferred.

Full field semantics and the operator procedure are in
[TomcatDeployment.md](TomcatDeployment.md).

`TomcatLogRequest` is `{instance, log_file, tail}` (`tail` 10–1000, default 200). `log_file` must be an
absolute path matching a discovered `log_files[].path` for that server, or the call returns 400.

`TomcatActionRequest` is `{instance, action, sudo_password}` with `action` ∈
`restart | start | stop | status` (default `restart`). Any other action → 400
`"Action must be restart, start, stop, or status"`; an empty `instance` → 400
`"Tomcat instance is required"`. This endpoint is **admin-only** — deliberately stricter than
container restart, which also accepts `developer`.

### WAR deployment

`POST /api/servers/{server_id}/tomcat/deploy` is **admin-only** + ACL and takes
**`multipart/form-data`**, not JSON — it is the only endpoint in the API that does.

| Form field | Required | Meaning |
| --- | :---: | --- |
| `instance` | yes | the instance `name` from discovery |
| `file` | yes | the WAR |
| `filename` | no | override the deployed filename; defaults to the upload's name |
| `restart` | no | bool, default `false` — restart the instance after a successful deploy |
| `sudo_password` | no | only if the move into place, or the restart, needs it |

Validation, all before anything touches the remote host:

| Rule | Failure |
| --- | --- |
| Must end `.war` and be a **bare basename** — no `/`, `\` or `..` | 400 |
| Body over `max_war_mb` (`MAX_WAR_MB`, default **512**) | **413** |
| Bytes must start with the ZIP magic `PK\x03\x04` | 400 |
| `instance` must exist in the persisted `tomcat_json` (or a fresh probe) | 404 |

The target directory is resolved as `<catalina_base>/webapps` from the **discovered instance**, never
from the request — that is what makes the filename check sufficient against traversal.

`WarDeployResult` is `{ok, message, target_path, backup_path, bytes_written, restarted,
needs_sudo_password}`. `backup_path` is `""` when there was no existing file; otherwise an existing
target is renamed to `<target>.bak-<timestamp>` first.

Three response shapes worth handling explicitly:

| Response | Meaning |
| --- | --- |
| `ok: true, restarted: true` | Deployed and restarted. |
| `ok: false, needs_sudo_password: true` | Nothing was deployed. The webapps directory is not writable by the SSH user. Prompt and retry the whole request. |
| **`ok: true, restarted: false, needs_sudo_password: true`** | **Deployed.** Only the restart needs a password. Retry `POST .../tomcat/action` alone — **do not re-upload**, or you create a second `.bak` whose contents are the WAR you just deployed. |

Upload goes over SFTP, not the command line, and the temp file is always removed including on failure.
See [TomcatDeployment.md](TomcatDeployment.md) for the runbook and rollback procedure.

### Sudo password flow

`/services/restart` and `/tomcat/action` both need root on the remote host. Three outcomes:

1. The SSH user is root, or passwordless sudo works → the command runs.
   `{"ok": true, "needs_sudo_password": false, "output": "..."}`
2. Sudo needs a password and none was sent → **HTTP 200** with
   `{"ok": false, "needs_sudo_password": true, "message": "Sudo password required for <user>@<host>"}`.
   It is a 200, not a 4xx, because the client treats it as prompt-and-retry rather than an error.
   Re-send the same request with `sudo_password` filled in.
3. A password was sent and sudo rejected it → HTTP 200 with `{"ok": false,
   "needs_sudo_password": true, "message": "Sudo authentication failed"}`, so the client can prompt
   again.

Any other SSH failure (host unreachable, unit not found, and so on) is still an error: **400** with
the underlying message as `detail`. Only a recognised sudo rejection is downgraded to a 200 `ok:false`.

Sudo passwords are pass-through only: never stored, never logged, never echoed back in a response,
and never placed on a command line. They reach the remote host over SSH stdin.

### Interactive shell (WebSocket)

| Protocol | Path | Role | Notes |
|---|---|---|---|
| WS | `/api/servers/{server_id}/shell` | **admin** + ACL | Interactive PTY as the stored SSH user |

This is the only WebSocket route and **the highest-privilege surface in the product** — it is a real
terminal on the managed host, with that SSH user's full privileges and no command filtering. Read
[Security.md](Security.md#the-interactive-shell-is-the-highest-privilege-feature) before you enable
access to it.

**Authentication is in the first frame, not a header.** Browsers cannot set `Authorization` on a
WebSocket, and a token in the query string would be written to access logs, so the server accepts the
socket and then waits up to 10 seconds for a JSON handshake:

```json
{"token": "<bearer token>", "cols": 120, "rows": 32}
```

`cols`/`rows` are optional and default to 80×24. After the handshake the server sends a connection
banner and the session is live.

Frames after the handshake:

| Direction | Frame | Meaning |
|---|---|---|
| client → server | `{"d": "ls -la\r"}` | Keystrokes to write to the PTY |
| client → server | `{"r": [cols, rows]}` | Resize the PTY |
| server → client | raw text | PTY output (stdout and stderr, UTF-8, undecodable bytes replaced) |

Server-to-client frames are **plain terminal text**, not JSON — feed them straight to the emulator.
Client-to-server frames must be JSON; anything else ends the session.

Close codes are the product's own, and the close `reason` carries the message:

| Code | Meaning |
|---|---|
| `4401` | No handshake within 10 s, or a missing/malformed/invalid/expired token |
| `4403` | Authenticated, but the role is not `admin` |
| `4404` | Server not found, not accessible under the ACL, or has no stored credentials |
| `4429` | A concurrency cap is reached — either the caller's per-user limit or the process-wide one |
| `4500` | The SSH connection or PTY could not be opened; `reason` has the underlying error |

**All four server-side limits are configuration, not constants**, so a client must not hard-code them:

| Setting | Env | Default | `0` means |
|---|---|---|---|
| `shell_max_minutes` | `SHELL_MAX_MINUTES` | `480` | **no duration limit** |
| `shell_idle_minutes` | `SHELL_IDLE_MINUTES` | `30` | **no idle limit** |
| `shell_max_sessions` | `SHELL_MAX_SESSIONS` | `24` | **no sessions permitted** — every connection is refused with `4429` |
| `shell_max_sessions_per_user` | `SHELL_MAX_SESSIONS_PER_USER` | `8` | **no sessions permitted** — same |

Note the asymmetry: `0` disables a *time* cap and disables the *shell* on a concurrency cap, because one is
a threshold and the other is a count.

Idle and duration are checked by a supervisor task **every 5 seconds**, and hitting either closes the session
with a close `reason` that **names the setting that fired** — `idle limit reached (SHELL_IDLE_MINUTES=30)`,
`absolute session limit reached (SHELL_MAX_MINUTES=480)`. Surface it verbatim rather than reporting a generic
disconnect. A time cap set to `0` skips its check entirely.

The 480-minute default matches the default `access_token_expire_minutes` on purpose: **the handshake token
is validated once and never re-checked on a live socket**, so the duration cap is the only thing that stops
a session outliving its JWT. See
[Deployment.md](Deployment.md#why-the-default-is-480-and-what-shell_max_minutes0-accepts).

**The two `4429` refusals are distinguishable in the close `reason`, and clients should surface them
differently, because the remedy differs**: the per-user refusal names the caller's own open sessions and
is fixed by closing one of their tabs, while the process-wide refusal says the application is at capacity
and can only be fixed by waiting for someone else to disconnect. Reporting both as "too many sessions"
tells the user to do something that will not help.

The client may hold **several sockets at once** — the UI is a tabbed workspace, with tabs to the same host
or to different hosts. Nothing about the protocol is per-server-exclusive: each socket is independent, and
each counts separately against both caps.

Each session writes two `audit_logs` rows — `shell.open` and `shell.close`, the latter with **the reason the
session ended** (including the setting name when a cap fired), the duration and the byte counts. **No endpoint
reads that table back**; query the database directly. Commands typed inside the session are not recorded — see
[Security.md](Security.md#what-does-not-exist).

The socket is plain `ws://` on the application port. Nothing in either profile terminates TLS, so a
reverse proxy is the only way to get `wss://`, and it must be configured to forward WebSocket upgrades.

**`websockets` is a required backend dependency for this route to exist at all.** Plain `uvicorn` ships no
WebSocket protocol implementation, so without it the upgrade is not handled and the client gets a bare
**HTTP 404** with no useful message. See
[DeveloperGuide.md](DeveloperGuide.md#the-shell-needs-the-websockets-package).

### Shell favorites

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| GET | `/api/shell/favorites` | `require_user` | — | `list[ShellFavoriteRead]`, newest first |
| POST | `/api/shell/favorites` | `require_user` | `ShellFavoriteCreate` | `ShellFavoriteRead` (201) |
| DELETE | `/api/shell/favorites/{favorite_id}` | `require_user` | — | 204 |

Named commands the operator can insert into a shell tab. **Scoped to the calling user**: `GET` returns only
their rows, and `DELETE` only removes their own — another user's `favorite_id` is not deletable even if it
is guessed.

`require_user` rather than admin is deliberate: a stored string is inert, and running it still requires the
shell's admin gate.

| Field | Constraint |
|---|---|
| `name` | 1–128 characters. Unique **per user**, not globally |
| `command` | 1–4000 characters. Stored **verbatim** — not escaped, rewritten or validated |

| Condition | Status |
|---|---|
| `name` already used by this user | **409** |
| `name` or `command` outside its length bounds | **422** |
| `favorite_id` not found, or owned by another user | **404** — the two are indistinguishable, deliberately |

The server never executes a favorite. The UI *inserts* the command into the active terminal and leaves the
Enter keypress to the operator, so a mis-click cannot fire a destructive command.

### SFTP file transfer

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| POST | `/api/servers/{server_id}/sftp/list` | **admin** + ACL | `{path}` — omit for the SSH user's home | `SftpListing` |
| POST | `/api/servers/{server_id}/sftp/download` | **admin** + ACL | `{path}` | streaming file bytes + `Content-Disposition` |
| POST | `/api/servers/{server_id}/sftp/upload` | **admin** + ACL | **`multipart/form-data`**: `path` (target dir), `file` | `SftpUploadResult` |
| POST | `/api/servers/{server_id}/sftp/delete` | **admin** + ACL | `SftpDeleteRequest` — `{path, recursive}` | `SftpDeleteResult` |

These act as the **stored SSH user** and are **not confined to any subtree** — read
[Security.md](Security.md#the-sftp-file-pane-is-the-same-privilege-in-a-file-browser) before exposing them.
They are gated exactly like the shell: admin role plus the per-server ACL, and stored credentials required.

`SftpListing`:

| Field | Meaning |
|---|---|
| `path` | The normalised absolute path that was actually listed |
| `parent` | Parent directory, for an "up" control |
| `entries` | `SftpEntry` list, directories first then by name |
| `truncated` | `true` when the directory hit the **2000-entry** cap; the listing is partial |

`SftpEntry` is `{name, path, type, size_bytes, modified, mode, modified_epoch}`, where `type` is `file`,
`dir` or `link`. The default path is resolved from the remote home over SFTP, not assembled as
`/home/<user>`.

**Two fields exist for sorting, and a client must use them rather than the display strings.** `modified` is
a formatted date and sorts as text — "Jan" before "Feb" — so `modified_epoch` carries the raw `st_mtime` as
a **number** (`0` when the SFTP server reported no usable mtime). `size_bytes` is a **string**, because the
model sets `coerce_numbers_to_str`, so it must be run through `Number()` before comparing: `"9"` sorts
after `"10"` lexically.

> **There is no creation time in this model, and there cannot be.** The SFTP protocol's file attributes
> carry modification time, access time, size, permissions and ownership — **there is no birth/creation
> timestamp in the protocol**, and paramiko's `SFTPAttributes` has no field for one. A client cannot sort
> or filter by creation time against this API, and `modified` is not a substitute for it: a file created
> years ago and edited today has a recent `modified_epoch`. Do not add a "Created" column fed by
> `modified`.

| Condition | Status |
|---|---|
| Download of a file larger than `max_download_mb` (`MAX_DOWNLOAD_MB`, default **200**) | **413** |
| Upload larger than `max_war_mb` (`MAX_WAR_MB`, default **512**) | **413** |
| Path containing a NUL byte, or longer than 4096 characters | **400** |
| Empty `path` on download or upload (on `list` it means "home") | **400** |
| Download target is a directory, or a symlink to one | **400** |
| Upload filename empty, over 255 characters, or carrying path structure (`/`, `\`, `..`, control characters) | **400** |
| Upload body empty | **400** |
| The remote SFTP operation failed (no such file, permission denied) | **400**, with the underlying message |
| Server not found, blocked by the ACL, or no stored credentials | **404** |
| Role is not `admin` | **403** |

The download size is checked against the remote `stat` **before** any bytes are streamed, so an oversized
file is refused up front rather than mid-transfer. If the file grows between the `stat` and the read it is
still a **413**, not a generic failure. An upload filename that adds path structure is **rejected, not
reduced to its basename** — silently rewriting it would write a file the caller did not ask for.

#### `POST /sftp/delete` — the one destructive route

This is the only endpoint in the product that **removes data from a managed host**. It is gated like the
rest of the pane (admin role, per-server ACL, stored credentials) and has its own refusals on top.

`SftpDeleteRequest`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | string, 1–4096 chars | required | Absolute path to remove. Normalised with `posixpath` (`.`/`..` collapsed) so the path used is the path reported back |
| `recursive` | bool | `false` | Required to remove a **non-empty** directory. The default is `false` deliberately — a delete that quietly recursed because the flag was absent is the one mistake this endpoint cannot take back |

`SftpDeleteResult`:

| Field | Meaning |
|---|---|
| `ok` | Always `true` on a 200. Declared explicitly rather than left for the client to infer — every failure path is a 4xx with the reason in `detail` |
| `message` | Human-readable summary of what was removed |
| `path` | The path that was removed |
| `deleted` | `file`, `dir` or `link` — what the target actually was, from `lstat` |
| `recursive` | Echoed back, so the response, the audit row and the UI confirmation agree on whether this was a recursive removal |
| `entries_removed` | Every unlink and rmdir actually performed, **the target included**: `1` for a file, a link or an empty directory, and `4` for a directory holding three files |

The target is classified with **`lstat`, not `stat`**, which is the difference between deleting a symlink
and deleting whatever it points at. **A symlink is always unlinked**, whether it is the target of the call
or found inside a recursive walk; its destination is never followed, read or removed. "Delete this link"
therefore cannot turn into "delete that directory".

**An empty directory is removed without `recursive`.** Only a directory with contents needs the flag —
removing an empty one destroys nothing beyond the path that was named, so requiring the opt-in there would
be noise. The refusal for a populated directory says how many entries it holds.

| Condition | Status |
|---|---|
| `path` empty or over 4096 characters | **422** — the request schema bounds it, before any SSH connection is opened |
| `path` whitespace only | **400** — `"A remote path is required"` |
| `path` contains a NUL byte | **400** |
| `path` is `/` | **400** — refused outright, recursive or not |
| `recursive: true` on a path with fewer than two components (`/etc`, `/var`, `/opt`) | **400** — refused outright |
| `recursive: true` on the SSH user's **home directory** | **400** — refused outright |
| Target is a **non-empty** directory and `recursive` is `false` | **400**, naming the entry count and telling the caller to opt in |
| Not found, or permission denied | **400**, with the remote error distinguishable in the message |
| Server not found, blocked by the ACL, or no stored credentials | **404** |
| Role is not `admin` | **403** |

Guard failures return **400 with the message intact**, so a client can show the operator what was refused
and why instead of a generic failure.

The recursive walk is bounded: **32 levels deep** and **5000 entries per request**. Both bounds exist so a
pathological or looping tree cannot hold a request open indefinitely, and neither is a policy about how much
an operator may remove. **Hitting one raises rather than stopping quietly, and the delete is left partly
done** — the message says how many entries were already removed and that re-running will continue. There is
no rollback; SFTP has no transaction.

A directory read is fully drained before anything under it is removed, because paramiko multiplexes every
SFTP request over one channel and a removal interleaved with an in-progress `readdir` can consume a packet
that read is waiting for and hang until the channel times out.

**Every successful delete is audited** as an `sftp.delete` row recording the path, the kind, whether it was
recursive, and `entries_removed`. A delete that was **refused or failed writes no row** — the audit trail
records destruction that happened, not attempts. Deletes, downloads and uploads are audited; **listings are
not**. A download writes an `sftp.download` row and an upload an `sftp.upload` row, each with the remote path
and the byte count.

There is still **no rename, chmod, chown or mkdir route.**

### Dashboard, integrations and alerts

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| GET | `/api/dashboard/summary` | `require_user` (filtered) | — | `Summary` |
| GET | `/api/integrations` | `require_user` | — | `list[IntegrationStatus]` |
| POST | `/api/alerts/webhook` | none — Alertmanager posts here | Alertmanager payload | `AlertWebhookResult` |
| GET | `/api/alerts/recent` | `require_user` | — | `AlertBufferResponse` |

`GET /api/integrations` probes only the monitoring URLs that are configured (`PROMETHEUS_URL`,
`GRAFANA_URL`, `LOKI_URL`, `ALERTMANAGER_URL`). In lite all four are empty, so it returns `[]` and the
dashboard hides the panel; the full overlay sets all four. Probes run concurrently with a 2.5-second
timeout, and each result is `healthy`, `warning` or `offline`. It is a reachability check only — it does
not verify that Prometheus has targets or that Grafana's datasources resolve.

`POST /api/alerts/webhook` is what Alertmanager posts to in full mode. It exists in lite as well;
nothing posts to it there. It returns `AlertWebhookResult` — `{ok, received, stored, message}`.

The payload shape is **validated defensively.** A body whose `alerts` is not a list is accepted and
ignored (`received: 0`, `stored: 0`) rather than raising: the previous version called
`len(payload.get("alerts", []))` on an unvalidated dict, so a payload where `alerts` was a number raised
`TypeError` and became an unhandled 500.

`GET /api/alerts/recent` returns `AlertBufferResponse` — `{alerts[], count, capacity, persistent, note}`.
Each `AlertRecord` is `{alertname, severity, status, instance, summary, starts_at, received_at}`.

> **This is an in-memory ring buffer of the most recent 100 alerts.** `capacity` is 100 and
> **`persistent` is always `false`** — the response says so in the payload itself, and `note` spells it
> out. The buffer lives in the API process: it is **lost on every restart or redeploy** of the `app`
> container, the 101st alert evicts the oldest, and there is no database table behind it. It is a
> visibility improvement, **not durable alert storage** — do not build reporting or incident review on
> it. Send Alertmanager to a real destination as well.

### App-level (no `/api` prefix)

| Method | Path | Role | Response |
|---|---|---|---|
| GET | `/health` | none | `{"status": "ok", "service": "inframonitor-backend", "database": "ok"}` — **503** with `"status": "degraded"`, `"database": "unavailable"` if the probe query fails |
| GET | `/metrics` | none | Prometheus exposition — **only when `METRICS_ENABLED=true`** |
| GET | `/docs`, `/openapi.json` | none | Swagger UI / OpenAPI schema |

`/health` really checks the database — it queries a real table rather than a constant expression, because
`SELECT 1` never opens the SQLite file and so reported healthy against a deleted or corrupt database. It
is safe to use as the container healthcheck.

`/metrics` is **not registered at all** when `METRICS_ENABLED` is false, rather than registered and
returning a 404 body. In lite that means the path falls through to the static UI mount, so you get the
UI's 404 page — if `curl /metrics` returns HTML, you are in lite or the full overlay was not applied.
It carries request count and latency labelled by method, **route template** (not the raw path, which
would explode cardinality with server UUIDs) and status code, plus a servers-total gauge. See
[Monitoring.md](Monitoring.md).

## Example

```bash
TOKEN=$(curl -s -X POST http://localhost:8088/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@inframonitor.local","password":"ChangeMe123!"}' | jq -r .access_token)

curl -s http://localhost:8088/api/servers -H "Authorization: Bearer $TOKEN"
```

Or explore interactively at `http://localhost:8088/docs` — click **Authorize**, paste the token, and
call any endpoint from the browser.
