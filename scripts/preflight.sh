#!/usr/bin/env bash
#
# Pre-start checks. Mode-aware: lite publishes one port, full publishes six.
#
#     scripts/preflight.sh            # detects the mode (see lib/mode.sh)
#     scripts/preflight.sh lite
#     scripts/preflight.sh full
#
# History worth not repeating: the original version checked a hardcoded array of
# eight ports left over from the multi-container stack and treated the stack's
# own listeners as conflicts, so it failed forever once Infra Monitor was running -- and
# its advice to "edit .env" could not have helped, because none of those ports
# were ever read from .env. Then it was cut down to a single hardcoded port for
# lite. Now the list comes from the mode plus .env, and a port held by one of our
# own containers is still not a conflict -- for any service, not just app.
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/mode.sh"
cd -- "$INFRAMONITOR_REPO_ROOT"

failed=0
ok()   { printf 'OK    %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; failed=1; }
note() { printf '      %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Mode
# ---------------------------------------------------------------------------
case "${1:-}" in
  lite|full) mode="$1" ;;
  "")        mode="$(inframonitor_require_mode)" ;;
  -h|--help) echo "Usage: scripts/preflight.sh [lite|full]"; exit 0 ;;
  *)         echo "Usage: scripts/preflight.sh [lite|full]" >&2; exit 2 ;;
esac
echo "Mode: ${mode}"
echo

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  bad "docker is not installed, or not on PATH."
  echo
  echo "Preflight failed."
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  bad "the 'docker compose' plugin is missing (Compose v2 is required)."
elif ! docker info >/dev/null 2>&1; then
  bad "cannot reach the Docker daemon."
  note "Is it running, and is your user in the 'docker' group?"
else
  ok "docker and docker compose are usable."
fi

# ---------------------------------------------------------------------------
# .env and JWT_SECRET
# ---------------------------------------------------------------------------
if [[ ! -f .env ]]; then
  bad ".env is missing."
  note "Run scripts/deploy.sh, which creates it with a generated JWT_SECRET,"
  note "or copy .env.example to .env and set JWT_SECRET yourself."
