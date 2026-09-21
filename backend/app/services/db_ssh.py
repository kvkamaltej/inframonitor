"""SSH tunnel (bastion / jump host) for database connections.

A saved DbConnection may reach its database THROUGH an SSH bastion instead of directly (the DB only
listens on a private network). This mirrors DBeaver's "SSH Tunnel": the tunnel host/port/user and
its own credentials are typed on the connection, independent of any managed server.

`target(conn)` returns the (host, port) a DB driver should actually dial:
  * no ssh_host -> the connection's own (host, port), unchanged;
  * ssh_host set -> ("127.0.0.1", <local port>) of a live forwarder that carries the bytes over SSH
    to (conn.host, conn.port).

Tunnels are kept open per connection and reused across requests (opening one per query would double
every DB round trip's latency). They are torn down when the connection is edited or deleted
(routes call `close(public_id)`), and re-established lazily if a tunnel has died.
"""

from __future__ import annotations

import threading
from io import StringIO

import paramiko

from app.core.crypto import decrypt_secret
from app.services.db_console import DbConsoleError

# Failure to bring up the tunnel is reported as a DbConsoleError subclass, so every SQL/metadata
# route's existing `except DbConsoleError` surfaces it as a clean 400 rather than a 500. The redis
# routes catch it explicitly.
class DbTunnelError(DbConsoleError):
    pass


CONNECT_TIMEOUT_SECONDS = 8

_tunnels: dict[str, "object"] = {}
_lock = threading.Lock()


def _pkey(text: str):
    key_text = (text or "").strip()
    if not key_text:
        return None
    for key_class in (paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.DSSKey):
        try:
            return key_class.from_private_key(StringIO(key_text))
        except Exception:
            continue
    raise DbTunnelError("Unable to parse the SSH tunnel private key")


def _forwarder(ssh_host, ssh_port, ssh_username, ssh_password, ssh_key_text, db_host, db_port):
    import sshtunnel  # noqa: PLC0415  # lazy so importing this module never requires the package

    try:
        forwarder = sshtunnel.SSHTunnelForwarder(
            (ssh_host, int(ssh_port or 22)),
            ssh_username=(ssh_username or "").strip() or None,
            ssh_password=ssh_password or None,
            ssh_pkey=_pkey(ssh_key_text),
            remote_bind_address=(db_host, int(db_port or 0)),
            local_bind_address=("127.0.0.1", 0),
            set_keepalive=30.0,
        )
        forwarder.daemon_forward_servers = True
        forwarder.daemon_transport = True
        forwarder.SSH_TIMEOUT = CONNECT_TIMEOUT_SECONDS
        forwarder.start()
        return forwarder
    except DbTunnelError:
        raise
    except Exception as exc:  # auth, unreachable bastion, remote host closed, ...
        raise DbTunnelError(f"SSH tunnel via {ssh_host}: {str(exc).splitlines()[0][:300]}") from exc


def target(conn) -> tuple[str, int]:
    """The (host, port) to actually connect to for this saved connection: direct, or the local end
    of a live SSH tunnel. Raises DbTunnelError if a configured tunnel cannot be established."""
    if not (getattr(conn, "ssh_host", "") or "").strip():
        return conn.host, conn.port

    key = conn.public_id
    # A signature of the tunnel-relevant fields; if any changed since the cached tunnel was opened,
    # the old forwarder points at the wrong place and must be replaced.
    sig = (conn.ssh_host, conn.ssh_port, conn.ssh_username, conn.encrypted_ssh_password,
           conn.encrypted_ssh_private_key, conn.host, conn.port)
    with _lock:
        cached = _tunnels.get(key)
        if cached is not None and cached["sig"] == sig and cached["fwd"].is_active:
            return "127.0.0.1", cached["fwd"].local_bind_port
        if cached is not None:
            _stop(cached["fwd"])
            _tunnels.pop(key, None)
        fwd = _forwarder(
            conn.ssh_host.strip(), conn.ssh_port, conn.ssh_username,
            decrypt_secret(conn.encrypted_ssh_password) if conn.encrypted_ssh_password else "",
            decrypt_secret(conn.encrypted_ssh_private_key) if conn.encrypted_ssh_private_key else "",
            conn.host, conn.port,
        )
        _tunnels[key] = {"fwd": fwd, "sig": sig}
        return "127.0.0.1", fwd.local_bind_port


def close(public_id: str) -> None:
    """Tear down a connection's tunnel (called when it is edited or deleted)."""
    with _lock:
        cached = _tunnels.pop(public_id, None)
    if cached is not None:
        _stop(cached["fwd"])


def temp_target(ssh_host, ssh_port, ssh_username, ssh_password, ssh_private_key, db_host, db_port):
    """A one-shot forwarder for an UNSAVED connection test. Returns (host, port, forwarder); the
    caller must call `stop(forwarder)` when done. When ssh_host is blank, returns the direct target
    and a None forwarder."""
    if not (ssh_host or "").strip():
        return db_host, db_port, None
    fwd = _forwarder(ssh_host.strip(), ssh_port, ssh_username, ssh_password or "",
                     ssh_private_key or "", db_host, db_port)
    return "127.0.0.1", fwd.local_bind_port, fwd


def stop(forwarder) -> None:
    _stop(forwarder)


def _stop(forwarder) -> None:
    if forwarder is None:
        return
    try:
        forwarder.stop()
    except Exception:
        pass
