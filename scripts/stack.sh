#!/usr/bin/env bash
#
# One entry point for both install profiles, so nobody has to remember the -f
# list or which extra ports full mode publishes.
#
#     scripts/stack.sh lite up
#     scripts/stack.sh full up
#     scripts/stack.sh full logs
#     scripts/stack.sh lite down
#
# The mode is a required, explicit argument. There is no default and no
# auto-detection here on purpose: every other script in this directory detects
# the mode (see lib/mode.sh), but the one command that *changes* which mode is
# running should say so out loud, because getting it wrong swaps the database
# under a live install.
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/mode.sh"
cd -- "$INFRAMONITOR_REPO_ROOT"

usage() {
  cat <<'EOF'
Usage: scripts/stack.sh <lite|full> <up|down|restart|ps|logs|pull> [extra args...]

Modes
  lite    One container, SQLite, no monitoring. The default install.
            docker compose up -d
  full    Adds postgres, prometheus, grafana, loki, promtail, alertmanager, and
          switches the app to Postgres with metrics enabled.
            docker compose -f docker-compose.yml -f docker-compose.full.yml up -d

Actions
  up        Create/start (adds -d unless you pass your own flags)
  down      Stop and remove containers. Named volumes are kept unless you add -v.
  restart   Restart the containers of this mode
  ps        Status
  logs      Recent logs (defaults to --tail 200; add -f to follow)
  pull      Pull the images this mode uses. The app image is BUILT from this
            repo, not pulled, so pull only fetches the third-party images and
            says so. Use scripts/upgrade.sh to rebuild the app.

Anything after the action is passed straight through to docker compose, e.g.
  scripts/stack.sh full logs -f grafana
  scripts/stack.sh lite up --remove-orphans
  scripts/stack.sh full up --build

Examples of what this wrapper adds over raw compose: it checks .env and
JWT_SECRET, checks the full-mode passwords and monitoring configs, prints the
ports each mode publishes, and warns when you are about to leave the other
mode's containers behind as orphans.
EOF
}

case "${1:-}" in
  -h|--help|help|"") usage; [[ -z "${1:-}" ]] && exit 2 || exit 0 ;;
esac

mode="$1"; shift
case "$mode" in
  lite|full) ;;
  *) printf "First argument must be 'lite' or 'full', not '%s'.\n\n" "$mode" >&2
     usage >&2; exit 2 ;;
esac

action="${1:-}"; shift || true
case "$action" in
  up|down|restart|ps|logs|pull) ;;
  "") printf "Missing action.\n\n" >&2; usage >&2; exit 2 ;;
  *)  printf "Unknown action '%s'.\n\n" "$action" >&2; usage >&2; exit 2 ;;
esac

# Everything this script runs, and everything it may in turn call, agrees on the
# mode the operator asked for rather than re-detecting it.
export INFRAMONITOR_MODE="$mode"

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL  docker is not installed, or not on PATH." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "FAIL  the 'docker compose' plugin is missing (Compose v2 is required)." >&2
  exit 1
fi

# `ps` and `logs` are read-only and are exactly what you reach for when the
# stack is broken, so they are not gated on .env being valid.
needs_env=1
case "$action" in
  ps|logs) needs_env=0 ;;
esac

if (( needs_env )); then
  if [[ ! -f .env ]]; then
    cat >&2 <<'EOF'
FAIL  .env is missing.

Create it with a generated secret:
    scripts/deploy.sh
or by hand:
    cp .env.example .env
    python -c "import secrets; print(secrets.token_urlsafe(48))"   # -> JWT_SECRET
EOF
    exit 1
  fi

  jwt="$(inframonitor_read_env JWT_SECRET)"
  if inframonitor_is_placeholder "$jwt" 32; then
    cat >&2 <<'EOF'
FAIL  JWT_SECRET in .env is empty, still the placeholder, or shorter than 32
      characters. Compose refuses to start without a real value, and this one
      secret both signs JWTs and derives the key that encrypts every stored SSH
      credential.

Generate one:
    python -c "import secrets; print(secrets.token_urlsafe(48))"
EOF
    exit 1
  fi

  if [[ "$mode" == "full" ]]; then
    inframonitor_check_full_env || exit 1
  fi
elif [[ "$mode" == "full" ]]; then
  # ps and logs skipped the checks above so that they still work on a broken
  # install. Compose, however, has to interpolate docker-compose.full.yml before
  # it can list anything, and it cannot do that without POSTGRES_PASSWORD. Say so
  # up front, because "error while interpolating services.app.environment" does
  # not read like "your .env is missing a full-mode variable".
  if inframonitor_is_placeholder "$(inframonitor_read_env POSTGRES_PASSWORD)" 1 \
     || inframonitor_is_placeholder "$(inframonitor_read_env GRAFANA_ADMIN_PASSWORD)" 1; then
    cat >&2 <<'EOF'
NOTE  POSTGRES_PASSWORD or GRAFANA_ADMIN_PASSWORD is not set in .env. Compose has
      to interpolate docker-compose.full.yml even for a read-only command, so
      this will fail on that before it can show you anything. Set both in .env
      (see the BLOCK 2 section of .env.example), or use lite:
        scripts/stack.sh lite ps

