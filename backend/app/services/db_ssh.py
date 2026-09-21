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

from app.services.db_console import DbConsoleError
from app.services.ssh_common import resolve_ssh, ssh_signature

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


def _forwarder_via(jump, endpoint, dest_host, dest_port):
    """A tunnel whose SSH host (the endpoint) is itself reached THROUGH a jump host — two hops. Both
    `jump` and `endpoint` are (host, port, user, password, private_key) tuples. Opens a paramiko
    connection to the jump, a direct-tcpip channel to the endpoint's SSH port, and hands that channel
    to sshtunnel as its transport socket, so the forwarder logs in to the endpoint through the jump
    and then forwards (dest_host, dest_port) from the ENDPOINT's side. The jump client is attached to
    the returned forwarder so `_stop` closes both together.

    Used for a Kubernetes API server reachable only by SSHing into a control-plane node that itself
    sits behind a bastion: app -> jump -> node -> node's own :6443.
    """
    import sshtunnel  # noqa: PLC0415

    j_host, j_port, j_user, j_pass, j_key = jump
    e_host, e_port, e_user, e_pass, e_key = endpoint
    jump_client = paramiko.SSHClient()
    jump_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    jkwargs: dict = {
        "hostname": (j_host or "").strip(),
        "port": int(j_port or 22),
        "username": (j_user or "").strip() or None,
        "timeout": CONNECT_TIMEOUT_SECONDS,
        "banner_timeout": CONNECT_TIMEOUT_SECONDS,
        "auth_timeout": CONNECT_TIMEOUT_SECONDS,
    }
    jpkey = _pkey(j_key)
    if jpkey is not None:
        jkwargs["pkey"] = jpkey
    elif j_pass:
        jkwargs["password"] = j_pass
    try:
        jump_client.connect(**jkwargs)
    except Exception as exc:
        jump_client.close()
        raise DbTunnelError(f"Jump host {j_host}: {str(exc).splitlines()[0][:300]}") from exc
    try:
        channel = jump_client.get_transport().open_channel(
            "direct-tcpip", (e_host, int(e_port or 22)), ("", 0)
        )
    except Exception as exc:
        jump_client.close()
        raise DbTunnelError(f"Jump host {j_host} cannot reach {e_host}:{e_port or 22}: {str(exc).splitlines()[0][:300]}") from exc
    try:
        forwarder = sshtunnel.SSHTunnelForwarder(
            (e_host, int(e_port or 22)),
            ssh_username=(e_user or "").strip() or None,
            ssh_password=e_pass or None,
            ssh_pkey=_pkey(e_key),
            ssh_proxy=channel,
            ssh_proxy_enabled=True,
            remote_bind_address=(dest_host, int(dest_port or 0)),
            local_bind_address=("127.0.0.1", 0),
            set_keepalive=30.0,
        )
        forwarder.daemon_forward_servers = True
        forwarder.daemon_transport = True
        forwarder.SSH_TIMEOUT = CONNECT_TIMEOUT_SECONDS
        forwarder.start()
    except DbTunnelError:
        jump_client.close()
        raise
    except Exception as exc:
        jump_client.close()
        raise DbTunnelError(f"SSH tunnel via {e_host} (through {j_host}): {str(exc).splitlines()[0][:300]}") from exc
    forwarder._jump_client = jump_client  # type: ignore[attr-defined]  # keep alive; closed in _stop
    return forwarder


def target(conn) -> tuple[str, int]:
    """The (host, port) to actually connect to for this saved connection: direct, or the local end
    of a live SSH tunnel. Raises DbTunnelError if a configured tunnel cannot be established."""
    # The tunnel is EITHER a referenced reusable SshConfig OR the connection's inline ssh_* fields.
    tunnel = resolve_ssh(
        getattr(conn, "ssh_config", None),
        conn.ssh_host, conn.ssh_port, conn.ssh_username,
        conn.encrypted_ssh_password, conn.encrypted_ssh_private_key,
    )
    if tunnel is None:
        return conn.host, conn.port
    ssh_host, ssh_port, ssh_username, ssh_password, ssh_key_text = tunnel

    key = conn.public_id
    # A signature of the tunnel-relevant fields; if any changed since the cached tunnel was opened
    # (on the connection OR the referenced config), the old forwarder points at the wrong place and
    # must be replaced. Computed without decrypting.
    sig = ssh_signature(
        getattr(conn, "ssh_config", None), getattr(conn, "ssh_config_id", None),
        conn.ssh_host, conn.ssh_port, conn.ssh_username,
        conn.encrypted_ssh_password, conn.encrypted_ssh_private_key, conn.host, conn.port,
    )
    with _lock:
        cached = _tunnels.get(key)
        if cached is not None and cached["sig"] == sig and cached["fwd"].is_active:
            return "127.0.0.1", cached["fwd"].local_bind_port
        if cached is not None:
            _stop(cached["fwd"])
            _tunnels.pop(key, None)
        fwd = _forwarder(
            ssh_host, ssh_port, ssh_username, ssh_password, ssh_key_text,
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


def temp_target(ssh_host, ssh_port, ssh_username, ssh_password, ssh_private_key, db_host, db_port,
                config=None):
    """A one-shot forwarder for an UNSAVED connection test. Returns (host, port, forwarder); the
    caller must call `stop(forwarder)` when done. The tunnel is either a referenced SshConfig or the
    inline ssh_* fields; when neither is set, returns the direct target and a None forwarder."""
    tunnel = resolve_ssh(config, ssh_host, ssh_port, ssh_username, None, None)
    if tunnel is None:
        # No config and no inline host: nothing to tunnel through.
        if not (ssh_host or "").strip():
            return db_host, db_port, None
        ssh_host_r, ssh_port_r, ssh_username_r = ssh_host.strip(), ssh_port, ssh_username
        ssh_password_r, ssh_key_r = ssh_password or "", ssh_private_key or ""
    elif config is not None and (config.host or "").strip():
        ssh_host_r, ssh_port_r, ssh_username_r, ssh_password_r, ssh_key_r = tunnel
    else:
        # inline host present: resolve_ssh returned it but with unusable (None) creds, so use the
        # plaintext creds the caller passed for the test.
        ssh_host_r, ssh_port_r, ssh_username_r = tunnel[0], tunnel[1], tunnel[2]
        ssh_password_r, ssh_key_r = ssh_password or "", ssh_private_key or ""
    fwd = _forwarder(ssh_host_r, ssh_port_r, ssh_username_r, ssh_password_r, ssh_key_r,
                     db_host, db_port)
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
    # a two-hop forwarder (_forwarder_via) carries the jump client that owns its proxy channel; close
    # it too so the bastion connection is not leaked.
    jump_client = getattr(forwarder, "_jump_client", None)
    if jump_client is not None:
        try:
            jump_client.close()
        except Exception:
            pass
