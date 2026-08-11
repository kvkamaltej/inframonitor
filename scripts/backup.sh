#!/usr/bin/env bash
#
# Backs up whichever datastore this install actually uses, plus the .env that
# holds the key to its contents.
#
#     scripts/backup.sh [label]
#     BACKUP_DIR=/mnt/backups scripts/backup.sh
#     INFRAMONITOR_MODE=full scripts/backup.sh      # when detection cannot tell
#
# LITE  -> SQLite, copied with `VACUUM INTO` (falling back to the online backup
#          API), which produces a fully checkpointed, internally consistent
#          standalone file while the app keeps serving. A plain `cp` of a live
#          WAL database is NOT a backup: committed transactions still sitting in
#          inframonitor.db-wal would be missing from the copy, and the result can be
#          torn mid-write. Written as inframonitor-<stamp>.db.
#
# FULL  -> Postgres, dumped with `pg_dump -Fc` inside the postgres container.
#          Custom format, so pg_restore can validate the archive and restore it
#          transactionally. Written as inframonitor-<stamp>.dump.
#
# The extension is the marker: restore.sh dispatches on the file's magic bytes,
# so a SQLite backup can never be fed to Postgres or the other way round.
#
# It refuses to guess which store to read. Backing up an abandoned SQLite file
# and labelling it a backup of a Postgres install is the failure this is written
# to prevent, so an undecidable situation exits 1 with instructions instead.
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/mode.sh"
cd -- "$INFRAMONITOR_REPO_ROOT"

# ---------------------------------------------------------------------------
# Which store?
# ---------------------------------------------------------------------------
mode="$(inframonitor_require_mode)"
store="$(inframonitor_store_for_mode "$mode")"

if inframonitor_docker_ok; then
  pg_any="$(inframonitor_service_containers postgres)"
  pg_running="$(inframonitor_service_containers postgres --running)"
else
  pg_any=""
  pg_running=""
fi

if [[ "$store" == "postgres" ]]; then
  if [[ -z "$pg_running" ]]; then
    {
      echo "FAIL  full mode, but no running postgres container for project '$(inframonitor_project_name)'."
      if [[ -n "$pg_any" ]]; then
        echo "      A postgres container exists but is stopped. pg_dump needs it up:"
        echo "        scripts/stack.sh full up"
      else
        echo "      There is no postgres container at all. Either the stack is down:"
        echo "        scripts/stack.sh full up"
        echo "      or this install is really lite, in which case say so:"
        echo "        INFRAMONITOR_MODE=lite scripts/backup.sh"
      fi
      echo
      echo "      Refusing to fall back to the SQLite file. In full mode that file is"
      echo "      at best months stale, and a backup of it would look completely"
      echo "      normal right up to the moment you needed it."
    } >&2
    exit 1
  fi
elif [[ -n "$pg_any" ]]; then
  # Only reachable when the operator forced INFRAMONITOR_MODE=lite: detection would have
  # answered "full" on its own if a postgres container existed.
  {
    echo "FAIL  INFRAMONITOR_MODE=lite was given, but this project has a postgres container."
    echo "      That is a contradiction, and resolving it the wrong way means backing"
    echo "      up an idle SQLite file instead of the live database."
    echo "      If the install really is full:   INFRAMONITOR_MODE=full scripts/backup.sh"
    echo "      If postgres is a leftover:       scripts/stack.sh full down"
  } >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Destination
# ---------------------------------------------------------------------------
backup_dir="${BACKUP_DIR:-${INFRAMONITOR_REPO_ROOT}/backups}"
label="${1:-}"
label="${label//[^A-Za-z0-9._-]/_}"
stamp="$(date +%Y%m%d-%H%M%S)"
[[ -n "$label" ]] && stamp="${stamp}-${label}"

name="inframonitor-${stamp}"
env_out="${backup_dir}/${name}.env"
if [[ "$store" == "postgres" ]]; then
  data_out="${backup_dir}/${name}.dump"
else
  data_out="${backup_dir}/${name}.db"
fi

mkdir -p -- "$backup_dir"

echo "Mode  : ${mode}"
echo "Store : ${store}"
echo "Output: ${data_out}"
echo

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