else
  ok ".env is present."
  jwt_secret="$(inframonitor_read_env JWT_SECRET)"
  if [[ -z "$jwt_secret" ]]; then
    bad "JWT_SECRET is empty or absent in .env. Compose will refuse to start."
    note 'Generate one: python -c "import secrets; print(secrets.token_urlsafe(48))"'
  elif [[ "$jwt_secret" == *REPLACE_ME* || "$jwt_secret" == change_this_secret* ]]; then
    bad "JWT_SECRET in .env is still the placeholder value."
    note 'Generate one: python -c "import secrets; print(secrets.token_urlsafe(48))"'
  elif (( ${#jwt_secret} < 32 )); then
    bad "JWT_SECRET in .env is only ${#jwt_secret} characters; use at least 32."
    note 'Generate one: python -c "import secrets; print(secrets.token_urlsafe(48))"'
  else
    ok "JWT_SECRET is set to a non-placeholder value."
  fi
fi

# ---------------------------------------------------------------------------
# Full-mode extras: the two required passwords and the monitoring configs.
# ---------------------------------------------------------------------------
if [[ "$mode" == "full" ]]; then
  if inframonitor_check_full_env; then
    ok "full-mode passwords are set, and the monitoring configs are all present."
  else
    failed=1
  fi
fi

# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------
# Build "label:port" pairs for the mode. Lite is one port. Full adds five, all
# read from .env with the documented defaults.
declare -a port_checks=()
app_port="$(inframonitor_read_env APP_PORT)"; app_port="${app_port:-8088}"
port_checks+=("app:${app_port}")

if [[ "$mode" == "full" ]]; then
  for spec in "${INFRAMONITOR_FULL_PORT_SPECS[@]}"; do
    var="${spec%%:*}"
    default="${spec#*:}"; default="${default%%:*}"
    label="${spec##*:}"
    value="$(inframonitor_read_env "$var")"; value="${value:-$default}"
    port_checks+=("${label}:${value}")
  done
fi

# Host ports published by any container in THIS Compose project, running or not.
# The previous version only looked at the app service, so in full mode every one
# of our own monitoring listeners would have been reported as a conflict.
own_ports=" "
if docker info >/dev/null 2>&1; then
  while IFS= read -r cid; do
    [[ -n "$cid" ]] || continue
    own_ports+="$(docker inspect \
      -f '{{range $p, $cfg := .NetworkSettings.Ports}}{{range $cfg}}{{.HostPort}} {{end}}{{end}}' \
      "$cid" 2>/dev/null || true) "
  done < <(docker ps -q --filter "label=com.docker.compose.project=$(inframonitor_project_name)" 2>/dev/null || true)
fi

probe_python() {
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

# Which containers publish this host port? Docker knows regardless of which
# netstat-alike the host has, and it can name the holder.
#
# The Ports column reads like "0.0.0.0:8088->8000/tcp, [::]:8088->8000/tcp",
# so ":8088->" is an exact anchor: it cannot match ":18088->", because the
# character before 8088 there is a 1 and not a colon.
docker_holders() {
  local port="$1"
  docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null \
    | awk -F'|' -v pat=":${port}->" 'index($2, pat) { print $1 }' \
    | tr '\n' ' '
}

# 0 = in use, 1 = free, 2 = cannot tell.
#
# An earlier version tried `ss` and then `netstat -ltn`. On a host with no `ss`
# and a non-GNU netstat -- a Windows Docker Desktop host, for instance --
# `netstat -ltn` prints its usage text and still exits 0, so the pipeline
# produced no listeners and the check silently answered "free" for every port,
# including ones that were definitely occupied. A bind attempt is tried first
# because it is the only method that means the same thing on every OS: if we
# cannot bind it, Compose cannot publish it either, which is the actual question
# being asked.
port_state() {
  local port="$1" listeners py
  if py="$(probe_python)"; then
    "$py" - "$port" <<'PY'
import socket, sys

port = int(sys.argv[1])

# Both addresses, not just 0.0.0.0. Windows lets a process bind 0.0.0.0:P while
# another already holds 127.0.0.1:P, so probing only the wildcard reported "free"
# for a port that a host-local process was serving on -- and the stack then came
# up with the container published on the wildcard while every request to
# localhost:P still went to the other process. Linux rejects the overlapping
# wildcard bind on its own, so this only ever adds detections.
for address in ("0.0.0.0", "127.0.0.1"):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((address, port))
        except OSError:
            sys.exit(0)   # in use
sys.exit(1)               # free
PY
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    listeners="$(ss -ltn 2>/dev/null | tail -n +2 | awk '{print $4}')"
    # Anchor on the separator so 8088 does not match 18088.
    printf '%s\n' "$listeners" | grep -Eq "[:.]${port}\$"
    return $?
  fi
  # GNU netstat. Verified to actually support -ltn before its output is trusted,
  # so a netstat that only prints usage is not read as "nothing is listening".
  if command -v netstat >/dev/null 2>&1; then
    if netstat -ltn >/dev/null 2>&1 && netstat -ltn 2>/dev/null | grep -q '^tcp'; then
      listeners="$(netstat -ltn 2>/dev/null | awk '/^tcp/ {print $4}')"
      printf '%s\n' "$listeners" | grep -Eq "[:.]${port}\$"
      return $?
    fi
    # Windows netstat: different flags, different columns.
    if netstat -ano 2>/dev/null | grep -q 'LISTENING'; then
      netstat -ano 2>/dev/null \
        | awk -v p=":${port}" '/LISTENING/ && $2 ~ p"$" { found = 1 } END { exit !found }'
      return $?
    fi
  fi
  return 2
}

check_port() {  # check_port <label> <port>
  local label="$1" port="$2" holders state holder

  if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    bad "the port configured for ${label} is not a valid port number: '${port}'"
    return
  fi

  holders="$(docker_holders "$port")"
  if [[ -n "${holders// /}" ]]; then
    state=0
  else
    set +e
    port_state "$port"
    state=$?
    set -e
  fi

  case "$state" in
    0)
      if [[ "$own_ports" == *" ${port} "* ]]; then
        ok "port ${port} (${label}) is held by one of our own containers -- not a conflict."
      else
        bad "port ${port} (${label}) is already in use."
        if [[ -n "${holders// /}" ]]; then
          note "held by container(s): ${holders% }"
        else
          holder="$( { ss -ltnp 2>/dev/null || true; } | grep -E "[:.]${port}[[:space:]]" || true)"
          [[ -n "$holder" ]] && note "listener: ${holder}"
        fi
        if [[ "$label" == "app" ]]; then
          note "Either stop whatever holds it, or set a different APP_PORT in .env."
        else
          note "Either stop whatever holds it, or change the matching *_PORT in .env."
        fi
      fi
      ;;
    1) ok "port ${port} (${label}) is free." ;;
    *) warn "no usable way to check port ${port} (${label}) on this host; skipped." ;;
  esac
}

# Duplicates inside our own list are worth catching before Compose does: two
# services asking for the same host port fails at `up` with a message about the
# second one, which does not point at the .env line that caused it.
declare -A seen_ports=()
for entry in "${port_checks[@]}"; do
  label="${entry%%:*}"
  port="${entry##*:}"
  if [[ -n "${seen_ports[$port]:-}" ]]; then
    bad "ports collide inside .env: ${label} and ${seen_ports[$port]} are both ${port}."
    continue
  fi
  seen_ports["$port"]="$label"
  check_port "$label" "$port"
done

echo
if (( failed )); then
  echo "Preflight failed."
  exit 1
fi
echo "Preflight passed."
