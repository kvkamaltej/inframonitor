"""Install / uninstall Prometheus node_exporter on a managed server over SSH.

This is the invasive half of per-server monitoring: it runs real, privileged commands on a real
host to lay down node_exporter as a systemd service so the app's Prometheus can scrape that host's
metrics. It deliberately owns no SSH of its own -- every command goes through
``app.services.ssh_ops.run_privileged``, which reuses the same sudo-password mechanism the Tomcat
and service-restart flows use (root, passwordless sudo, or a supplied sudo password). A missing
sudo password surfaces as ``SudoPasswordRequired`` from that layer, which the route turns into the
usual "needs_sudo_password" prompt.

The install pins a known node_exporter release and is written to be idempotent: re-running it
re-installs the same version and rewrites the unit without error (``set -e`` throughout, with each
step tolerant of a previous partial run). Nothing user-supplied is interpolated into the shell --
the only per-server variable is the listen port, which is validated to be an integer in range and
formatted as a bare number.
"""

from __future__ import annotations

from app.models.entities import Server
from app.schemas.contracts import CredentialPayload
from app.services import ssh_ops

# Pinned node_exporter release. Bump deliberately; the checksum-free download trusts TLS to
# github's release CDN, matching how the rest of the product fetches tooling.
NODE_EXPORTER_VERSION = "1.8.2"

# Downloads can be slow on a constrained host; give the whole privileged script room rather than
# the 15s one-shot default run_privileged uses for systemctl calls.
INSTALL_TIMEOUT_SECONDS = 180
UNINSTALL_TIMEOUT_SECONDS = 60


class NodeExporterError(RuntimeError):
    """A predictable, user-facing failure (e.g. an invalid port). Distinct from the SSH errors
    ssh_ops raises, which the route handles with the shared sudo-aware failure mapping."""


def _valid_port(port: int) -> int:
    try:
        value = int(port)
    except (TypeError, ValueError) as exc:
        raise NodeExporterError("node_exporter port must be an integer") from exc
    if value < 1 or value > 65535:
        raise NodeExporterError("node_exporter port must be between 1 and 65535")
    return value


def _install_script(port: int, version: str) -> str:
    # port and version are both validated/pinned before they reach here, so formatting them into
    # the script is safe -- there is no request-controlled string in this text.
    return f"""set -e
VERSION={version}
PORT={port}
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l|armv7|armhf) ARCH=armv7 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
TARBALL="node_exporter-${{VERSION}}.linux-${{ARCH}}"
URL="https://github.com/prometheus/node_exporter/releases/download/v${{VERSION}}/${{TARBALL}}.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP/ne.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP/ne.tar.gz" "$URL"
else
  echo "neither curl nor wget is available to download node_exporter" >&2
  exit 1
fi
tar -xzf "$TMP/ne.tar.gz" -C "$TMP"
# stop a running instance so the binary can be replaced on a re-install
systemctl stop node_exporter >/dev/null 2>&1 || true
install -m 0755 "$TMP/${{TARBALL}}/node_exporter" /usr/local/bin/node_exporter
# dedicated system user, created only once (id check keeps re-runs clean)
if ! id node_exporter >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin node_exporter 2>/dev/null \
    || useradd --system --no-create-home --shell /bin/false node_exporter 2>/dev/null \
    || adduser --system --no-create-home --shell /bin/false node_exporter 2>/dev/null \
    || true
fi
cat > /etc/systemd/system/node_exporter.service <<UNIT
[Unit]
Description=Prometheus Node Exporter
Wants=network-online.target
After=network-online.target

[Service]
User=node_exporter
Group=node_exporter
Type=simple
ExecStart=/usr/local/bin/node_exporter --web.listen-address=:${{PORT}}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now node_exporter
systemctl is-active node_exporter
echo "node_exporter ${{VERSION}} installed and listening on :${{PORT}}"
"""


_UNINSTALL_SCRIPT = """set -e
systemctl disable --now node_exporter >/dev/null 2>&1 || true
rm -f /etc/systemd/system/node_exporter.service
systemctl daemon-reload >/dev/null 2>&1 || true
rm -f /usr/local/bin/node_exporter
echo "node_exporter removed"
"""


def install(
    server: Server,
    credentials: CredentialPayload,
    sudo_password: str = "",
    *,
    version: str = NODE_EXPORTER_VERSION,
    port: int | None = None,
) -> tuple[bool, str]:
    """Install node_exporter as a systemd service on ``server``.

    Returns ``(ok, message)``. Raises ``SudoPasswordRequired`` (from ssh_ops) when a sudo password
    is needed but none was supplied, and ``SshOperationError`` for a command/transport failure --
    the route maps both onto the shared sudo-aware PrivilegedOperationResult response.
    """
    listen_port = _valid_port(server.node_exporter_port if port is None else port)
    script = _install_script(listen_port, version)
    output = ssh_ops.run_privileged(server, credentials, script, sudo_password, timeout=INSTALL_TIMEOUT_SECONDS)
    message = _last_meaningful_line(output) or f"node_exporter installed on :{listen_port}"
    return True, message


def uninstall(
    server: Server,
    credentials: CredentialPayload,
    sudo_password: str = "",
) -> tuple[bool, str]:
    """Disable and remove node_exporter from ``server``. Returns ``(ok, message)``; same error
    contract as :func:`install`."""
    output = ssh_ops.run_privileged(
        server, credentials, _UNINSTALL_SCRIPT, sudo_password, timeout=UNINSTALL_TIMEOUT_SECONDS
    )
    message = _last_meaningful_line(output) or "node_exporter removed"
    return True, message


def _last_meaningful_line(output: str) -> str:
    for line in reversed((output or "").splitlines()):
        text = line.strip()
        if text:
            return text
    return ""
