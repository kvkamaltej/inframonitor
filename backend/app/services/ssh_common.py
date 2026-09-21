"""Shared resolution of a jump host / SSH tunnel: from a reusable SshConfig or inline fields.

A server's jump host and a database connection's SSH tunnel each store EITHER a reference to a
reusable `SshConfig` (the "global SSH config", selected from a dropdown) OR the bastion details
inline. This turns both cases into one (host, port, username, password, private_key), or None when
no jump/tunnel is configured. Credentials come back decrypted.
"""

from __future__ import annotations

from app.core.crypto import decrypt_secret


def resolve_ssh(config, host, port, username, enc_password, enc_private_key):
    """(host, port, username, password, private_key) for the jump/tunnel, or None if none is set.

    A referenced SshConfig wins over the inline fields. Passwords/keys are returned decrypted.
    """
    if config is not None and (config.host or "").strip():
        return (
            config.host.strip(),
            config.port or 22,
            config.username or "",
            decrypt_secret(config.encrypted_password) if config.encrypted_password else "",
            decrypt_secret(config.encrypted_private_key) if config.encrypted_private_key else "",
        )
    if (host or "").strip():
        return (
            host.strip(),
            port or 22,
            username or "",
            decrypt_secret(enc_password) if enc_password else "",
            decrypt_secret(enc_private_key) if enc_private_key else "",
        )
    return None


def ssh_signature(config, config_id, host, port, username, enc_password, enc_private_key, db_host, db_port):
    """A cache key over the tunnel-relevant fields, computed WITHOUT decrypting, so an edit to either
    the connection or the referenced SshConfig invalidates a cached tunnel."""
    if config is not None:
        return ("cfg", config_id, config.host, config.port, config.username,
                config.encrypted_password, config.encrypted_private_key, db_host, db_port)
    return ("inline", host, port, username, enc_password, enc_private_key, db_host, db_port)
