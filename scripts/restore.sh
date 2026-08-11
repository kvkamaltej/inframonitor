#!/usr/bin/env bash
#
# Restores a backup produced by scripts/backup.sh, into whichever store this
# install uses.
#
#     scripts/restore.sh backups/inframonitor-20260811-120000.db    --confirm
#     scripts/restore.sh backups/inframonitor-20260811-120000.dump  --confirm --with-env
#
# The store is decided by the FILE, not by a flag: a "SQLite format 3" header
# means the lite path, a "PGDMP" header means the Postgres path. The detected
# mode is then cross-checked against it, so feeding a SQLite backup to a full
# install (or the reverse) stops with an explanation instead of doing something
# creative.
#
# Two defects from the original are fixed and must stay fixed:
#   * it piped a .sql dump into psql with no ON_ERROR_STOP and then printed
#     "Restore completed" unconditionally, so a restore in which every single
#     statement failed still looked like a success. The Postgres path below uses
#     pg_restore --exit-on-error --single-transaction: all of it or none of it.
#   * it did all of that without --confirm and without a safety copy.
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/mode.sh"

# Remembered before the cd, because the backup file is a path the operator typed
# and it is relative to where they typed it, not to the repo root.
invocation_dir="$PWD"
cd -- "$INFRAMONITOR_REPO_ROOT"

usage() {
  cat <<'EOF'
Usage: scripts/restore.sh <backup-file> --confirm [--with-env]

  <backup-file>  Either a .db (SQLite, lite) or a .dump (Postgres custom format,
                 full) written by scripts/backup.sh. Which one it is, is read
                 from the file's own header.
  --confirm      Required. This overwrites the live database; without the flag
                 nothing is written.
  --with-env     Also restore the .env saved next to the backup (same name, .env
                 extension). Needed whenever the current JWT_SECRET differs from
                 the one that was in use when the backup was taken -- otherwise
                 the SSH credentials inside the restored database cannot be
                 decrypted. Your current .env is copied aside first.

Environment:
  INFRAMONITOR_MODE=lite|full   Skip mode detection. Only needed when the stack is down
                        and a stale postgres volume makes the mode undecidable.
EOF
}

src=""
confirm=0
with_env=0
while (($#)); do
  case "$1" in
    --confirm)   confirm=1 ;;
    --with-env)  with_env=1 ;;
    -h|--help)   usage; exit 0 ;;
    -*)          echo "Unknown option: $1" >&2; echo >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "$src" ]]; then
        echo "Unexpected extra argument: $1" >&2; exit 2
      fi
      src="$1" ;;
  esac
  shift
done

[[ -n "$src" ]] || { usage >&2; exit 2; }