EOF
  fi
fi

# ---------------------------------------------------------------------------
# Orphan warning
# ---------------------------------------------------------------------------
# Compose only manages the services in the files it was given. Starting lite
# while full's containers exist leaves postgres and the monitoring stack running
# and unmanaged -- and, worse, leaves the app pointed at SQLite while Postgres
# still holds the data that was being written a minute ago. Say so.
warn_orphans() {
  local other_service found=""
  for other_service in postgres prometheus grafana loki promtail alertmanager; do
    if [[ -n "$(inframonitor_service_containers "$other_service")" ]]; then
      found="${found}${other_service} "
    fi
  done
  [[ -n "$found" ]] || return 0
  cat >&2 <<EOF

WARNING  full-mode containers still exist: ${found% }
         This lite command does not manage them, so they are left running and
         Compose will report them as orphans. The app you are starting will use
         SQLite while Postgres still holds whatever full mode wrote.

         Take full down first:      scripts/stack.sh full down
         Or remove them as you go:  scripts/stack.sh lite ${action} --remove-orphans

EOF
}

if [[ "$mode" == "lite" ]] && [[ "$action" == "up" || "$action" == "restart" ]] && inframonitor_docker_ok; then
  warn_orphans
fi

# `down -v` deletes the named volumes, which is the database, the metrics and the
# logs. Compose does not ask. Neither does this, because a prompt in a script
# that might be run non-interactively is its own trap -- but it is worth saying
# before the work starts.
if [[ "$action" == "down" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "-v" || "$arg" == "--volumes" ]]; then
      cat >&2 <<EOF

WARNING  -v deletes this project's named volumes. For ${mode} mode that includes
         inframonitor_data, which is the database. There is no undo.
         Back up first if you have not:   scripts/backup.sh

EOF
      break
    fi
  done
fi

# ---------------------------------------------------------------------------
# Announce and run
# ---------------------------------------------------------------------------
files_display="$(inframonitor_compose_files "$mode" | paste -sd' ' -)"
app_port="$(inframonitor_read_env APP_PORT)"; app_port="${app_port:-8088}"

echo "Mode   : ${mode}"
echo "Files  : ${files_display}"
echo "Action : ${action} $*"

if [[ "$action" == "up" || "$action" == "restart" ]]; then
  echo "Ports  :"
  printf '    %-13s 0.0.0.0:%s      (UI + API, same origin)\n' "app" "$app_port"
  if [[ "$mode" == "full" ]]; then
    inframonitor_print_full_ports
    echo
    echo "In full mode the app talks to postgres, prometheus, grafana, loki and"
    echo "alertmanager over the Compose network, so those published ports are for"
    echo "you, not for the app. Prometheus, Loki and Alertmanager are on 127.0.0.1"
    echo "by default because none of them has any authentication."
  else
    echo "    (lite publishes nothing else -- no postgres, no monitoring)"
  fi
fi
echo

declare -a passthrough=("$@")

# No `set +e` / captured exit status here: under `set -euo pipefail` a failing
# docker compose ends this script with docker's own exit code, which is what a
# caller in a CI pipeline wants. The post-up summary below is therefore only
# reached on success.
case "$action" in
  up)
    # Default to detached. If the caller passed any flags of their own, respect
    # them exactly: adding -d to `up --abort-on-container-exit` would be wrong.
    if (( ${#passthrough[@]} == 0 )); then
      passthrough=(-d)
    fi
    inframonitor_dc "$mode" up "${passthrough[@]}"
    ;;
  logs)
    if (( ${#passthrough[@]} == 0 )); then
      passthrough=(--tail 200)
    fi
    inframonitor_dc "$mode" logs "${passthrough[@]}"
    ;;
  pull)
    echo "Note: the app image is built from this repo, so it is not pulled here."
    echo "      Use scripts/upgrade.sh (or 'docker compose build --pull') for that."
    echo
    if [[ "$mode" == "lite" ]]; then
      echo "Lite has no third-party images to pull. Nothing to do."
    else
      # --ignore-buildable skips the app service instead of failing on it.
      inframonitor_dc "$mode" pull --ignore-buildable "${passthrough[@]}"
    fi
    ;;
  *)
    inframonitor_dc "$mode" "$action" "${passthrough[@]}"
    ;;
esac

if [[ "$action" == "up" ]]; then
  echo
  inframonitor_dc "$mode" ps
  echo
  echo "Infra Monitor: http://localhost:${app_port}"
  if [[ "$mode" == "full" ]]; then
    grafana_port="$(inframonitor_read_env GRAFANA_PORT)"; grafana_port="${grafana_port:-13000}"
    echo "Grafana: http://localhost:${grafana_port} (dashboard 'Infra Monitor Overview', folder Infra Monitor)"
  fi
  echo
  echo "On a first boot the admin password is printed in the container log:"
  echo "  scripts/stack.sh ${mode} logs app | head -40"
fi
