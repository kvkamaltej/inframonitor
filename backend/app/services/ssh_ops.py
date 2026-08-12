from collections.abc import Iterator
from contextlib import contextmanager
from io import BytesIO, StringIO
import errno
import json
import posixpath
import re
import shlex
import stat
import time
import uuid

import paramiko

from app.models.entities import Server
from app.schemas.contracts import ContainerRead, CredentialPayload

_q = shlex.quote


class SshOperationError(RuntimeError):
    pass


class SudoPasswordRequired(RuntimeError):
    pass


def _client(server: Server, credentials: CredentialPayload) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs: dict = {
        "hostname": server.ip_address,
        "port": server.ssh_port,
        "username": server.username,
        "timeout": 8,
        "banner_timeout": 8,
        "auth_timeout": 8,
    }
    if credentials.private_key.strip():
        key_text = credentials.private_key.strip()
        last_error: Exception | None = None
        for key_class in (paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.DSSKey):
            try:
                kwargs["pkey"] = key_class.from_private_key(StringIO(key_text))
                break
            except Exception as exc:
                last_error = exc
        if "pkey" not in kwargs:
            raise SshOperationError(f"Unable to parse private key: {last_error}")
    elif credentials.password:
        kwargs["password"] = credentials.password
    client.connect(**kwargs)
    return client


def _exec_on(client: paramiko.SSHClient, command: str, stdin_data: str = "", timeout: int = 15) -> tuple[int, str, str]:
    """Run one command on an already-open client. Callers own the connection lifetime."""
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    if stdin_data:
        try:
            stdin.write(stdin_data)
            stdin.flush()
        except Exception:
            pass
    try:
        stdin.channel.shutdown_write()
    except Exception:
        pass
    output = stdout.read().decode("utf-8", errors="replace")
    error = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    return code, output, error


def _exec(server: Server, credentials: CredentialPayload, command: str, stdin_data: str = "", timeout: int = 15) -> tuple[int, str, str]:
    client: paramiko.SSHClient | None = None
    try:
        client = _client(server, credentials)
        return _exec_on(client, command, stdin_data, timeout)
    except Exception as exc:
        if isinstance(exc, SshOperationError):
            raise
        raise SshOperationError(str(exc)) from exc
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


# timeout is per-command, not global: 15s suits a single remote command, but the bulk
# discovery probe legitimately runs for tens of seconds and must not be trimmed to fit a
# limit meant for one-shot calls.
def run_command(server: Server, credentials: CredentialPayload, command: str, stdin_data: str = "", timeout: int = 15) -> str:
    code, output, error = _exec(server, credentials, command, stdin_data, timeout)
    if code != 0:
        raise SshOperationError(error.strip() or f"Command failed with exit code {code}")
    return output + error


# One round trip. CPU% needs two /proc/stat samples because the file holds cumulative
# jiffies since boot -- a single read would report the average since boot, not "now".
_VITALS_SH = r"""
read -r __up __idle < /proc/uptime 2>/dev/null || __up=0
echo UPTIME_SECONDS="${__up%%.*}"
echo LOAD_AVERAGE="$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '')"
echo CPU_CORES="$(nproc 2>/dev/null || echo 0)"
awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if(t>0){printf "RAM_TOTAL_MB=%d\nRAM_USED_MB=%d\n", int(t/1024), int((t-a)/1024)}}' /proc/meminfo 2>/dev/null
echo PROCESS_COUNT="$(ps -e 2>/dev/null | awk 'NR>1' | wc -l | tr -d ' ')"
__s1=$(awk '/^cpu /{print $2+$3+$4+$6+$7+$8, $5; exit}' /proc/stat 2>/dev/null)
sleep 1
__s2=$(awk '/^cpu /{print $2+$3+$4+$6+$7+$8, $5; exit}' /proc/stat 2>/dev/null)
echo CPU_PERCENT="$(echo "$__s1 $__s2" | awk '{b1=$1;i1=$2;b2=$3;i2=$4;db=b2-b1;di=i2-i1;t=db+di; if(t>0) printf "%d", (db*100)/t; else print ""}')"
exit 0
"""


def probe_vitals(server: Server, credentials: CredentialPayload) -> dict:
    output = run_command(server, credentials, f"sh -c {_q(_VITALS_SH)}")
    facts: dict[str, str] = {}
    for line in output.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            facts[key.strip()] = value.strip()
    return facts


def _int_or(value: str, fallback: int = 0) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return fallback


_SUDO_PROBE = "id -u 2>/dev/null; if sudo -n true 2>/dev/null; then echo SUDO_NOPASSWD; else echo SUDO_PASSWORD; fi"

_SUDO_AUTH_MARKERS = (
    "incorrect password",
    "sorry, try again",
    "authentication failure",
    "a password is required",
    "no password was provided",
    "password is required",
)


def _privilege_mode(server: Server, credentials: CredentialPayload) -> str:
    _, output, _ = _exec(server, credentials, _SUDO_PROBE)
    lines = [item.strip() for item in output.splitlines() if item.strip()]
    if lines and lines[0] == "0":
        return "root"
    if "SUDO_NOPASSWD" in lines:
        return "nopasswd"
    return "password"


def _is_sudo_auth_failure(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in _SUDO_AUTH_MARKERS)


def run_privileged(server: Server, credentials: CredentialPayload, command: str, sudo_password: str = "") -> str:
    mode = _privilege_mode(server, credentials)
    if mode == "root":
        return run_command(server, credentials, command)
    if mode == "nopasswd":
        return run_command(server, credentials, f"sudo -n sh -c {_q(command)}")
    if not sudo_password:
        raise SudoPasswordRequired(f"Sudo password required for {server.username}@{server.ip_address}")
    code, output, error = _exec(
        server,
        credentials,
        f"sudo -S -p '' sh -c {_q(command)}",
        stdin_data=sudo_password if sudo_password.endswith("\n") else sudo_password + "\n",
    )
    if code != 0:
        if _is_sudo_auth_failure(error) or _is_sudo_auth_failure(output):
            raise SshOperationError("Sudo authentication failed")
        raise SshOperationError(error.strip() or f"Command failed with exit code {code}")
    return output + error


_TOMCAT_SCAN_SH = r"""
if command -v systemctl >/dev/null 2>&1; then
  if [ -d /run/systemd/system ]; then
    echo 'SYSTEMD|running'
  else
    echo 'SYSTEMD|offline'
  fi
  __tc_units=$( { systemctl list-units --type=service --all --no-legend 'tomcat*' 2>/dev/null; systemctl list-unit-files --no-legend 'tomcat*' 2>/dev/null; } | awk '{for (i = 1; i <= NF; i++) if ($i ~ /\.service$/) { print $i; break }}' | sort -u | head -n 12 )
  for u in $__tc_units; do
    st=$(systemctl is-active "$u" 2>/dev/null || true)
    en=$(systemctl is-enabled "$u" 2>/dev/null || true)
    props=$(systemctl show -p MainPID -p Environment -p ExecStart -p User -p StandardOutput -p StandardError "$u" 2>/dev/null || true)
    mp=$(printf '%s\n' "$props" | sed -n 's/^MainPID=//p' | head -n 1)
    printf 'U|%s|%s|%s|%s\n' "$u" "$st" "$en" "${mp:-0}"
    printf '%s\n' "$props" | awk -v u="$u" '/^Environment=/ || /^ExecStart=/ || /^User=/ || /^StandardOutput=/ || /^StandardError=/ {print "UP|" u "|" $0}'
    n=${u%.service}
    for ef in "/etc/default/$n" "/etc/sysconfig/$n" "/etc/$n/$n.conf" "/etc/tomcat/tomcat.conf"; do
      if [ -r "$ef" ]; then
        awk -v u="$u" '/^[ \t]*(export[ \t]+)?(CATALINA_(BASE|HOME|OUT)|JAVA_HOME|TOMCAT_USER)=/ {print "UF|" u "|" $0}' "$ef" 2>/dev/null || true
      fi
    done
  done
fi
__tc_ps=$(ps -eo pid= -o args= 2>/dev/null | grep -E '[o]rg\.apache\.catalina\.startup\.(Bootstrap|Tomcat)|[-]Dcatalina\.(base|home)=' | head -n 20)
if [ -n "$__tc_ps" ]; then
  printf '%s\n' "$__tc_ps" | awk '{pid = $1; $1 = ""; sub(/^[ \t]+/, ""); print "P|" pid "|" $0}'
  printf '%s\n' "$__tc_ps" | awk '{print $1}' | while IFS= read -r tp; do
    to=$(stat -c '%U' "/proc/$tp" 2>/dev/null || true)
    [ -n "$to" ] && printf 'PO|%s|%s\n' "$tp" "$to"
  done
fi
for d in /opt/tomcat* /usr/share/tomcat* /var/lib/tomcat* /opt/apache-tomcat*; do
  [ -d "$d" ] || continue
  dh=0
  db=0
  if [ -f "$d/bin/catalina.sh" ] || [ -f "$d/lib/catalina.jar" ]; then dh=1; fi
  if [ -f "$d/conf/server.xml" ] && [ -d "$d/webapps" ]; then db=1; fi
  [ "$dh" = 1 ] || [ "$db" = 1 ] || continue
  printf 'D|%s|%s|%s\n' "$d" "$dh" "$db"
done
ss -ltnp 2>/dev/null | awk 'NR > 1 {print "SS|" $0}' | head -n 200
if command -v java >/dev/null 2>&1; then
  java -version 2>&1 | head -n 1 | awk '{print "JAVA|" $0}'
fi
"""

_TOMCAT_DETAIL_SH = r"""
if command -v timeout >/dev/null 2>&1; then __TMO='timeout 5'; else __TMO=''; fi
printf 'UNAME|%s %s (%s)\n' "$(uname -s 2>/dev/null)" "$(uname -r 2>/dev/null)" "$(uname -m 2>/dev/null)"
__tc_logfiles() {
  __lb="$1"
  __ld="$2"
  __lp="$3"
  __mk="$4"
  [ -d "$__ld" ] || return 0
  printf '%s|%s|%s\n' "$__mk" "$__lb" "$__ld"
  if [ -n "$__lp" ]; then
    find -H "$__ld" -maxdepth 1 -type f \( -name 'catalina.out' -o -name 'catalina*.log' -o -name 'localhost*.log' -o -name 'manager*.log' -o -name 'host-manager*.log' -o -name 'localhost_access_log*' -o -name "$__lp*" \) -print 2>/dev/null | head -n 48 | tr '\n' '\0' | xargs -0 -r stat -c 'L|%n|%s|%y|%Y' 2>/dev/null || true
  else
    find -H "$__ld" -maxdepth 1 -type f \( -name 'catalina.out' -o -name 'catalina*.log' -o -name 'localhost*.log' -o -name 'manager*.log' -o -name 'host-manager*.log' -o -name 'localhost_access_log*' \) -print 2>/dev/null | head -n 48 | tr '\n' '\0' | xargs -0 -r stat -c 'L|%n|%s|%y|%Y' 2>/dev/null || true
  fi
}
__tc_detail() {
  b="$1"
  h="$2"
  p="$3"
  jhh="$4"
  tu="$5"
  deep="$6"
  xlog="$7"
  [ -n "$h" ] || h="$b"
  v=""
  if [ -r "$h/RELEASE-NOTES" ]; then
    v=$(sed -n 's/.*Apache Tomcat Version *\([0-9][^ ]*\).*/Apache Tomcat\/\1/p' "$h/RELEASE-NOTES" 2>/dev/null | head -n 1)
  fi
  printf 'V|%s|%s\n' "$b" "$v"
  if [ "$deep" = 1 ] && [ -x "$h/bin/version.sh" ]; then
    CATALINA_HOME="$h" CATALINA_BASE="$b" $__TMO "$h/bin/version.sh" 2>/dev/null \
      | sed -n 's/^\([A-Za-z][A-Za-z ]*\):[[:blank:]]*\(.*\)$/\1|\2/p' | head -n 12 \
      | awk -v b="$b" '{print "VS|" b "|" $0}'
  fi
  if [ -r "$b/conf/server.xml" ]; then
    sed -n '/<!--/d; s/.*<Connector[^>]*[[:blank:]]port="\([0-9][0-9]*\)".*/\1/p' "$b/conf/server.xml" 2>/dev/null | head -n 8 | while IFS= read -r cp; do
      printf 'X|%s|%s\n' "$b" "$cp"
    done
  fi
  lgd=""
  lgp=""
  if [ -r "$b/conf/logging.properties" ]; then
    awk -v b="$b" '/FileHandler\./ || /^[[:blank:]]*\.?handlers[[:blank:]]*=/ {print "G|" b "|" $0}' "$b/conf/logging.properties" 2>/dev/null | head -n 60
    lgd=$(sed -n 's/^[[:blank:]]*[0-9]*catalina\.[A-Za-z0-9_.]*FileHandler\.directory[[:blank:]]*=[[:blank:]]*\(.*\)$/\1/p' "$b/conf/logging.properties" 2>/dev/null | head -n 1)
    lgp=$(sed -n 's/^[[:blank:]]*[0-9]*catalina\.[A-Za-z0-9_.]*FileHandler\.prefix[[:blank:]]*=[[:blank:]]*\(.*\)$/\1/p' "$b/conf/logging.properties" 2>/dev/null | head -n 1)
    lgd=$(printf '%s' "$lgd" | sed 's/[[:blank:]]*$//' | sed 's|${catalina.base}|@@CB@@|g; s|${catalina.home}|@@CH@@|g' | sed "s|@@CB@@|$b|g; s|@@CH@@|$h|g")
    lgp=$(printf '%s' "$lgp" | sed 's/[[:blank:]]*$//')
  fi
  if [ -z "$lgd" ] || [ "$lgd" = "$b/logs" ]; then
    __tc_logfiles "$b" "$b/logs" "$lgp" LB
  else
    __tc_logfiles "$b" "$b/logs" "" LB
    __tc_logfiles "$b" "$lgd" "$lgp" LD
  fi
  if [ -n "$xlog" ] && [ -f "$xlog" ]; then
    printf 'LD|%s|%s\n' "$b" "$(dirname "$xlog")"
    stat -c 'L|%n|%s|%y|%Y' "$xlog" 2>/dev/null || true
  fi
  if [ -d "$b/webapps" ]; then
    printf 'WB|%s|%s\n' "$b" "$b/webapps"
    ww=0
    if [ -w "$b/webapps" ]; then ww=1; fi
    printf 'WD|%s|%s|%s\n' "$b" "$(stat -c '%U:%G:%a' "$b/webapps" 2>/dev/null || printf '::')" "$ww"
    find -H "$b/webapps" -mindepth 1 -maxdepth 1 -print 2>/dev/null | head -n 60 | tr '\n' '\0' | xargs -0 -r stat -c 'W|%n|%F|%s|%y|%Y' 2>/dev/null || true
  fi
  jh="$jhh"
  jset=0
  if [ -n "$jhh" ]; then jset=1; fi
  if [ -n "$p" ] && [ -r "/proc/$p/environ" ]; then
    pj=$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | sed -n 's/^JAVA_HOME=//p' | head -n 1)
    if [ -n "$pj" ]; then jh="$pj"; jset=1; fi
  fi
  printf 'JS|%s|%s\n' "$b" "$jset"
  jbin=""
  if [ -n "$jh" ] && [ -x "$jh/bin/java" ]; then jbin="$jh/bin/java"; fi
  if [ -z "$jbin" ] && [ -x "$h/jre/bin/java" ]; then jbin="$h/jre/bin/java"; fi
  if [ -z "$jbin" ]; then jbin=$(command -v java 2>/dev/null || true); fi
  if [ -n "$jbin" ]; then
    printf 'JR|%s|%s\n' "$b" "$(readlink -f "$jbin" 2>/dev/null || printf '%s' "$jbin")"
    if [ "$deep" = 1 ]; then
      $__TMO "$jbin" -version 2>&1 | head -n 3 | awk -v b="$b" '{print "JV|" b "|" $0}'
    fi
  fi
  if [ -n "$jh" ]; then printf 'JH|%s|%s\n' "$b" "$jh"; fi
  if [ -n "$tu" ]; then
    printf 'TU|%s|%s\n' "$b" "$tu"
    printf 'TG|%s|%s\n' "$b" "$(id -nG "$tu" 2>/dev/null || true)"
  fi
}
"""

