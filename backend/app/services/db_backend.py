"""Switch Infra Monitor's OWN backing database (feature/app-db-backend).

The app ships on a local SQLite file. This service lets an admin point it at an external
PostgreSQL (primary) or MySQL instead, copying all existing data across first. Because the
SQLAlchemy engine is a module-level singleton built once at import (see
``app.core.database``), the switch cannot happen live: the chosen target URL is written to a
JSON override file next to the SQLite database and picked up on the NEXT start.

Flow behind the admin config page:
  * ``build_url`` turns form fields into a driver URL (postgres -> ``postgresql+psycopg``,
    mysql -> ``mysql+pymysql``), URL-encoding the credentials.
  * ``test_url`` opens a short-lived connection, runs ``SELECT 1`` and disposes it, never
    raising -- the Test-connection button gets ``(ok, message)`` either way.
  * ``migrate_to`` COPIES (never moves) every table from the current engine into the target,
    preserving primary keys, then on PostgreSQL resets each identity sequence so future
    inserts do not collide with the copied ids. The source SQLite is left untouched, so a
    failed or aborted migration loses nothing.
  * ``write_override`` / ``clear_override`` manage the override file; ``current_config``
    reports the active backend with the password masked.

Encrypted-credential columns (``Server.encrypted_password`` etc.) are plain text as far as
this copy is concerned -- they are moved verbatim. ``JWT_SECRET`` is unchanged, so the Fernet
key is identical on the new database and the ciphertext still decrypts.
"""

from __future__ import annotations

import json
import os

from sqlalchemy import Integer, create_engine, select, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError

from app.core.database import (
    Base,
    effective_database_url,
    override_path,
    read_override_url,
)
from app.models import entities  # noqa: F401 -- register all tables on Base.metadata

# supported external targets and the SQLAlchemy driver each maps to
_DRIVERS = {"postgres": "postgresql+psycopg", "mysql": "mysql+pymysql"}
DEFAULT_PORTS = {"postgres": 5432, "mysql": 3306}

CONNECT_TIMEOUT_SECONDS = 8


def _friendly_backend(backend: str) -> str:
    return {"sqlite": "SQLite", "postgresql": "PostgreSQL", "mysql": "MySQL"}.get(backend, backend)


def _clean(exc: Exception) -> str:
    """Collapse a noisy driver exception to a single, operator-safe line."""
    text_value = str(exc).strip() or exc.__class__.__name__
    first = next((line.strip() for line in text_value.splitlines() if line.strip()), text_value)
    return first[:500]


def _connect_args(url_obj) -> dict:
    """Short connect timeout so a bad host cannot hang the request. SQLite ignores it."""
    backend = url_obj.get_backend_name()
    if backend in ("postgresql", "mysql"):
        return {"connect_timeout": CONNECT_TIMEOUT_SECONDS}
    return {}


# --- URL construction / masking ------------------------------------------------------------


def build_url(engine: str, host: str, port: int | None, username: str, password: str, database: str) -> str:
    """Build a SQLAlchemy URL for ``engine`` ('postgres'|'mysql') with credentials URL-encoded.

    Uses ``URL.create`` so any special characters in the username/password/database are percent-
    encoded correctly when the URL is rendered.
    """
    driver = _DRIVERS.get(engine)
    if driver is None:
        raise ValueError(f"Unsupported engine '{engine}'. Use one of: {', '.join(_DRIVERS)}.")
    resolved_port = int(port) if port else DEFAULT_PORTS[engine]
    url = URL.create(
        driver,
        username=(username or None),
        password=(password or None),
        host=(host or None),
        port=resolved_port,
        database=(database or None),
    )
    return url.render_as_string(hide_password=False)


def mask_url(url: str) -> str:
    """Render ``url`` with the password replaced by ``***`` (safe to show/log)."""
    try:
        return make_url(url).render_as_string(hide_password=True)
    except ArgumentError:
        return url


# --- connectivity test ----------------------------------------------------------------------


def test_url(url: str) -> tuple[bool, str]:
    """Open a short-lived connection, run SELECT 1, dispose. Never raises."""
    try:
        url_obj = make_url(url)
    except ArgumentError as exc:
        return False, f"Invalid database URL: {exc}"
    try:
        eng = create_engine(url, connect_args=_connect_args(url_obj))
    except Exception as exc:  # e.g. a driver that is not installed
        return False, _clean(exc)
    try:
        with eng.connect() as conn:
            conn.execute(text("SELECT 1"))
        where = url_obj.host or url_obj.database or ""
        return True, f"Connected to {_friendly_backend(url_obj.get_backend_name())}{f' at {where}' if where else ''}."
    except Exception as exc:
        return False, _clean(exc)
    finally:
        eng.dispose()


