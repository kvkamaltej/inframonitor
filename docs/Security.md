# Security

This page describes what the code actually does, and — just as important — what it does not do. Infra Monitor
holds SSH credentials for your fleet, so read the second half before you expose it.

Three capabilities dominate this page's risk profile, and all are admin-only:
[the interactive shell](#the-interactive-shell-is-the-highest-privilege-feature), which is a real PTY on
a managed host; [the SFTP file pane](#the-sftp-file-pane-is-the-same-privilege-in-a-file-browser), which is
unrestricted filesystem read, write **and delete** as the same SSH user; and
[WAR deployment](#war-upload-is-validated-before-it-touches-a-host). Each is code execution, data
exfiltration or data destruction on a managed server. Read all three before you grant anyone `admin`.

Everything here applies to **both install profiles**. Full mode adds five more unauthenticated or
separately-authenticated ports; those are called out in
[Full mode adds attack surface](#full-mode-adds-attack-surface).

## What exists

### Authentication

- `POST /api/auth/login` checks the email and a bcrypt password hash (passlib), and returns a JWT.
- The token is HS256, signed with `JWT_SECRET`. Claims are `sub` (email), `role` and `exp`.
- Lifetime is `ACCESS_TOKEN_EXPIRE_MINUTES`, default 480 minutes (8 hours). There is no refresh
  token and no server-side session, so **there is no way to revoke an issued token** short of
  changing `JWT_SECRET`, which also destroys your stored credentials. Prefer a short lifetime.
- Every other endpoint requires `Authorization: Bearer <token>`. A missing header is 401
  `"Missing access token"`; an invalid or expired one is 401 `"Invalid access token"`.
- Passwords are only ever stored as bcrypt hashes. `POST /api/auth/change-password` verifies the
  current password and enforces a minimum new length of 8.

### Authorization

Two independent layers, both enforced server-side:

1. **Role checks** as FastAPI dependencies — `require_user`, `require_admin_or_developer`,
   `require_admin`. Writing credentials, running discovery, managing users and policies, restarting
   services and all Tomcat actions are admin-only. Restarting a container also accepts `developer`.
   The full matrix is in [Architecture.md](Architecture.md#rbac).
2. **Per-server ACLs.** Every server-scoped route resolves its target through
   `_server_or_404(db, server_id, claims)`. Admins reach everything; anyone else reaches only servers
   granted to them directly or by a matching access policy (on environment, server type, tag or
   explicit id). Not granted is 403 `"Server is not assigned to this user"`. List endpoints
   (`GET /api/servers`, `GET /api/dashboard/summary`) silently filter instead of erroring, so a user
   cannot enumerate servers they have no access to.

### Credentials at rest

SSH passwords and private keys are Fernet-encrypted before they are written to the database and
decrypted only in the moment a connection is opened. No endpoint returns a credential value in any
response — not the create call, not `ServerRead`, not the CSV import result.

The key is derived from `JWT_SECRET` by SHA-256 in `backend/app/core/crypto.py`. That means
**`JWT_SECRET` is your credential-encryption key**, with three consequences:

- It must be high-entropy and secret. Generate it with
  `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
- Compose refuses to start without it. There is no default, deliberately: the previous stack shipped
  a committed constant, which meant a default install encrypted real SSH passwords with a publicly
  known key.
- Rotating it makes every already-stored credential permanently undecryptable, and a database backup
  taken under a different secret is unusable. See [BackupRecovery.md](BackupRecovery.md).

Anyone who can read `.env` **and** the database file can recover every SSH credential in plaintext.
Protect both accordingly; that is the real trust boundary.

### Remote file read is allowlisted

The log endpoints cannot be used to read arbitrary files off a managed host, which matters because
they are available to non-admin users:

- `source="journal"` — the unit name must match `^[A-Za-z0-9@._:-]{1,128}$`, else 400
  `"Journal unit name contains unsupported characters"`. No shell metacharacters, no spaces, no path
  separators.
- any other source — the path must be a member of that server's **discovered** log paths (every
  `path` in `database_logs`, plus every `log_files[].path` across the Tomcat snapshot), else 400
  `"Log path is not a discovered log source for this server. Run discovery first."`
- `POST .../tomcat/logs` applies the same check: `log_file` must be an absolute path that discovery
  actually found on that server.

So the readable set is bounded by what discovery found, not by what the user asks for. A user cannot
name `/etc/shadow` or `~/.ssh/id_rsa` and get it back.

### WAR upload is validated before it touches a host

`POST /api/servers/{server_id}/tomcat/deploy` is **admin-only** plus the per-server ACL, and its
filename is the obvious path-traversal sink. Four checks run **before** anything is uploaded:

- The filename must end `.war` and be a **bare basename**. Anything containing `/`, `\` or `..` is
  rejected.
- The target directory is always `<catalina_base>/webapps` resolved from the **discovered instance**,
  never taken from the request. A crafted filename has nothing to redirect: it cannot escape the
  directory and it cannot choose the directory.
- A body over `max_war_mb` (default 512 MB) is rejected with 413, and the read is capped rather than
  buffering an unbounded upload — so this is not a memory-exhaustion vector either.
- The bytes must start with the ZIP magic `PK\x03\x04`.

The upload goes over SFTP to a temp path, is size- and magic-verified again on the remote side, and is
only then moved into place. The temp file is always removed, including on failure.

This is still an **admin-only remote code deployment path** by nature — an admin who can deploy a WAR to
a Tomcat instance can run code as the Tomcat user on that host. The validation stops path traversal and
malformed uploads; it does not and cannot make the capability safe to hand out. Grant `admin` on that
basis. See [TomcatDeployment.md](TomcatDeployment.md).

### The interactive shell is the highest-privilege feature

`WS /api/servers/{server_id}/shell` opens an **interactive PTY on the managed host as the stored SSH
user**. There is no command allowlist, no wrapper and no filtering: whatever that user can do on that
host, a shell user can do — read any file the user can read, edit configuration, stop services, and
escalate with `sudo` wherever the user is permitted to. Every other server-scoped route in this product
runs one fixed, constructed command; this one runs whatever is typed. Treat granting it as equivalent to
handing out the SSH credential itself, because in effect it is.

What constrains it:

- **Admin role only.** The handshake closes the socket with code **4403** for any other role — the same
  bar as `/services/restart` and the Tomcat actions.
- **The per-server ACL still applies.** The target resolves through `_server_or_404`, so an admin still
  only reaches servers they can reach elsewhere; a rejected server closes with **4404**.
- **Stored credentials only.** The session uses the server's encrypted stored credential. A server with
  none cannot be shelled into, and the UI disables the button.
- **Authentication happens in the first frame.** The socket is accepted but unauthenticated until the
  client sends `{"token": ..., "cols": ..., "rows": ...}`, which must arrive within 10 seconds. A
  missing, malformed or invalid token closes with **4401**. The token is deliberately *not* in the URL:
  browsers cannot set an `Authorization` header on a WebSocket, and a query-string token would be
  written to access logs.
- **Caps — but they are configuration, not guarantees.** By default **24** concurrent sessions
  process-wide and **8** per user (**4429** beyond either), **30 minutes** idle and **480 minutes**
  maximum regardless of activity. Idle and duration are enforced by a supervisor task that tears the
  session down and names the limit in the close reason. All four are settings
  (`SHELL_MAX_SESSIONS`, `SHELL_MAX_SESSIONS_PER_USER`, `SHELL_IDLE_MINUTES`, `SHELL_MAX_MINUTES`), so on
  a given install the real numbers are whatever the operator set — **and `0` on either time limit removes
  that limit entirely.** Do not read this bullet as a bound the product enforces for you; read it as a
  default you should check.

  The per-user cap exists because the shell is a **tabbed workspace**: one operator with tabs open could
  otherwise consume the whole process-wide allowance and lock every other admin out. The `4429` close
  reason distinguishes the two refusals — "you already hold your limit, close a tab" versus "the
  application is at capacity, wait" — because only the first is something the refused user can fix.

  **The duration cap is the only thing binding a session to its credential.** The handshake token is
  checked once and **never re-validated on a live socket**; there is no revocation path into an
  established session. That is why the 480-minute default matches the default token lifetime, and why
  `SHELL_MAX_MINUTES=0` means a PTY on a managed host can outlive the token that authorised it — and
  survive the operator's account being deleted, demoted or having its password changed. See
  [Deployment.md](Deployment.md#why-the-default-is-480-and-what-shell_max_minutes0-accepts).
- **Every session is recorded.** A `shell.open` row and a `shell.close` row are written to `audit_logs`
  — see [the audit-log entry below](#what-does-not-exist) for exactly what that does and does not cover.
  Each tab is a separate session and produces its own pair of rows.

What does **not** constrain it:

- **The transport is not encrypted by anything in this repository.** Neither install profile terminates
  TLS, so an unproxied deployment carries the terminal stream — every keystroke, including any password
  or sudo password typed at the remote prompt, and every byte of output — as **plaintext `ws://` on the
  wire**. This is worse than it is for the REST API: a REST call leaks one request, whereas a shell
  session leaks a continuous interactive session with the credentials typed inside it. **Do not enable
  or use the shell on a network you would not run plain `telnet` over.** Put a TLS-terminating reverse
  proxy in front of `APP_PORT` (it must also proxy WebSocket upgrades), or keep the port on a trusted
  network.
- **No command-level record.** The audit rows say a session happened and how much data moved, not what
  was run in it. See below.
- **Nothing stops a shell user from undoing the product's other protections.** The log-path allowlist,
  the WAR filename validation and the sudo pass-through discipline all constrain *the API*. A shell
  bypasses all of them by construction — that is what a shell is.

If you do not want this capability on your fleet, the primary lever is the **admin role** — it is what gates
access to it. There is also a blunt configuration lever: **`SHELL_MAX_SESSIONS=0` refuses every shell
session**, closing each with `4429` and a reason naming the setting. The route still exists and still
authenticates, so this is a capacity refusal rather than the endpoint being removed, but nothing gets a PTY.
`SHELL_MAX_SESSIONS_PER_USER=0` has the same effect. Neither affects the SFTP pane, which is a separate set
of routes with its own gate.

### The SFTP file pane is the same privilege in a file browser

The shell workspace includes a file pane backed by four routes — `POST /api/servers/{id}/sftp/list`,
`/sftp/download`, `/sftp/upload` and `/sftp/delete`. Read this as carefully as the shell section above,
because it is the same capability wearing different clothes: **arbitrary filesystem access as the stored SSH
user**. Anything that account can read can be pulled off the host to the operator's browser, anything it can
write can be pushed onto the host, and anything it can unlink can be **destroyed**, from anywhere in the
filesystem.

What constrains it:

- **Admin role only**, and **the same per-server ACL** as everything else — identical gating to the shell,
  resolved through the same helper. A non-admin has no access to these routes at all.
- **Every transfer and every delete is audited.** A download writes an `sftp.download` row and an upload an
  `sftp.upload` row, each recording the remote path and the byte count; a delete writes an `sftp.delete` row
  recording the path, whether it was recursive, and how many entries were removed. This is a genuine
  improvement on the shell's session-level record: for file movement and file destruction specifically, you
  get *what* and *how much*, not just that a session happened. Listing a directory is deliberately **not**
  audited — it is high-volume, and browsing moves no data off the host.
- **Size caps, checked in the right order.** Downloads are bounded by `MAX_DOWNLOAD_MB` (default **200**),
  and the size is read from the remote `stat` **before** any bytes are streamed, so an oversized file is
  refused up front instead of being discovered mid-transfer. Uploads reuse `MAX_WAR_MB` (default **512**).
  Over either → **413**.
- **A listing cap of 2000 entries**, flagged as truncated in the response so the UI can say the directory
  was cut short rather than presenting a partial listing as complete. This is availability, not security:
  it stops a directory with a million files from hanging the browser.
- **Malformed input is rejected** — NUL bytes and empty paths — and `.`/`..` are normalised so the path the
  UI displays is the path that was actually used.
- **No rename, chmod, chown or mkdir route.** Browse, download, upload and delete is the whole surface.

**It is deliberately not jailed to a subtree, and that is a considered decision rather than an omission.**
The obvious-looking hardening would be to confine the pane to, say, the SSH user's home directory. It was
not done because it would be **security theatre**: the same admin, on the same server, through the same
panel, already has a **full interactive PTY** as the same user. Anyone stopped by a path restriction in the
file pane can switch to the terminal tab beside it and `cat` the file, or `scp` it out. A restriction that
is trivially bypassed one tab over does not reduce anyone's access; it only misleads whoever reads the
feature list into thinking the boundary is real, and it makes legitimate work (fetching a log from
`/var/log`, dropping a file into `/opt`) needlessly painful. The honest position is the one the shell
section already states: **this feature is equivalent to handing out the SSH credential**, and the control
that matters is who holds `admin`.

The audit rows are the mitigation that *does* work here, and they are why transfers and deletes are worth
recording even though the shell can move or destroy the same bytes unrecorded: an operator using the
supported pane leaves a trail.

#### Delete is the first thing in this product that destroys data

`POST /api/servers/{id}/sftp/delete` removes files and directories on a managed host. Every other
server-scoped route reads, restarts or writes; this one deletes. Treat that as a **new class of
consequence** rather than another file operation: a mistaken download is an information leak you can reason
about after the fact, while a mistaken recursive delete on a production host is data that is gone, and
nothing in this product holds a copy of it.

What constrains it:

- **The same gate as the rest of the pane** — admin role, per-server ACL, stored credentials. No new
  privilege was introduced; the set of people who can delete is exactly the set who already held a PTY on
  the same host.
- **A directory with contents requires an explicit `recursive: true`.** Without it the request is refused
  with a message naming how many entries the directory holds, so recursion is never something a request fell
  into by omission. An **empty** directory is removed without the flag: nothing beyond the named path goes
  with it, so there is nothing extra to consent to.
- **`/` is refused outright**, and so is any `recursive: true` on a path with **fewer than two path
  components** — `/etc`, `/var`, `/opt`, `/home` cannot be handed to a recursive delete at all — and so is a
  recursive delete of **the SSH user's own home directory**. This is a guard against the mis-click and the
  mis-typed variable, not against a determined admin: the same person can still `rm -rf` from the terminal
  tab. It is worth having anyway, because the failure it prevents is the accidental one.
- **Symlinks are unlinked, never followed.** Classification uses `lstat`, so deleting a symlink removes the
  link and leaves its target untouched, and a symlink met inside a recursive walk is unlinked rather than
  descended into. Without this, "delete this link" silently becomes "delete that directory" — and that
  directory could be anywhere on the host.
- **The walk is bounded** — 32 levels deep, 5000 entries per request — so a pathological or looping tree
  returns an error rather than holding a request open indefinitely. Note what that bound is *not*: it is not
  a rollback. Hitting it raises **after** the entries removed so far are gone, and the message says how many
  and that re-running continues. Nothing here is transactional, because SFTP has no transaction.
- **The UI puts the path in front of you.** The confirm dialog shows the full absolute path and what will be
  removed, and a directory requires the operator to **type its name** before the request is sent — chosen
  over a checkbox precisely because a checkbox beside a confirm button is two clicks in the same place, which
  a stray double-click or a held Enter key defeats. No single click can remove a tree. The dialog also refuses
  a shallow path up front rather than sending a request that the backend will reject.
- **It is audited** as `sftp.delete`, with the path, what was removed, the recursive flag and the entry
  count. An unaudited delete would have been strictly worse than the unaudited restarts this document already
  lists as a gap. Note the row is written on **success**: a refused or failed delete leaves no record, so the
  table shows destruction that happened and not attempts to destroy.

What does **not** constrain it: there is no trash, no undo, no snapshot and no confirmation from the host
beyond the SFTP result. Deleting through this pane is exactly as final as deleting over SSH, because it is
the same operation.

### Favorite commands are personal notes, not a privileged feature

`GET`/`POST`/`DELETE /api/shell/favorites` store named commands per user. These are gated by
`require_user`, not admin, on purpose: a saved string is inert. It does nothing until someone who *already*
has shell access pastes it into a terminal, and that person's ability to run it comes from the shell's
admin gate, not from the favorite.

- **Scoped to the owner.** A user only ever sees and deletes their own rows; a `DELETE` for someone else's
  id fails rather than succeeding by guessing. Names are unique per user, not globally, so two operators
  can each keep their own "tail catalina" entry — a duplicate name for the same user is a **409**.
- **Stored verbatim.** The command text is not sanitised, escaped or validated beyond a 4000-character
  length cap. This is intentional. It is a string the user typed for their own shell, there is no
  meaningful notion of a "safe" shell command to check against, and a validator here would suggest a
  guarantee that does not exist. Nothing on the server ever executes it.
- **Clicking one inserts, it does not run.** The UI writes the command into the active terminal and leaves
  the Enter key to the operator, so a mis-click cannot execute a destructive command against a production
  host. A separate run control exists and is two-step: one click arms it, a second confirms.
- Favorites cascade-delete with the user.

### Sudo passwords are pass-through only

`/services/restart`, `/tomcat/action` and the move-into-place step of `/tomcat/deploy` need root on the
remote host. When the SSH user is not root
and passwordless sudo is unavailable, the API returns HTTP 200 with
`{"ok": false, "needs_sudo_password": true}` and the UI prompts for the sudo password, which is
re-sent with the retried request.

That password is used for that one command and then discarded. It is **never** stored in the
database, never written to a log, never echoed back in a response, and never placed on a command line
where `ps` could show it — it is delivered to `sudo -S -p ''` over SSH stdin. The user is prompted
again next time.

### Other

- The container runs as a **non-root user**. Every container in the previous stack ran as root.
- CORS middleware is only installed when `CORS_ORIGINS` is non-empty. The normal same-origin
  deployment adds no cross-origin permission at all.
- `/health` exposes only `{status, service, database}` — no version or configuration detail.
- The fabricated demo server that the old build seeded into every fresh database is gone; nothing
  fake is written to your inventory.
- **The default admin password is surfaced, not hidden.** While the seeded admin still has
  `settings.admin_password`, the app logs a banner on every boot and `GET /api/auth/me` returns
  `using_default_password: true`, which the UI turns into a warning banner. The banner can be dismissed,
  but the dismissal is **time-limited, not permanent**: it is remembered in `localStorage` with a timestamp
  and the banner returns **after 24 hours** and **on a fresh sign-in**. Dismissing therefore stops the
  banner nagging during one working session; it cannot be used to silence it. Override the seed with
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` before first boot, or change the password on the Profile page.
  Making the problem loud is not the same as fixing it — a default-password install is exposed until
  someone changes it.

## What does not exist

Do not assume any of the following. Each is a real gap, not an oversight in the documentation.

- **Almost no audit log — shell sessions and SFTP file operations are the exceptions.** The `audit_logs`
  table in `models/entities.py` has exactly **five writers**. Every row carries the actor (the token's
  `sub`, i.e. the operator's email), the action, and the server:

  | Action | Written when | Extra detail in the row |
  | --- | --- | --- |
  | `shell.open` | a shell session starts | — |
  | `shell.close` | that session ends | **why it ended**, duration in seconds, bytes each way |
  | `sftp.download` | a file is downloaded through the file pane | remote path, byte count |
  | `sftp.upload` | a file is uploaded through the file pane | remote path, byte count |
  | `sftp.delete` | a file, directory or symlink is deleted through the file pane | remote path, whether recursive, entries removed |

  **Nothing else writes a row, and the list of what is not recorded is still longer than the list of what
  is.** There is still **no record of who restarted a service or a Tomcat instance, who ran a Tomcat
  start/stop, who deployed which WAR to which host, who changed or saved a credential, who added or deleted
  a server, who created or deleted a user or policy, or who read which log.** Those are among the
  highest-consequence actions in the product and they leave nothing behind. Five audited actions do not make
  this an audited product: treat the blanket statement — that this product has no audit trail you can rely
  on for accountability — as still true for everything outside the table above.

  It is worth being precise about what adding `sftp.delete` changed, because it is easy to over-read. It
  closed one specific gap: **destructive file operations through the supported pane are now recorded** —
  which is the operation this table would most obviously have been missing, since it is the only one that
  destroys data. It changed nothing else. In particular, **destruction elsewhere in the product is still
  unrecorded**: deleting a server row, deleting a user, and overwriting a webapp with a WAR deploy all
  write nothing.

  Note also that the SFTP rows do not narrow the shell's gap. An admin with the file pane also has the
  terminal, and can move the same bytes with `cat` or an outbound `scp`, or delete the same tree with
  `rm -rf`, and produce no row at all. The SFTP rows record use of the supported path; they do not bound
  what left the host or what was destroyed on it.

  Limits that apply to what *is* recorded:

  - **Directory listings are not recorded.** `sftp.list` does not exist as an action. Browsing is
    high-volume and moves no data off the host, so only transfers and deletes are written. You can see that
    a file was fetched or removed; you cannot see what an operator looked at before choosing it.
  - **A delete row does not tell you what was in the tree.** `entries_removed` is a count. The row proves
    that an operator recursively removed a path and how many entries went with it; it does not list them,
    and there is no way to recover the names afterwards.
  - **There is no API or UI for reading the table.** No endpoint returns audit rows and no page displays
    them, for shell or SFTP events. Query the database directly
    (`SELECT * FROM audit_logs ORDER BY created_at DESC;`), and include the table in your backup plan — it
    is in the same database as everything else, so [BackupRecovery.md](BackupRecovery.md) already covers it.

  Two further limits apply to the shell records specifically:

  - **Sessions are recorded; commands are not.** The rows prove that an operator held a PTY on a host
    for a period and how much data crossed it. They do not contain what was typed or what came back, and
    there is no plan for that: keystrokes inside a PTY cannot be captured reliably or completely (line
    editing, control characters, `vi`, an inner `ssh` or `su`, and any full-screen program all defeat
    it), and a partial transcript presented as a command history would be worse than none. If you need
    command-level accountability, get it on the managed host — `auditd`, shell process accounting, or an
    SSH session recorder — not from here.
  - **The close row says why the session ended, and that is worth reading.** Its detail text carries the
    reason verbatim, so a session killed by a cap is identifiable from the table alone — for example
    `Shell session ended: absolute session limit reached (SHELL_MAX_MINUTES=480) after 28800s`, or the idle
    equivalent, against a plain `Shell closed` for a browser disconnect or a remote `exit`, and
    `Shell server shutting down` for a redeploy. Alongside the duration and byte counts, that tells you
    whether a long session was ended by policy or by the operator.
  - **An `open` row without a matching `close` row is ambiguous, though less often than it used to be.**
    The close row is written from a `finally` block, so it survives every ordinary ending — the browser
    disconnecting, either cap firing, the remote shell exiting — **and** the handler being cancelled under a
    graceful shutdown. What still produces no close row: the process dying hard (`SIGKILL`, an OOM kill, power
    loss), and an audit write that itself fails, which is deliberately swallowed so it cannot mask the reason
    the session closed. A session still in progress obviously has no close row yet either. So an unmatched
    `open` means "in progress **or** the process died abruptly" — narrower than before, but still not a single
    answer.

  For accountability across the rest of the product, put it in front of the app or at the SSH layer on
  the managed hosts.
- **No durable alert storage.** `POST /api/alerts/webhook` (full mode) keeps the most recent **100**
  alerts in an **in-process, in-memory ring buffer**, readable via `GET /api/alerts/recent`. It is
  **lost completely on every restart or redeploy of the `app` container**, and the 101st alert evicts
  the oldest. There is no database table behind it. It is a visibility convenience, **not** an alert
  history: do not use it for incident review, reporting, or anything you have to be able to prove
  after the fact. Send Alertmanager to a real destination as well.
- **No rate limiting or lockout on login.** `POST /api/auth/login` will accept unlimited attempts at
  full speed. There is no delay, no attempt counter, no lockout, no CAPTCHA and no logging of
  failures. Password guessing is bounded only by bcrypt's cost factor. If the port is reachable by
  untrusted clients, put a rate limiter in your reverse proxy.
- **No TLS, in either profile.** The process serves plain HTTP on `APP_PORT`. **Neither profile
  contains a reverse proxy** — nginx was not restored in full mode either, because the app serves its
  own UI and the old config's `/grafana/` route was broken. Nothing in this repository terminates TLS.
  **Providing TLS is the operator's responsibility**: run your own reverse proxy with a certificate in
  front of `APP_PORT`, or keep the port on a trusted network only. Over plain HTTP, bearer tokens, the
  admin password, any sudo password the operator types, **and every uploaded WAR** cross the network in
  the clear. In full mode this covers the five monitoring ports too.

  **This is most acute for the interactive shell.** `WS /api/servers/{server_id}/shell` is plain `ws://`
  on the same port, so an unproxied install puts an entire terminal session — every keystroke and every
  byte of output, including anything typed at a remote password prompt — on the wire in clear text. A
  proxy in front of it must forward WebSocket upgrades (`Upgrade`/`Connection` headers) as well as
  ordinary requests, or the terminal will simply fail to connect. See
  [the shell section above](#the-interactive-shell-is-the-highest-privilege-feature).
- **No SSH host key verification.** `services/ssh_ops.py` sets
  `paramiko.AutoAddPolicy()`, so an unknown host key is accepted silently and never pinned. A
  machine-in-the-middle between the container and a managed host can impersonate that host and
  collect the SSH credential Infra Monitor presents. Only manage hosts over a network path you trust.
- **No token revocation.** Covered above: a stolen token is valid until it expires.
- **No secret manager integration.** Credentials are in the SQLite file, encrypted with a key that
  sits in plaintext in `.env` on the same host. There is no Vault or KMS support.
- **No password policy beyond an 8-character minimum**, no expiry, and no MFA.
- **No CSRF protection**, which is acceptable only because the API authenticates with a bearer token
  in a header rather than a cookie. Do not change the client to use cookie auth without adding it.

## Full mode adds attack surface

Lite publishes **one** port. Full publishes **six**, and the five new ones do not share Infra Monitor's
authentication. If you do not need the monitoring stack, running lite is a smaller target.

| Port | Auth | What an unauthenticated visitor gets |
| --- | --- | --- |
| `19090` Prometheus | **none** | Every metric and label, your alert rules, current alert state, and the target list |
| `19093` Alertmanager | **none** | Current alerts, **and the ability to silence them** |
| `13100` Loki | **none** | Query access to every shipped log line |
| `13000` Grafana | its own login | Everything above, if the password is weak or unchanged |
| `15432` Postgres | password | Bound to **`127.0.0.1` only** — deliberately, unlike the rest |
| `8088` app `/metrics` | **none** | Route templates, status codes and traffic shape |

Points that follow from that:

- **Grafana is a separate account system.** `admin@inframonitor.local` does not work there and Infra Monitor's roles and
  per-server ACLs do not apply. A `support` user who is given the Grafana password can read logs from
  every server, including ones the ACL denies them in Infra Monitor.
- **Alertmanager silencing is an unauthenticated write.** Anyone who reaches 19093 can suppress your
  alerts.
- **Loki holds the app's container logs**, so treat its query API as being as sensitive as those logs.
- **Postgres is `127.0.0.1`-bound on purpose.** The previous stack published it on all interfaces with a
  committed default password. Keep it that way; set a real password in `.env`.
- `/metrics` is unauthenticated in full mode and **absent entirely** in lite, because the route is not
  registered when `METRICS_ENABLED` is false.

Firewall the monitoring ports to your operators' network or bind them to a trusted interface. See
[Monitoring.md](Monitoring.md).

## Before you expose this

1. Set a strong `JWT_SECRET`, then back it up (see [BackupRecovery.md](BackupRecovery.md)).
2. Change the seeded `admin@inframonitor.local` / `ChangeMe123!` password. It is published in this repository.
   Set `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env` before the first boot, or change it on the Profile
   page afterwards. While it is unchanged the app says so in its startup log on every boot and the UI
   shows a warning banner — if you see either, this step is not done.
3. Put a TLS-terminating reverse proxy in front of `APP_PORT`, with a rate limit on
   `/api/auth/login`. Neither profile ships one. Configure it to pass WebSocket upgrades through, or the
   interactive shell will not connect; without the proxy, shell sessions run in clear text.
4. Keep the port off the public internet. This is an internal tool that holds root-capable
   credentials for your fleet.
5. Give each managed host a dedicated SSH account with the narrowest sudo rules that still let the
   operations you use work, rather than a shared root login.
6. Restrict who can read `.env` and the `inframonitor_data` volume — together they are every SSH credential
   you have stored.
7. Delete any CSV you imported servers from; it holds plaintext credentials. See
   [CsvImport.md](CsvImport.md).
8. Remember what `admin` includes on **every host the user can reach**: an **interactive shell** as the
   stored SSH user, **unrestricted SFTP browse, download, upload and delete** as that same user anywhere on
   the filesystem, and **deploying a WAR** — code execution as the Tomcat user. Shell sessions are recorded
   in `audit_logs` as open/close events with no command detail; SFTP transfers as one row each with path and
   byte count; SFTP deletes as one row each with path, recursive flag and entry count. WAR deployments,
   service and Tomcat actions, credential changes and server or user CRUD are not recorded at all. Keep the
   admin role to the people who should have that.
9. Decide the shell session limits deliberately rather than inheriting them. `SHELL_MAX_MINUTES` (default
   480) is the only thing that stops a live PTY outliving the token that authorised it, because that token
   is never re-checked after the handshake. `0` removes that bound — see
   [Deployment.md](Deployment.md#shell-session-limits).
10. In full mode, firewall or interface-bind the five monitoring ports, and set a real Grafana password.
    If you do not need monitoring, run lite: one port instead of six.