# ===========================================================================
# SQLite (lite)
# ===========================================================================
backup_sqlite() {
  # The vacuum program, run either inside the container or on the host. argv[1]
  # is the destination path; the source comes from DATABASE_URL.
  local vacuum_py
  read -r -d '' vacuum_py <<'PY' || true
import os, sqlite3, sys

dest = sys.argv[1]
url = os.environ.get("DATABASE_URL") or "sqlite:///./data/inframonitor.db"
if not url.startswith("sqlite"):
    sys.exit(f"DATABASE_URL is not a SQLite URL, refusing to guess: {url}")
src = url.split("///", 1)[1] if "///" in url else url.split("//", 1)[-1]
src = os.path.abspath(src)
if not os.path.exists(src):
    sys.exit(f"database file does not exist: {src}")

con = sqlite3.connect(src)
try:
    try:
        # Compacts as it copies. Takes a read lock only.
        con.execute("VACUUM INTO ?", (dest,))
    except sqlite3.Error as exc:
        # Older SQLite builds reject a bound parameter here; the online backup
        # API is equally consistent, just without the compaction.
        print(f"VACUUM INTO unavailable ({exc}); using the online backup API", file=sys.stderr)
        failure = None
        dst = sqlite3.connect(dest)
        try:
            con.backup(dst)
        except sqlite3.DatabaseError as exc2:
            failure = exc2
        finally:
            dst.close()
        if failure is not None:
            # Both routes failing means the *source* is damaged, not that the
            # method was unsupported. Fail with that reason rather than a
            # traceback, and do not leave a half-written file lying around
            # looking like a backup somebody might later trust.
            if os.path.exists(dest):
                os.remove(dest)
            sys.exit(f"could not read the live database at {src}: {failure}")
finally:
    con.close()
print(f"{src} -> {dest}", file=sys.stderr)
PY

  local container_state="absent" cid
  if inframonitor_docker_ok; then
    cid="$(inframonitor_service_containers app | head -n 1)"
    if [[ -n "$cid" ]]; then
      if [[ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo false)" == "true" ]]; then
        container_state="running"
      else
        container_state="stopped"
      fi
    elif inframonitor_dc "$mode" config --services 2>/dev/null | grep -qx app; then
      container_state="stopped"
    fi
  fi

  # Runs a command in the app container whether or not the stack is up. A one-off
  # `run` container still mounts inframonitor_data, and without --service-ports it does
  # not publish anything, so it cannot fight the real container for the host
  # port. An explicit --name is passed because the service declares
  # container_name: inframonitor, and a one-off container must not collide with it.
  # MSYS_NO_PATHCONV / MSYS2_ARG_CONV_EXCL are set on these commands only, not
  # exported globally. Under Git Bash, MSYS rewrites arguments that look like
  # Unix absolute paths into Windows paths before the program sees them, so the
  # container path /app/data/x.db arrived as
  # "C:/Program Files/Git/app/data/x.db" and every container-side file operation
  # failed. Suppressing it globally is wrong, though: the host-side python calls
  # below are given *host* paths, and on Windows those do need the conversion.
  # So scope it to the docker calls, which are the only ones carrying container
  # paths. Both variables are no-ops on Linux and macOS.
  app_run() {
    if [[ "$container_state" == "running" ]]; then
      MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' inframonitor_dc "$mode" exec -T app "$@"
    else
      MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
        inframonitor_dc "$mode" run --rm -T --no-deps --name "inframonitor-maint-$$-${RANDOM}" \
          --entrypoint "$1" app "${@:2}"
    fi
  }

  local tmp_in_volume="/app/data/.backup-${stamp}.db"

  if [[ "$container_state" != "absent" ]]; then
    echo "Backing up from the container (state: ${container_state})."
    # Vacuum into the volume first, then stream the finished file out. -T keeps
    # the stream raw, so the binary arrives intact.
    printf '%s' "$vacuum_py" | app_run python - "$tmp_in_volume"
    app_run cat "$tmp_in_volume" > "$data_out"
    app_run rm -f "$tmp_in_volume"
  else
    echo "No docker app service found; backing up the local checkout's database."
    local py
    py="$(host_python)" || { echo "FAIL  need python3 on PATH for a local backup." >&2; exit 1; }
    if [[ -z "${DATABASE_URL:-}" ]]; then
      DATABASE_URL="$(inframonitor_read_env DATABASE_URL)"
    fi
    DATABASE_URL="${DATABASE_URL:-sqlite:///./data/inframonitor.db}" \
      "$py" - "$data_out" <<<"$vacuum_py"
  fi

  if [[ ! -s "$data_out" ]]; then
    echo "FAIL  the backup file is empty or missing: ${data_out}" >&2
    rm -f -- "$data_out"
    exit 1
  fi

  # Verify what actually landed on disk, so a truncated stream is caught here and
  # not at restore time, months later.
  if [[ "$(head -c 15 -- "$data_out")" != "SQLite format 3" ]]; then
    echo "FAIL  ${data_out} is not a SQLite database; the copy did not work." >&2
    exit 1
  fi
  local py
  if py="$(host_python)"; then
    "$py" - "$data_out" <<'PY'
import sqlite3, sys
path = sys.argv[1]
con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
try:
    result = con.execute("PRAGMA integrity_check").fetchone()[0]
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
finally:
    con.close()
if result != "ok":
    sys.exit(f"integrity_check on the backup failed: {result}")
missing = {"users", "servers"} - tables
if missing:
    print("WARN  the backup has no " + ", ".join(sorted(missing)) + " table -- it "
          "looks like an empty database.", file=sys.stderr)
PY
    echo "Verified: SQLite header and PRAGMA integrity_check both pass."
  else
    echo "Note: python3 not on PATH, skipped the local integrity_check."
  fi
}

# ===========================================================================
# Postgres (full)
# ===========================================================================
backup_postgres() {
  # /tmp inside the postgres container, not a mounted volume: the dump is
  # streamed out immediately and the temp file is removed either way.
  local remote_tmp="/tmp/inframonitor-backup-${stamp}.dump"

  # PGPASSWORD is taken from the container's OWN environment. It is never put on
  # our command line, so it cannot appear in this host's process list, and it is
  # never read out of .env by this script at all.
  pg_sh() {  # pg_sh <shell-snippet>
    MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
      inframonitor_dc full exec -T postgres sh -c "$1"
  }

  # Always clean up the temp file, including on failure.
  cleanup_remote() {
    pg_sh "rm -f ${remote_tmp}" >/dev/null 2>&1 || true
  }
  trap cleanup_remote EXIT

  echo "Dumping Postgres with pg_dump -Fc inside the postgres container."
  # -Fc: custom format. Compressed, restorable selectively, and verifiable with
  #      pg_restore --list, which is the closest equivalent to SQLite's
  #      integrity_check available for a dump.
  # --no-owner / --no-privileges: the restore target's role names need not match
  #      the source's, which is what makes a dump restorable into a fresh volume
  #      with a rotated POSTGRES_USER.
  pg_sh "set -e
    export PGPASSWORD=\"\$POSTGRES_PASSWORD\"
    pg_dump -Fc --no-owner --no-privileges \
      -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -f ${remote_tmp}"

  echo "Verifying the archive with pg_restore --list."
  local toc
  toc="$(pg_sh "pg_restore --list ${remote_tmp}")" || {
    echo "FAIL  pg_restore could not read the dump it just produced." >&2
    exit 1
  }

  # -T keeps the stream raw, so the binary arrives intact.
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
    inframonitor_dc full exec -T postgres cat "${remote_tmp}" > "$data_out"

  if [[ ! -s "$data_out" ]]; then
    echo "FAIL  the backup file is empty or missing: ${data_out}" >&2
    rm -f -- "$data_out"
    exit 1
  fi

  # Custom-format dumps begin with the literal "PGDMP". Checking it here catches
  # a truncated `cat` now instead of at restore time.
  if [[ "$(head -c 5 -- "$data_out")" != "PGDMP" ]]; then
    echo "FAIL  ${data_out} does not start with the PGDMP magic; the copy did not work." >&2
    exit 1
  fi

  local missing=""
  grep -qiE 'TABLE .*[[:space:]]users([[:space:]]|$)' <<<"$toc" || missing="${missing}users "
  grep -qiE 'TABLE .*[[:space:]]servers([[:space:]]|$)' <<<"$toc" || missing="${missing}servers "
  if [[ -n "$missing" ]]; then
    echo "WARN  the dump contains no ${missing% } table -- it looks like an empty database." >&2
  fi
  echo "Verified: PGDMP header present and pg_restore can read the table of contents."
}

case "$store" in
  postgres) backup_postgres ;;
  *)        backup_sqlite ;;
