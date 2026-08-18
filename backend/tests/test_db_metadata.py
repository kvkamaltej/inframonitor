"""Local tests for the database metadata / catalog-browsing routes, the connection `environment`
field, query-history recording, and generate_sql shape.

No live database is required: the metadata routes monkeypatch app.services.db_metadata.* to canned
data so the route serialisation and auth wiring are exercised without a real driver, generate_sql is
unit-tested against a monkeypatched list_columns, and the CRUD/history paths run end to end against a
temp SQLite database.

Style mirrors tests/test_db_connections.py: DATABASE_URL + JWT_SECRET are set before app.main imports
app.core.database (the engine is built at import time).
"""

import os
import tempfile

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_dbmetatest_")
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
    from app.core.security import require_user
    from app.main import app

    app.dependency_overrides[require_user] = lambda: _USER
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture()
def conn_id(client):
    return client.post("/api/db/connections", json={
        "name": "meta", "engine": "postgres", "host": "h", "port": 5432, "password": "x",
        "database": "app", "environment": "prod",
    }).json()["id"]


# --- connection environment field ------------------------------------------------------------


def test_environment_persists_and_echoes(client):
    r = client.post("/api/db/connections", json={
        "name": "envconn", "engine": "postgres", "host": "h", "port": 5432, "environment": "qa",
    })
    assert r.status_code == 201
    assert r.json()["environment"] == "qa"

    cid = r.json()["id"]
    assert client.get(f"/api/db/connections/{cid}").json()["environment"] == "qa"

    # patch to a new environment, and clearing it back to ""
    assert client.patch(f"/api/db/connections/{cid}", json={"environment": "prod"}).json()["environment"] == "prod"
    assert client.patch(f"/api/db/connections/{cid}", json={"environment": ""}).json()["environment"] == ""


def test_environment_defaults_blank(client):
    r = client.post("/api/db/connections", json={"name": "noenv", "engine": "mysql", "host": "h", "port": 3306})
    assert r.status_code == 201
    assert r.json()["environment"] == ""


# --- metadata routes (monkeypatched service) -------------------------------------------------


def test_schemas_route(client, conn_id, monkeypatch):
    monkeypatch.setattr(db_metadata, "list_schemas", lambda *a, **k: [{"name": "public"}, {"name": "app"}])
    r = client.get(f"/api/db/connections/{conn_id}/schemas")
    assert r.status_code == 200
    assert [s["name"] for s in r.json()] == ["public", "app"]


def test_schema_tables_route(client, conn_id, monkeypatch):
    canned = [
        {"schema": "public", "name": "users", "type": "table"},
        {"schema": "public", "name": "v_active", "type": "view"},
    ]
    monkeypatch.setattr(db_metadata, "list_tables_in_schema", lambda *a, **k: canned)
    r = client.get(f"/api/db/connections/{conn_id}/schemas/public/tables")
    assert r.status_code == 200
    body = r.json()
    assert body[0]["name"] == "users" and body[1]["type"] == "view"


def test_routines_route(client, conn_id, monkeypatch):
    canned = [{"schema": "public", "name": "do_it", "kind": "procedure"}]
    monkeypatch.setattr(db_metadata, "list_routines", lambda *a, **k: canned)
    r = client.get(f"/api/db/connections/{conn_id}/schemas/public/routines")
    assert r.status_code == 200 and r.json()[0]["kind"] == "procedure"


def test_columns_route(client, conn_id, monkeypatch):
    canned = [
        {"name": "id", "data_type": "integer", "nullable": False, "default": "", "is_primary_key": True, "ordinal": 1},
        {"name": "name", "data_type": "text", "nullable": True, "default": "", "is_primary_key": False, "ordinal": 2},
    ]
    monkeypatch.setattr(db_metadata, "list_columns", lambda *a, **k: canned)
    r = client.get(f"/api/db/connections/{conn_id}/tables/public/users/columns")
    assert r.status_code == 200
    body = r.json()
    assert body[0]["is_primary_key"] is True and body[1]["name"] == "name"


def test_indexes_route(client, conn_id, monkeypatch):
    canned = [{"name": "users_pkey", "columns": ["id"], "unique": True, "primary": True}]
    monkeypatch.setattr(db_metadata, "list_indexes", lambda *a, **k: canned)
    r = client.get(f"/api/db/connections/{conn_id}/tables/public/users/indexes")
    assert r.status_code == 200 and r.json()[0]["columns"] == ["id"]


