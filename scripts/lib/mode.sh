# shellcheck shell=bash
#
# Shared profile (lite/full) helpers. SOURCE this, do not execute it:
#
#     source "$(dirname -- "${BASH_SOURCE[0]}")/lib/mode.sh"
#
# It defines inframonitor_* functions only. It sets no options and no traps -- callers
# already run under `set -euo pipefail` and every function here is written to be
# safe under `-u`. Nothing here prints a secret: values read out of .env or out
# of a container's environment are compared and classified, never echoed.
#
# Everything that has to know whether the stack is lite or full goes through
# inframonitor_detect_mode, so there is exactly one place where that decision is made.

# Repo root, resolved from this file's location, so every script works from any
# working directory.
INFRAMONITOR_REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

INFRAMONITOR_LITE_FILE="docker-compose.yml"
INFRAMONITOR_FULL_FILE="docker-compose.full.yml"

# Extra host ports that only full mode publishes, as "VAR:default:service".
INFRAMONITOR_FULL_PORT_SPECS=(
  "POSTGRES_PORT:15432:postgres"
  "PROMETHEUS_PORT:19090:prometheus"
  "GRAFANA_PORT:13000:grafana"
  "LOKI_PORT:13100:loki"
  "ALERTMANAGER_PORT:19093:alertmanager"
)

# ---------------------------------------------------------------------------
# .env reading
# ---------------------------------------------------------------------------
# Read one key out of .env without sourcing it: the file holds secrets and
# sourcing would execute whatever else is in there. Last assignment wins; CRLF
# and surrounding quotes are stripped.
inframonitor_read_env() {  # inframonitor_read_env <key> [env-file]
  local key="$1" file="${2:-${INFRAMONITOR_REPO_ROOT}/.env}" line
  [[ -f "$file" ]] || return 0
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" | tail -n 1)" || return 0
  line="${line#*=}"
  line="${line%$'\r'}"
  printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
                            -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# True when a value is missing or is still an example placeholder.
inframonitor_is_placeholder() {  # inframonitor_is_placeholder <value> [min-length]
  local value="$1" min="${2:-1}"
  [[ -z "$value" ]] && return 0
  [[ "$value" == *REPLACE_ME* ]] && return 0
  [[ "$value" == change_this_secret* ]] && return 0
  (( ${#value} < min )) && return 0
  return 1
}

# ---------------------------------------------------------------------------
# Docker plumbing
# ---------------------------------------------------------------------------
inframonitor_docker_ok() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

# Compose project name. `name: inframonitor` in docker-compose.yml sets it; the
# COMPOSE_PROJECT_NAME environment variable overrides that.
inframonitor_project_name() {
  printf '%s' "${COMPOSE_PROJECT_NAME:-inframonitor}"
}

# Container IDs for one service in this project, by label rather than by
# `docker compose ps`. Deliberate: `docker compose -f ... -f docker-compose.full.yml ps`
# has to interpolate the overlay first, so it fails outright when
# POSTGRES_PASSWORD is unset -- which is exactly the situation where we are
# trying to find out whether full mode is in use. Labels need no interpolation.
inframonitor_service_containers() {  # inframonitor_service_containers <service> [--running]
  local service="$1" only_running="${2:-}"
  local -a args=(-a)
  [[ "$only_running" == "--running" ]] && args=()
  docker ps "${args[@]}" \
    --filter "label=com.docker.compose.project=$(inframonitor_project_name)" \
    --filter "label=com.docker.compose.service=${service}" \
    --format '{{.ID}}' 2>/dev/null || true
}

# Does the Postgres data volume exist? A leftover volume is what makes "which
# store holds my data" ambiguous after switching modes, so it is worth knowing.
inframonitor_postgres_volume() {
  docker volume ls -q 2>/dev/null \
    | grep -Fx "$(inframonitor_project_name)_postgres_data" || true
}

# The scheme of the app container's DATABASE_URL -- "sqlite", "postgresql", or
# empty. Only the scheme is ever returned; the rest of the DSN contains the
# Postgres password, and this must never leak it.
#
# A *stopped* app container answers this just as well as a running one: its
# Config.Env still records the DSN it was created with, which is the mode this
# install last ran in. That is what makes "stack is down" a decidable case rather
# than an ambiguous one.
inframonitor_app_dsn_scheme() {  # inframonitor_app_dsn_scheme [--running]
  local cid url
  cid="$(inframonitor_service_containers app "${1:-}" | head -n 1)"
  [[ -n "$cid" ]] || return 0
  url="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" 2>/dev/null \
        | grep -E '^DATABASE_URL=' | tail -n 1 || true)"
  url="${url#DATABASE_URL=}"
  case "$url" in
    postgres*|postgresql*) printf 'postgresql' ;;
    sqlite*)               printf 'sqlite' ;;
    *)                     : ;;
  esac
}