# --- copy migration -------------------------------------------------------------------------


def _reset_pg_sequences(conn, dialect_name: str, counts: dict[str, int]) -> None:
    """PostgreSQL only: after copying with explicit ids, advance each identity sequence past the
    highest copied id so the next auto-generated id does not collide with an existing row.

    Only integer single-column primary keys have a serial sequence; ``app_settings`` (a string
    PK) has none and is skipped. Empty tables are skipped too -- their sequence already sits at
    its default. On MySQL the AUTO_INCREMENT counter self-heals on insert-with-id, so nothing is
    needed there.
    """
    if dialect_name != "postgresql":
        return
    for table in Base.metadata.sorted_tables:
        if counts.get(table.name, 0) == 0:
            continue
        pk_cols = list(table.primary_key.columns)
        if len(pk_cols) != 1:
            continue
        pk = pk_cols[0]
        if not isinstance(pk.type, Integer):
            continue
        # pg_get_serial_sequence returns NULL for a non-serial column; setval(NULL, ...) would
        # error, so guard the call to a no-op in that case.
        conn.execute(
            text(
                "SELECT setval(seq, (SELECT COALESCE(MAX(\"{pk}\"), 1) FROM \"{tbl}\")) "
                "FROM (SELECT pg_get_serial_sequence(:tbl, :pk) AS seq) s WHERE seq IS NOT NULL".format(
                    pk=pk.name, tbl=table.name
                )
            ),
            {"tbl": table.name, "pk": pk.name},
        )


def migrate_to(target_url: str) -> dict:
    """Copy every table from the CURRENT engine into ``target_url``, preserving primary keys.

    Returns ``{"ok": bool, "message": str, "tables": {name: rowcount}}``. On any failure the
    target is left as-is and the source SQLite is untouched (this is a copy, not a move); the
    caller must NOT write the override file unless ``ok`` is true.
    """
    # imported here (not at module load) so this always reflects the engine the app is running on
    from app.core.database import engine as source_engine

    try:
        target_url_obj = make_url(target_url)
    except ArgumentError as exc:
        return {"ok": False, "message": f"Invalid target URL: {exc}", "tables": {}}

    try:
        target_engine = create_engine(target_url, connect_args=_connect_args(target_url_obj))
    except Exception as exc:
        return {"ok": False, "message": _clean(exc), "tables": {}}

    try:
        # 1. schema on the target (create_all is a no-op for tables that already exist)
        Base.metadata.create_all(bind=target_engine)

        # 2. read every table from the source, in FK-safe (referenced-first) order
        data: dict[str, list[dict]] = {}
        with source_engine.connect() as src:
            for table in Base.metadata.sorted_tables:
                data[table.name] = [dict(row._mapping) for row in src.execute(select(table))]

        # 3. bulk insert into the target in the same order, then fix PG sequences, in one txn
        counts: dict[str, int] = {}
        with target_engine.begin() as dst:
            for table in Base.metadata.sorted_tables:
                rows = data[table.name]
                if rows:
                    dst.execute(table.insert(), rows)
                counts[table.name] = len(rows)
            _reset_pg_sequences(dst, target_engine.dialect.name, counts)
    except Exception as exc:
        return {"ok": False, "message": _clean(exc), "tables": {}}
    finally:
        target_engine.dispose()

    total = sum(counts.values())
    return {
        "ok": True,
        "message": f"Copied {total} row(s) across {len(counts)} table(s) to {_friendly_backend(target_url_obj.get_backend_name())}.",
        "tables": counts,
    }


# --- override file management ---------------------------------------------------------------


def write_override(url: str) -> str:
    """Write ``db_config.json`` so the NEXT start uses ``url``. Returns the file path."""
    path = override_path()
    if not path:
        raise RuntimeError(
            "The app is not running on the default SQLite backend, so there is no location to "
            "store the database override."
        )
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"url": url}, handle)
    return path


def clear_override() -> bool:
    """Remove the override file so the NEXT start reverts to the configured SQLite. Idempotent."""
    path = override_path()
    if path and os.path.exists(path):
        os.remove(path)
        return True
    return False


def current_config() -> dict:
    """Report the active backend, masked URL, and whether an override file is in force."""
    eff = effective_database_url()
    try:
        backend = make_url(eff).get_backend_name()
    except ArgumentError:
        backend = "unknown"
    return {
        "backend": _friendly_backend(backend),
        "url_masked": mask_url(eff),
        "is_override": read_override_url() is not None,
    }