def test_constraints_route(client, conn_id, monkeypatch):
    canned = [{"name": "users_pkey", "type": "PRIMARY KEY", "definition": "PRIMARY KEY (id)"}]
    monkeypatch.setattr(db_metadata, "list_constraints", lambda *a, **k: canned)
    r = client.get(f"/api/db/connections/{conn_id}/tables/public/users/constraints")
    assert r.status_code == 200 and r.json()[0]["type"] == "PRIMARY KEY"


def test_foreign_keys_route(client, conn_id, monkeypatch):
    canned = [{"name": "fk_o", "columns": ["user_id"], "ref_schema": "public", "ref_table": "users", "ref_columns": ["id"]}]
    monkeypatch.setattr(db_metadata, "list_foreign_keys", lambda *a, **k: canned)
    r = client.get(f"/api/db/connections/{conn_id}/tables/public/orders/foreign-keys")
    assert r.status_code == 200 and r.json()[0]["ref_table"] == "users"


def test_metadata_route_error_is_400(client, conn_id, monkeypatch):
    def boom(*a, **k):
        raise DbConsoleError("permission denied")

    monkeypatch.setattr(db_metadata, "list_schemas", boom)
    r = client.get(f"/api/db/connections/{conn_id}/schemas")
    assert r.status_code == 400 and "permission denied" in r.json()["detail"]


def test_generate_sql_route(client, conn_id, monkeypatch):
    monkeypatch.setattr(db_metadata, "generate_sql", lambda *a, **k: "SELECT 1;")
    r = client.post(f"/api/db/connections/{conn_id}/generate-sql", json={"schema": "public", "table": "users", "kind": "select"})
    assert r.status_code == 200 and r.json()["sql"] == "SELECT 1;"


def test_generate_sql_route_error_is_400(client, conn_id, monkeypatch):
    def boom(*a, **k):
        raise DbConsoleError("Unknown SQL kind: bogus")

    monkeypatch.setattr(db_metadata, "generate_sql", boom)
    r = client.post(f"/api/db/connections/{conn_id}/generate-sql", json={"table": "users", "kind": "bogus"})
    assert r.status_code == 400 and "Unknown SQL kind" in r.json()["detail"]


# --- query history ---------------------------------------------------------------------------


def test_query_records_success_history(client, conn_id, monkeypatch):
    client.delete("/api/db/query-history")  # this module shares one SQLite file; start clean
    monkeypatch.setattr(db_console, "run_query", lambda *a, **k: {
        "columns": ["n"], "rows": [[1]], "row_count": 1, "truncated": False, "elapsed_ms": 7,
    })
    client.post(f"/api/db/connections/{conn_id}/query", json={"sql": "SELECT n FROM t"})

    hist = client.get("/api/db/query-history").json()
    assert len(hist) == 1
    row = hist[0]
    assert row["status"] == "success"
    assert row["sql"] == "SELECT n FROM t"
    assert row["row_count"] == 1 and row["elapsed_ms"] == 7
    assert row["connection_name"] == "meta" and row["engine"] == "postgres" and row["database"] == "app"
    assert row["user_email"] == "tester@local"


def test_query_records_error_history(client, conn_id, monkeypatch):
    def boom(*a, **k):
        raise DbConsoleError("syntax error")

    monkeypatch.setattr(db_console, "run_query", boom)
    r = client.post(f"/api/db/connections/{conn_id}/query", json={"sql": "SELCT 1"})
    assert r.status_code == 400

    hist = client.get("/api/db/query-history").json()
    assert any(h["status"] == "error" and "syntax error" in h["error"] for h in hist)


def test_query_history_filters_and_clear(client, conn_id, monkeypatch):
    client.delete("/api/db/query-history")  # this module shares one SQLite file; start clean
    monkeypatch.setattr(db_console, "run_query", lambda *a, **k: {
        "columns": [], "rows": [], "row_count": 0, "truncated": False, "elapsed_ms": 1,
    })
    client.post(f"/api/db/connections/{conn_id}/query", json={"sql": "SELECT alpha FROM t"})
    client.post(f"/api/db/connections/{conn_id}/query", json={"sql": "SELECT beta FROM t"})

    # newest first
    hist = client.get("/api/db/query-history").json()
    assert hist[0]["sql"] == "SELECT beta FROM t"

    # search is a case-insensitive LIKE on sql
    only_alpha = client.get("/api/db/query-history", params={"search": "ALPHA"}).json()
    assert len(only_alpha) == 1 and only_alpha[0]["sql"] == "SELECT alpha FROM t"

    # status filter
    assert client.get("/api/db/query-history", params={"status": "error"}).json() == []

    # connection_id filter (numeric primary key)
    cid_int = only_alpha[0]["connection_id"]
    assert len(client.get("/api/db/query-history", params={"connection_id": cid_int}).json()) == 2

    # clear wipes the caller's own rows
    assert client.delete("/api/db/query-history").status_code == 204
    assert client.get("/api/db/query-history").json() == []


