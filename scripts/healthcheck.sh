#!/usr/bin/env bash
#
# Liveness check for a running Infra Monitor install.
#
#     scripts/healthcheck.sh                       # detects lite/full
#     scripts/healthcheck.sh http://host:8088      # explicit base URL
#
# /health is the ONLY app endpoint probed, and that is deliberate. An earlier
# version also curled /api/dashboard/summary, which requires a bearer token, so
# `curl -f` under `set -e` reported failure against a completely healthy stack.
# /health is the only unauthenticated app endpoint, and it genuinely verifies the
# database (200 when reachable, 503 when not), so it is the only thing worth
# probing and the only thing that decides this script's exit code.
#
# In full mode the four monitoring components are probed as well, on their own
# unauthenticated health endpoints. Those results are INFORMATIONAL: a dead
# Grafana does not make Infra Monitor unhealthy, and this script's contract is "is Infra Monitor
# up". The exit code still comes from /health alone.
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/mode.sh"
cd -- "$INFRAMONITOR_REPO_ROOT"

# Probe rather than trust `command -v`: Windows PATH carries a Microsoft Store
# stub named python3 that exists but only prints an ad for the Store.
python_bin=""
for candidate in python3 python py; do
  if command -v "$candidate" >/dev/null 2>&1 \
     && "$candidate" -c 'import sys; sys.exit(0)' >/dev/null 2>&1; then
    python_bin="$candidate"
    break
  fi
done

# http_probe <url> -> sets $code and $body, returns 1 if the connection failed.
code=""
body=""
probe_error=""
http_probe() {
  local url="$1" response err_file
  code=""
  body=""
  probe_error=""

  if command -v curl >/dev/null 2>&1; then
    # curl's own diagnostics go to a separate file rather than into the response.
    # Merging them with 2>&1 would splice "curl: (7) ..." into the same string as
    # the body and the -w status code, and the failure message came out garbled.
    err_file="$(mktemp)"
    # No -f: a 503 from /health carries a body naming what is wrong, and we want
    # to print it rather than have curl swallow it.
    if ! response="$(curl -sS -m 10 -w $'\n%{http_code}' "$url" 2>"$err_file")"; then
      probe_error="$(sed -e 's/^/      /' -- "$err_file")"
      rm -f -- "$err_file"
      return 1
    fi
    rm -f -- "$err_file"
    code="${response##*$'\n'}"
    body="${response%$'\n'*}"
    return 0
  fi

  if [[ -z "$python_bin" ]]; then
    probe_error="      neither curl nor python is available to probe ${url}"
    return 1
  fi
  if ! response="$("$python_bin" - "$url" <<'PY'
import sys, urllib.error, urllib.request
url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=10) as r:
        print(r.read().decode("utf-8", "replace"))
        print(r.status)
except urllib.error.HTTPError as e:
    print(e.read().decode("utf-8", "replace"))
    print(e.code)
except Exception as e:
    sys.exit(f"{type(e).__name__}: {e}")
PY
  )"; then
    probe_error="      could not connect"
    return 1
  fi
  code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  return 0
}

# ---------------------------------------------------------------------------
# The app: /health, and nothing else.
# ---------------------------------------------------------------------------
app_port="$(inframonitor_read_env APP_PORT)"
app_port="${app_port:-8088}"
base="${1:-http://localhost:${app_port}}"
base="${base%/}"
url="${base}/health"

if ! http_probe "$url"; then
  echo "FAIL  could not connect to ${url}" >&2
  [[ -n "$probe_error" ]] && printf '%s\n' "$probe_error" >&2
  exit 1
fi

printf '%s\n' "$body"

app_ok=0
if [[ "$code" == "200" ]]; then
  echo "OK    ${url} returned 200."
  app_ok=1
else
  echo "FAIL  ${url} returned HTTP ${code}." >&2
  if [[ "$code" == "503" ]]; then
    echo "      503 means the app is up but its database is unreachable." >&2
    echo "      In lite mode, check that the inframonitor_data volume is mounted and" >&2
    echo "      writable by uid 10001:" >&2
    echo "        docker compose exec app ls -la /app/data" >&2
    echo "      In full mode, check postgres:" >&2
    echo "        scripts/stack.sh full ps" >&2
    echo "        scripts/stack.sh full logs postgres" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Full mode only: the monitoring components, informationally.
# ---------------------------------------------------------------------------
mode="$(inframonitor_detect_mode)"
if [[ "$mode" == "full" && -z "${1:-}" ]]; then
  # Only when no explicit base URL was given: with one, the caller is probing
  # some other host and guessing its monitoring ports would be wrong.
  host="localhost"

  prom_port="$(inframonitor_read_env PROMETHEUS_PORT)";    prom_port="${prom_port:-19090}"
  graf_port="$(inframonitor_read_env GRAFANA_PORT)";       graf_port="${graf_port:-13000}"
  loki_port="$(inframonitor_read_env LOKI_PORT)";          loki_port="${loki_port:-13100}"
  am_port="$(inframonitor_read_env ALERTMANAGER_PORT)";    am_port="${am_port:-19093}"

  echo
  echo "Full mode: monitoring components (informational -- these do not affect the"
  echo "exit code, which is decided by /health above)."

  # All four endpoints are unauthenticated by design in these components; none of
  # them is an Infra Monitor API endpoint and none needs a token.
  for entry in \
    "prometheus:${prom_port}:/-/ready" \
    "grafana:${graf_port}:/api/health" \
    "loki:${loki_port}:/ready" \
    "alertmanager:${am_port}:/-/ready"
  do
    name="${entry%%:*}"
    rest="${entry#*:}"
    port="${rest%%:*}"
    path="${rest#*:}"
    if http_probe "http://${host}:${port}${path}"; then
      if [[ "$code" == "200" ]]; then
        printf '  OK    %-13s http://%s:%s%s -> 200\n' "$name" "$host" "$port" "$path"
      else
        printf '  WARN  %-13s http://%s:%s%s -> %s\n' "$name" "$host" "$port" "$path" "$code"
      fi
    else
      printf '  WARN  %-13s http://%s:%s%s -> unreachable\n' "$name" "$host" "$port" "$path"
      if [[ "$name" != "grafana" ]]; then
        printf '        (bound to MONITORING_BIND, 127.0.0.1 by default -- unreachable\n'
        printf '         from another machine is expected, not a fault)\n'
      fi
    fi
  done
fi

(( app_ok )) || exit 1
exit 0
