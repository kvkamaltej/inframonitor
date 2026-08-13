"""Secrets backend abstraction for stored SSH credentials.

Two backends live behind one small API (``store_credentials`` / ``load_credentials``):

* **Fernet (default, unchanged).** The historical path: each secret is encrypted with the
  Fernet key derived from ``JWT_SECRET`` (see ``app.core.crypto``) and the ciphertext is kept
  in ``Server.encrypted_password`` / ``Server.encrypted_private_key``. This is what runs when
  Vault is disabled, which is the default, so existing installs behave exactly as before.

* **HashiCorp Vault (opt-in).** When an admin enables Vault in app settings, new secrets are
  written to Vault KV v2 at ``<kv_mount>/<path_prefix>/<server.public_id>`` with the fields
  ``password`` and ``private_key``. Token auth only (v1).

Per-server storage scheme (backward compatible)
-----------------------------------------------
The ``Server.encrypted_password`` / ``Server.encrypted_private_key`` columns keep doing double
duty as the routing marker, decided **per field**:

* a value that is the sentinel ``"vault:"`` means "the real secret for this field lives in
  Vault, keyed by this server's ``public_id``";
* any other non-empty value is Fernet ciphertext (the pre-existing scheme);
* an empty string means "no secret".

Because the marker is per field, a server can legitimately have its password in Vault while an
older private key is still Fernet-encrypted in the DB (e.g. Vault was turned on and only the
password was re-saved). ``load_credentials`` decodes each column independently, so both keep
working. Nothing migrates existing Fernet secrets into Vault implicitly — a secret moves to
Vault only when it is next written while Vault is enabled.

If a field is marked ``vault:`` but Vault is unreachable, reads raise ``VaultError`` (surfaced
as a clear API error) rather than silently returning an empty credential.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.core.crypto import decrypt_secret, encrypt_secret
from app.models.entities import AppSetting, Server

# AppSetting key holding the Vault configuration JSON.
VAULT_CONFIG_KEY = "vault_config"

# Written verbatim into a credential column when that field's real secret lives in Vault.
VAULT_SENTINEL = "vault:"

DEFAULT_KV_MOUNT = "secret"
DEFAULT_PATH_PREFIX = "inframonitor"


class VaultError(RuntimeError):
    """A required Vault operation failed (unreachable, unauthenticated, or denied).

    Raised only when Vault is actually needed (enabled for a write, or a field is marked
    ``vault:`` for a read). The route layer converts it into a clear HTTP error; it is never
    raised on the default Fernet path.
    """


@dataclass
class VaultConfig:
    enabled: bool = False
    address: str = ""
    token: str = ""
    kv_mount: str = DEFAULT_KV_MOUNT
    path_prefix: str = DEFAULT_PATH_PREFIX

    @property
    def token_set(self) -> bool:
        return bool(self.token)


# --- configuration in AppSetting -----------------------------------------------------------


def get_vault_config(db: Session) -> VaultConfig:
    """Read the stored Vault config, falling back to disabled defaults when unset/corrupt."""
    setting = db.get(AppSetting, VAULT_CONFIG_KEY)
    if not setting or not setting.value:
        return VaultConfig()
    try:
        raw = json.loads(setting.value)
    except json.JSONDecodeError:
        return VaultConfig()
    if not isinstance(raw, dict):
        return VaultConfig()
    return VaultConfig(
        enabled=bool(raw.get("enabled", False)),
        address=str(raw.get("address") or "").strip(),
        token=str(raw.get("token") or ""),
        kv_mount=str(raw.get("kv_mount") or DEFAULT_KV_MOUNT).strip() or DEFAULT_KV_MOUNT,
        path_prefix=(str(raw.get("path_prefix") or DEFAULT_PATH_PREFIX).strip().strip("/") or DEFAULT_PATH_PREFIX),
    )


def save_vault_config(
    db: Session,
    *,
    enabled: bool,
    address: str,
    kv_mount: str,
    path_prefix: str,
    token: str | None = None,
) -> VaultConfig:
    """Persist the Vault config. The token is only overwritten when a non-empty one is supplied.

    Passing ``token=None`` or ``token=""`` keeps whatever token is already stored, so the UI can
    save address/mount/prefix changes without ever having to re-send (or even see) the token.
    """
    current = get_vault_config(db)
    new_token = current.token
    if token:
        new_token = token
    cfg = VaultConfig(
        enabled=bool(enabled),
        address=(address or "").strip(),
        token=new_token,
        kv_mount=(kv_mount or "").strip() or DEFAULT_KV_MOUNT,
        path_prefix=((path_prefix or "").strip().strip("/") or DEFAULT_PATH_PREFIX),
    )
    setting = db.get(AppSetting, VAULT_CONFIG_KEY)
    if not setting:
        setting = AppSetting(key=VAULT_CONFIG_KEY, value="")
        db.add(setting)
    setting.value = json.dumps(
        {
            "enabled": cfg.enabled,
            "address": cfg.address,
            "token": cfg.token,
            "kv_mount": cfg.kv_mount,
            "path_prefix": cfg.path_prefix,
        }
    )
    db.commit()
    return cfg


# --- Vault client ---------------------------------------------------------------------------


def _client(cfg: VaultConfig):
    """Build an authenticated hvac client or raise VaultError.

    hvac is imported lazily so the default (Fernet) path never pays for the import and installs
    without Vault enabled do not require the dependency to be present at call time.
    """
    if not cfg.address:
        raise VaultError("Vault address is not configured.")
    if not cfg.token:
        raise VaultError("Vault token is not configured.")
    try:
        import hvac
    except ImportError as exc:  # pragma: no cover - dependency is in requirements.txt
        raise VaultError("The 'hvac' package is not installed on the server.") from exc
    try:
        client = hvac.Client(url=cfg.address, token=cfg.token, timeout=5)
        authenticated = client.is_authenticated()
    except VaultError:
        raise
    except Exception as exc:
        raise VaultError(f"Cannot reach Vault at {cfg.address}: {exc}") from exc
    if not authenticated:
        raise VaultError("Vault rejected the token (authentication failed).")
    return client


def test_vault(cfg: VaultConfig) -> tuple[bool, str]:
    """Connectivity/auth probe for the Test-connection button. Never raises."""
    if not cfg.address:
        return False, "Vault address is not set."
    if not cfg.token:
        return False, "Vault token is not set."
    try:
        _client(cfg)
    except VaultError as exc:
        return False, str(exc)
    except Exception as exc:  # defensive: test must always degrade gracefully
        return False, f"Vault test failed: {exc}"
    return True, f"Connected to Vault at {cfg.address} and authenticated (KV mount '{cfg.kv_mount}')."


def _secret_path(cfg: VaultConfig, server: Server) -> str:
    prefix = cfg.path_prefix.strip().strip("/")
    return f"{prefix}/{server.public_id}" if prefix else server.public_id


def _read_vault_secret(client, cfg: VaultConfig, server: Server) -> dict:
    """Return the {password, private_key} dict stored at the server's path, or {} if none."""
    import hvac

    try:
        resp = client.secrets.kv.v2.read_secret_version(
            path=_secret_path(cfg, server),
            mount_point=cfg.kv_mount,
            raise_on_deleted_version=True,
        )
    except hvac.exceptions.InvalidPath:
        return {}
    except VaultError:
        raise
    except Exception as exc:
        raise VaultError(f"Failed to read secret from Vault: {exc}") from exc
    return ((resp or {}).get("data") or {}).get("data") or {}