# ---------------------------------------------------------------------------
# Mode detection
# ---------------------------------------------------------------------------
# Prints exactly one of: lite, full, ambiguous.
#
# Order, most authoritative first:
#   1. $INFRAMONITOR_MODE, if set. stack.sh exports it, so anything it calls agrees with
#      the mode the operator actually asked for.
#   2. The DATABASE_URL of the *running* app container. Not a guess: it is the
#      store the live process is using right now.
#   3. A postgres container belonging to this project, running or stopped. If one
#      exists at all, this install is full.
#   4. The DATABASE_URL of a stopped app container -- the mode this install last
#      ran in.
#   5. .env, which only settles it if it names a Postgres DSN. Full mode does not
#      read DATABASE_URL from .env, so a SQLite value there proves nothing about
#      a full install.
#   6. A Postgres data volume with none of the above to explain it: genuinely
#      undecidable -> ambiguous.
#   7. Nothing anywhere -> lite, the documented default.
#
# "ambiguous" is a real answer and callers must handle it. backup.sh and
# restore.sh refuse to run on it, because the alternative is backing up an
# abandoned SQLite file and calling it a backup of a Postgres install.
inframonitor_detect_mode() {
  local scheme dsn

  if [[ -n "${INFRAMONITOR_MODE:-}" ]]; then
    case "${INFRAMONITOR_MODE}" in
      lite|full) printf '%s' "${INFRAMONITOR_MODE}"; return 0 ;;
      *) printf 'ambiguous' ; return 0 ;;
    esac
  fi

  if inframonitor_docker_ok; then
    scheme="$(inframonitor_app_dsn_scheme --running)"
    case "$scheme" in
      postgresql) printf 'full'; return 0 ;;
      sqlite)     printf 'lite'; return 0 ;;
    esac

    if [[ -n "$(inframonitor_service_containers postgres)" ]]; then
      printf 'full'; return 0
    fi

    scheme="$(inframonitor_app_dsn_scheme)"
    case "$scheme" in
      postgresql) printf 'full'; return 0 ;;
      sqlite)     printf 'lite'; return 0 ;;
    esac

    dsn="$(inframonitor_read_env DATABASE_URL)"
    case "$dsn" in
      postgres*|postgresql*) printf 'full'; return 0 ;;
    esac

    if [[ -n "$(inframonitor_postgres_volume)" ]]; then
      printf 'ambiguous'; return 0
    fi
    printf 'lite'; return 0
  fi

  dsn="$(inframonitor_read_env DATABASE_URL)"
  case "$dsn" in
    postgres*|postgresql*) printf 'full' ;;
    *)                     printf 'lite' ;;
  esac
}

