#!/usr/bin/env bash
#
# First-run / redeploy.
#
#     scripts/deploy.sh              # lite (the default profile)
#     scripts/deploy.sh full         # postgres + the monitoring stack
#
# The old version silently did `cp .env.example .env`. Now that JWT_SECRET is
# required with no default, that would hand you a .env containing a placeholder
# and the only symptom would be a confusing Compose interpolation error. So:
# generate real secrets when creating .env for the first time, and stop with
# instructions when an existing .env has bad ones.
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/mode.sh"
cd -- "$INFRAMONITOR_REPO_ROOT"

case "${1:-}" in
  lite|full)  mode="$1" ;;
  "")         mode="lite" ;;
  -h|--help)  echo "Usage: scripts/deploy.sh [lite|full]"; exit 0 ;;
  *)          echo "Usage: scripts/deploy.sh [lite|full]" >&2; exit 2 ;;
esac
# Everything called from here agrees with the mode being deployed.
export INFRAMONITOR_MODE="$mode"

# Finds a Python that actually runs. `command -v python3` is not enough: on
# Windows, PATH contains a Microsoft Store stub named python3 that exists, is
# executable, and does nothing but print an ad for the Store. Trusting it made
# this script abort with that ad as its only output. So probe each candidate.
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

# A secret must be obtainable even with no usable Python on the host -- the whole
# point of the container is that the host needs no Python. Every branch produces
# a cryptographically random, URL-safe string of at least 48 bytes of entropy.
# URL-safe matters for more than tidiness in full mode: POSTGRES_PASSWORD is
# interpolated into a postgresql+psycopg:// DSN.
gen_secret() {  # gen_secret [bytes]
  local bytes="${1:-48}" py out
  if py="$(host_python)"; then
    if out="$("$py" -c "import secrets; print(secrets.token_urlsafe(${bytes}))")" && [[ -n "$out" ]]; then
      printf '%s' "$out"
      return 0
    fi
  fi
  if command -v openssl >/dev/null 2>&1; then
    # base64 of N random bytes, translated into the URL-safe alphabet and
    # stripped of padding, which is exactly what token_urlsafe(N) produces.
    if out="$(openssl rand -base64 "$bytes" | tr -d '\n' | tr '+/' '-_' | tr -d '=')" \
       && (( ${#out} >= bytes )); then
      printf '%s' "$out"
      return 0
    fi
  fi
  if [[ -r /dev/urandom ]]; then
    if out="$(LC_ALL=C tr -dc 'A-Za-z0-9_-' < /dev/urandom | head -c "$(( bytes + 16 ))")" \
       && (( ${#out} == bytes + 16 )); then
      printf '%s' "$out"
      return 0
    fi
  fi
  return 1
}

# Rewrite one KEY=value line in .env, or append it if the key is absent. The
# value travels through the environment, never through the command line, so it
# cannot show up in `ps` output or need escaping in a sed pattern.
set_env_value() {  # set_env_value <key> <value>
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -qE "^[[:space:]]*${key}[[:space:]]*=" .env; then
    INFRAMONITOR_SET_KEY="$key" INFRAMONITOR_SET_VALUE="$value" awk '
      $0 ~ "^[[:space:]]*" ENVIRON["INFRAMONITOR_SET_KEY"] "[[:space:]]*=" && !done {
        print ENVIRON["INFRAMONITOR_SET_KEY"] "=" ENVIRON["INFRAMONITOR_SET_VALUE"]; done = 1; next
      }
      { print }
    ' .env > "$tmp"
  else
    cat .env > "$tmp"
    INFRAMONITOR_SET_KEY="$key" INFRAMONITOR_SET_VALUE="$value" \
      awk 'BEGIN { print ENVIRON["INFRAMONITOR_SET_KEY"] "=" ENVIRON["INFRAMONITOR_SET_VALUE"] }' >> "$tmp"
  fi
  cat "$tmp" > .env
  rm -f -- "$tmp"
  chmod 600 .env
}

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

echo "Deploying in ${mode} mode."
echo

# ---------------------------------------------------------------------------
# .env
# ---------------------------------------------------------------------------
created_env=0
if [[ ! -f .env ]]; then
  echo "No .env found. Creating one from .env.example with a generated JWT_SECRET."
  [[ -f .env.example ]] || { echo "FAIL  .env.example is missing; cannot bootstrap." >&2; exit 1; }
  secret="$(gen_secret 48)" || {
    echo "FAIL  could not generate a JWT_SECRET: no working python, no openssl," >&2
    echo "      and no readable /dev/urandom on this host." >&2
    echo "      Copy .env.example to .env and set JWT_SECRET yourself. Generate" >&2
    echo "      a value anywhere you do have Python:" >&2
    echo '        python -c "import secrets; print(secrets.token_urlsafe(48))"' >&2
    exit 1
  }
  [[ -n "$secret" ]] || { echo "FAIL  secret generation produced nothing." >&2; exit 1; }

  # Pass the secret through the environment rather than the command line so it
  # never shows up in `ps` output or in a sed pattern that needs escaping.
  umask 077
  if grep -qE '^[[:space:]]*JWT_SECRET[[:space:]]*=' .env.example; then
    INFRAMONITOR_NEW_SECRET="$secret" awk '
      /^[[:space:]]*JWT_SECRET[[:space:]]*=/ && !done {
        print "JWT_SECRET=" ENVIRON["INFRAMONITOR_NEW_SECRET"]; done = 1; next
      }
      { print }
    ' .env.example > .env
  else
    cp -- .env.example .env
    printf 'JWT_SECRET=%s\n' "$secret" >> .env
  fi
  chmod 600 .env
  unset secret
  created_env=1

  cat <<'EOF'

Created .env with a freshly generated JWT_SECRET (mode 600).

Back that value up now, before you add any servers. JWT_SECRET signs JWTs and
also derives the key that encrypts every stored SSH credential. If it is lost or
changed later, those credentials are permanently undecryptable and every server
has to have its credentials re-entered. scripts/backup.sh saves .env alongside
the database for this reason.
EOF
else
  jwt_secret="$(inframonitor_read_env JWT_SECRET)"
  if inframonitor_is_placeholder "$jwt_secret" 32; then
    cat >&2 <<'EOF'
FAIL  JWT_SECRET in your existing .env is empty, a placeholder, or too short.

Generate a value:
    python -c "import secrets; print(secrets.token_urlsafe(48))"

then set it in .env:
    JWT_SECRET=<the generated value>

This script deliberately will NOT write a secret into an existing .env. If
servers have already been added, JWT_SECRET is the key to their stored SSH
credentials, and replacing it would make them permanently undecryptable. That
has to be your decision, not a side effect of running a deploy script.
EOF
    exit 1
  fi
  echo "Using the existing .env (JWT_SECRET is set)."
fi

# ---------------------------------------------------------------------------
# Full-mode secrets
# ---------------------------------------------------------------------------
# Same rule as JWT_SECRET, and for the same reason: generate freely into a .env
# we just created, never overwrite one that already exists. Postgres reads
# POSTGRES_PASSWORD only at initdb time, so rewriting it after the volume exists
# does not change the database's password -- it just stops the app being able to
# log in. That has to be a deliberate act, not a side effect.
if [[ "$mode" == "full" ]]; then
  if (( created_env )); then
    for key in POSTGRES_PASSWORD GRAFANA_ADMIN_PASSWORD; do
      if inframonitor_is_placeholder "$(inframonitor_read_env "$key")" 8; then
        value="$(gen_secret 24)" || {
          echo "FAIL  could not generate a value for ${key}." >&2
          echo "      Set it in .env yourself:" >&2
          echo '        python -c "import secrets; print(secrets.token_urlsafe(24))"' >&2
          exit 1
        }
        set_env_value "$key" "$value"
        unset value
        echo "Generated ${key} in .env."
      fi
    done
    echo "Both full-mode passwords are in .env (mode 600). Back it up with JWT_SECRET."
  fi

  # --- Prometheus service-discovery token ----------------------------------
  # Prometheus authenticates to the app's http_sd endpoint (the node_exporter
  # target list) with a bearer token it reads from monitoring/prometheus/sd_token;
  # the app requires the SAME value in MONITORING_SD_TOKEN. Nothing else creates
  # either, so a fresh full bring-up would otherwise start Prometheus with no
  # token file -- Docker would materialise a directory in its place -- and scrape
  # zero node_exporter targets. Generate once and keep the two in sync.
  #
  # Idempotent: if the file already holds a token and .env already matches it,
  # leave both alone. Unlike POSTGRES_PASSWORD this is safe to (re)write into an
  # existing .env -- it is just a shared bearer token, read fresh at every app
  # start, not a key that decrypts stored data. Reuse whichever side already has
  # a value so a token an already-running Prometheus is using is never invalidated;
  # only generate when neither side has one.
  sd_file="monitoring/prometheus/sd_token"
  sd_env="$(inframonitor_read_env MONITORING_SD_TOKEN)"
  sd_file_value=""
  [[ -f "$sd_file" ]] && sd_file_value="$(tr -d '\r\n' < "$sd_file")"
  if [[ -n "$sd_file_value" && "$sd_file_value" == "$sd_env" ]]; then
    echo "Prometheus SD token already set (sd_token matches MONITORING_SD_TOKEN)."
  else
    token="$sd_file_value"
    [[ -z "$token" ]] && token="$sd_env"
    if [[ -z "$token" ]]; then
      token="$(gen_secret 24)" || {
        echo "FAIL  could not generate a MONITORING_SD_TOKEN." >&2
        echo "      Set it in .env and write the same value to ${sd_file}:" >&2
        echo '        python -c "import secrets; print(secrets.token_urlsafe(24))"' >&2
        exit 1
      }
    fi
    # printf, not echo: the bearer token must be the exact file contents with no
    # trailing newline surprises. mode 600 to match .env and the passwords above.
    umask 077
    printf '%s' "$token" > "$sd_file"
    chmod 600 "$sd_file"
    set_env_value MONITORING_SD_TOKEN "$token"
    unset token
    echo "Wrote ${sd_file} (mode 600) and set MONITORING_SD_TOKEN in .env to match."
  fi
  unset sd_file sd_env sd_file_value

  # Whether we generated them or not, they have to be usable now.
  inframonitor_check_full_env || exit 1
fi

# ---------------------------------------------------------------------------
# Preflight, build, start
# ---------------------------------------------------------------------------
echo
bash scripts/preflight.sh "$mode"

echo
# `docker compose pull` is wrong for the app: its image is built from this repo,
# not fetched from a registry. `build --pull` refreshes the base images instead.
echo "Building the app image."
inframonitor_dc "$mode" build --pull

if [[ "$mode" == "full" ]]; then
  echo
  echo "Pulling the third-party images (postgres, prometheus, grafana, loki,"
  echo "promtail, alertmanager)."
  inframonitor_dc "$mode" pull --ignore-buildable
fi

echo
echo "Starting."
inframonitor_dc "$mode" up -d

app_port="$(inframonitor_read_env APP_PORT)"
app_port="${app_port:-8088}"

echo
echo "Waiting for the health check (up to 120s)..."
status="$(wait_healthy 60)"

echo
inframonitor_dc "$mode" ps

if [[ "$status" == "healthy" || "$status" == "none" ]]; then
  echo
  echo "Infra Monitor is up: http://localhost:${app_port}"
  echo "The API and the UI are the same origin, so there is no separate API URL."
  if [[ "$mode" == "full" ]]; then
    grafana_port="$(inframonitor_read_env GRAFANA_PORT)"; grafana_port="${grafana_port:-13000}"
    graf_user="$(inframonitor_read_env GRAFANA_ADMIN_USER)"; graf_user="${graf_user:-admin}"
    echo
    echo "Grafana: http://localhost:${grafana_port}  (user '${graf_user}', password from"
    echo "         GRAFANA_ADMIN_PASSWORD in .env). Dashboard: Infra Monitor Overview, folder Infra Monitor."
    echo "Prometheus, Loki and Alertmanager are bound to 127.0.0.1 by default; see"
    echo "MONITORING_BIND in .env.example."
  fi
  echo
  echo "The admin login for a first boot is printed in the app log:"
  echo "  scripts/stack.sh ${mode} logs app | head -40"
  exit 0
fi

echo
echo "The container did not become healthy (state: '${status:-unknown}')." >&2
echo "Recent logs:" >&2
inframonitor_dc "$mode" logs --tail 50 app >&2 || true
exit 1
