# Tomcat: prerequisites, versions, logs and WAR deployment

An operator runbook for the Tomcat tab. Applies to **both install profiles** — none of this is
full-mode-only.

For the UI walkthrough (loading instances, reading logs, the sudo prompt) see
[Usage.md](Usage.md#tomcat). This page is the reference and the deployment procedure.

## What discovery reports per instance

`POST /api/servers/{server_id}/tomcat` probes the host over SSH and persists the snapshot onto the
server row, so returning to the tab renders the last result without a new round trip.

### Identity and process

| Field | Meaning |
| --- | --- |
| `name` | The instance identifier. **This is the value the log, action and deploy endpoints take.** |
| `unit` | systemd unit name, when the instance is systemd-managed |
| `source` | `systemd` or `process` — both bare processes and units are found |
| `status`, `enabled`, `pid` | current state |
| `catalina_base`, `catalina_home` | the two paths everything else is resolved against |
| `ports` | listening ports |

### Version detail

Read from `version.sh` where it is available:

| Field | Example | Meaning |
| --- | --- | --- |
| `version` | `Apache Tomcat/10.1.55` | the "Server version" line |
| `server_number` | `10.1.55.0` | the "Server number" line — the precise build, which `version` does not always give you |
| `jvm_version` | `17.0.9+9` | JVM the instance is actually running on |
| `jvm_vendor` | `Eclipse Adoptium` | JVM vendor |
| `os_name` | | the host's OS name / version / architecture as Tomcat sees it |
| `java_home` | `/usr/lib/jvm/java-17-openjdk` | resolved for **that instance** — from the systemd unit's environment, `/etc/default/<unit>`, or the running process's environment |

`server_number` and `java_home` are the two that matter in practice. `version` may be blank or
imprecise on some installs, and `java_home` is per-instance: two Tomcats on one host can and do run on
different JVMs, so a host-wide `java -version` can be misleading.

### Prerequisites

A per-instance list of `{name, required, detected, status}`, with `status` one of:

| Status | Meaning |
| --- | --- |
| `ok` | detected satisfies required |
| `unsupported` | something is installed but it is **below** the requirement |
| `missing` | not found at all |
| `unknown` | could not determine — most often because the Tomcat version could not be read |

A `java` entry is always present. The required minimum is derived from the Tomcat major version:

| Tomcat | Requires |
| --- | --- |
| 8.5 | Java 7+ |
| 9.0 | Java 8+ |
| 10.0 | Java 8+ |
| 10.1 | Java 11+ |
| 11.0 | Java 17+ |

Other cheaply-detectable prerequisites appear alongside it — for example whether `JAVA_HOME` is set,
and whether the webapps directory is writable by the Tomcat user.

**Read the prerequisites block before deploying anything.** The single most common Tomcat 10.1 failure
is a WAR that deploys cleanly and then will not start, because the instance is on Java 8. That shows
here as `java` / `unsupported` *before* you upload, which is much cheaper than reading a stack trace
afterwards. A `java` entry of `unsupported` or `missing` means the instance's problems are not going to
be fixed by a deployment.

`unknown` is not a failure — it means the probe could not read the Tomcat version, so it declines to
guess a requirement rather than inventing one.

### Log files, and which one to actually read

Two independent mechanisms produce Tomcat logs, and confusing them is why operators tail the wrong
file:

| Field | Meaning |
| --- | --- |
| `configured_log_dir` | the directory Tomcat is **configured** to log to, from `conf/logging.properties` |
| `configured_log_prefix` | the handler prefix, e.g. `catalina.` |
| `primary_log_file` | the file you should actually tail |
| `log_files[]` | every discovered log file: `name`, `path`, `size_bytes`, `modified` |
| `log_dir` | the directory the enumeration walked |

**`catalina.out` is not produced by `logging.properties` at all.** It is the **shell redirect** in
`catalina.sh` — or the systemd unit's `StandardOutput` — capturing the JVM's stdout and stderr. It gets
everything written to the console: `System.out.println`, stack traces thrown before logging initialises,
JVM crash output, and anything a library writes directly to stdout.

The `catalina.<date>.log` family is a different thing: it comes from the
`1catalina.org.apache.juli.*FileHandler` entries in `conf/logging.properties` (with `${catalina.base}`
resolved), which is why it is **date-rotated** and why its content is only what went through Tomcat's
JULI logging. That is also why the two files do not agree — neither is a subset of the other.

Practical consequence:

- **A crash or a startup failure → `catalina.out`.** It is what `primary_log_file` prefers when it
  exists, precisely for this reason.
- **Ordinary application/container logging → the `catalina.<date>.log` family**, and
  `configured_log_dir` / `configured_log_prefix` tell you where those land, which is not always
  `<catalina_base>/logs`.
- If `catalina.out` does not exist, `primary_log_file` falls back to the newest file matching the
  configured prefix. A missing `catalina.out` usually means a systemd unit sending stdout to the journal
  instead — use the Services tab's journal view for that unit.

**Only paths discovery found are readable.** The backend allowlists every log request against this
server's discovered paths (`log_files[].path` across the Tomcat snapshot, plus `database_logs`), so a
path that is not in `log_files[]` is rejected with `Log path is not a discovered log source for this
server. Run discovery first.` `primary_log_file` and the configured-prefix matches are added into
`log_files[]`, so they are viewable. If a log file is new, **re-run discovery** — that is the fix, not
a bug.

### Webapps

`webapps[]` lists what is under `<catalina_base>/webapps`: `name`, `path`, `type` (`war` or `dir`),
`size_bytes`, `modified`.

Both types normally appear for the same application, because Tomcat unpacks `foo.war` into `foo/`. That
is expected. It also means the unpacked directory is stale state that survives replacing the WAR — see
[Troubleshooting a deploy](#troubleshooting-a-deploy).

## Deploying a WAR

`POST /api/servers/{server_id}/tomcat/deploy` — **admin only**, plus the per-server ACL, as
`multipart/form-data`.

| Field | Required | Meaning |
| --- | :---: | --- |
| `instance` | yes | the instance `name` from discovery |
| `file` | yes | the WAR |
| `filename` | no | override the deployed filename; defaults to the upload's name |
| `restart` | no | restart the instance after a successful deploy (default false) |
| `sudo_password` | no | only if the move into place, or the restart, needs it |

Response `WarDeployResult`: `ok`, `message`, `target_path`, `backup_path`, `bytes_written`, `restarted`,
`needs_sudo_password`.

### Before you deploy

1. **Load / Refresh the Tomcat tab.** The target directory is resolved from the **discovered
   instance's** `catalina_base`, never from your request, so a stale or absent snapshot means the wrong
   instance or a 404. An unknown `instance` is a 404.
2. **Check the prerequisites block.** A `java` status of `unsupported` will not stop the upload — it
   will stop the application starting.
3. **Check `webapps[]` for your filename.** If it is already there, this is a replacement. The UI asks
   you to confirm and tells you it will be backed up.
4. **Know the context path you are creating.** Tomcat derives it from the filename:
   `myapp.war` → `/myapp`, `myapp##002.war` → `/myapp` (parallel deployment),
   `ROOT.war` → `/`. Deploying `ROOT.war` replaces the root application. There is no "are you sure"
   for that beyond the existing-file confirmation.
5. **Have a rollback plan.** Usually that is the `.bak` file this deploy is about to create — but only
   if there is an existing WAR to back up. A **first** deployment has nothing to roll back to.

### What happens, in order

1. The upload is validated **before anything touches the remote host**:
   - The filename must end `.war` and be a **bare basename**. Anything containing `/`, `\` or `..` is
     rejected. The target directory always comes from the discovered `catalina_base`, so a crafted
     filename cannot redirect the write.
   - A body over `MAX_WAR_MB` (default **512 MB**) is rejected with **413**, and the read is capped
     rather than buffering an unbounded upload.
   - The bytes must start with the ZIP magic `PK\x03\x04`. A WAR is a ZIP; something that is not one
     never gets uploaded.
2. The file is uploaded over **SFTP** — not shelled out through the command line, because a WAR can be
   hundreds of megabytes — to a temp path the SSH user can definitely write (`/tmp/<random>.war`).
3. The uploaded size is verified against the bytes sent, and the ZIP magic is re-checked **on the remote
   file**. A truncated transfer fails here, before anything is replaced.
4. **Any existing target file is renamed to `<target>.bak-<timestamp>`.** For example
   `/opt/tomcat/webapps/myapp.war` → `/opt/tomcat/webapps/myapp.war.bak-20260811-142530`.
5. The temp file is moved into place, preserving the ownership and mode of the file it replaced where
   possible. This matters: a WAR left as `root:root` in a Tomcat-owned webapps directory **will not
   deploy**, and Tomcat will not tell you why in an obvious way.
6. The temp file is removed — **always, including on failure.** A failed deploy does not leave a
   half-uploaded WAR in `/tmp`.
7. If `restart` was set, the existing Tomcat restart action runs, and `restarted` reflects whether it
   did.

`target_path`, `backup_path` (empty string when there was nothing to back up) and `bytes_written` come
back in the response. **Record `backup_path`** — it is your rollback.

### When sudo is required, and why

Deploying does **not** always need sudo. It needs it when the SSH user cannot write the webapps
directory.

That is the common case, and it is not a misconfiguration: `<catalina_base>/webapps` is normally owned
by the **Tomcat service user** (`tomcat`, `tomcat9`, or similar), while you connect as an ordinary
operations account. The SSH user can read the directory and list webapps but cannot create a file in it.

So the sequence is: upload to `/tmp` always succeeds as the SSH user, and only the **move into place**
escalates. The existing sudo-password flow handles it — the same one used for service and Tomcat
restarts:

1. SSH user is root, or has passwordless sudo, or owns the webapps directory → the deploy just runs.
2. A password is needed and none was sent → the response is **HTTP 200** with
   `needs_sudo_password: true`. That is a prompt, not an error. The UI shows its inline sudo prompt;
   enter the password and retry.
3. Wrong password → `Sudo authentication failed`, and you can retry.

**The deploy-succeeded-but-restart-needs-sudo case is handled specially, and it matters.** If the upload
and the move worked but the restart needs a password you did not supply, the response is:

```json
{"ok": true, "restarted": false, "needs_sudo_password": true, ...}
```

`ok: true` with `restarted: false`. The WAR is **already in place** — retry only the **restart**
(`POST .../tomcat/action`). Do **not** re-upload. Re-uploading works, but it creates a second `.bak`
file, and the second backup is a copy of the WAR you just deployed, not of the original. Two rounds of
that and your `.bak` chain no longer contains the version you wanted to roll back to.

The sudo password is used for that one command and discarded: never stored, never logged, never echoed
back in a response, and never placed on a command line where `ps` could show it. It goes to the host
over SSH stdin. You will be asked again next time.

### The size cap

`MAX_WAR_MB` defaults to **512** (MB). Over it → **413**, and the request body is not buffered without
limit. Raise it in `.env` if you genuinely ship a larger artifact, and remember the upload crosses two
hops — browser to app, then app to host over SFTP — so a large WAR on a slow link takes a while. The UI
shows a busy state for the duration; leave the tab alone rather than retrying.

The same variable also caps **SFTP uploads** from the shell workspace's file pane, so raising it for a big
WAR raises that too. Downloads use a separate `MAX_DOWNLOAD_MB` (default 200).

## Rolling back

Rollback is a rename. There is no rollback endpoint — do it over SSH.

You need `backup_path` from the deploy response (or list the directory and pick the timestamp you
want):

```bash
ssh ems@app-01
ls -la /opt/tomcat/webapps/*.bak-*
```

Then, as a user that can write the webapps directory (usually with `sudo`, for the reason above):

```bash
sudo systemctl stop tomcat

# remove the WAR you are rolling back FROM, and its unpacked directory
sudo rm /opt/tomcat/webapps/myapp.war
sudo rm -rf /opt/tomcat/webapps/myapp

# put the backup back under its original name
sudo mv /opt/tomcat/webapps/myapp.war.bak-20260811-142530 /opt/tomcat/webapps/myapp.war
sudo chown tomcat:tomcat /opt/tomcat/webapps/myapp.war

sudo systemctl start tomcat
```

Then tail `primary_log_file` from the Tomcat tab to confirm it came up.

Four things to get right:

- **Remove the unpacked directory too.** Tomcat will not necessarily re-expand a WAR when a directory
  of the same name already exists, so leaving `myapp/` in place can leave the *new* code running after
  you restored the *old* WAR — a rollback that appears to do nothing.
- **Restore the original name**, without the `.bak-<timestamp>` suffix. Tomcat derives the context path
  from the filename.
- **Fix ownership** if you moved the file as root. Same failure mode as step 5 of a deploy.
- **Stop Tomcat first** if you can. Swapping a WAR under a running Tomcat with autoDeploy on produces
  an undeploy/redeploy race and, at best, a confusing log.

`.bak-<timestamp>` files are **never cleaned up automatically.** They accumulate in `webapps/`, one per
replacement deploy, each the full size of a WAR. Prune them on a schedule — but keep at least the most
recent one, since it is the only rollback point you have.

Note that a `.bak-*` file sitting in `webapps/` is inert: Tomcat only auto-deploys `*.war`, so the
suffix keeps it from being picked up.

## Troubleshooting a deploy

| Symptom | Cause |
| --- | --- |
| **404**, unknown instance | The `instance` name is not in the persisted snapshot. Load / Refresh the Tomcat tab first. |
| **400**, filename rejected | Not ending `.war`, or containing `/`, `\` or `..`. Send a bare basename. |
| **400**, not a ZIP | The bytes do not start with `PK\x03\x04`. Usually a corrupt or truncated build artifact, or an HTML error page saved with a `.war` name. |
| **413** | Over `MAX_WAR_MB` (default 512). |
| **403** `"Admin role required"` | Deployment is admin-only. Developer and support cannot deploy. |
| **403** `"Server is not assigned to this user"` | Per-server ACL. |
| **200** with `needs_sudo_password: true`, `ok: false` | Prompt-and-retry. The webapps directory is not writable by the SSH user. |
| **200** with `ok: true`, `restarted: false`, `needs_sudo_password: true` | Deployed. Retry the **restart** only. Never re-upload. |
| Deployed, but the app never starts | Check the `java` prerequisite first, then `catalina.out`. This is where an `unsupported` Java surfaces. |
| Deployed, but the old version still serves | The stale unpacked directory. Stop Tomcat, remove `<name>/`, restart. |
| Deployed, nothing happens at all, no log entry | Ownership. A `root:root` WAR in a Tomcat-owned webapps directory is silently ignored. Check `ls -la` and `chown` to the Tomcat user. |

## Limits worth knowing

- **No deployment history.** The `.bak-<timestamp>` files on the host are the only record of what was
  deployed and when. **Deployments are not audited**: nothing records who deployed what. The `audit_logs`
  table does now get written to, but only by the interactive shell — no WAR deployment, and no Tomcat
  start/stop/restart, produces a row ([Security.md](Security.md#what-does-not-exist)).
- **No Manager-app deployment.** This writes to the filesystem and lets Tomcat's autoDeploy pick the
  WAR up (or restarts it). Tomcat's Manager application is not used and does not need to be installed.
- **No pre-deploy validation of the WAR's contents.** The checks are: `.war` extension, bare basename,
  size cap, ZIP magic. Nothing inspects `web.xml`, checks the servlet spec version against the Tomcat
  version, or verifies the classes were compiled for a JVM the instance can load. A WAR built for Java
  17 deployed onto a Java 8 instance uploads perfectly and then fails at class load.
- **No parallel or staged rollout, and no health gate.** The deploy replaces the file. If `restart` is
  set, the instance restarts. Nothing waits for the application to become healthy, and nothing rolls
  back automatically on failure.
- **One instance at a time.** There is no fan-out across a fleet.