# Print the reason an ambiguous detection happened, and how to resolve it.
inframonitor_explain_ambiguous() {
  cat >&2 <<EOF
Cannot tell whether this install is lite or full.

  * no app container exists at all, running or stopped, so there is no
    DATABASE_URL to read from one
  * no postgres container exists for project '$(inframonitor_project_name)'
  * .env either has no DATABASE_URL or has a SQLite one (full mode ignores it)
  * but the volume $(inframonitor_project_name)_postgres_data DOES exist

That combination is what a full install looks like while it is stopped, and it
is also what a lite install looks like after somebody ran full once and switched
back without removing the volume. Guessing here would mean either backing up an
abandoned SQLite file and labelling it a backup of a Postgres install, or the
reverse. So: say which one you mean.

    INFRAMONITOR_MODE=full  scripts/backup.sh
    INFRAMONITOR_MODE=lite  scripts/backup.sh

If the Postgres volume really is stale and you are certain you no longer need
what is in it:

    docker volume rm $(inframonitor_project_name)_postgres_data
EOF
}

# Resolve mode, or exit 1 with an explanation. Usage:
#     mode="$(inframonitor_require_mode)"
inframonitor_require_mode() {
  local mode
  mode="$(inframonitor_detect_mode)"
  if [[ "$mode" == "ambiguous" ]]; then
    if [[ -n "${INFRAMONITOR_MODE:-}" ]]; then
      printf "INFRAMONITOR_MODE must be 'lite' or 'full', not '%s'.\n" "${INFRAMONITOR_MODE}" >&2
    else
      inframonitor_explain_ambiguous
    fi
    exit 1
  fi
  printf '%s' "$mode"
}

# ---------------------------------------------------------------------------
# Compose invocation
# ---------------------------------------------------------------------------
# The -f list for a mode, one argument per line so callers can read it into an
# array safely.
#
# The file names are RELATIVE, and inframonitor_dc runs docker compose from the repo root
# so that they resolve. That is not a style choice. Some callers have to set
# MSYS_NO_PATHCONV=1 / MSYS2_ARG_CONV_EXCL='*' around docker, because they pass
# container paths like /app/data/x.db that Git Bash would otherwise rewrite into
# "C:/Program Files/Git/app/data/x.db". With conversion suppressed, an absolute
# POSIX path in the same command line stops being converted too, so
# `-f /d/code/dashboard/docker-compose.yml` reached docker as exactly that and it
# looked for D:\d\code\dashboard\docker-compose.yml. Relative names are immune:
# MSYS never rewrites them, converted or not.
inframonitor_compose_files() {  # inframonitor_compose_files <lite|full>
  printf '%s\n' -f "${INFRAMONITOR_LITE_FILE}"
  if [[ "$1" == "full" ]]; then
    printf '%s\n' -f "${INFRAMONITOR_FULL_FILE}"
  fi
}

# docker compose for a mode. First argument is the mode, the rest is the command:
#     inframonitor_dc full ps
#     inframonitor_dc lite logs --tail 50 app
#
# The subshell cd makes the relative -f names above resolve and makes the repo
# root the project directory, which is what the `./monitoring/...` bind mounts in
# docker-compose.full.yml are relative to. It is a subshell so the caller's
# working directory is left alone, and so a redirection on the call
# (`inframonitor_dc ... < "$file"`) is still resolved in the caller's directory.
inframonitor_dc() {
  local mode="$1"; shift
  local -a files=()
  while IFS= read -r arg; do files+=("$arg"); done < <(inframonitor_compose_files "$mode")
  ( cd -- "${INFRAMONITOR_REPO_ROOT}" && docker compose "${files[@]}" "$@" )
}

# The datastore a mode uses. This, not the mode name, is what backup.sh and
# restore.sh dispatch on -- so it must not have a permissive default. Mapping an
# unresolved mode to "sqlite" here would quietly undo the ambiguity check that
# inframonitor_require_mode exists to enforce.
inframonitor_store_for_mode() {  # inframonitor_store_for_mode <lite|full>
  case "${1:-}" in
    full) printf 'postgres' ;;
    lite) printf 'sqlite' ;;
    *)    printf 'inframonitor_store_for_mode: expected lite or full, got %s\n' "${1:-<empty>}" >&2
          return 2 ;;
  esac
}