_TOMCAT_CONTROL_SH = r"""
export CATALINA_HOME CATALINA_BASE
for cand in "$CATALINA_BASE/tomcat.pid" "$CATALINA_BASE/CATALINA_PID" "$CATALINA_BASE/logs/catalina.pid" "$CATALINA_BASE/run/tomcat.pid"; do
  if [ -f "$cand" ]; then
    CATALINA_PID="$cand"
    export CATALINA_PID
    break
  fi
done
__alive() {
  [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null
}
__find_pid() {
  ps -eo pid= -o args= 2>/dev/null | grep -F -- "-Dcatalina.base=$CATALINA_BASE" | grep -E '[o]rg\.apache\.catalina\.startup\.' | awk '{print $1; exit}'
}
__stop() {
  if ! __alive; then
    echo TOMCAT_STOPPED
    return 0
  fi
  if [ -x "$CATALINA_HOME/bin/shutdown.sh" ]; then
    "$CATALINA_HOME/bin/shutdown.sh" >/dev/null 2>&1 || true
  fi
  i=0
  while [ $i -lt 6 ]; do
    __alive || break
    echo TOMCAT_WAIT
    sleep 1
    i=$((i + 1))
  done
  if __alive; then
    kill "$OLD" 2>/dev/null || true
    i=0
    while [ $i -lt 3 ]; do
      __alive || break
      echo TOMCAT_WAIT
      sleep 1
      i=$((i + 1))
    done
  fi
  if __alive; then
    echo TOMCAT_STOP_FAILED
    return 1
  fi
  echo TOMCAT_STOPPED
  return 0
}
__start() {
  if [ ! -x "$CATALINA_HOME/bin/startup.sh" ]; then
    echo TOMCAT_NO_SCRIPT
    return 1
  fi
  "$CATALINA_HOME/bin/startup.sh" >/dev/null 2>&1 || true
  i=0
  while [ $i -lt 5 ]; do
    NEW=$(__find_pid)
    if [ -n "$NEW" ]; then
      echo "TOMCAT_STARTED $NEW"
      return 0
    fi
    echo TOMCAT_WAIT
    sleep 1
    i=$((i + 1))
  done
  echo TOMCAT_START_FAILED
  return 1
}
[ -n "$OLD" ] || OLD=$(__find_pid)
"""

_DISCOVER_SH = r"""
echo OS="$(. /etc/os-release 2>/dev/null && echo ${PRETTY_NAME:-unknown})"
echo KERNEL="$(uname -r)"
echo ARCH="$(uname -m)"
echo CPU="$(nproc 2>/dev/null || echo 0)"
echo RAM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
echo DISK_GB="$(df -Pk / 2>/dev/null | awk 'NR == 2 {printf "%d\n", $2 / 1048576; f = 1} END {if (f != 1) print 0}')"
echo DOCKER="$(docker --version 2>/dev/null || true)"
echo PODMAN="$(podman --version 2>/dev/null || true)"
echo __OSRELEASE__
cat /etc/os-release 2>/dev/null || true
echo __OSEXTRA__
printf 'redhat_release=%s\n' "$(head -n 1 /etc/redhat-release 2>/dev/null || true)"
printf 'debian_version=%s\n' "$(head -n 1 /etc/debian_version 2>/dev/null || true)"
if [ ! -r /etc/os-release ]; then
  lsb_release -a 2>/dev/null | sed 's/^/lsb:/' || true
fi
echo __PKG__
for p in dnf yum apt-get zypper apk; do
  command -v "$p" >/dev/null 2>&1 && echo "$p"
done
echo __SERVICES__
# Patterns, not fixed names: distributions ship versioned units (postgresql@16-main on
# Debian, postgresql-16 on RHEL, mysqld vs mysql). Both listings are needed and neither
# alone is enough: list-units --all is the only one that sees *instantiated* template units
# such as postgresql@16-main.service, because an instance has no unit file of its own, while
# list-unit-files is the only one that sees installed units that were never loaded. Resolving
# every pattern in two calls rather than one call per pattern is also what keeps the added
# systemctl traffic inside the single 15s channel timeout. Quoted patterns are passed through
# to systemd, which does the globbing -- the shell must not expand them against the cwd.
if command -v systemctl >/dev/null 2>&1; then
  __svc_list() {
    systemctl "$@" \
      'docker.service' 'podman.service' 'postgresql*.service' 'mysql*.service' \
      'mariadb*.service' 'mongod*.service' 'redis*.service' 'valkey*.service' \
      'mssql-server*.service' 'oracle*.service' 'clickhouse-server*.service' \
      'cassandra*.service' 'influxd*.service' 'couchdb*.service' 'elasticsearch*.service' \
      'rabbitmq-server*.service' 'kafka*.service' 'nginx*.service' 'apache2*.service' \
      'httpd*.service' 'haproxy*.service' 2>/dev/null
  }
  # The first field of list-units can be a status bullet, so pick the .service field rather
  # than assuming column 1; drop bare templates, which cannot be queried for state.
  __svc_units=$( { __svc_list list-units --type=service --all --no-legend; \
                   __svc_list list-unit-files --no-legend; } \
                 | awk '{for (i = 1; i <= NF; i++) if ($i ~ /\.service$/) { print $i; break }}' \
                 | grep -v '@\.service$' | sort -u | head -n 24 )
  for unit in $__svc_units; do
    name=${unit%.service}
    state=$(systemctl is-active "$unit" 2>/dev/null || true)
    enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
    [ -n "$state" ] && printf '%s|systemd|%s|%s\n' "$name" "$state" "$enabled"
  done
fi
# `sqlplus`, `db2` and `couchdb` do not implement --version: they treat the argument as a
# connect string or pass it to a release runner, so they can sit waiting on input or start a
# server. Cap each one rather than let a single engine eat the whole channel timeout.
if command -v timeout >/dev/null 2>&1; then __VTMO='timeout 3'; else __VTMO=''; fi
for bin in psql postgres mysql mysqld mariadb mongod mongosh redis-server redis-cli valkey-server \
           sqlcmd clickhouse-client cqlsh influx couchdb sqlplus db2 \
           nginx apache2 httpd java python3 node; do
  path=$(command -v "$bin" 2>/dev/null || true)
  if [ -n "$path" ]; then
    version=$($__VTMO "$bin" --version 2>&1 </dev/null | head -n 1 || true)
    printf '%s|binary|present|%s\n' "$bin" "$version"
  fi
done
echo __STORAGE__
df -PT 2>/dev/null | awk 'NR>1 {print $1"|"$2"|"$3"|"$4"|"$5"|"$6"|"$7}'
echo __DBLOGS__
# $path is intentionally unquoted so the shell globs it; the guard is that these are
# fixed literals here, never anything from a request.
for item in \
  "postgresql|/var/log/postgresql/*.log" \
  "postgresql|/var/lib/pgsql/data/log/*.log" \
  "postgresql|/var/lib/pgsql/*/data/log/*.log" \
  "postgresql|/var/lib/pgsql/data/pg_log/*.log" \
  "mysql|/var/log/mysql/error.log" \
  "mysql|/var/log/mysqld.log" \
  "mysql|/var/log/mysql/*.err" \
  "mariadb|/var/log/mariadb/*.log" \
  "mongodb|/var/log/mongodb/*.log" \
  "redis|/var/log/redis/*.log" \
  "valkey|/var/log/valkey/*.log" \
  "mssql|/var/opt/mssql/log/errorlog" \
  "oracle|/opt/oracle/diag/rdbms/*/*/trace/alert_*.log" \
  "oracle|/u01/app/oracle/diag/rdbms/*/*/trace/alert_*.log" \
  "clickhouse|/var/log/clickhouse-server/clickhouse-server.log" \
  "cassandra|/var/log/cassandra/system.log" \
  "influxdb|/var/log/influxdb/*.log" \
  "couchdb|/var/log/couchdb/*.log" \
  "elasticsearch|/var/log/elasticsearch/*.log" \
  "db2|/home/db2inst1/sqllib/db2dump/db2diag.log"; do
  name=${item%%|*}
  path=${item#*|}
  ls $path >/dev/null 2>&1 && printf '%s|file|%s\n' "$name" "$path"
done
echo __TOMCAT__
"""


# Discovery is a bulk probe: two systemctl listings, per-unit state, ~23 capped version
# checks, df, the DB log globs and the Tomcat scan. Measured at 8.7s on one host, and it
# scales with how many units and engines are installed. The 15s default exists for one-shot
# commands; capping discovery at it would mean trimming detection breadth to fit a limit
# that was never about discovery.
DISCOVERY_TIMEOUT = 90


def discover_host(server: Server, credentials: CredentialPayload) -> dict:
    command = _DISCOVER_SH + _TOMCAT_SCAN_SH + "\nexit 0\n"
    output = run_command(server, credentials, command, timeout=DISCOVERY_TIMEOUT)
    result: dict[str, str] = {}
    services: list[dict] = []
    storage: list[dict] = []
    db_logs: list[dict] = []
    os_release: list[str] = []
    os_extra: list[str] = []
    packages: list[str] = []
    tomcat_lines: list[str] = []
    section = "facts"
    for line in output.splitlines():
        if line == "__OSRELEASE__":
            section = "osrelease"
            continue
        if line == "__OSEXTRA__":
            section = "osextra"
            continue
        if line == "__PKG__":
            section = "pkg"
            continue
        if line == "__SERVICES__":
            section = "services"
            continue
        if line == "__STORAGE__":
            section = "storage"
            continue
        if line == "__DBLOGS__":
            section = "dblogs"
            continue
        if line == "__TOMCAT__":
            section = "tomcat"
            continue
        if section == "facts" and "=" in line:
            key, value = line.split("=", 1)
            result[key] = value.strip()
        elif section == "osrelease":
            os_release.append(line)
        elif section == "osextra":
            os_extra.append(line)
        elif section == "pkg":
            text = line.strip()
            if text:
                packages.append(text)
        elif section == "tomcat":
            tomcat_lines.append(line)
        elif section == "services" and "|" in line:
            name, kind, state, detail = (line.split("|", 3) + [""])[:4]
            services.append({"name": name, "type": _service_type(name), "source": kind, "status": state or "present", "detail": detail})
        elif section == "storage" and "|" in line:
            parts = line.split("|")
            if len(parts) >= 7:
                storage.append({
                    "filesystem": parts[0],
                    "type": parts[1],
                    "blocks_1k": parts[2],
                    "used_1k": parts[3],
                    "available_1k": parts[4],
                    "used_percent": parts[5],
                    "mount": parts[6],
                    "status": _usage_status(parts[5]),
                    "size_bytes": _kib_to_bytes(parts[2]),
                    "used_bytes": _kib_to_bytes(parts[3]),
                    "available_bytes": _kib_to_bytes(parts[4]),
                    "used_percent_num": _percent_num(parts[5]),
                })
        elif section == "dblogs" and "|" in line:
            name, source, path = line.split("|", 2)
            db_logs.append({"database": name, "source": source, "path": path})
    result.update(_os_facts(os_release, os_extra, packages))
    instances = _tomcat_instances(tomcat_lines)
    if instances:
        try:
            _tomcat_apply_details(server, credentials, instances)
        except Exception:
            pass
    if not result.get("OS") or result.get("OS") == "unknown":
        if result.get("OS_NAME"):
            result["OS"] = result["OS_NAME"]
    result["SERVICES_JSON"] = json.dumps(services)
    result["STORAGE_JSON"] = json.dumps(storage)
    result["DB_LOGS_JSON"] = json.dumps(db_logs)
    result["TOMCAT_JSON"] = json.dumps(_strip_private(instances))
    return result