# Make it absolute against the directory the command was run from, so
# `cd /tmp && bash /path/to/scripts/restore.sh mybackup.db` finds mybackup.db
# where the operator is, not in the repo root this script cd'd to.
case "$src" in
  /* | [A-Za-z]:[/\\]* | ~/*) ;;
  *) src="${invocation_dir}/${src}" ;;
esac

[[ -f "$src" ]] || { echo "No such file: ${src}" >&2; exit 1; }

# ---------------------------------------------------------------------------
# What kind of backup is this?
# ---------------------------------------------------------------------------
src_kind=""
if [[ "$(head -c 15 -- "$src")" == "SQLite format 3" ]]; then
  src_kind="sqlite"
elif [[ "$(head -c 5 -- "$src")" == "PGDMP" ]]; then
  src_kind="postgres"
else
  {
    echo "Refusing to restore: ${src} is neither a SQLite database nor a pg_dump archive."
    echo "  Its first bytes match neither 'SQLite format 3' nor 'PGDMP'."
    echo "  A plain-text .sql dump from the pre-2026 stack is not restorable here;"
    echo "  neither is a tar or gzip wrapper -- unpack it first."
  } >&2
  exit 1
fi
echo "Source: ${src}"
echo "        header identifies it as a ${src_kind} backup"

# ---------------------------------------------------------------------------
# Does that match the install?
# ---------------------------------------------------------------------------
mode="$(inframonitor_require_mode)"
store="$(inframonitor_store_for_mode "$mode")"
echo "Target: ${mode} mode, ${store} store"

if [[ "$src_kind" != "$store" ]]; then
  {
    echo
    echo "Refusing to restore: this is a ${src_kind} backup and the install stores its"
    echo "data in ${store}."
    echo
    if [[ "$src_kind" == "sqlite" ]]; then
      echo "  You are holding a lite backup and pointing it at a full install. Restoring"
      echo "  it would leave a SQLite file in the volume that nothing reads, while"
      echo "  Postgres carried on serving the old data -- a restore that appears to"
      echo "  succeed and changes nothing."
      echo
      echo "  To run this install as lite again:   scripts/stack.sh lite up"
      echo "  then re-run this command."
    else
      echo "  You are holding a full backup and pointing it at a lite install. There is"
      echo "  no Postgres here to restore it into. Moving data from Postgres to SQLite"
      echo "  is a conversion, not a restore, and this script does not do it."
      echo
      echo "  To restore it, bring full mode up first:   scripts/stack.sh full up"
    fi
  } >&2
  exit 1
fi

if (( ! confirm )); then
  echo
  echo "Refusing to continue without --confirm." >&2
  echo "This would overwrite the live database. Re-run as:" >&2
  echo "  scripts/restore.sh ${src} --confirm" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# JWT_SECRET pairing
# ---------------------------------------------------------------------------
env_src="${src%.*}.env"
if (( with_env )) && [[ ! -f "$env_src" ]]; then
  echo "--with-env was given but no env file sits beside the backup: ${env_src}" >&2
  exit 1
fi

# Compare the keys without ever printing them.
current_jwt="$(inframonitor_read_env JWT_SECRET)"
backup_jwt="$(inframonitor_read_env JWT_SECRET "$env_src")"
if [[ -n "$current_jwt" && -n "$backup_jwt" ]]; then
  if [[ "$current_jwt" == "$backup_jwt" ]]; then
    echo "JWT_SECRET in .env matches the one saved with this backup."
  else
    echo
    echo "WARNING: JWT_SECRET in your current .env differs from the one saved with" >&2
    echo "         this backup. JWT_SECRET is the key for the encrypted SSH" >&2
    echo "         credentials inside the database you are about to restore." >&2
    if (( with_env )); then
      echo "         --with-env was given, so the backup's .env will be restored too." >&2
    else
      echo "         Without --with-env those credentials will be undecryptable and" >&2
      echo "         every server's credentials will have to be re-entered by hand." >&2
      echo "         Re-run with --with-env unless you know you want that." >&2
      exit 1
    fi
  fi
elif [[ -z "$backup_jwt" ]]; then
  echo "Note: no JWT_SECRET found alongside this backup; cannot verify key pairing."
fi

# For Postgres there is a second pairing that matters, and it is not obvious.
if [[ "$store" == "postgres" && -f "$env_src" ]]; then
  current_pw="$(inframonitor_read_env POSTGRES_PASSWORD)"
  backup_pw="$(inframonitor_read_env POSTGRES_PASSWORD "$env_src")"
  if [[ -n "$current_pw" && -n "$backup_pw" && "$current_pw" != "$backup_pw" ]]; then
    echo
    echo "Note: POSTGRES_PASSWORD differs between .env and the backup's .env." >&2
    echo "      That is harmless for this restore -- the dump goes into the postgres" >&2
    echo "      volume that is already running with your current password. But if you" >&2
    echo "      use --with-env, the .env that lands will carry the OLD password while" >&2
    echo "      the volume still has the current one, and the app will stop being able" >&2
    echo "      to log in. Postgres only reads POSTGRES_PASSWORD at initdb time." >&2
  fi
fi

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------
# Probe each candidate rather than trusting `command -v`: on Windows the PATH
# contains a Microsoft Store stub called python3 that exists and is executable
# but only prints an ad for the Store, which made callers fail confusingly.
host_python() {
  local candidate
  for candidate in python3 python py; do
    if command -v "$candidate" >/dev/null 2>&1 \
       && "$candidate" -c 'import sys; sys.exit(0)' >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# Ask Compose which container backs the service instead of hardcoding the name
# "inframonitor". The hardcoded form silently reported the container's health as
# "unknown" -- and so exited non-zero on a completely successful run -- whenever
# the name differed, which happens with COMPOSE_PROJECT_NAME set, with a second
# instance, or if container_name is ever changed.
wait_healthy() {  # wait_healthy [tries]
  local tries="${1:-60}" cid status=""
  for _ in $(seq 1 "$tries"); do
    cid="$(inframonitor_dc "$mode" ps -q app 2>/dev/null | head -n 1 || true)"
    if [[ -n "$cid" ]]; then
      status="$(docker inspect \
        -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$cid" 2>/dev/null || true)"
      [[ "$status" == "healthy" || "$status" == "unhealthy" ]] && break
    fi
    sleep 2
  done
  printf '%s' "${status:-unknown}"
}

container_mode=0
if inframonitor_docker_ok; then
  if inframonitor_dc "$mode" config --services 2>/dev/null | grep -qx app; then
    container_mode=1
  fi
fi

# ---------------------------------------------------------------------------
# Safety copy of what we are about to replace
# ---------------------------------------------------------------------------
echo
echo "Taking a safety backup of the current database before overwriting it."
if INFRAMONITOR_MODE="$mode" bash scripts/backup.sh pre-restore; then
  echo "Safety backup taken."
else
  echo
  echo "WARNING: could not back up the current database (it may not exist yet)." >&2
  echo "         Continuing, because --confirm was given." >&2
fi

# ===========================================================================
# SQLite (lite)
# ===========================================================================
restore_sqlite() {
  # Verify, stage and swap. argv[1] is the incoming file; the live path comes
  # from DATABASE_URL; CHOWN_TO is "user:group" when we are root and can set it.
  local swap_py
  read -r -d '' swap_py <<'PY' || true
import os, shutil, sqlite3, sys

incoming = sys.argv[1]
url = os.environ.get("DATABASE_URL") or "sqlite:///./data/inframonitor.db"
if not url.startswith("sqlite"):
    sys.exit(f"DATABASE_URL is not a SQLite URL, refusing to guess: {url}")
target = url.split("///", 1)[1] if "///" in url else url.split("//", 1)[-1]
target = os.path.abspath(target)

con = sqlite3.connect(f"file:{incoming}?mode=ro", uri=True)
try:
    # A badly damaged file makes integrity_check itself raise rather than return
    # a description of the damage. Catch that instead of letting a traceback out:
    # the exit code was already correct, but the operator needs to see a reason,
    # not a stack.
    try:
        check = con.execute("PRAGMA integrity_check").fetchone()[0]
    except sqlite3.DatabaseError as exc:
        sys.exit(f"refusing to restore: {incoming} is damaged beyond checking ({exc})")
    if check != "ok":
        sys.exit(f"refusing to restore: integrity_check on the backup failed: {check}")
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
finally:
    con.close()

missing = {"users", "servers"} - tables
if missing:
    sys.exit("refusing to restore: this does not look like an Infra Monitor database, "
             "missing table(s): " + ", ".join(sorted(missing)))
print(f"integrity_check ok, {len(tables)} tables present")

os.makedirs(os.path.dirname(target), exist_ok=True)

# Stage inside the target directory so the final step is an atomic rename on the
# same filesystem, and so a failure here leaves the live database untouched.
staged = target + ".restore-staged"
shutil.copyfile(incoming, staged)

# The -wal and -shm files belong to the database being replaced. Left in place,
# SQLite would try to recover the *old* database's pages into the restored file.
for suffix in ("-wal", "-shm"):
    stale = target + suffix
    if os.path.exists(stale):
        os.remove(stale)
        print(f"removed stale {os.path.basename(stale)}")

os.replace(staged, target)

owner = os.environ.get("CHOWN_TO", "")
if owner:
    user, _, group = owner.partition(":")
    try:
        shutil.chown(target, user=user, group=group or user)
        shutil.chown(os.path.dirname(target), user=user, group=group or user)
        print(f"ownership set to {owner}")
    except (LookupError, PermissionError, OSError) as exc:
        print(f"warning: could not chown {target} to {owner}: {exc}", file=sys.stderr)
os.chmod(target, 0o640)
print(f"restored -> {target}")
PY

  if (( container_mode )); then
    echo
    echo "Stopping the app so nothing writes to the database mid-restore."
    inframonitor_dc "$mode" stop app >/dev/null 2>&1 || true

    local incoming_in_volume="/app/data/.restore-incoming.db"
    # Root, because files written into the volume from outside land owned by root
    # while the runtime user (uid 10001) has to own the result. --no-deps and no
    # --service-ports, so this one-off container cannot fight the real one for
    # the published port; an explicit --name because the service sets
    # container_name: inframonitor and a one-off must not collide with it.
    #
    # MSYS_NO_PATHCONV / MSYS2_ARG_CONV_EXCL are set on this command only, not
    # exported globally. Under Git Bash, MSYS rewrites arguments that look like
    # Unix absolute paths into Windows paths before the program sees them, so
    # /app/data/x.db arrived as "C:/Program Files/Git/app/data/x.db" and every
    # container-side file operation failed. It must not be suppressed globally,
    # because the host-side python fallback further down is given *host* paths
    # and on Windows those do need converting. Both are no-ops on Linux.
    maint() {
      MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
        inframonitor_dc "$mode" run --rm -T --no-deps --user 0 \
          --name "inframonitor-restore-$$-${RANDOM}" "$@"
    }

    maint --entrypoint sh app -c "cat > ${incoming_in_volume}" < "$src"

    printf '%s' "$swap_py" | maint --env CHOWN_TO=inframonitor:inframonitor \
      --entrypoint python app - "$incoming_in_volume"

    maint --entrypoint rm app -f "$incoming_in_volume"
  else
    echo
    echo "No docker app service found; restoring into the local checkout."
    local py
    py="$(host_python)" || { echo "FAIL  need python3 on PATH to restore locally." >&2; exit 1; }
    if [[ -z "${DATABASE_URL:-}" ]]; then
      DATABASE_URL="$(inframonitor_read_env DATABASE_URL)"
    fi
    DATABASE_URL="${DATABASE_URL:-sqlite:///./data/inframonitor.db}" \
      "$py" - "$src" <<<"$swap_py"
  fi
}

# ===========================================================================
# Postgres (full)
# ===========================================================================
restore_postgres() {
  local pg_running
  pg_running="$(inframonitor_service_containers postgres --running)"
  if [[ -z "$pg_running" ]]; then
    {
      echo "FAIL  no running postgres container for project '$(inframonitor_project_name)'."
      echo "      pg_restore needs the server up. Start it first:"
      echo "        scripts/stack.sh full up"
    } >&2
    exit 1
  fi

  local remote_tmp="/tmp/inframonitor-restore-$$.dump"

  # PGPASSWORD comes from the container's own environment, so it never appears on
  # this host's command line or in its process list.
  pg_sh() {  # pg_sh <shell-snippet>
    MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
      inframonitor_dc full exec -T postgres sh -c "$1"
  }
  cleanup_remote() {
    pg_sh "rm -f ${remote_tmp}" >/dev/null 2>&1 || true
  }
  trap cleanup_remote EXIT

  echo
  echo "Copying the dump into the postgres container."
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
    inframonitor_dc full exec -T postgres sh -c "cat > ${remote_tmp}" < "$src"

  # Verify before touching anything, the same way the SQLite path does.
  echo "Checking the archive."
  local toc
  toc="$(pg_sh "pg_restore --list ${remote_tmp}")" || {
    echo "FAIL  pg_restore cannot read this archive; refusing to restore." >&2
    exit 1
  }
  local missing=""
  grep -qiE 'TABLE .*[[:space:]]users([[:space:]]|$)' <<<"$toc" || missing="${missing}users "
  grep -qiE 'TABLE .*[[:space:]]servers([[:space:]]|$)' <<<"$toc" || missing="${missing}servers "
  if [[ -n "$missing" ]]; then
    echo "FAIL  refusing to restore: this does not look like an Infra Monitor dump, no ${missing% } table." >&2
    exit 1
  fi
  printf 'Archive readable, %s entries, users and servers present.\n' "$(grep -c ';' <<<"$toc" || true)"

  # The app must not be writing while the schema is dropped and recreated.
  if (( container_mode )); then
    echo
    echo "Stopping the app so nothing writes to the database mid-restore."
    inframonitor_dc "$mode" stop app >/dev/null 2>&1 || true
  fi

  echo
  echo "Restoring with pg_restore."
  # --single-transaction --exit-on-error is the whole point: either every object
  # is restored or the transaction rolls back and the database is left exactly as
  # it was. The original script piped SQL into psql without ON_ERROR_STOP, so a
  # restore in which everything failed still reported success.
  # --clean --if-exists drops the existing objects first; --if-exists keeps the
  # drops from erroring on objects that are not there, which under
  # --single-transaction would abort the whole restore.
  # --no-owner --no-privileges: role names in the dump need not exist here.
  if ! pg_sh "set -e
    export PGPASSWORD=\"\$POSTGRES_PASSWORD\"
    pg_restore --clean --if-exists --no-owner --no-privileges \
      --single-transaction --exit-on-error \
      -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" ${remote_tmp}"; then
    {
      echo
      echo "FAIL  pg_restore reported an error, so the transaction rolled back and the"
      echo "      database is unchanged. Nothing was half-restored."
      echo "      The safety backup taken at the start of this run is in backups/,"
      echo "      named inframonitor-*-pre-restore.dump."
    } >&2
    exit 1
  fi
  echo "pg_restore completed inside a single transaction."
}

case "$store" in
  postgres) restore_postgres ;;
  *)        restore_sqlite ;;
esac

# ---------------------------------------------------------------------------
# .env
# ---------------------------------------------------------------------------
if (( with_env )); then
  if [[ -f .env ]]; then
    aside=".env.replaced-$(date +%Y%m%d-%H%M%S)"
    cp -p -- .env "$aside"
    chmod 600 -- "$aside"
    echo "Current .env copied aside to ${aside}"
  fi
  cp -- "$env_src" .env
  chmod 600 -- .env
  echo "Restored .env from ${env_src}"
fi

# ---------------------------------------------------------------------------
# Bring the app back up
# ---------------------------------------------------------------------------
if (( container_mode )); then
  echo
  echo "Starting the app again."
  inframonitor_dc "$mode" up -d
  echo "Waiting for the health check..."
  status="$(wait_healthy 30)"
  if [[ "$status" == "healthy" ]]; then
    echo "Restore complete and the container reports healthy."
  elif [[ "$status" == "none" ]]; then
    echo "Restore complete. The container is running but declares no healthcheck."
  else
    echo "Restore finished, but the container is '${status}'." >&2
    echo "Logs:" >&2
    inframonitor_dc "$mode" logs --tail 30 app >&2 || true
    exit 1
  fi
else
  echo "Restore complete."
fi

if (( ! with_env )); then
  echo
  echo "Reminder: .env was not restored. If the SSH credentials in this database"
  echo "were encrypted under a different JWT_SECRET, they cannot be decrypted now."
fi
