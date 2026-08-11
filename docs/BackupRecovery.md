# Backup and Recovery

**Backup and restore differ by install profile**, because the database does:

| | **Lite** | **Full** |
| --- | --- | --- |
| Database | SQLite at `./data/inframonitor.db` on volume `inframonitor_data` | PostgreSQL 16-alpine on its own volume |
| Method | SQLite `VACUUM INTO` (hot, no downtime) | `pg_dump` |
| Shipped scripts | `scripts/backup.sh`, `scripts/restore.sh` | **none — the scripts refuse to run** |

`backup.sh` and `restore.sh` read `DATABASE_URL` and **exit with an error rather than guessing** when it
is not a SQLite URL: `DATABASE_URL is not a SQLite URL, refusing to guess: ...`. That is deliberate — a
backup tool that silently produces the wrong kind of file, or an empty one, is worse than one that
stops. In full mode, use `pg_dump` (see [Taking a backup — full mode](#taking-a-backup--full-mode-postgres)).

Everything in the next section applies to **both** profiles and is the part people get wrong.

## Read this first: a database backup without `.env` is useless

Every SSH password and private key in the database is encrypted with Fernet, and the Fernet key is
derived from **`JWT_SECRET`** in `.env` (`backend/app/core/crypto.py` SHA-256s the secret to build the
key). The key is not stored in the database and there is no escrow copy anywhere.

Two consequences, and they are the most important facts on this page:

1. **Restore the database with a different `JWT_SECRET` and every stored credential is lost.** The
   inventory, users, policies and discovery snapshots come back fine, but each encrypted credential
   fails to decrypt, and every operation that needs SSH — containers, logs, Tomcat, discovery,
   restart — fails on every server until an admin re-enters the credentials one host at a time.
2. **Rotating `JWT_SECRET` on a live system has the same effect, immediately and irreversibly.**
   There is no re-encryption path. The old ciphertext cannot be recovered without the old secret.
   If you must rotate, plan on re-entering credentials for the whole fleet afterwards, and keep the
   old secret until you have confirmed you no longer need it.

So: **back up `.env` together with the database, every time, and keep them together.** A backup that
contains only `data/inframonitor.db` is not a recoverable backup.

Because `.env` holds that key in plaintext, the backup archive is as sensitive as the credentials it
protects. Store it encrypted, restrict it to the operators who need it, and do not put it in git or
in a cloud-synced folder.

## What to back up

| Item | Where | Profile | Why |
| --- | --- | --- | --- |
| `data/inframonitor.db` | volume `inframonitor_data`, mounted at `/app/data` | lite | All inventory, users, policies, discovery snapshots, encrypted credentials |
| the `inframonitor` Postgres database | the `postgres` container / its volume | full | The same content |
| `.env` | repository root | **both** | `JWT_SECRET` — without it the credentials in the DB are unreadable |

Nothing else is stateful **for the application**. The image is rebuildable and the static UI is baked
into it.

In full mode, the monitoring volumes — Prometheus TSDB, Loki chunks, Grafana's own database — are
**observability data, not application state.** Losing them loses metric and log history and any
Grafana annotation or hand-created user, and loses nothing about your inventory or credentials. Back
them up if that history matters to you; the dashboards and datasources themselves come from
`monitoring/` in git and are recreated by provisioning ([Monitoring.md](Monitoring.md)). The alerts
buffer needs no backup because it is in-memory and already lost on every restart.

## Taking a backup — lite (SQLite)

```bash
bash scripts/backup.sh
```

The script produces a consistent copy of the SQLite database and captures `.env` alongside it.

Do **not** improvise this with `cp data/inframonitor.db backup.db`. The database runs in WAL mode, so a live
file copy can miss committed transactions still in the write-ahead log and can capture a torn state.
Use `VACUUM INTO`, or the SQLite backup API:

```bash
# consistent hot copy, no downtime
docker compose exec app python -c \
  "import sqlite3; sqlite3.connect('/app/data/inframonitor.db').execute(\"VACUUM INTO '/app/data/inframonitor-backup.db'\")"
docker compose cp app:/app/data/inframonitor-backup.db ./inframonitor-$(date +%Y%m%d-%H%M%S).db
docker compose exec app rm /app/data/inframonitor-backup.db
cp .env ./env-$(date +%Y%m%d-%H%M%S).bak
```

Stopping the container first (`docker compose stop app`) and copying the volume is also safe, if you
can take the downtime.

## Taking a backup — full mode (Postgres)

`scripts/backup.sh` will refuse here. Use `pg_dump` inside the Postgres container, and **capture `.env`
in the same operation** — the reason is unchanged and just as absolute in this profile.

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
C="docker compose -f docker-compose.yml -f docker-compose.full.yml"

# custom-format dump: compressed, and restorable with pg_restore
$C exec -T postgres pg_dump -U inframonitor -d inframonitor -Fc > ./inframonitor-$STAMP.dump
cp .env ./env-$STAMP.bak
```

Substitute the user and database name from your `.env` full-mode block if you changed them. `-Fc` is
worth preferring over a plain SQL dump: it is compressed and `pg_restore` can be pointed at it
selectively.

Keep the dump and the `.env` copy together, in one archive, as one unit. A `pg_dump` without the
matching `JWT_SECRET` restores your inventory and **none of your credentials**.

`pg_dump` is transactionally consistent and does not need downtime.

## Restoring — lite (SQLite)

```bash
bash scripts/restore.sh backups/inframonitor-YYYYMMDD-HHMMSS.db
```

`restore.sh` verifies that the source file is actually a SQLite database before doing anything, and
refuses to overwrite a live database without an explicit confirmation flag — a restore is
destructive and there is no undo.

Restore `.env` from the same backup set at the same time, or at minimum confirm that the `JWT_SECRET`
now in `.env` is byte-identical to the one that was in use when the database was backed up.

By hand:

```bash
docker compose stop app
# put the matching .env back in place first
docker compose cp ./inframonitor-YYYYMMDD-HHMMSS.db app:/app/data/inframonitor.db
docker compose start app
```

## Restoring — full mode (Postgres)

```bash
C="docker compose -f docker-compose.yml -f docker-compose.full.yml"

# put the matching .env back in place FIRST, then stop the app so nothing writes
$C stop app

# --clean --if-exists drops the existing objects before recreating them
$C exec -T postgres pg_restore -U inframonitor -d inframonitor --clean --if-exists < ./inframonitor-YYYYMMDD-HHMMSS.dump

$C start app
```

Stopping `app` first is not optional: the startup schema step and a concurrent `pg_restore --clean`
will fight over the same tables.

Do not restore into a database another `app` container is still writing to, and note there is **no
cross-profile restore** — a SQLite backup does not load into Postgres or the reverse. See
[Deployment.md](Deployment.md#switching-profiles).

## Verifying a restore

1. `curl -fsS http://localhost:8088/health` — expect `"database":"ok"`. A 503 means the file is
   missing or unreadable.
2. Log in. If login fails with credentials you know are correct, the database restored but is not
   the one you expected.
3. Open a server and run **Test Connection**. This is the check that actually proves `JWT_SECRET`
   matches: it decrypts a stored credential and uses it. If it fails while the host is reachable,
   your secret does not match the backup and the stored credentials are gone.
4. Confirm the server count on the dashboard matches what you expect.

Step 3 is the one people skip, and it is the only one that detects a mismatched secret.

Step 1's URL and step 3 are the same in both profiles. In full mode a `"database":"unavailable"` from
`/health` after a restore usually means `app` came up before Postgres finished starting, or that the
overlay was not applied and the app is looking at SQLite instead.

## Practical policy

- Run `backup.sh` on a schedule, and before every upgrade (`upgrade.sh` does it for you). In full mode,
  script the `pg_dump` block above yourself — nothing shipped here does it, and `upgrade.sh` is
  SQLite-only too, so it will not take a backup for you before rebuilding.
- Copy backups off-host. A volume backup that lives on the same disk as the volume is not a backup.
- Restore-test periodically into a throwaway environment, and include step 3 above — an untested
  backup of an encrypted database is a guess.
- Keep the number of distinct `JWT_SECRET` values in your history at one. Every rotation splits your
  backup archive into eras that are not interchangeable.