def _kib_to_bytes(value: str) -> str:
    try:
        blocks = int(float(str(value).strip()))
    except (TypeError, ValueError):
        return "0"
    if blocks < 0:
        return "0"
    return str(blocks * 1024)


def _percent_num(value: str) -> str:
    try:
        number = int(float(str(value).strip().rstrip("%")))
    except (TypeError, ValueError):
        return "0"
    return str(max(0, min(100, number)))


_OS_FAMILY_BY_ID = {
    "rhel": "rhel",
    "centos": "rhel",
    "rocky": "rhel",
    "almalinux": "rhel",
    "fedora": "rhel",
    "amzn": "rhel",
    "ol": "rhel",
    "oracle": "rhel",
    "scientific": "rhel",
    "ubuntu": "debian",
    "debian": "debian",
    "linuxmint": "debian",
    "mint": "debian",
    "raspbian": "debian",
    "pop": "debian",
    "sles": "suse",
    "sled": "suse",
    "suse": "suse",
    "alpine": "alpine",
}

_PKG_MANAGER_BY_BINARY = {
    "dnf": "dnf",
    "yum": "yum",
    "apt-get": "apt",
    "apt": "apt",
    "zypper": "zypper",
    "apk": "apk",
}

_PKG_MANAGER_ORDER = ("dnf", "yum", "apt-get", "apt", "zypper", "apk")


def _unquote(value: str) -> str:
    text = value.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1]
    return text.strip()


def _os_family(os_id: str, id_like: str) -> str:
    tokens = [os_id.strip().lower()] + [item for item in re.split(r"[\s,]+", id_like.lower()) if item]
    for token in tokens:
        if not token:
            continue
        if token in _OS_FAMILY_BY_ID:
            return _OS_FAMILY_BY_ID[token]
        if token.startswith("opensuse"):
            return "suse"
    return "unknown"


def _package_manager(binaries: list[str]) -> str:
    available = {item.strip() for item in binaries if item.strip()}
    for candidate in _PKG_MANAGER_ORDER:
        if candidate in available:
            return _PKG_MANAGER_BY_BINARY[candidate]
    return ""


def _os_facts(os_release: list[str], os_extra: list[str], packages: list[str]) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in os_release:
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        fields[key.strip().upper()] = _unquote(value)

    extra: dict[str, str] = {}
    lsb: dict[str, str] = {}
    for line in os_extra:
        text = line.strip()
        if text.startswith("lsb:"):
            body = text[4:]
            if ":" in body:
                key, value = body.split(":", 1)
                lsb[key.strip().lower()] = value.strip()
            continue
        if "=" in text:
            key, value = text.split("=", 1)
            extra[key.strip().lower()] = value.strip()

    os_id = fields.get("ID", "")
    id_like = fields.get("ID_LIKE", "")
    version_id = fields.get("VERSION_ID", "")
    name = fields.get("PRETTY_NAME", "") or fields.get("NAME", "")

    redhat_release = extra.get("redhat_release", "")
    if redhat_release:
        if not name:
            name = redhat_release
        if not os_id:
            lowered = redhat_release.lower()
            for token in ("centos", "rocky", "almalinux", "fedora", "oracle", "scientific"):
                if token in lowered:
                    os_id = "ol" if token == "oracle" else token
                    break
            else:
                os_id = "rhel"
        if not version_id:
            match = re.search(r"release\s+([0-9]+(?:\.[0-9]+)*)", redhat_release, re.IGNORECASE)
            if match:
                version_id = match.group(1)

    debian_version = extra.get("debian_version", "")
    if debian_version:
        if not os_id:
            os_id = "debian"
        if not version_id:
            version_id = debian_version
        if not name:
            name = f"Debian GNU/Linux {debian_version}"

    if lsb:
        if not os_id and lsb.get("distributor id"):
            os_id = lsb["distributor id"].strip().lower().replace(" ", "")
        if not version_id and lsb.get("release"):
            version_id = lsb["release"]
        if not name:
            name = lsb.get("description", "") or lsb.get("distributor id", "")

    family = _os_family(os_id, id_like)
    manager = _package_manager(packages)
    return {
        "OS_ID": os_id,
        "OS_ID_LIKE": id_like,
        "OS_VERSION_ID": version_id,
        "OS_NAME": name,
        "OS_FAMILY": family,
        "OS_DISTRO": os_id,
        "PKG_MANAGER": manager,
    }


# Prefixes, not exact names. Distributions ship versioned and instantiated units --
# postgresql-16 on RHEL, postgresql@16-main on Debian, mysqld vs mysql, redis-server@6379 --
# and an exact-match set silently drops every one of them. That matters because the UI only
# shows the Database Logs tab when a discovered service has type == "database", so an
# unclassified engine is an invisible engine.
_DATABASE_PREFIXES = (
    "postgres",       # postgresql, postgresql-16, postgresql@16-main, postgres
    "psql",
    "pgsql",
    "mysql",          # mysql, mysqld, mysql@..., mysql-8.0
    "mariadb",
    "mongo",          # mongod, mongodb, mongosh
    "redis",          # redis, redis-server, redis-server@6379
    "valkey",         # valkey, valkey-server
    "mssql",          # mssql-server
    "sqlservr",
    "sqlcmd",
    "oracle",
    "sqlplus",
    "clickhouse",     # clickhouse-server, clickhouse-client
    "cassandra",
    "cqlsh",
    "influx",         # influxd, influxdb, influx
    "couchdb",
    "db2",
    "elasticsearch",
)
_CONTAINER_PREFIXES = ("docker", "podman")
_WEB_PREFIXES = ("nginx", "apache2", "httpd", "haproxy")
_QUEUE_PREFIXES = ("rabbitmq", "kafka")
_APP_PREFIXES = ("java", "python", "node")


def _normalise_service_name(name: str) -> str:
    """Lower-case, drop a `.service` suffix, and keep only the unit's template stem.

    `postgresql@16-main.service` -> `postgresql`, `Redis-Server@6379` -> `redis-server`.
    Version suffixes such as `-16` are deliberately left alone: prefix matching already
    absorbs them, and stripping trailing digits would turn `db2` into `db`.
    """
    text = (name or "").strip().lower()
    if text.endswith(".service"):
        text = text[: -len(".service")]
    text = text.split("@", 1)[0]
    return text.strip(" -_.")


def _service_type(name: str) -> str:
    text = _normalise_service_name(name)
    if not text:
        return "service"
    for prefixes, label in (
        (_DATABASE_PREFIXES, "database"),
        (_CONTAINER_PREFIXES, "container"),
        (_WEB_PREFIXES, "web"),
        (_QUEUE_PREFIXES, "queue"),
        (_APP_PREFIXES, "application"),
    ):
        if text.startswith(prefixes):
            return label
    return "service"


def _usage_status(percent: str) -> str:
    try:
        value = int(percent.strip().rstrip("%"))
    except ValueError:
        return "unknown"
    if value >= 90:
        return "critical"
    if value >= 80:
        return "warning"
    return "healthy"


_TOMCAT_ACTIONS = ("restart", "start", "stop", "status")

_TOMCAT_LOG_KEYS = (
    "name",
    "unit",
    "source",
    "status",
    "enabled",
    "pid",
    "catalina_base",
    "catalina_home",
    "log_dir",
    "version",
    "java",
    "ports",
    "server_number",
    "jvm_version",
    "jvm_vendor",
    "os_name",
    "java_home",
    "configured_log_dir",
    "configured_log_prefix",
    "primary_log_file",
)


def _blank_tomcat() -> dict:
    item: dict = {key: "" for key in _TOMCAT_LOG_KEYS}
    item["status"] = "unknown"
    item["log_files"] = []
    item["webapps"] = []
    item["prerequisites"] = []
    return item


def _basename(path: str) -> str:
    text = path.rstrip("/")
    if not text:
        return ""
    return text.rsplit("/", 1)[-1]


def _catalina_paths(text: str) -> tuple[str, str]:
    base = ""
    home = ""
    for pattern, target in (
        (r"-Dcatalina\.base=(\"[^\"]+\"|'[^']+'|[^\s\"']+)", "base"),
        (r"-Dcatalina\.home=(\"[^\"]+\"|'[^']+'|[^\s\"']+)", "home"),
        (r"\bCATALINA_BASE=(\"[^\"]*\"|'[^']*'|[^\s;\"']*)", "base"),
        (r"\bCATALINA_HOME=(\"[^\"]*\"|'[^']*'|[^\s;\"']*)", "home"),
    ):
        if target == "base" and base:
            continue
        if target == "home" and home:
            continue
        match = re.search(pattern, text)
        if not match:
            continue
        value = _unquote(match.group(1))
        if not value.startswith("/"):
            continue
        if target == "base":
            base = value
        else:
            home = value
    return base, home


def _env_value(text: str, name: str) -> str:
    match = re.search(rf"\b{re.escape(name)}=(\"[^\"]*\"|'[^']*'|[^\s;\"']*)", text)
    if not match:
        return ""
    return _unquote(match.group(1))


def _standard_output_path(text: str) -> str:
    """systemd StandardOutput=append:/var/log/tomcat/catalina.out -> the path."""
    for match in re.finditer(r"^Standard(?:Output|Error)=(\S+)", text, re.MULTILINE):
        value = match.group(1)
        for scheme in ("append:", "file:", "truncate:"):
            if value.startswith(scheme):
                candidate = value[len(scheme):]
                if candidate.startswith("/"):
                    return candidate
    return ""


def _java_label(text: str) -> str:
    body = text.strip()
    match = re.search(r"^(\S+)\s+version\s+\"([^\"]+)\"", body)
    if match:
        return f"{match.group(1)} {match.group(2)}"
    return body


_LOGGING_PROP_KEYS = ("directory", "prefix", "suffix", "rotatable", "maxdays")


def _properties_pairs(text: str) -> list[tuple[str, str]]:
    """Parse java.util.Properties-ish text, honouring comments and backslash continuations."""
    pairs: list[tuple[str, str]] = []
    pending = ""
    for raw in text.splitlines():
        line = pending + raw.lstrip() if pending else raw
        pending = ""
        stripped = line.strip()
        if not stripped or stripped[0] in "#!":
            continue
        # A single trailing backslash continues the logical line; a doubled one is a literal.
        if stripped.endswith("\\") and not stripped.endswith("\\\\"):
            pending = stripped[:-1]
            continue
        if "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        pairs.append((key.strip(), value.strip()))
    return pairs


def _expand_catalina(value: str, catalina_base: str, catalina_home: str) -> str:
    text = value
    if catalina_base:
        text = text.replace("${catalina.base}", catalina_base)
    if catalina_home or catalina_base:
        text = text.replace("${catalina.home}", catalina_home or catalina_base)
    return text.rstrip("/") if text not in ("", "/") else text


def parse_logging_properties(text: str, catalina_base: str = "", catalina_home: str = "") -> dict:
    """Resolve the juli FileHandler directory/prefix Tomcat is configured to write.

    `catalina.out` is deliberately not considered here: it is produced by the shell
    redirect in catalina.sh (or a systemd StandardOutput=), never by logging.properties.
    """
    handlers: dict[str, dict[str, str]] = {}
    order: list[str] = []
    declared: list[str] = []
    for key, value in _properties_pairs(text):
        lowered = key.lower()
        if lowered in ("handlers", ".handlers"):
            declared.extend(item.strip() for item in value.split(",") if item.strip())
            continue
        for prop in _LOGGING_PROP_KEYS:
            if not lowered.endswith("." + prop):
                continue
            handler = key[: -(len(prop) + 1)]
            if "filehandler" not in handler.lower():
                break
            if handler not in handlers:
                handlers[handler] = {}
                order.append(handler)
            handlers[handler][prop] = value
            break

    chosen = ""
    for handler in declared:
        if handler in handlers and "catalina" in handler.lower():
            chosen = handler
            break
    if not chosen:
        for handler in order:
            if "catalina" in handler.lower():
                chosen = handler
                break
    if not chosen:
        for handler in declared:
            if handler in handlers:
                chosen = handler
                break
    if not chosen and order:
        chosen = order[0]

    props = handlers.get(chosen, {})
    directory = _expand_catalina(props.get("directory", ""), catalina_base, catalina_home)
    if not directory and catalina_base:
        # juli's documented default when the handler omits .directory
        directory = f"{catalina_base.rstrip('/')}/logs"
    return {
        "handler": chosen,
        "directory": directory,
        "prefix": props.get("prefix", ""),
        "suffix": props.get("suffix", ""),
        "handlers": order,
    }


