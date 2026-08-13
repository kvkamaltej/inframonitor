import json
import os
from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


def _is_sqlite(database_url: str) -> bool:
    return make_url(database_url).get_backend_name() == "sqlite"


def _ensure_sqlite_parent_dir(database_url: str) -> None:
    database = make_url(database_url).database
    if not database or database == ":memory:":
        return
    parent = os.path.dirname(os.path.abspath(database))
    if parent:
        os.makedirs(parent, exist_ok=True)


# --- persistent DB-backend override (feature/app-db-backend) -------------------------------
#
# The app cannot swap its own SQLAlchemy engine live, so switching Infra Monitor's backing
# database to an external PostgreSQL/MySQL is a "takes effect on the NEXT start" operation. The
# chosen target is stored as a tiny JSON file next to the SQLite database:
#
#     {"url": "postgresql+psycopg://user:pass@host:5432/db"}
#
# At import time the engine below is built from the EFFECTIVE url = (a valid override file url)
# OR settings.database_url. A missing/blank/corrupt override file is ignored silently so a bad
# file can never stop the app from booting -- it simply falls back to SQLite as today.

OVERRIDE_FILENAME = "db_config.json"


def _sqlite_dir(database_url: str) -> str | None:
    """Directory holding the SQLite database file, or None for non-sqlite / in-memory."""
    try:
        url = make_url(database_url)
    except ArgumentError:
        return None
    if url.get_backend_name() != "sqlite":
        return None
    database = url.database
    if not database or database == ":memory:":
        return None
    return os.path.dirname(os.path.abspath(database))


def override_path() -> str | None:
    """Absolute path of the db_config.json override file, or None when there is nowhere to anchor it.

    The location is derived from the CONFIGURED database_url (settings), not the effective one, so
    the file is always found at the same place regardless of which backend is currently active:
    the directory that holds the SQLite database (``%APPDATA%\\InfraMonitor`` for the desktop app,
    ``./data`` for the server). Returns None when the configured URL is not a SQLite file path
    (e.g. an install already pointed straight at Postgres via DATABASE_URL, or ``:memory:``) --
    there is then no canonical directory to place the override in, and the feature is unavailable.
    """
    directory = _sqlite_dir(get_settings().database_url)
    if directory is None:
        return None
    return os.path.join(directory, OVERRIDE_FILENAME)


def read_override_url() -> str | None:
    """The url stored in the override file, or None if absent/blank/unparseable. Never raises."""
    path = override_path()
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    url = raw.get("url")
    if not isinstance(url, str) or not url.strip():
        return None
    url = url.strip()
    try:
        make_url(url)  # reject a value that is not a valid SQLAlchemy URL
    except ArgumentError:
        return None
    return url


def effective_database_url() -> str:
    """The URL the engine is actually built from: a valid override url, else settings.database_url.

    Never raises -- any problem reading the override falls back silently to the configured URL, so
    with no override file the app runs on SQLite exactly as before.
    """
    return read_override_url() or get_settings().database_url


def _build_engine(database_url: str) -> Engine:
    # Two dialects are supported: SQLite (lite profile) and PostgreSQL via
    # postgresql+psycopg:// (full profile), plus MySQL via mysql+pymysql:// for the
    # app-DB-backend switch. Everything SQLite-specific below -- check_same_thread, the
    # parent-directory creation and the PRAGMAs -- is confined to the branch after this guard,
    # so a server dialect gets a plain pooled engine.
    if not _is_sqlite(database_url):
        return create_engine(database_url, pool_pre_ping=True, pool_recycle=1800)
    _ensure_sqlite_parent_dir(database_url)
    sqlite_engine = create_engine(
        database_url,
        pool_pre_ping=True,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(sqlite_engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, connection_record) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.execute("PRAGMA foreign_keys=ON")
        finally:
            cursor.close()

    return sqlite_engine


engine = _build_engine(effective_database_url())
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
