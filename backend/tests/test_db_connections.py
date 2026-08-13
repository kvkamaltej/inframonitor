"""Local tests for saved database connections (feature/db-connect follow-on) and the
parse_limit row-cap rule.

No live database is required: the CRUD path runs end to end against a temp SQLite database, and
the tables/query routes monkeypatch app.services.db_console.list_tables / run_query so the route
serialisation, the row-cap rule, and the auth wiring are exercised without a real driver.

Style mirrors tests/test_kube.py and tests/test_db_console.py: DATABASE_URL + JWT_SECRET are set
before app.main imports app.core.database (the engine is built at import time).
"""

import os
import tempfile

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_dbconntest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.services import db_console  # noqa: E402
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


# --- parse_limit (unit) ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "sql,expected",
    [
        ("SELECT 1", None),
        ("select * from t limit 50", 50),
        ("SELECT n FROM t LIMIT 10 -- c", 10),
        ("SELECT 'limit 5'", None),
        ("select * from t limit 10 offset 5", 10),
        ("SELECT * FROM t LIMIT :param", None),
        ("SELECT * FROM t /* limit 9 */", None),
        ('SELECT * FROM "limit" FROM t', None),
        ("SELECT * FROM t LIMIT 5, 10", 10),  # MySQL offset,count -> row_count
    ],
)
def test_parse_limit(sql, expected):
    assert db_console.parse_limit(sql) == expected


# --- CRUD ------------------------------------------------------------------------------------