_JAVA_VENDOR_TOKENS = (
    ("temurin", "Eclipse Temurin"),
    ("adoptopenjdk", "AdoptOpenJDK"),
    ("zulu", "Azul Zulu"),
    ("corretto", "Amazon Corretto"),
    ("graalvm", "GraalVM"),
    ("semeru", "IBM Semeru"),
    ("openj9", "Eclipse OpenJ9"),
    ("sapmachine", "SapMachine"),
    ("liberica", "BellSoft Liberica"),
    ("dragonwell", "Alibaba Dragonwell"),
    ("microsoft", "Microsoft"),
    ("red_hat", "Red Hat"),
    ("red hat", "Red Hat"),
    ("redhat", "Red Hat"),
    ("ubuntu", "Ubuntu"),
    ("debian", "Debian"),
    ("amazon", "Amazon"),
)


def java_major(version: str) -> int:
    """8 from `1.8.0_402`, 11 from `11.0.22`, 21 from `21.0.11`, 22 from `22-ea`."""
    text = (version or "").strip()
    match = re.match(r"^1\.(\d+)", text)
    if match:
        return int(match.group(1))
    match = re.match(r"^(\d+)", text)
    if match:
        return int(match.group(1))
    return 0


def parse_java_version(text: str) -> dict:
    """Read the 1-3 line banner emitted by `java -version` (which prints to stderr)."""
    body = (text or "").strip()
    version = ""
    match = re.search(r'version\s+"([^"]+)"', body)
    if match:
        version = match.group(1).strip()
    else:
        match = re.search(r"\bversion\s+(\d[\w.+\-]*)", body)
        if match:
            version = match.group(1).strip()
    lowered = body.lower()
    vendor = ""
    for token, label in _JAVA_VENDOR_TOKENS:
        if token in lowered:
            vendor = label
            break
    if not vendor:
        if "java(tm)" in lowered or "hotspot(tm)" in lowered:
            vendor = "Oracle"
        elif "openjdk" in lowered:
            vendor = "OpenJDK"
    return {
        "version": version,
        "vendor": vendor,
        "major": java_major(version),
        "label": _java_label(body.splitlines()[0]) if body else "",
    }


# Minimum Java major per Tomcat series, from the Apache "Which version" matrix.
_TOMCAT_JAVA_MIN = {
    "6.0": 5,
    "7.0": 6,
    "8.0": 7,
    "8.5": 7,
    "9.0": 8,
    "10.0": 8,
    "10.1": 11,
    "11.0": 17,
    "12.0": 21,
}


def tomcat_series(version: str) -> str:
    match = re.search(r"(\d+)\.(\d+)", version or "")
    if not match:
        return ""
    return f"{match.group(1)}.{match.group(2)}"


def required_java_major(version: str) -> int:
    """0 when the Tomcat version is unknown, so callers can report `unknown`."""
    series = tomcat_series(version)
    if not series:
        return 0
    if series in _TOMCAT_JAVA_MIN:
        return _TOMCAT_JAVA_MIN[series]
    major = int(series.split(".")[0])
    if major >= 12:
        return 21
    if major == 11:
        return 17
    if major == 10:
        return 11
    if major == 9:
        return 8
    if major == 8:
        return 7
    if major == 7:
        return 6
    return 0


def _mode_writable(owner: str, group: str, mode: str, user: str, groups: list[str]) -> str:
    """yes/no/unknown for "can `user` write this path", from stat -c '%U:%G:%a'."""
    digits = "".join(ch for ch in (mode or "") if ch.isdigit())
    if not digits or not user:
        return "unknown"
    bits = digits[-3:].rjust(3, "0")
    try:
        own, grp, other = int(bits[0]), int(bits[1]), int(bits[2])
    except ValueError:
        return "unknown"
    if user == "root":
        return "yes"
    if other & 2:
        return "yes"
    if owner and user == owner:
        return "yes" if own & 2 else "no"
    if group and (group == user or group in groups):
        return "yes" if grp & 2 else "no"
    return "no"


def _tomcat_prerequisites(
    version: str,
    java_info: dict,
    java_home: str,
    java_home_set: bool,
    webapps: dict,
    tomcat_user: str,
    tomcat_groups: list[str],
) -> list[dict]:
    required = required_java_major(version)
    detected_major = int(java_info.get("major") or 0)
    detected_text = " ".join(part for part in (java_info.get("vendor", ""), java_info.get("version", "")) if part)
    if detected_major <= 0:
        java_status = "missing"
    elif required <= 0:
        java_status = "unknown"
    elif detected_major >= required:
        java_status = "ok"
    else:
        java_status = "unsupported"
    entries: list[dict] = [{
        "name": "Java runtime",
        "required": f"Java {required}+" if required else "unknown (Tomcat version undetermined)",
        "detected": detected_text or "not found",
        "status": java_status,
    }]

    if java_home_set and java_home:
        home_status = "ok"
        home_detected = java_home
    elif java_home:
        home_status = "unknown"
        home_detected = f"{java_home} (inferred from java on PATH; JAVA_HOME not set for this instance)"
    else:
        home_status = "missing"
        home_detected = "not set"
    entries.append({
        "name": "JAVA_HOME",
        "required": "set for the Tomcat process",
        "detected": home_detected,
        "status": home_status,
    })

    if webapps.get("present"):
        owner = webapps.get("owner", "")
        group = webapps.get("group", "")
        mode = webapps.get("mode", "")
        verdict = _mode_writable(owner, group, mode, tomcat_user, tomcat_groups)
        detail = f"{owner or '?'}:{group or '?'} mode {mode or '?'}"
        if verdict == "yes":
            web_status = "ok"
        elif verdict == "no":
            web_status = "unsupported"
        else:
            web_status = "unknown"
        entries.append({
            "name": "webapps directory writable",
            "required": f"writable by {tomcat_user}" if tomcat_user else "writable by the Tomcat user",
            "detected": detail,
            "status": web_status,
        })
    else:
        entries.append({
            "name": "webapps directory writable",
            "required": f"writable by {tomcat_user}" if tomcat_user else "writable by the Tomcat user",
            "detected": "webapps directory not found",
            "status": "missing",
        })
    return entries


def _version_from_path(*paths: str) -> str:
    for path in paths:
        if not path:
            continue
        match = re.search(r"tomcat[-/]?([0-9]+(?:\.[0-9]+){1,3})", path, re.IGNORECASE)
        if match:
            return f"Apache Tomcat/{match.group(1)}"
    return ""


def _ports_for_pid(ss_lines: list[str], pid: str) -> str:
    if not pid or pid == "0":
        return ""
    ports: list[str] = []
    for line in ss_lines:
        if f"pid={pid}," not in line and f"pid={pid})" not in line:
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        port = parts[3].rsplit(":", 1)[-1]
        if port.isdigit() and port not in ports:
            ports.append(port)
    return ", ".join(sorted(ports, key=int))


def _same_install(existing: dict, base: str, home: str, pid: str) -> bool:
    if pid and existing.get("pid") == pid:
        return True
    if base and existing.get("catalina_base") == base:
        return True
    if not base and home and existing.get("catalina_home") == home:
        return True
    if existing.get("_base_is_home") and home and existing.get("catalina_base") == home:
        return True
    return False


def _match_install(instances: list[dict], base: str, home: str, pid: str = "") -> int:
    for index, existing in enumerate(instances):
        if _same_install(existing, base, home, pid):
            return index
    return -1


def _absorb_runtime(target: dict, base: str, home: str, pid: str, status: str, ports: str, owner: str) -> None:
    if base and (not target.get("catalina_base") or target.get("_base_is_home")):
        target["catalina_base"] = base
        target["_base_is_home"] = False
    if home and not target.get("catalina_home"):
        target["catalina_home"] = home
    if pid and not target.get("pid"):
        target["pid"] = pid
    if ports and not target.get("ports"):
        target["ports"] = ports
    if owner and not target.get("_owner"):
        target["_owner"] = owner
    if status and target.get("status") in ("", "unknown"):
        target["status"] = status


def _strip_private(instances: list[dict]) -> list[dict]:
    return [{key: value for key, value in item.items() if not key.startswith("_")} for item in instances]


def _unique_names(instances: list[dict]) -> None:
    used: set[str] = set()
    for index, item in enumerate(instances):
        name = item.get("name", "").strip()
        if not name:
            name = _basename(item.get("catalina_base", "")) or _basename(item.get("catalina_home", ""))
        if not name and item.get("pid"):
            name = f"tomcat-{item['pid']}"
        if not name:
            name = f"tomcat-{index + 1}"
        if name in used:
            if item.get("pid"):
                name = f"{name}-{item['pid']}"
            suffix = 2
            candidate = name
            while candidate in used:
                candidate = f"{name}-{suffix}"
                suffix += 1
            name = candidate
        used.add(name)
        item["name"] = name


def _dir_for_unit(dirs: list[dict], short: str, flag: str) -> str:
    for entry in dirs:
        if entry[flag] and _basename(entry["path"]) == short:
            return entry["path"]
    return ""


def _tomcat_instances(lines: list[str]) -> list[dict]:
    units: list[str] = []
    unit_meta: dict[str, tuple[str, str, str]] = {}
    unit_text: dict[str, list[str]] = {}
    procs: list[tuple[str, str]] = []
    owners: dict[str, str] = {}
    dirs: list[dict] = []
    ss_lines: list[str] = []
    java = ""
    systemd = ""
    for line in lines:
        if line.startswith("U|"):
            parts = (line.split("|", 4) + ["", "", "", ""])[:5]
            unit = parts[1].strip()
            if not unit:
                continue
            if unit not in unit_meta:
                units.append(unit)
            unit_meta[unit] = (parts[2].strip(), parts[3].strip(), parts[4].strip())
            unit_text.setdefault(unit, [])
        elif line.startswith("UP|") or line.startswith("UF|"):
            parts = line.split("|", 2)
            if len(parts) == 3:
                unit_text.setdefault(parts[1].strip(), []).append(parts[2])
        elif line.startswith("P|"):
            parts = line.split("|", 2)
            if len(parts) == 3 and parts[1].strip().isdigit():
                procs.append((parts[1].strip(), parts[2]))
        elif line.startswith("PO|"):
            parts = line.split("|", 2)
            if len(parts) == 3 and parts[1].strip().isdigit():
                owners[parts[1].strip()] = parts[2].strip()
        elif line.startswith("D|"):
            parts = (line.split("|", 3) + ["", "", ""])[:4]
            path = parts[1].strip()
            if path and path not in [entry["path"] for entry in dirs]:
                dirs.append({
                    "path": path,
                    "is_home": parts[2].strip() == "1",
                    "is_base": parts[3].strip() == "1",
                })
        elif line.startswith("SS|"):
            ss_lines.append(line[3:])
        elif line.startswith("SYSTEMD|"):
            systemd = line.split("|", 1)[1].strip()
        elif line.startswith("JAVA|"):
            if not java:
                java = _java_label(line[5:])

    proc_args = dict(procs)
    instances: list[dict] = []

    for unit in units:
        status, enabled, pid = unit_meta.get(unit, ("", "", "0"))
        if pid in ("", "0"):
            pid = ""
        blob = "\n".join(unit_text.get(unit, []))
        if pid and pid in proc_args:
            blob = blob + "\n" + proc_args[pid]
        base, home = _catalina_paths(blob)
        short = unit[:-8] if unit.endswith(".service") else unit
        if not base:
            base = _dir_for_unit(dirs, short, "is_base")
        if not home:
            home = _dir_for_unit(dirs, short, "is_home")
        base_is_home = False
        if not base and home:
            base = home
            base_is_home = True
        item = _blank_tomcat()
        item["name"] = short
        item["unit"] = unit
        item["source"] = "systemd"
        item["status"] = status or "unknown"
        item["enabled"] = enabled
        item["pid"] = pid
        item["catalina_base"] = base
        item["catalina_home"] = home or base
        item["java"] = java
        item["ports"] = _ports_for_pid(ss_lines, pid)
        item["_base_is_home"] = base_is_home
        item["_owner"] = owners.get(pid, "")
        item["_systemd"] = systemd
        item["_java_home_hint"] = _env_value(blob, "JAVA_HOME")
        item["_unit_user"] = _env_value(blob, "User") or _env_value(blob, "TOMCAT_USER")
        item["_std_out"] = _standard_output_path(blob) or _env_value(blob, "CATALINA_OUT")
        instances.append(item)

    for pid, args in procs:
        base, home = _catalina_paths(args)
        if not base and not home:
            continue
        ports = _ports_for_pid(ss_lines, pid)
        owner = owners.get(pid, "")
        found = _match_install(instances, base, home, pid)
        if found >= 0:
            _absorb_runtime(instances[found], base, home, pid, "running", ports, owner)
            continue
        item = _blank_tomcat()
        item["name"] = _basename(base or home)
        item["source"] = "process"
        item["status"] = "running"
        item["pid"] = pid
        item["catalina_base"] = base or home
        item["catalina_home"] = home or base
        item["java"] = java
        item["ports"] = ports
        item["_base_is_home"] = not base
        item["_owner"] = owner
        item["_systemd"] = systemd
        item["_java_home_hint"] = ""
        item["_unit_user"] = ""
        item["_std_out"] = ""
        instances.append(item)

    known_paths: set[str] = set()
    for item in instances:
        known_paths.add(item.get("catalina_base", ""))
        known_paths.add(item.get("catalina_home", ""))
    for entry in dirs:
        if not entry["is_base"] and not entry["is_home"]:
            continue
        path = entry["path"]
        if path in known_paths:
            continue
        base = path if entry["is_base"] else ""
        home = path if entry["is_home"] else ""
        if _match_install(instances, base, home) >= 0:
            continue
        base_is_home = False
        if not base:
            base = home
            base_is_home = True
        item = _blank_tomcat()
        item["name"] = _basename(path)
        item["source"] = "process"
        item["status"] = "unknown"
        item["catalina_base"] = base
        item["catalina_home"] = home or base
        item["java"] = java
        item["_base_is_home"] = base_is_home
        item["_owner"] = ""
        item["_systemd"] = systemd
        item["_java_home_hint"] = ""
        item["_unit_user"] = ""
        item["_std_out"] = ""
        instances.append(item)

    for item in instances:
        if not item.get("version"):
            item["version"] = _version_from_path(item.get("catalina_home", ""), item.get("catalina_base", ""))
    _unique_names(instances)
    return instances


