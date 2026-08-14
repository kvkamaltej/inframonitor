"""Tests for list_databases (the "show all databases" listing) and the database-override query
param threaded through the metadata + query routes.

Postgres/MySQL list_databases is unit-tested by monkeypatching db_metadata._run (no driver needed);
SQLite is covered live in test_db_sqlite_live.py. The routes run end to end against a temp SQLite
app database with the service layer monkeypatched, mirroring test_db_metadata.py.
"""

import os
import tempfile

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_dbdbtest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.services import db_console, db_metadata  # noqa: E402
from app.services.db_console import DbConsoleError  # noqa: E402


_USER = {"sub": "tester@local", "role": "admin", "guest": False}


@pytest.fixture()
def client():
    from app.core.security import require_user_not_guest
    from app.main import app

    app.dependency_overrides[require_user_not_guest] = lambda: _USER
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture()
def conn_id(client):
    return client.post("/api/db/connections", json={
        "name": "meta", "engine": "postgres", "host": "h", "port": 5432, "password": "x",
        "database": "app",
    }).json()["id"]


# --- list_databases unit (monkeypatched _run) ------------------------------------------------


def test_list_databases_postgres(monkeypatch):
    monkeypatch.setattr(db_metadata, "_run", lambda *a, **k: [("app",), ("analytics",)])
    out = db_metadata.list_databases("postgres", "h", 5432, "u", "p", "app")
    assert out == [{"name": "app"}, {"name": "analytics"}]


def test_list_databases_mysql_excludes_system(monkeypatch):
    rows = [("app",), ("information_schema",), ("mysql",), ("performance_schema",), ("sys",), ("shop",)]
    monkeypatch.setattr(db_metadata, "_run", lambda *a, **k: rows)
    out = db_metadata.list_databases("mysql", "h", 3306, "u", "p", "app")
    assert out == [{"name": "app"}, {"name": "shop"}]


def test_list_databases_sqlite_basename():
    out = db_metadata.list_databases("sqlite", "", 0, "", "", "/data/library.sqlite")
    assert out == [{"name": "library.sqlite"}]


# --- /databases route ------------------------------------------------------------------------


def test_databases_route(client, conn_id, monkeypatch):
    monkeypatch.setattr(db_metadata, "list_databases", lambda *a, **k: [{"name": "app"}, {"name": "reports"}])
    r = client.get(f"/api/db/connections/{conn_id}/databases")
    assert r.status_code == 200
    assert [d["name"] for d in r.json()] == ["app", "reports"]


def test_databases_route_error_is_400(client, conn_id, monkeypatch):
    def boom(*a, **k):
        raise DbConsoleError("permission denied")

    monkeypatch.setattr(db_metadata, "list_databases", boom)
    r = client.get(f"/api/db/connections/{conn_id}/databases")
    assert r.status_code == 400 and "permission denied" in r.json()["detail"]


# --- database override threading -------------------------------------------------------------


def test_schemas_route_uses_stored_database_by_default(client, conn_id, monkeypatch):
    captured = {}

    def fake(engine, host, port, username, password, database):
        captured["database"] = database
        return [{"name": "public"}]

    monkeypatch.setattr(db_metadata, "list_schemas", fake)
    client.get(f"/api/db/connections/{conn_id}/schemas")
    assert captured["database"] == "app"  # the connection's stored database


def test_schemas_route_database_override(client, conn_id, monkeypatch):
    captured = {}

    def fake(engine, host, port, username, password, database):
        captured["database"] = database
        return [{"name": "public"}]

    monkeypatch.setattr(db_metadata, "list_schemas", fake)
    client.get(f"/api/db/connections/{conn_id}/schemas", params={"database": "other_db"})
    assert captured["database"] == "other_db"  # override wins


# --- sqlite saved connections ----------------------------------------------------------------


def test_create_sqlite_connection_ok(client):
    r = client.post("/api/db/connections", json={
        "name": "local-sqlite", "engine": "sqlite", "database": "/data/app.sqlite",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["engine"] == "sqlite"
    assert body["host"] == ""  # sqlite has no host
    assert body["port"] == 0
    assert body["database"] == "/data/app.sqlite"


def test_create_sqlite_connection_requires_database_path(client):
    r = client.post("/api/db/connections", json={"name": "bad-sqlite", "engine": "sqlite"})
    assert r.status_code == 400
    assert "file path" in r.json()["detail"].lower()


def test_create_postgres_still_requires_host(client):
    r = client.post("/api/db/connections", json={"name": "no-host", "engine": "postgres", "database": "app"})
    assert r.status_code == 400
    assert "host" in r.json()["detail"].lower()


def test_query_route_database_override(client, conn_id, monkeypatch):
    captured = {}

    def fake_run(engine, host, port, username, password, database, sql, row_cap):
        captured["database"] = database
        return {"columns": [], "rows": [], "row_count": 0, "truncated": False, "elapsed_ms": 0}

    monkeypatch.setattr(db_console, "run_query", fake_run)
    client.post(f"/api/db/connections/{conn_id}/query", params={"database": "other_db"}, json={"sql": "SELECT 1"})
    assert captured["database"] == "other_db"