def test_query_history_survives_connection_delete(client, conn_id, monkeypatch):
    monkeypatch.setattr(db_console, "run_query", lambda *a, **k: {
        "columns": [], "rows": [], "row_count": 0, "truncated": False, "elapsed_ms": 1,
    })
    client.post(f"/api/db/connections/{conn_id}/query", json={"sql": "SELECT 1"})
    assert client.delete(f"/api/db/connections/{conn_id}").status_code == 204
    # the history row remains, snapshotting the now-deleted connection's identity
    hist = client.get("/api/db/query-history").json()
    assert any(h["connection_name"] == "meta" for h in hist)


# --- generate_sql (unit, monkeypatched list_columns) -----------------------------------------


_COLUMNS = [
    {"name": "id", "data_type": "integer", "nullable": False, "default": "", "is_primary_key": True, "ordinal": 1},
    {"name": "name", "data_type": "text", "nullable": True, "default": "", "is_primary_key": False, "ordinal": 2},
    {"name": "email", "data_type": "text", "nullable": False, "default": "", "is_primary_key": False, "ordinal": 3},
]


def _gen(monkeypatch, kind, columns=_COLUMNS, engine="postgres"):
    monkeypatch.setattr(db_metadata, "list_columns", lambda *a, **k: columns)
    return db_metadata.generate_sql(engine, "h", 5432, "u", "p", "app", "public", "users", kind)


def test_generate_select_shape(monkeypatch):
    sql = _gen(monkeypatch, "select")
    assert sql.startswith("SELECT ")
    assert '"id", "name", "email"' in sql
    assert 'FROM "public"."users"' in sql
    assert sql.rstrip().endswith("LIMIT 200;")


def test_generate_insert_shape(monkeypatch):
    sql = _gen(monkeypatch, "insert")
    assert sql.startswith("INSERT INTO \"public\".\"users\"")
    assert '("id", "name", "email")' in sql
    assert ":id" in sql and ":name" in sql and ":email" in sql


def test_generate_update_shape(monkeypatch):
    sql = _gen(monkeypatch, "update")
    assert sql.startswith("UPDATE ")
    # non-pk columns in the SET, pk in the WHERE
    assert '"name" = :name' in sql and '"email" = :email' in sql
    assert 'WHERE "id" = :id' in sql
    assert '"id" = :id' not in sql.split("WHERE")[0]  # id not in SET


def test_generate_delete_shape(monkeypatch):
    sql = _gen(monkeypatch, "delete")
    assert sql.startswith("DELETE FROM ")
    assert 'WHERE "id" = :id' in sql


def test_generate_delete_without_pk_is_commented(monkeypatch):
    cols = [{"name": "a", "data_type": "text", "nullable": True, "default": "", "is_primary_key": False, "ordinal": 1}]
    sql = _gen(monkeypatch, "delete", columns=cols)
    assert sql.startswith("--")  # a safety comment precedes a pk-less DELETE
    assert "DELETE FROM" in sql


def test_generate_create_shape(monkeypatch):
    sql = _gen(monkeypatch, "create")
    assert sql.startswith("CREATE TABLE \"public\".\"users\"")
    assert '"id" integer NOT NULL' in sql
    assert 'PRIMARY KEY ("id")' in sql


def test_generate_mysql_backtick_quoting(monkeypatch):
    sql = _gen(monkeypatch, "select", engine="mysql")
    assert "`id`, `name`, `email`" in sql
    assert "FROM `public`.`users`" in sql


def test_generate_unknown_kind_raises(monkeypatch):
    monkeypatch.setattr(db_metadata, "list_columns", lambda *a, **k: _COLUMNS)
    with pytest.raises(DbConsoleError):
        db_metadata.generate_sql("postgres", "h", 5432, "u", "p", "app", "public", "users", "truncate")