_DETAIL_MAX_BASES = 8
# version.sh and `java -version` each fork a JVM, so only the first few instances get the
# deep probe. Everything past that falls back to RELEASE-NOTES and the path-derived version,
# which keeps the whole detail pass inside the 15s channel timeout.
_DETAIL_DEEP_BASES = 5
_LOG_FILE_CAP = 26


def _detail_specs(instances: list[dict]) -> list[dict]:
    specs: dict[str, dict] = {}
    for item in instances:
        base = item.get("catalina_base", "")
        if not base:
            continue
        spec = specs.get(base)
        if spec is None:
            spec = {"base": base, "home": "", "pid": "", "java_home": "", "user": "", "std_out": ""}
            specs[base] = spec
        spec["home"] = spec["home"] or item.get("catalina_home", "") or base
        spec["pid"] = spec["pid"] or item.get("pid", "")
        spec["java_home"] = spec["java_home"] or item.get("_java_home_hint", "")
        spec["user"] = spec["user"] or item.get("_owner", "") or item.get("_unit_user", "")
        spec["std_out"] = spec["std_out"] or item.get("_std_out", "")
    return list(specs.values())[:_DETAIL_MAX_BASES]


def _parse_detail_output(output: str) -> dict:
    data: dict = {
        "uname": "",
        "release_versions": {},
        "version_sh": {},
        "xml_ports": {},
        "log_dirs": {},
        "log_files": {},
        "logging_props": {},
        "webapps_meta": {},
        "webapps": {},
        "java_home": {},
        "java_home_set": {},
        "java_real": {},
        "java_version": {},
        "tomcat_user": {},
        "tomcat_groups": {},
    }
    log_current = ""
    web_current = ""
    for line in output.splitlines():
        if line.startswith("UNAME|"):
            data["uname"] = line.split("|", 1)[1].strip()
            continue
        parts = line.split("|", 2)
        if len(parts) < 2:
            continue
        tag = parts[0]
        base = parts[1]
        value = parts[2] if len(parts) == 3 else ""
        if tag == "V":
            if value.strip():
                data["release_versions"][base] = value.strip()
        elif tag == "VS":
            key, _, detail = value.partition("|")
            if key.strip():
                data["version_sh"].setdefault(base, {})[key.strip()] = detail.strip()
        elif tag == "X":
            port = value.strip()
            if port.isdigit():
                ports = data["xml_ports"].setdefault(base, [])
                if port not in ports:
                    ports.append(port)
        elif tag in ("LB", "LD"):
            log_current = base
            data["log_files"].setdefault(base, [])
            if tag == "LB" and value.strip():
                data["log_dirs"][base] = value.strip()
        elif tag == "L" and log_current:
            # L|<path>|<size>|<mtime>|<epoch> -- `base` here is really the path
            fields = line.split("|", 4)
            if len(fields) < 5:
                continue
            try:
                epoch = int(float(fields[4].strip()))
            except (TypeError, ValueError):
                epoch = 0
            data["log_files"].setdefault(log_current, []).append({
                "name": _basename(fields[1]),
                "path": fields[1],
                "size_bytes": fields[2].strip() if fields[2].strip().isdigit() else "0",
                "modified": fields[3].strip()[:16],
                "_epoch": epoch,
            })
        elif tag == "G":
            data["logging_props"].setdefault(base, []).append(value)
        elif tag == "WB":
            web_current = base
            data["webapps"].setdefault(base, [])
        elif tag == "WD":
            owner_group_mode, _, writable = value.partition("|")
            chunks = owner_group_mode.split(":")
            data["webapps_meta"][base] = {
                "present": True,
                "owner": chunks[0] if len(chunks) > 0 else "",
                "group": chunks[1] if len(chunks) > 1 else "",
                "mode": chunks[2] if len(chunks) > 2 else "",
                "ssh_writable": writable.strip() == "1",
            }
        elif tag == "W" and web_current:
            # W|<path>|<%F>|<size>|<mtime>|<epoch>
            fields = line.split("|", 5)
            if len(fields) < 6:
                continue
            path = fields[1]
            kind = fields[2].strip().lower()
            if "directory" in kind:
                app_type = "dir"
            elif path.lower().endswith(".war"):
                app_type = "war"
            else:
                continue
            try:
                epoch = int(float(fields[5].strip()))
            except (TypeError, ValueError):
                epoch = 0
            data["webapps"].setdefault(web_current, []).append({
                "name": _basename(path),
                "path": path,
                "type": app_type,
                "size_bytes": fields[3].strip() if fields[3].strip().isdigit() else "0",
                "modified": fields[4].strip()[:16],
                "_epoch": epoch,
            })
        elif tag == "JS":
            data["java_home_set"][base] = value.strip() == "1"
        elif tag == "JR":
            data["java_real"][base] = value.strip()
        elif tag == "JV":
            data["java_version"].setdefault(base, []).append(value)
        elif tag == "JH":
            data["java_home"][base] = value.strip()
        elif tag == "TU":
            data["tomcat_user"][base] = value.strip()
        elif tag == "TG":
            data["tomcat_groups"][base] = [item for item in value.split() if item]
    return data


def _java_home_from_binary(real_path: str) -> str:
    path = (real_path or "").strip()
    if not path.endswith("/bin/java"):
        return ""
    home = path[: -len("/bin/java")]
    if home.endswith("/jre"):
        home = home[: -len("/jre")]
    return home


def _pick_log_files(entries: list[dict], prefix: str) -> tuple[list[dict], str]:
    """Order log files newest-first and choose the file an operator should tail.

    catalina.out wins when present because it carries stdout/stderr (it comes from the
    catalina.sh redirect or a systemd StandardOutput=, never from logging.properties);
    otherwise the newest file matching the configured juli prefix. The chosen file and the
    newest configured-prefix matches are always kept in the returned list, because
    routes.py allowlists viewable log paths against log_files[] -- anything missing here
    would be rejected with a 400 by the log viewer.
    """
    seen: set[str] = set()
    unique: list[dict] = []
    for row in sorted(entries, key=lambda item: item["_epoch"], reverse=True):
        if row["path"] in seen:
            continue
        seen.add(row["path"])
        unique.append(row)

    primary = ""
    for row in unique:
        if row["name"] == "catalina.out":
            primary = row["path"]
            break
    prefix_matches = [row for row in unique if prefix and row["name"].startswith(prefix)]
    if not primary and prefix_matches:
        primary = prefix_matches[0]["path"]
    if not primary and unique:
        primary = unique[0]["path"]

    keep = {row["path"] for row in unique[:20]}
    keep.update(row["path"] for row in prefix_matches[:5])
    if primary:
        keep.add(primary)
    ordered = [row for row in unique if row["path"] in keep]
    return ordered[:_LOG_FILE_CAP], primary


def _tomcat_apply_details(server: Server, credentials: CredentialPayload, instances: list[dict]) -> None:
    specs = _detail_specs(instances)
    if not specs:
        return
    command = [_TOMCAT_DETAIL_SH]
    for index, spec in enumerate(specs):
        deep = "1" if index < _DETAIL_DEEP_BASES else "0"
        command.append(
            "__tc_detail "
            f"{_q(spec['base'])} {_q(spec['home'])} {_q(spec['pid'])} "
            f"{_q(spec['java_home'])} {_q(spec['user'])} {deep} {_q(spec['std_out'])}"
        )
    command.append("exit 0")
    output = run_command(server, credentials, "\n".join(command))
    data = _parse_detail_output(output)

    for item in instances:
        base = item.get("catalina_base", "")
        if not base:
            continue
        version_sh = data["version_sh"].get(base, {})

        version = version_sh.get("Server version", "") or data["release_versions"].get(base, "")
        if version:
            item["version"] = version
        item["server_number"] = version_sh.get("Server number", "")

        java_lines = data["java_version"].get(base, [])
        java_info = parse_java_version("\n".join(java_lines)) if java_lines else {"version": "", "vendor": "", "major": 0, "label": ""}
        item["jvm_version"] = version_sh.get("JVM Version", "") or java_info["version"]
        item["jvm_vendor"] = version_sh.get("JVM Vendor", "") or java_info["vendor"]
        if java_info.get("label"):
            item["java"] = java_info["label"]

        os_parts = [version_sh.get("OS Name", ""), version_sh.get("OS Version", "")]
        os_name = " ".join(part for part in os_parts if part).strip()
        arch = version_sh.get("Architecture", "")
        if os_name and arch:
            os_name = f"{os_name} ({arch})"
        item["os_name"] = os_name or data["uname"]

        java_home = data["java_home"].get(base, "") or _java_home_from_binary(data["java_real"].get(base, ""))
        item["java_home"] = java_home
        java_home_set = bool(data["java_home_set"].get(base)) and bool(data["java_home"].get(base))

        parsed_logging = parse_logging_properties(
            "\n".join(data["logging_props"].get(base, [])),
            base,
            item.get("catalina_home", "") or base,
        )
        item["configured_log_dir"] = parsed_logging["directory"]
        item["configured_log_prefix"] = parsed_logging["prefix"]

        if data["log_dirs"].get(base):
            item["log_dir"] = data["log_dirs"][base]
        elif parsed_logging["directory"]:
            item["log_dir"] = parsed_logging["directory"]

        if not item.get("ports") and data["xml_ports"].get(base):
            item["ports"] = ", ".join(sorted(data["xml_ports"][base], key=int))

        entries, primary = _pick_log_files(data["log_files"].get(base, []), parsed_logging["prefix"])
        item["log_files"] = [{key: value for key, value in row.items() if key != "_epoch"} for row in entries]
        item["primary_log_file"] = primary

        webapps = sorted(data["webapps"].get(base, []), key=lambda row: row["name"].lower())
        item["webapps"] = [{key: value for key, value in row.items() if key != "_epoch"} for row in webapps]

        webapps_meta = data["webapps_meta"].get(base, {"present": False})
        tomcat_user = data["tomcat_user"].get(base, "") or item.get("_owner", "") or item.get("_unit_user", "")
        item["prerequisites"] = _tomcat_prerequisites(
            item.get("version", ""),
            java_info,
            java_home,
            java_home_set,
            webapps_meta,
            tomcat_user,
            data["tomcat_groups"].get(base, []),
        )


def _tomcat_scan(server: Server, credentials: CredentialPayload) -> list[dict]:
    output = run_command(server, credentials, _TOMCAT_SCAN_SH + "\nexit 0\n")
    return _tomcat_instances(output.splitlines())


def discover_tomcat(server: Server, credentials: CredentialPayload) -> list[dict]:
    instances = _tomcat_scan(server, credentials)
    if instances:
        _tomcat_apply_details(server, credentials, instances)
    return _strip_private(instances)


def tomcat_logs(server: Server, credentials: CredentialPayload, log_file: str, tail: int = 200) -> list[str]:
    safe_tail = max(10, min(tail, 1000))
    output = run_command(server, credentials, f"tail -n {safe_tail} -- {_q(log_file)}")
    return output.splitlines()