esac

chmod 600 -- "$data_out"

env_saved=0
if [[ -f .env ]]; then
  cp -p -- .env "$env_out"
  chmod 600 -- "$env_out"
  env_saved=1
fi

size="$(du -h -- "$data_out" | cut -f1)"

echo
echo "Backup complete."
printf '  %-8s : %s (%s)\n' "$store" "$data_out" "$size"
if (( env_saved )); then
  printf '  %-8s : %s\n' "env" "$env_out"
else
  printf '  %-8s : NOT SAVED -- no .env in %s\n' "env" "$INFRAMONITOR_REPO_ROOT"
fi
echo
cat <<'EOF'
Keep BOTH files together, and treat them as equally sensitive.

The database alone is not a restorable backup. Every SSH credential stored in it
is encrypted with a key derived from JWT_SECRET, which lives only in .env.
Restore the database against a different JWT_SECRET and those credentials are
permanently undecryptable -- every server has to have its credentials re-entered
by hand. The .env copy is also why these files are mode 600: it contains the
secret in plain text.
EOF

if [[ "$store" == "postgres" ]]; then
  cat <<'EOF'

For a full install the saved .env matters twice over: besides JWT_SECRET it holds
POSTGRES_PASSWORD, and Postgres only reads that at initdb time. Restoring this
dump into a fresh postgres_data volume with a different password in .env gives
you a database the app cannot log in to.
EOF
fi

if (( ! env_saved )); then
  echo
  echo "WARN  No .env was found, so the decryption key for this database is NOT" >&2
  echo "      in this backup. Store JWT_SECRET somewhere safe yourself." >&2
fi