# ---------------------------------------------------------------------------
# Full-mode prerequisites
# ---------------------------------------------------------------------------
# Compose itself refuses to start full mode without POSTGRES_PASSWORD and
# GRAFANA_ADMIN_PASSWORD (both are `${VAR:?...}`), but its interpolation error
# arrives as a wall of text about a variable in a YAML file. Checking here means
# the operator gets told what to do instead. Returns 1 on any problem.
inframonitor_check_full_env() {
  local ok=0 value key
  for key in POSTGRES_PASSWORD GRAFANA_ADMIN_PASSWORD; do
    value="$(inframonitor_read_env "$key")"
    if inframonitor_is_placeholder "$value" 8; then
      printf 'FAIL  %s is empty, a placeholder, or shorter than 8 characters in .env.\n' "$key" >&2
      printf '      Full mode has no default for it. Generate one:\n' >&2
      printf '        python -c "import secrets; print(secrets.token_urlsafe(24))"\n' >&2
      ok=1
    fi
  done

  # A Postgres password with URL-reserved characters produces a DSN that parses
  # into a different host, which surfaces as a baffling connection error rather
  # than as a config problem.
  value="$(inframonitor_read_env POSTGRES_PASSWORD)"
  if [[ -n "$value" && "$value" =~ [@:/?\#\[\]] ]]; then
    printf 'FAIL  POSTGRES_PASSWORD contains a character that is reserved in a URL.\n' >&2
    printf '      It is interpolated into postgresql+psycopg://user:PASSWORD@postgres:5432/db,\n' >&2
    printf '      so @ : / ? # [ ] would silently change which host is connected to.\n' >&2
    printf '      Use letters, digits and - _ . ~ only.\n' >&2
    ok=1
  fi

  # A full install with no monitoring configs starts containers that immediately
  # exit, which reads as a mysterious crash loop.
  local -a required=(
    "monitoring/prometheus/prometheus.yml"
    "monitoring/prometheus/alerts.yml"
    # Must exist as a FILE before `up`: it is bind-mounted at
    # /etc/prometheus/sd_token, and a missing path makes Docker create a
    # directory there, so Prometheus reads no bearer token and the node_exporter
    # http_sd job is refused. scripts/deploy.sh generates it on a full deploy.
    "monitoring/prometheus/sd_token"
    "monitoring/prometheus/targets"
    "monitoring/alertmanager/alertmanager.yml"
    "monitoring/loki/loki.yml"
    "monitoring/promtail/promtail.yml"
    "monitoring/grafana/provisioning/datasources/datasources.yml"
    "monitoring/grafana/provisioning/dashboards/dashboards.yml"
    "monitoring/grafana/dashboards/inframonitor-overview.json"
  )
  local path
  for path in "${required[@]}"; do
    if [[ ! -e "${INFRAMONITOR_REPO_ROOT}/${path}" ]]; then
      printf 'FAIL  full mode needs %s and it is missing.\n' "$path" >&2
      ok=1
    fi
  done

  return "$ok"
}

# Print the ports full mode adds, with the values actually configured.
inframonitor_print_full_ports() {
  local spec var default desc value bind monitoring_bind grafana_bind
  monitoring_bind="$(inframonitor_read_env MONITORING_BIND)"; monitoring_bind="${monitoring_bind:-127.0.0.1}"
  grafana_bind="$(inframonitor_read_env GRAFANA_BIND)";       grafana_bind="${grafana_bind:-0.0.0.0}"
  for spec in "${INFRAMONITOR_FULL_PORT_SPECS[@]}"; do
    var="${spec%%:*}"
    desc="${spec##*:}"
    default="${spec#*:}"; default="${default%%:*}"
    value="$(inframonitor_read_env "$var")"; value="${value:-$default}"
    case "$var" in
      POSTGRES_PORT)  bind="127.0.0.1" ;;
      GRAFANA_PORT)   bind="$grafana_bind" ;;
      *)              bind="$monitoring_bind" ;;
    esac
    printf '    %-13s %s:%s\n' "$desc" "$bind" "$value"
  done
}