def tomcat_action(server: Server, credentials: CredentialPayload, instance: str, action: str, sudo_password: str = "") -> str:
    if action not in _TOMCAT_ACTIONS:
        raise SshOperationError(f"Unsupported tomcat action: {action}")
    target: dict | None = None
    for item in _tomcat_scan(server, credentials):
        if item.get("name") == instance or item.get("unit") == instance:
            target = item
            break
    if target is None:
        raise SshOperationError(f"Tomcat instance not found: {instance}")

    unit = target.get("unit", "")
    if unit and target.get("_systemd") == "running":
        if action == "status":
            return run_command(server, credentials, f"systemctl is-active {_q(unit)} 2>&1 || true").strip()
        run_privileged(server, credentials, f"systemctl {action} {_q(unit)}", sudo_password)
        return run_command(server, credentials, f"systemctl is-active {_q(unit)} 2>&1 || true").strip()

    if action == "status":
        return target.get("status", "unknown")
    home = target.get("catalina_home", "") or target.get("catalina_base", "")
    base = target.get("catalina_base", "") or home
    if not home:
        raise SshOperationError(f"No systemd unit or CATALINA_HOME known for {instance}")

    script = [
        f"CATALINA_HOME={_q(home)}",
        f"CATALINA_BASE={_q(base)}",
        f"OLD={_q(target.get('pid', ''))}",
        _TOMCAT_CONTROL_SH,
    ]
    if action == "stop":
        script.append("__stop")
    elif action == "start":
        script.append('CUR=$(__find_pid)')
        script.append('if [ -n "$CUR" ]; then echo "TOMCAT_ALREADY_RUNNING $CUR"; else __start; fi')
    else:
        script.append("__stop && __start")
    script.append("exit 0")
    output = _tomcat_run_as_owner(server, credentials, "\n".join(script), target.get("_owner", ""), sudo_password)
    return _tomcat_control_result(instance, action, output)


def _tomcat_run_as_owner(server: Server, credentials: CredentialPayload, script: str, owner: str, sudo_password: str) -> str:
    if owner and owner != server.username:
        return run_privileged(server, credentials, f"su -s /bin/sh {_q(owner)} -c {_q(script)}", sudo_password)
    return run_command(server, credentials, script)


def _tomcat_control_result(instance: str, action: str, output: str) -> str:
    markers = [line.strip() for line in output.splitlines() if line.strip().startswith("TOMCAT_")]
    if any(marker == "TOMCAT_STOP_FAILED" for marker in markers):
        raise SshOperationError(
            f"Tomcat {instance} is still running: the graceful shutdown and SIGTERM both failed, "
            "so no new instance was started"
        )
    if any(marker == "TOMCAT_NO_SCRIPT" for marker in markers):
        raise SshOperationError(f"Tomcat {instance} has no executable bin/startup.sh")
    if any(marker == "TOMCAT_START_FAILED" for marker in markers):
        raise SshOperationError(f"Tomcat {instance} did not come up after {action}; check catalina.out")
    for marker in markers:
        if marker.startswith("TOMCAT_ALREADY_RUNNING"):
            return f"already running (pid {marker.split(' ', 1)[-1]})"
        if marker.startswith("TOMCAT_STARTED"):
            return f"running (pid {marker.split(' ', 1)[-1]})"
    if action == "stop" and "TOMCAT_STOPPED" in markers:
        return "stopped"
    raise SshOperationError(f"Tomcat {action} produced no recognisable result for {instance}")


_ZIP_MAGIC = b"PK\x03\x04"


def _safe_war_name(filename: str) -> str:
    name = (filename or "").strip()
    if not name:
        raise SshOperationError("A WAR filename is required")
    if name != filename.strip() or "/" in name or "\\" in name or "\x00" in name:
        raise SshOperationError(f"Refusing unsafe WAR filename: {filename!r}")
    if name.startswith(".") or ".." in name:
        raise SshOperationError(f"Refusing unsafe WAR filename: {filename!r}")
    if not name.lower().endswith(".war"):
        raise SshOperationError("WAR filename must end with .war")
    return name


_WAR_PROBE_SH = r"""
if [ -d "$D" ]; then echo 'DIR|1'; else echo 'DIR|0'; fi
if [ -w "$D" ]; then echo 'DIRW|1'; else echo 'DIRW|0'; fi
stat -c 'DIRMETA|%U|%G|%a' "$D" 2>/dev/null || true
if [ -e "$T" ]; then
  echo 'TGT|1'
  stat -c 'TGTMETA|%U|%G|%a' "$T" 2>/dev/null || true
else
  echo 'TGT|0'
fi
printf 'WHO|%s|%s\n' "$(id -un 2>/dev/null)" "$(id -gn 2>/dev/null)"
exit 0
"""


def _war_move_script(tmp: str, target: str, backup: str, owner: str, group: str, mode: str, strict_chown: bool) -> str:
    lines = [
        "set -e",
        f"TMP={_q(tmp)}",
        f"TGT={_q(target)}",
        f"BAK={_q(backup)}",
        'if [ -n "$BAK" ] && [ -e "$TGT" ]; then cp -p -- "$TGT" "$BAK"; fi',
        'mv -f -- "$TMP" "$TGT"',
    ]
    if owner and group:
        # A WAR left owned by root in a Tomcat-owned webapps dir never deploys, so the
        # privileged path insists on the chown succeeding; unprivileged it is best-effort.
        suffix = "" if strict_chown else " 2>/dev/null || true"
        lines.append(f"chown {_q(owner + ':' + group)} -- \"$TGT\"{suffix}")
    if mode:
        lines.append(f"chmod {_q(mode)} -- \"$TGT\" 2>/dev/null || true")
    lines.append("echo WAR_DEPLOY_OK")
    return "\n".join(lines)


def deploy_war(
    server: Server,
    credentials: CredentialPayload,
    target_dir: str,
    filename: str,
    data: bytes,
    sudo_password: str = "",
    backup: bool = True,
) -> dict:
    """Upload a WAR over SFTP and move it into `target_dir`.

    SFTP rather than a shell redirect because a WAR can be hundreds of megabytes. The temp
    file is always removed, including on every failure path. Raises SudoPasswordRequired
    when the move needs root and no password was supplied, so the caller can prompt.
    """
    name = _safe_war_name(filename)
    if not target_dir.startswith("/"):
        raise SshOperationError("The WAR target directory must be an absolute path")
    if len(data) < len(_ZIP_MAGIC) or not data.startswith(_ZIP_MAGIC):
        raise SshOperationError("Uploaded file is not a ZIP/WAR archive (missing PK\\x03\\x04 magic)")

    directory = target_dir.rstrip("/") or "/"
    target = f"{directory}/{name}"
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    tmp = f"/tmp/inframonitor-war-{uuid.uuid4().hex[:16]}.war"

    client: paramiko.SSHClient | None = None
    sftp = None
    uploaded = False
    try:
        client = _client(server, credentials)
        sftp = client.open_sftp()
        uploaded = True
        attrs = sftp.putfo(BytesIO(data), tmp, confirm=True)
        written = int(getattr(attrs, "st_size", 0) or 0)
        if written != len(data):
            written = int(sftp.stat(tmp).st_size)
        if written != len(data):
            raise SshOperationError(f"Upload truncated: the remote file is {written} of {len(data)} bytes")
        with sftp.open(tmp, "rb") as handle:
            head = handle.read(len(_ZIP_MAGIC))
        if head != _ZIP_MAGIC:
            raise SshOperationError("The uploaded file on the remote host is not a ZIP/WAR archive")

        probe = f"D={_q(directory)}\nT={_q(target)}\n" + _WAR_PROBE_SH
        _, probe_out, _ = _exec_on(client, probe)
        facts: dict[str, list[str]] = {}
        for line in probe_out.splitlines():
            fields = line.strip().split("|")
            if len(fields) >= 2:
                facts[fields[0]] = fields[1:]
        if facts.get("DIR", ["0"])[0] != "1":
            raise SshOperationError(f"Target directory does not exist: {directory}")

        dir_writable = facts.get("DIRW", ["0"])[0] == "1"
        who = facts.get("WHO", ["", ""])
        ssh_user = who[0] if len(who) > 0 else ""
        ssh_group = who[1] if len(who) > 1 else ""
        target_exists = facts.get("TGT", ["0"])[0] == "1"
        source_meta = facts.get("TGTMETA") if target_exists else facts.get("DIRMETA")
        want_owner = source_meta[0] if source_meta and len(source_meta) > 0 else ""
        want_group = source_meta[1] if source_meta and len(source_meta) > 1 else ""
        want_mode = ""
        if target_exists and facts.get("TGTMETA") and len(facts["TGTMETA"]) > 2:
            want_mode = facts["TGTMETA"][2]
        if not want_mode:
            want_mode = "644"

        backup_path = f"{target}.bak-{stamp}" if (backup and target_exists) else ""
        needs_chown = bool(want_owner) and (want_owner != ssh_user or want_group != ssh_group)

        if dir_writable:
            script = _war_move_script(tmp, target, backup_path, want_owner if needs_chown else "", want_group if needs_chown else "", want_mode, False)
            code, out, err = _exec_on(client, script)
            if code != 0 or "WAR_DEPLOY_OK" not in out:
                # A sticky-bit webapps dir can refuse the unlink even when the dir is
                # writable; fall back to the privileged move so the sudo flow applies.
                run_privileged(
                    server,
                    credentials,
                    _war_move_script(tmp, target, backup_path, want_owner, want_group, want_mode, True),
                    sudo_password,
                )
        else:
            run_privileged(
                server,
                credentials,
                _war_move_script(tmp, target, backup_path, want_owner, want_group, want_mode, True),
                sudo_password,
            )
        uploaded = False
        return {"target_path": target, "backup_path": backup_path, "bytes_written": len(data)}
    except Exception as exc:
        if isinstance(exc, (SshOperationError, SudoPasswordRequired)):
            raise
        raise SshOperationError(str(exc)) from exc
    finally:
        if uploaded and sftp is not None:
            removed = False
            try:
                sftp.remove(tmp)
                removed = True
            except Exception:
                removed = False
            if not removed and client is not None:
                try:
                    _exec_on(client, f"rm -f -- {_q(tmp)}")
                except Exception:
                    pass
        if sftp is not None:
            try:
                sftp.close()
            except Exception:
                pass
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


class SftpTooLarge(SshOperationError):
    # A subclass so existing `except SshOperationError` handlers keep working, but callers
    # that want to answer 413 rather than a generic failure can catch this first.
    pass


# 2000 is a display cap, not a filesystem one: /var/log or a Maven repository can hold six
# figures of entries, and materialising them would blow both the response and the pane.
_SFTP_LIST_CAP = 2000
# Every symlink resolved for its target size costs one extra round trip, so a directory of
# nothing but links cannot be allowed to turn one listing into 2000 stats.
_SFTP_LINK_RESOLVE_CAP = 200
# Deliberately below paramiko's default of 50: a huge directory that we abandon at the cap
# has that many READDIR requests already in flight and thrown away.
_SFTP_READ_AHEADS = 8
_SFTP_CHUNK = 262144
_SFTP_META_TIMEOUT = 30
_SFTP_TRANSFER_TIMEOUT = 300
_SFTP_NAME_MAX = 255

_SFTP_MISSING_MARKERS = ("no such file", "not found", "does not exist")
_SFTP_DENIED_MARKERS = ("permission denied", "access denied", "not permitted")


def _sftp_reason(exc: Exception, path: str) -> str:
    # paramiko maps only ENOENT and EACCES onto errno and raises a bare IOError(text) for
    # every other SFTP status, so the text is checked too. An operator needs to know
    # "permission denied" from "no such file"; a paramiko repr tells them neither.
    where = path or "the remote path"
    code = getattr(exc, "errno", None)
    text = str(exc).strip()
    lowered = text.lower()
    if code == errno.ENOENT or any(marker in lowered for marker in _SFTP_MISSING_MARKERS):
        return f"No such file or directory: {where}"
    if code in (errno.EACCES, errno.EPERM) or any(marker in lowered for marker in _SFTP_DENIED_MARKERS):
        return f"Permission denied: {where}"
    if code == errno.ENOTDIR:
        return f"Not a directory: {where}"
    if code == errno.EISDIR:
        return f"Is a directory: {where}"
    if code == errno.ELOOP:
        return f"Too many levels of symbolic links: {where}"
    if code == errno.EEXIST:
        return f"Already exists: {where}"
    if code == errno.ENOSPC:
        return f"No space left on the remote filesystem while writing {where}"
    if code == errno.EROFS:
        return f"Read-only remote filesystem: {where}"
    if isinstance(exc, TimeoutError):
        return f"Timed out talking to the remote host while accessing {where}"
    if isinstance(exc, EOFError):
        return f"The remote host closed the SFTP connection while accessing {where}"
    return f"SFTP failed on {where}: {text or type(exc).__name__}"


def _sftp_error(exc: Exception, path: str) -> Exception:
    if isinstance(exc, (SshOperationError, SudoPasswordRequired)):
        return exc
    return SshOperationError(_sftp_reason(exc, path))


@contextmanager
def _sftp_session(
    server: Server,
    credentials: CredentialPayload,
    timeout: int = _SFTP_META_TIMEOUT,
) -> Iterator[paramiko.SFTPClient]:
    # Connection failures are converted here; body failures pass through untouched so the
    # caller can attach the path it was working on. Both are cleaned up either way.
    client: paramiko.SSHClient | None = None
    sftp: paramiko.SFTPClient | None = None
    try:
        try:
            client = _client(server, credentials)
            sftp = client.open_sftp()
            channel = sftp.get_channel()
            if channel is not None:
                channel.settimeout(timeout)
        except Exception as exc:
            if isinstance(exc, SshOperationError):
                raise
            raise SshOperationError(
                f"Unable to open SFTP to {server.username}@{server.ip_address}: {exc}"
            ) from exc
        yield sftp
    finally:
        if sftp is not None:
            try:
                sftp.close()
            except Exception:
                pass
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