def test_create_persists_and_encrypts(client):
    r = client.post("/api/db/connections", json={
        "name": "prod-pg", "engine": "postgres", "host": "db.internal", "port": 5432,
        "username": "reader", "password": "p@ss:word", "database": "app", "group": "EMS",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "prod-pg"
    assert body["engine"] == "postgres"
    assert body["group"] == "EMS"
    assert body["has_password"] is True
    assert body["id"]  # a public_id was minted
    # the password is never echoed back
    assert "password" not in body and "encrypted_password" not in body

    # read straight from the DB and confirm the password is stored encrypted, not in the clear
    from app.core.database import SessionLocal
    from app.core.crypto import decrypt_secret
    from app.models.entities import DbConnection
    from sqlalchemy import select

    with SessionLocal() as db:
        row = db.scalar(select(DbConnection).where(DbConnection.public_id == body["id"]))
        assert row is not None
        assert row.encrypted_password and row.encrypted_password != "p@ss:word"
        assert decrypt_secret(row.encrypted_password) == "p@ss:word"


def test_list_get_patch_delete(client):
    created = client.post("/api/db/connections", json={
        "name": "lifecycle", "engine": "mysql", "host": "h", "port": 3306, "password": "secret",
    }).json()
    cid = created["id"]

    # list
    listing = client.get("/api/db/connections")
    assert listing.status_code == 200
    assert any(c["id"] == cid for c in listing.json())

    # get
    got = client.get(f"/api/db/connections/{cid}")
    assert got.status_code == 200 and got.json()["engine"] == "mysql"

    # patch: rename + move group, leaving the password untouched (blank -> keep)
    patched = client.patch(f"/api/db/connections/{cid}", json={"name": "renamed", "group": "BH", "password": ""})
    assert patched.status_code == 200
    assert patched.json()["name"] == "renamed"
    assert patched.json()["group"] == "BH"
    assert patched.json()["has_password"] is True  # blank password did not wipe it

    # delete
    assert client.delete(f"/api/db/connections/{cid}").status_code == 204
    assert client.get(f"/api/db/connections/{cid}").status_code == 404


def test_get_missing_is_404(client):
    assert client.get("/api/db/connections/does-not-exist").status_code == 404


def test_create_rejects_bad_engine(client):
    r = client.post("/api/db/connections", json={"name": "x", "engine": "oracle", "host": "h", "port": 1521})
    assert r.status_code == 400
    assert "postgres or mysql" in r.json()["detail"]


# --- /test (unsaved + saved) -----------------------------------------------------------------


def test_test_unsaved_ok(client, monkeypatch):
    monkeypatch.setattr(db_console, "test_connection", lambda *a, **k: "Connected to PostgreSQL at h:5432")
    r = client.post("/api/db/connections/test", json={"name": "t", "engine": "postgres", "host": "h", "port": 5432})
    assert r.status_code == 200
    assert r.json()["ok"] is True and "Connected" in r.json()["message"]


def test_test_unsaved_failure_is_200_ok_false(client, monkeypatch):
    def boom(*a, **k):
        raise DbConsoleError("auth failed")

    monkeypatch.setattr(db_console, "test_connection", boom)
    r = client.post("/api/db/connections/test", json={"name": "t", "engine": "postgres", "host": "h", "port": 5432})
    assert r.status_code == 200
    assert r.json()["ok"] is False and "auth failed" in r.json()["message"]


def test_test_saved_ok(client, monkeypatch):
    cid = client.post("/api/db/connections", json={
        "name": "s", "engine": "postgres", "host": "h", "port": 5432, "password": "x",
    }).json()["id"]
    monkeypatch.setattr(db_console, "test_connection", lambda *a, **k: "Connected")
    r = client.post(f"/api/db/connections/{cid}/test")
    assert r.status_code == 200 and r.json()["ok"] is True


# --- tables + query (monkeypatched service) --------------------------------------------------


@pytest.fixture()
def conn_id(client):
    return client.post("/api/db/connections", json={
        "name": "live", "engine": "postgres", "host": "h", "port": 5432, "password": "x", "database": "app",
    }).json()["id"]


def test_tables_route(client, conn_id, monkeypatch):
    canned = [
        {"schema": "public", "name": "users", "type": "table"},
        {"schema": "public", "name": "v_active", "type": "view"},
    ]
    monkeypatch.setattr(db_console, "list_tables", lambda *a, **k: canned)
    r = client.get(f"/api/db/connections/{conn_id}/tables")
    assert r.status_code == 200
    body = r.json()
    assert body[0]["name"] == "users" and body[1]["type"] == "view"


def test_tables_route_error_is_400(client, conn_id, monkeypatch):
    def boom(*a, **k):
        raise DbConsoleError("permission denied")

    monkeypatch.setattr(db_console, "list_tables", boom)
    r = client.get(f"/api/db/connections/{conn_id}/tables")
    assert r.status_code == 400 and "permission denied" in r.json()["detail"]


def test_query_route_row_cap_default(client, conn_id, monkeypatch):
    captured = {}

    def fake_run(engine, host, port, username, password, database, sql, row_cap):
        captured["row_cap"] = row_cap
        return {"columns": ["n"], "rows": [[1]], "row_count": 1, "truncated": False, "elapsed_ms": 1}

    monkeypatch.setattr(db_console, "run_query", fake_run)
    r = client.post(f"/api/db/connections/{conn_id}/query", json={"sql": "SELECT n FROM t"})
    assert r.status_code == 200
    assert captured["row_cap"] == 200  # no LIMIT -> default cap


def test_query_route_row_cap_honors_limit(client, conn_id, monkeypatch):
    captured = {}

    def fake_run(engine, host, port, username, password, database, sql, row_cap):
        captured["row_cap"] = row_cap
        return {"columns": [], "rows": [], "row_count": 0, "truncated": False, "elapsed_ms": 0}

    monkeypatch.setattr(db_console, "run_query", fake_run)
    client.post(f"/api/db/connections/{conn_id}/query", json={"sql": "SELECT * FROM t LIMIT 50"})
    assert captured["row_cap"] == 50


def test_query_route_row_cap_hard_capped(client, conn_id, monkeypatch):
    captured = {}

    def fake_run(engine, host, port, username, password, database, sql, row_cap):
        captured["row_cap"] = row_cap
        return {"columns": [], "rows": [], "row_count": 0, "truncated": False, "elapsed_ms": 0}

    monkeypatch.setattr(db_console, "run_query", fake_run)
    client.post(f"/api/db/connections/{conn_id}/query", json={"sql": "SELECT * FROM t LIMIT 99999"})
    assert captured["row_cap"] == 5000  # hard cap


def test_query_route_error_is_400(client, conn_id, monkeypatch):
    def boom(*a, **k):
        raise DbConsoleError("syntax error")

    monkeypatch.setattr(db_console, "run_query", boom)
    r = client.post(f"/api/db/connections/{conn_id}/query", json={"sql": "SELCT 1"})
    assert r.status_code == 400 and "syntax error" in r.json()["detail"]
