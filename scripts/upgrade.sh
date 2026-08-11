#!/usr/bin/env bash
#
# Upgrades a running install: back up, fetch, rebuild, restart, verify.
#
#     scripts/upgrade.sh             # detects lite/full (see lib/mode.sh)
#     scripts/upgrade.sh full        # or say it explicitly
#
# The old version went straight to pull-and-rebuild with no backup at all. The
# new image runs a schema migration against the existing database on startup, so
# an upgrade is exactly the moment a restorable copy matters most. If the backup
# fails, this stops before touching anything.
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/mode.sh"
cd -- "$INFRAMONITOR_REPO_ROOT"

case "${1:-}" in
  lite|full)  mode="$1" ;;
  "")         mode="$(inframonitor_require_mode)" ;;
  -h|--help)  echo "Usage: scripts/upgrade.sh [lite|full]"; exit 0 ;;
  *)          echo "Usage: scripts/upgrade.sh [lite|full]" >&2; exit 2 ;;
esac
export INFRAMONITOR_MODE="$mode"

store="$(inframonitor_store_for_mode "$mode")"
if [[ "$store" == "postgres" ]]; then
  backup_ext="dump"
else
  backup_ext="db"
fi

# Ask Compose which container backs the service instead of hardcoding the name
# "inframonitor", which reports "unknown" and exits non-zero on a successful run whenever
# the container name differs (COMPOSE_PROJECT_NAME set, a second instance, or a
# changed container_name).
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

echo "Upgrading in ${mode} mode (${store} store)."

# ---------------------------------------------------------------------------
# 1. Back up first. Non-negotiable.
# ---------------------------------------------------------------------------
echo
echo "Step 1/4: backing up the ${store} database and .env before changing anything."
if ! bash scripts/backup.sh pre-upgrade; then
  echo >&2
  echo "FAIL  the backup failed, so the upgrade is stopping here with nothing changed." >&2
  echo "      Fix the backup first -- an upgrade runs a schema migration against" >&2
  echo "      your live database and you want a restorable copy before that." >&2
  echo "      Override only if you truly accept the risk:" >&2
  if [[ "$mode" == "full" ]]; then
    echo "        docker compose -f docker-compose.yml -f docker-compose.full.yml build --pull" >&2
    echo "        docker compose -f docker-compose.yml -f docker-compose.full.yml up -d" >&2
  else
    echo "        docker compose build --pull && docker compose up -d" >&2
  fi
  exit 1
fi

latest_backup="$(ls -1t "${BACKUP_DIR:-${INFRAMONITOR_REPO_ROOT}/backups}"/inframonitor-*-pre-upgrade."${backup_ext}" 2>/dev/null | head -n 1 || true)"

# ---------------------------------------------------------------------------
# 2. Fetch source changes, if this is a git checkout.
# ---------------------------------------------------------------------------
echo
echo "Step 2/4: fetching source changes."
if [[ -d .git ]] && command -v git >/dev/null 2>&1; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Local changes are present; skipping git pull so nothing of yours is lost."
    git status --short
  else
    git pull --ff-only
  fi
else
  echo "Not a git checkout (or git is unavailable); skipping. Update the files yourself."
fi

# ---------------------------------------------------------------------------
# 3. Rebuild and restart.
# ---------------------------------------------------------------------------
echo
echo "Step 3/4: rebuilding the image and restarting."
# Not `docker compose pull` for the app: its image is built here, not fetched.
# --pull refreshes the node/python base images.
inframonitor_dc "$mode" build --pull
if [[ "$mode" == "full" ]]; then
  # The third-party images are pinned by tag, so this is a no-op unless a tag was
  # changed in docker-compose.full.yml. --ignore-buildable skips the app service
  # rather than failing on it.
  inframonitor_dc "$mode" pull --ignore-buildable
fi
inframonitor_dc "$mode" up -d

# ---------------------------------------------------------------------------
# 4. Verify.
# ---------------------------------------------------------------------------
echo
echo "Step 4/4: waiting for the health check (up to 120s)..."
status="$(wait_healthy 60)"

echo
inframonitor_dc "$mode" ps

app_port="$(inframonitor_read_env APP_PORT)"
app_port="${app_port:-8088}"

if [[ "$status" == "healthy" || "$status" == "none" ]]; then
  echo
  echo "Upgrade complete. Infra Monitor is up at http://localhost:${app_port}"
  [[ -n "$latest_backup" ]] && echo "Pre-upgrade backup: ${latest_backup}"
  exit 0
fi

echo
echo "Upgrade finished but the container is '${status}'." >&2
echo "Recent logs:" >&2
inframonitor_dc "$mode" logs --tail 50 app >&2 || true
if [[ -n "$latest_backup" ]]; then
  echo >&2
  echo "To roll the database back to the pre-upgrade state:" >&2
  echo "  scripts/restore.sh ${latest_backup} --confirm" >&2
fi
exit 1