def _sftp_clean(path: str) -> str:
    text = (path or "").strip()
    if "\x00" in text:
        raise SshOperationError("Refusing a remote path containing a NUL byte")
    return text


def _sftp_norm(path: str) -> str:
    text = posixpath.normpath(path)
    # POSIX gives a leading `//` implementation-defined meaning and normpath preserves it;
    # nothing here wants that, and a doubled root reads as a bug in the pane.
    while text.startswith("//"):
        text = text[1:]
    return text or "/"


def _sftp_home(sftp: paramiko.SFTPClient) -> str:
    # The SSH user's home comes from the server, never from /home/<user>: system accounts,
    # /opt homes and NFS layouts all break that guess, and a wrong default opens the pane
    # on a directory that does not exist.
    try:
        home = (sftp.normalize(".") or "").strip()
    except Exception:
        home = ""
    if not home.startswith("/"):
        return "/"
    return _sftp_norm(home)


def _sftp_resolve(path: str, home: str) -> str:
    text = _sftp_clean(path)
    if not text:
        return home
    if not text.startswith("/"):
        text = posixpath.join(home, text)
    return _sftp_norm(text)


def _sftp_target(sftp: paramiko.SFTPClient, path: str) -> str:
    text = _sftp_clean(path)
    if not text:
        raise SshOperationError("A remote path is required")
    if text.startswith("/"):
        return _sftp_norm(text)
    return _sftp_resolve(text, _sftp_home(sftp))


def _sftp_parent(path: str) -> str:
    if not path or path == "/":
        return ""
    return posixpath.dirname(path.rstrip("/")) or "/"


def _sftp_join(directory: str, name: str) -> str:
    base = directory.rstrip("/")
    return f"{base}/{name}" if base else f"/{name}"


def _sftp_kind(mode: int) -> str:
    if stat.S_ISLNK(mode):
        return "link"
    if stat.S_ISDIR(mode):
        return "dir"
    return "file"


def _sftp_when(mtime: float | int | None) -> str:
    if not isinstance(mtime, (int, float)) or mtime <= 0:
        return ""
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.gmtime(mtime))
    except (OSError, OverflowError, ValueError):
        return ""


def _sftp_follow(sftp: paramiko.SFTPClient, path: str) -> tuple[str, int]:
    """Resolve a symlink with one server-side stat; returns ("", -1) when it will not resolve.

    A single `stat` hands the whole chain to the remote kernel, which stops at ELOOP.
    Walking `readlink` ourselves is what would let a link cycle spin forever, so we never do.
    """
    try:
        attrs = sftp.stat(path)
    except Exception:
        return "", -1
    mode = int(getattr(attrs, "st_mode", 0) or 0)
    size = getattr(attrs, "st_size", None)
    return _sftp_kind(mode), int(size) if isinstance(size, (int, float)) else -1


def _sftp_entry(name: str, path: str, attrs: paramiko.SFTPAttributes, target_type: str = "", size_override: int = -1) -> dict:
    mode = int(getattr(attrs, "st_mode", 0) or 0)
    raw_size = getattr(attrs, "st_size", None)
    size = int(raw_size) if isinstance(raw_size, (int, float)) else 0
    if size_override >= 0:
        size = size_override
    mtime = getattr(attrs, "st_mtime", None)
    return {
        "name": name,
        "path": path,
        "type": _sftp_kind(mode),
        "size_bytes": size,
        "modified": _sftp_when(mtime),
        "modified_epoch": int(mtime) if isinstance(mtime, (int, float)) and mtime > 0 else 0,
        "mode": stat.filemode(mode) if mode else "",
        "mode_octal": f"{stat.S_IMODE(mode):04o}" if mode else "",
        "target_type": target_type,
    }


def _sftp_exists(sftp: paramiko.SFTPClient, path: str) -> bool:
    try:
        sftp.lstat(path)
    except IOError as exc:
        if getattr(exc, "errno", None) == errno.ENOENT:
            return False
        raise
    return True


def sftp_list(server: Server, credentials: CredentialPayload, path: str = "") -> dict:
    """List one remote directory. An empty path means the SSH user's home."""
    with _sftp_session(server, credentials) as sftp:
        home = _sftp_home(sftp)
        target = _sftp_resolve(path, home)
        try:
            attrs = sftp.stat(target)
        except Exception as exc:
            raise _sftp_error(exc, target) from exc
        if not stat.S_ISDIR(int(getattr(attrs, "st_mode", 0) or 0)):
            raise SshOperationError(f"Not a directory: {target}")

        listed: list[paramiko.SFTPAttributes] = []
        truncated = False
        iterator = sftp.listdir_iter(target, read_aheads=_SFTP_READ_AHEADS)
        try:
            for item in iterator:
                name = getattr(item, "filename", "") or ""
                if name in ("", ".", ".."):
                    continue
                if len(listed) >= _SFTP_LIST_CAP:
                    # Stop pulling entries rather than reading the whole directory and
                    # slicing afterwards -- the point of the cap is the memory and the wait.
                    truncated = True
                    break
                listed.append(item)
        except Exception as exc:
            raise _sftp_error(exc, target) from exc
        finally:
            try:
                iterator.close()
            except Exception:
                pass

        # Links are resolved only once the directory handle is finished with. paramiko
        # multiplexes every SFTP request over one channel and listdir_iter matches responses
        # by request number itself, so a stat issued mid-iteration consumes a packet the
        # iterator is waiting for and the listing then hangs until the channel times out.
        # Verified: interleaving turns a 0.01s /var/log listing into a 15s timeout.
        entries: list[dict] = []
        links = 0
        for item in listed:
            name = item.filename
            full = _sftp_join(target, name)
            mode = int(getattr(item, "st_mode", 0) or 0)
            target_type = ""
            size_override = -1
            if stat.S_ISLNK(mode) and links < _SFTP_LINK_RESOLVE_CAP:
                links += 1
                target_type, size_override = _sftp_follow(sftp, full)
            entries.append(_sftp_entry(name, full, item, target_type, size_override))

        entries.sort(key=lambda item: (0 if item["type"] == "dir" else 1, item["name"].lower(), item["name"]))
        return {
            "path": target,
            "parent": _sftp_parent(target),
            "home": home,
            "entries": entries,
            "count": len(entries),
            "truncated": truncated,
            "cap": _SFTP_LIST_CAP,
        }


def sftp_stat(server: Server, credentials: CredentialPayload, path: str) -> dict:
    with _sftp_session(server, credentials) as sftp:
        target = _sftp_target(sftp, path)
        try:
            attrs = sftp.lstat(target)
        except Exception as exc:
            raise _sftp_error(exc, target) from exc
        mode = int(getattr(attrs, "st_mode", 0) or 0)
        target_type = ""
        size_override = -1
        if stat.S_ISLNK(mode):
            target_type, size_override = _sftp_follow(sftp, target)
        entry = _sftp_entry(_basename(target) or target, target, attrs, target_type, size_override)
        entry["parent"] = _sftp_parent(target)
        return entry


def sftp_download(server: Server, credentials: CredentialPayload, path: str, max_bytes: int) -> bytes:
    """Read a remote file into memory, refusing anything over `max_bytes`.

    The limit is enforced from `stat` before the first byte is read, and again while
    reading in case the file grows: reading first and checking after is how a 40 GB file
    takes the process out.
    """
    limit = int(max_bytes)
    if limit <= 0:
        raise SshOperationError("The download limit must be a positive number of bytes")
    with _sftp_session(server, credentials, _SFTP_TRANSFER_TIMEOUT) as sftp:
        target = _sftp_target(sftp, path)
        try:
            # stat, not lstat: downloading a symlink means downloading what it points at.
            attrs = sftp.stat(target)
        except Exception as exc:
            raise _sftp_error(exc, target) from exc
        mode = int(getattr(attrs, "st_mode", 0) or 0)
        if stat.S_ISDIR(mode):
            raise SshOperationError(f"Is a directory, not a downloadable file: {target}")
        if mode and not stat.S_ISREG(mode):
            raise SshOperationError(f"Not a regular file, refusing to download: {target}")
        size = int(getattr(attrs, "st_size", 0) or 0)
        if size > limit:
            raise SftpTooLarge(f"{target} is {size} bytes, over the {limit} byte download limit")

        buffer = BytesIO()
        total = 0
        try:
            with sftp.open(target, "rb") as handle:
                if size > 0:
                    handle.prefetch(size)
                while True:
                    chunk = handle.read(_SFTP_CHUNK)
                    if not chunk:
                        break
                    total += len(chunk)
                    # /proc and /sys report st_size 0 while still yielding content, and a
                    # log file can grow between the stat and the read, so the cap is
                    # re-checked per chunk instead of trusted once.
                    if total > limit:
                        raise SftpTooLarge(
                            f"{target} exceeded the {limit} byte download limit while being read"
                        )
                    buffer.write(chunk)
        except Exception as exc:
            raise _sftp_error(exc, target) from exc
        return buffer.getvalue()


def _sftp_discard(sftp: paramiko.SFTPClient, path: str) -> None:
    try:
        sftp.remove(path)
        return
    except Exception:
        pass
    # A timed-out SFTP request leaves that channel's pipeline out of step while the
    # transport underneath is still healthy, so one plain exec gets a second shot at the
    # temp file before we give up on it. Same fallback deploy_war uses.
    try:
        session = sftp.get_channel().get_transport().open_session()
        try:
            session.exec_command(f"rm -f -- {_q(path)}")
            session.recv_exit_status()
        finally:
            session.close()
    except Exception:
        pass


def _safe_upload_name(filename: str) -> str:
    name = (filename or "").strip()
    if not name:
        raise SshOperationError("A filename is required")
    if "/" in name or "\\" in name or "\x00" in name or name in (".", ".."):
        raise SshOperationError(f"Refusing unsafe upload filename: {filename!r}")
    if len(name.encode("utf-8", errors="replace")) > _SFTP_NAME_MAX:
        raise SshOperationError(f"Upload filename is longer than {_SFTP_NAME_MAX} bytes")
    return name


def sftp_upload(server: Server, credentials: CredentialPayload, target_dir: str, filename: str, data: bytes) -> dict:
    """Write `data` into `target_dir/filename`, never over an existing file.

    Same shape as `deploy_war`: a temp file first, then a rename, and the temp removed on
    every failure path so a failed upload cannot leave a half-written file behind. The temp
    lives in the target directory so the rename is a same-filesystem metadata operation.
    """
    name = _safe_upload_name(filename)
    with _sftp_session(server, credentials, _SFTP_TRANSFER_TIMEOUT) as sftp:
        directory = _sftp_target(sftp, target_dir)
        try:
            dir_attrs = sftp.stat(directory)
        except Exception as exc:
            raise _sftp_error(exc, directory) from exc
        if not stat.S_ISDIR(int(getattr(dir_attrs, "st_mode", 0) or 0)):
            raise SshOperationError(f"Upload target is not a directory: {directory}")

        target = _sftp_join(directory, name)
        try:
            occupied = _sftp_exists(sftp, target)
        except Exception as exc:
            raise _sftp_error(exc, target) from exc
        if occupied:
            # This pass has no delete and no rename, so silently clobbering a remote file
            # would be the one destructive thing the pane could do. It refuses instead.
            raise SshOperationError(f"Refusing to overwrite an existing remote path: {target}")

        tmp = _sftp_join(directory, f".inframonitor-upload-{uuid.uuid4().hex[:16]}.part")
        created = False
        try:
            # O_EXCL on the temp: never adopt a file somebody else left at that name.
            with sftp.open(tmp, "wxb") as handle:
                created = True
                handle.set_pipelined(True)
                handle.write(data)
            written = int(getattr(sftp.stat(tmp), "st_size", 0) or 0)
            if written != len(data):
                raise SshOperationError(f"Upload truncated: the remote file is {written} of {len(data)} bytes")
            try:
                # The EXCL create lands at the remote umask; pin it so an uploaded file has
                # a predictable mode rather than whatever the SSH user's umask happened to be.
                sftp.chmod(tmp, 0o644)
            except Exception:
                pass
            # Plain rename, not posix_rename: OpenSSH implements it with link()+unlink() and
            # fails on an existing target, which closes the race left by the check above.
            sftp.rename(tmp, target)
            created = False
        except Exception as exc:
            raise _sftp_error(exc, target) from exc
        finally:
            if created:
                _sftp_discard(sftp, tmp)
        return {
            "path": target,
            "target_path": target,
            "target_dir": directory,
            "filename": name,
            "bytes_written": len(data),
            "size_bytes": len(data),
        }


# Ceilings for a recursive delete. Unlike a listing, a delete cannot be re-fetched: these
# exist so a pathological or hostile tree cannot hold the request (and its SFTP channel)
# open indefinitely, not to express a policy about how much an operator may remove. Both
# raise rather than stopping quietly, and the message says how much was already gone.
_SFTP_DELETE_MAX_DEPTH = 32
_SFTP_DELETE_MAX_ENTRIES = 5000


