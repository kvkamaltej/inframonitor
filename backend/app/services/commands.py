"""Remote shell command catalog for :mod:`app.services.ssh_ops`.

These are the exact command strings that ssh_ops executes on remote hosts over
SSH. This module is the single place that decides *what* runs on a managed
server; ssh_ops.py owns *how* it runs -- connection handling, privilege
escalation and output parsing. To change a command that executes remotely, edit
it here (not in the execution code) so the whole remote command surface stays
reviewable in one file.

Every builder is pure: it takes the caller's values and returns the command
string, owning its own shell quoting via ``_q``.
"""

import shlex

_q = shlex.quote


def _binary(runtime: str) -> str:
    """Container CLI for a runtime: podman for 'podman', docker otherwise."""
    return "podman" if runtime == "podman" else "docker"


# --- Part A: builders for the discrete inline commands ssh_ops runs ----------


def tail_file(path: str, tail: int) -> str:
    return f"tail -n {tail} -- {_q(path)}"


def systemctl_is_active(unit: str) -> str:
    return f"systemctl is-active {_q(unit)} 2>&1 || true"


def systemctl_action(action: str, unit: str) -> str:
    return f"systemctl {action} {_q(unit)}"


def su_run(owner: str, script: str) -> str:
    return f"su -s /bin/sh {_q(owner)} -c {_q(script)}"


def container_ps(runtime: str, fmt: str) -> str:
    return f"{_binary(runtime)} ps -a --format '{fmt}'"


def container_logs(runtime: str, container: str, tail: int) -> str:
    # 2>&1 is load-bearing: docker/podman logs writes the container's stderr to
    # our stderr, and run_command returns stdout only.
    return f"{_binary(runtime)} logs --tail {tail} {_q(container)} 2>&1"


def container_exec_sh(runtime: str, container: str, inner: str) -> str:
    return f"{_binary(runtime)} exec {_q(container)} sh -c {_q(inner)}"


def container_env(runtime: str, container: str) -> str:
    return f"{_binary(runtime)} exec {_q(container)} env"


def container_restart(runtime: str, container: str) -> str:
    return f"{_binary(runtime)} restart {_q(container)}"


def container_rm(runtime: str, container: str) -> str:
    # -f so a running container is stopped and removed in one step (matches the
    # "delete" affordance in the UI). Destructive -> the route gates this to admins.
    return f"{_binary(runtime)} rm -f {_q(container)} 2>&1"


def image_ls(runtime: str, fmt: str) -> str:
    return f"{_binary(runtime)} images --format '{fmt}'"


def image_rm(runtime: str, image: str) -> str:
    # No -f: refuse to remove an image that still backs a container (the CLI error
    # is surfaced to the user) rather than silently orphaning running workloads.
    return f"{_binary(runtime)} rmi {_q(image)} 2>&1"


def journal_logs(unit: str, tail: int) -> str:
    return f"journalctl -u {_q(unit)} -n {tail} --no-pager"


def tail_logpath(path: str, tail: int) -> str:
    inner = f'tail -n {tail} -- "$LOGPATH"'
    return f"LOGPATH={_q(path)} sh -c {_q(inner)}"


def wrap_sh(script: str) -> str:
    return f"sh -c {_q(script)}"


def sudo_run(command: str) -> str:
    return f"sudo -n sh -c {_q(command)}"


# --- Part B: the big named script constants ----------------------------------


# One round trip. CPU% needs two /proc/stat samples because the file holds cumulative
# jiffies since boot -- a single read would report the average since boot, not "now".
VITALS_SH = r"""
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


TOMCAT_SCAN_SH = r"""
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


TOMCAT_DETAIL_SH = r"""
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


TOMCAT_CONTROL_SH = r"""
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


DISCOVER_SH = r"""
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
      'httpd*.service' 'haproxy*.service' 'kubelet.service' 'k3s.service' \
      'k3s-agent.service' 'containerd.service' 'crio.service' 2>/dev/null
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


WAR_PROBE_SH = r"""
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


# One cheap probe that reports which log-producing systems a host runs, so the log-shipping
# picker can pre-offer sources. Every check is guarded (`command -v`, `test -f`,
# `2>/dev/null || true`) so a missing binary or unreadable path never aborts the snippet, and
# the whole thing stays in a single round trip. kubernetes counts if any of kubectl, k3s or an
# active kubelet is present. The nginx log-path checks are fixed literals, never request input.
LOG_CAPS_SH = r"""
command -v nginx  >/dev/null 2>&1 && echo NGINX=1  || echo NGINX=0
command -v docker >/dev/null 2>&1 && echo DOCKER=1 || echo DOCKER=0
command -v podman >/dev/null 2>&1 && echo PODMAN=1 || echo PODMAN=0
if command -v kubectl >/dev/null 2>&1 || command -v k3s >/dev/null 2>&1 \
   || systemctl is-active --quiet kubelet 2>/dev/null; then echo KUBERNETES=1; else echo KUBERNETES=0; fi
test -f /var/log/nginx/access.log && echo NGINX_ACCESS=1 || echo NGINX_ACCESS=0
test -f /var/log/nginx/error.log  && echo NGINX_ERROR=1  || echo NGINX_ERROR=0
"""