# --- public API used by the routes ----------------------------------------------------------


def store_credentials(db: Session, server: Server, password: str, private_key: str) -> None:
    """Persist the provided (non-empty) credential fields for ``server``.

    An empty ``password``/``private_key`` means "leave this field as it is", matching the prior
    behaviour of the route helper. On the Vault path the two fields share one KV secret, so any
    field not being changed is merged back from the existing Vault secret before the write, and
    the corresponding DB column is stamped with the ``vault:`` sentinel. Raises ``VaultError``
    (before touching the DB columns) if Vault is enabled but the write cannot complete, so a
    Vault outage surfaces as an error instead of corrupting stored data.
    """
    cfg = get_vault_config(db)
    if cfg.enabled:
        client = _client(cfg)
        existing = _read_vault_secret(client, cfg, server)
        data: dict[str, str] = {}
        if existing.get("password"):
            data["password"] = existing["password"]
        if existing.get("private_key"):
            data["private_key"] = existing["private_key"]
        if password:
            data["password"] = password
        if private_key:
            data["private_key"] = private_key
        if data:
            try:
                client.secrets.kv.v2.create_or_update_secret(
                    path=_secret_path(cfg, server),
                    secret=data,
                    mount_point=cfg.kv_mount,
                )
            except Exception as exc:
                raise VaultError(f"Failed to write secret to Vault: {exc}") from exc
        if password:
            server.encrypted_password = VAULT_SENTINEL
        if private_key:
            server.encrypted_private_key = VAULT_SENTINEL
        return

    # Default backend: local Fernet, byte-for-byte the pre-existing behaviour.
    if password:
        server.encrypted_password = encrypt_secret(password)
    if private_key:
        server.encrypted_private_key = encrypt_secret(private_key)


def _decode_field(value: str, name: str, vault_data: dict | None) -> str:
    if value.startswith(VAULT_SENTINEL):
        return (vault_data or {}).get(name) or ""
    return decrypt_secret(value)


def load_credentials(db: Session, server: Server) -> tuple[str, str]:
    """Return ``(password, private_key)`` for ``server``, reading each field from wherever it
    lives (Vault if marked, otherwise Fernet). Raises ``VaultError`` if a field is marked
    ``vault:`` but Vault cannot be reached."""
    pw_field = server.encrypted_password or ""
    key_field = server.encrypted_private_key or ""
    vault_data: dict | None = None
    if pw_field.startswith(VAULT_SENTINEL) or key_field.startswith(VAULT_SENTINEL):
        cfg = get_vault_config(db)
        client = _client(cfg)
        vault_data = _read_vault_secret(client, cfg, server)
    password = _decode_field(pw_field, "password", vault_data)
    private_key = _decode_field(key_field, "private_key", vault_data)
    return password, private_key