def _sftp_delete_guard(target: str, recursive: bool, home: str) -> None:
    if target == "/":
        raise SshOperationError("Refusing to delete the filesystem root (/)")
    if not recursive:
        return
    # A recursive delete is the only call here that can remove more than it names, so the
    # breadth of the target is checked before anything is touched. One component means a
    # top-level directory -- /etc, /var, /usr -- and a single mis-click must not reach them.
    components = [part for part in target.split("/") if part]
    if len(components) < 2:
        raise SshOperationError(
            f"Refusing a recursive delete of {target}: a top-level path is too broad. "
            "Only paths at least two components deep may be removed recursively."
        )
    if home and target == home:
        raise SshOperationError(
            f"Refusing a recursive delete of the SSH user's home directory ({target})"
        )


def _sftp_delete_budget(state: dict) -> None:
    if state["removed"] >= _SFTP_DELETE_MAX_ENTRIES:
        raise SshOperationError(
            f"Stopped after removing {state['removed']} entries under {state['root']}, the "
            f"per-request limit of {_SFTP_DELETE_MAX_ENTRIES}. The delete is incomplete -- "
            "re-run it to remove the rest."
        )


def _sftp_rmdir_error(exc: Exception, path: str) -> Exception:
    if isinstance(exc, (SshOperationError, SudoPasswordRequired)):
        return exc
    reason = _sftp_reason(exc, path)
    # SFTP v3 has no ENOTEMPTY status, so OpenSSH answers rmdir on a populated directory
    # with SSH_FX_FAILURE, whose canned message is just "Failure" -- it can only land in the
    # generic fallback. Say what it most likely means rather than echoing "Failure".
    if reason.startswith("SFTP failed on "):
        reason += " -- the directory may not be empty, or the remote refused to remove it"
    return SshOperationError(reason)


def _sftp_unlink(sftp: paramiko.SFTPClient, path: str, state: dict) -> None:
    _sftp_delete_budget(state)
    try:
        # SSH_FXP_REMOVE unlinks the named path and refuses directories, so a symlink loses
        # the link and never the target.
        sftp.remove(path)
    except Exception as exc:
        raise _sftp_error(exc, path) from exc
    state["removed"] += 1


def _sftp_rmdir(sftp: paramiko.SFTPClient, path: str, state: dict) -> None:
    _sftp_delete_budget(state)
    try:
        sftp.rmdir(path)
    except Exception as exc:
        raise _sftp_rmdir_error(exc, path) from exc
    state["removed"] += 1


def _sftp_delete_children(sftp: paramiko.SFTPClient, directory: str, depth: int, state: dict) -> None:
    if depth > _SFTP_DELETE_MAX_DEPTH:
        raise SshOperationError(
            f"Refusing to recurse more than {_SFTP_DELETE_MAX_DEPTH} levels below "
            f"{state['root']} (reached {directory}). The delete is incomplete."
        )
    try:
        listed = sftp.listdir_attr(directory)
    except Exception as exc:
        raise _sftp_error(exc, directory) from exc

    # Two phases on purpose, the same shape sftp_list uses: the directory read is fully
    # drained before anything is removed or stat-ed. paramiko multiplexes every SFTP request
    # over one channel and matches replies by request number, so a call interleaved with a
    # directory read consumes a packet that read is waiting for and the request then hangs
    # until the channel times out.
    subdirs: list[str] = []
    doomed: list[str] = []
    unknown: list[str] = []
    for item in listed:
        name = getattr(item, "filename", "") or ""
        if name in ("", ".", ".."):
            continue
        full = _sftp_join(directory, name)
        mode = int(getattr(item, "st_mode", 0) or 0)
        if not mode:
            unknown.append(full)
        elif stat.S_ISLNK(mode):
            # Unlink the link, never walk it. A link to /etc sitting inside a doomed tree is
            # the whole difference between removing a directory and removing the system.
            doomed.append(full)
        elif stat.S_ISDIR(mode):
            subdirs.append(full)
        else:
            doomed.append(full)

    for full in unknown:
        # readdir is specified to carry lstat attributes; a server that sends none would
        # leave us guessing, so one explicit lstat -- now the listing is finished with.
        try:
            mode = int(getattr(sftp.lstat(full), "st_mode", 0) or 0)
        except Exception as exc:
            raise _sftp_error(exc, full) from exc
        if stat.S_ISDIR(mode):
            subdirs.append(full)
        else:
            doomed.append(full)

    for full in doomed:
        _sftp_unlink(sftp, full, state)
    for full in subdirs:
        _sftp_delete_children(sftp, full, depth + 1, state)
        _sftp_rmdir(sftp, full, state)


def sftp_delete(server: Server, credentials: CredentialPayload, path: str, recursive: bool = False) -> dict:
    """Delete one remote path, reporting what went and how many entries it cost.

    `entries_removed` counts every unlink and rmdir actually performed, the target itself
    included: a file is 1, an empty directory is 1, a directory holding three files is 4.
    An empty directory is removed without `recursive`, because that destroys nothing beyond
    the path named; a populated one is refused until the caller opts in.
    """
    with _sftp_session(server, credentials) as sftp:
        if not _sftp_clean(path):
            raise SshOperationError("A remote path is required")
        home = _sftp_home(sftp)
        target = _sftp_resolve(path, home)
        _sftp_delete_guard(target, recursive, home)
        try:
            # lstat, never stat. Under stat a symlink to a directory looks like a directory,
            # and "delete this link" would silently become "recursively delete its target".
            attrs = sftp.lstat(target)
        except Exception as exc:
            raise _sftp_error(exc, target) from exc
        kind = _sftp_kind(int(getattr(attrs, "st_mode", 0) or 0))
        state: dict = {"removed": 0, "root": target}

        if kind == "dir":
            if recursive:
                _sftp_delete_children(sftp, target, 1, state)
            else:
                try:
                    children = [name for name in sftp.listdir(target) if name not in ("", ".", "..")]
                except Exception as exc:
                    raise _sftp_error(exc, target) from exc
                if children:
                    raise SshOperationError(
                        f"{target} is a directory holding {len(children)} entries. Pass "
                        "recursive=true to delete it and everything inside it."
                    )
            _sftp_rmdir(sftp, target, state)
        else:
            _sftp_unlink(sftp, target, state)
        return {"path": target, "deleted": kind, "entries_removed": state["removed"]}


def list_containers(server: Server, credentials: CredentialPayload, runtime: str) -> list[ContainerRead]:
    binary = "podman" if runtime == "podman" else "docker"
    output = run_command(
        server,
        credentials,
        f"{binary} ps -a --format '{{{{.ID}}}}\\t{{{{.Names}}}}\\t{{{{.Image}}}}\\t{{{{.Status}}}}'",
    )
    containers: list[ContainerRead] = []
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) >= 4:
            containers.append(ContainerRead(runtime=runtime, id=parts[0], name=parts[1], image=parts[2], status=parts[3], ports=""))
    return containers


def list_containers_with_ports(server: Server, credentials: CredentialPayload, runtime: str) -> list[ContainerRead]:
    binary = "podman" if runtime == "podman" else "docker"
    fmt = "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"
    output = run_command(server, credentials, f"{binary} ps -a --format '{fmt}'")
    containers: list[ContainerRead] = []
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) >= 5:
            containers.append(ContainerRead(runtime=runtime, id=parts[0], name=parts[1], image=parts[2], status=parts[3], ports=_short_ports(parts[4])))
    return containers


def _short_ports(value: str) -> str:
    ports: list[str] = []
    for item in value.split(","):
        text = item.strip()
        if not text or text.startswith("[::]:"):
            continue
        if "->" in text:
            left, right = text.split("->", 1)
            left_port = left.rsplit(":", 1)[-1]
            right_port = right.split("/", 1)[0]
            short = f"{left_port}->{right_port}"
        else:
            short = text.split("/", 1)[0]
        if re.fullmatch(r"\d+(->\d+)?", short) and short not in ports:
            ports.append(short)
    return ", ".join(ports)


def container_logs(server: Server, credentials: CredentialPayload, runtime: str, container: str, tail: int = 200) -> list[str]:
    binary = "podman" if runtime == "podman" else "docker"
    safe_tail = max(10, min(tail, 1000))
    output = run_command(server, credentials, f"{binary} logs --tail {safe_tail} {_q(container)}")
    return output.splitlines()


# Where a .env conventionally lives inside an app image. Fixed literals (never anything from
# the request), tried in order; the first that exists is shown. WORKDIR is usually one of these.
_CONTAINER_ENV_PATHS = ("/app/.env", "/code/.env", "/usr/src/app/.env", "/src/.env", "/.env")


def container_env_file(server: Server, credentials: CredentialPayload, runtime: str, container: str) -> list[str]:
    """Return the first .env file found inside the container, as lines.

    Looks in the common app working directories. If none is present, falls back to the
    container's *runtime* environment (docker exec ... env) so the operator still learns the
    effective configuration, with a header making the source unambiguous.
    """
    binary = "podman" if runtime == "podman" else "docker"
    paths = " ".join(_q(path) for path in _CONTAINER_ENV_PATHS)
    # `sh -c` inside the container: print the first readable .env with a header naming it; if
    # none, print a sentinel so the caller can fall back to the live environment.
    inner = (
        'for f in ' + paths + '; do '
        'if [ -f "$f" ]; then echo "# $f"; cat "$f"; exit 0; fi; '
        'done; echo "__NO_ENV_FILE__"'
    )
    output = run_command(server, credentials, f"{binary} exec {_q(container)} sh -c {_q(inner)}")
    lines = output.splitlines()
    if lines and lines[-1].strip() == "__NO_ENV_FILE__":
        # No file: show the runtime environment instead, clearly labelled.
        env_output = run_command(server, credentials, f"{binary} exec {_q(container)} env")
        header = [
            f"# No .env file found in {', '.join(_CONTAINER_ENV_PATHS)}.",
            f"# Showing the container's runtime environment ({binary} exec {container} env) instead:",
            "",
        ]
        return header + env_output.splitlines()
    return lines


def service_logs(server: Server, credentials: CredentialPayload, source: str, name_or_path: str, tail: int = 200) -> list[str]:
    safe_tail = max(10, min(tail, 1000))
    if source == "journal":
        output = run_command(server, credentials, f"journalctl -u {_q(name_or_path)} -n {safe_tail} --no-pager")
    else:
        inner = f"tail -n {safe_tail} -- $LOGPATH"
        output = run_command(server, credentials, f"LOGPATH={_q(name_or_path)} sh -c {_q(inner)}")
    return output.splitlines()


def restart_container(server: Server, credentials: CredentialPayload, runtime: str, container: str) -> str:
    binary = "podman" if runtime == "podman" else "docker"
    return run_command(server, credentials, f"{binary} restart {_q(container)}").strip()


def restart_service(server: Server, credentials: CredentialPayload, service: str, sudo_password: str = "") -> str:
    unit = _q(service)
    run_privileged(server, credentials, f"systemctl restart {unit}", sudo_password)
    return run_command(server, credentials, f"systemctl is-active {unit} 2>&1 || true").strip()


class ShellSession:
    # Interactive PTY over SSH for the browser terminal. Deliberately thin: it owns the
    # paramiko client and channel and exposes non-blocking reads, so the websocket handler
    # can poll it from the event loop without a reader thread per session.
    def __init__(
        self,
        server: Server,
        credentials: CredentialPayload,
        term: str = "xterm-256color",
        cols: int = 80,
        rows: int = 24,
    ) -> None:
        # _client() does not wrap paramiko's connect(), so NoValidConnectionsError and the
        # auth exceptions would escape raw and close the websocket with a bare 1011 and no
        # reason. Normalise here so the caller only ever sees SshOperationError with a
        # message worth showing an operator.
        try:
            self._client = _client(server, credentials)
        except SshOperationError:
            raise
        except Exception as exc:
            raise SshOperationError(f"Unable to connect to {server.ip_address}: {exc}") from exc
        try:
            self.channel = self._client.invoke_shell(
                term=term, width=max(20, min(cols, 500)), height=max(5, min(rows, 200))
            )
        except Exception as exc:
            self._client.close()
            raise SshOperationError(f"Unable to open a shell: {exc}") from exc
        self.channel.settimeout(0.0)

    def read(self, size: int = 32768) -> bytes:
        # returns b"" when nothing is pending; raises SshOperationError once the remote
        # side has closed, which is how the handler learns the session ended
        if self.channel.closed:
            raise SshOperationError("shell closed")
        data = b""
        if self.channel.recv_ready():
            data += self.channel.recv(size)
        if self.channel.recv_stderr_ready():
            data += self.channel.recv_stderr(size)
        if not data and self.channel.exit_status_ready() and not self.channel.recv_ready():
            raise SshOperationError("shell closed")
        return data

    def write(self, data: str) -> None:
        if self.channel.closed:
            raise SshOperationError("shell closed")
        self.channel.send(data)

    def resize(self, cols: int, rows: int) -> None:
        if not self.channel.closed:
            self.channel.resize_pty(width=max(20, min(cols, 500)), height=max(5, min(rows, 200)))

    def close(self) -> None:
        try:
            self.channel.close()
        except Exception:
            pass
        try:
            self._client.close()
        except Exception:
            pass
