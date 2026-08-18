"""Local tests for the mssql engine, persisted show_all_databases, schema rename, and pg
backup/restore (feature/db-connect follow-on).

No live database or pg client binaries are required: db_metadata's mssql branches are exercised
through a monkeypatched _run that captures the SQL/params, db_console.test_connection runs against
a fake DB-API connection, the schema-rename route monkeypatches execute_ddl, and db_backup's argv
construction is asserted against a fake subprocess.run. Style mirrors tests/test_db_connections.py:
DATABASE_URL + JWT_SECRET are set before app.main imports app.core.database.
"""

import os
import tempfile

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_mssqltest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.services import db_backup, db_console, db_metadata  # noqa: E402
from app.services.db_console import DbConsoleError  # noqa: E402


_USER = {"sub": "tester@local", "role": "admin", "guest": False}


@pytest.fixture()
def client():
    from app.core.security import require_admin_not_guest, require_user_not_guest
    from app.main import app

    app.dependency_overrides[require_user_not_guest] = lambda: _USER
    app.dependency_overrides[require_admin_not_guest] = lambda: _USER
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# --- a minimal DB-API fake (mirrors tests/test_db_console.py) --------------------------------


class _FakeCursor:
    def __init__(self, conn):
        self._conn = conn
        self.description = None
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, *args, **kwargs):
        self._conn.executed.append(sql)
        desc, rows = self._conn.handler(sql)
        self.description = desc
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchmany(self, size):
        return self._rows[:size]

    def fetchall(self):
        return self._rows

    def close(self):
        pass


class _FakeConn:
    def __init__(self, handler):
        self.handler = handler
        self.executed = []
        self.closed = False

    def cursor(self):
        return _FakeCursor(self)

    def close(self):
        self.closed = True


def _install(monkeypatch, handler):
    holder = {}

    def fake_connect(*args, **kwargs):
        conn = _FakeConn(handler)
        holder["conn"] = conn
        holder["read_only"] = kwargs.get("read_only", True)
        return conn

    monkeypatch.setattr(db_console, "_connect", fake_connect)
    return holder


# --- mssql: db_console ------------------------------------------------------------------------


def test_mssql_registered():
    assert "mssql" in db_console.ENGINES
    assert db_console.DEFAULT_PORTS["mssql"] == 1433


def test_mssql_test_connection_label_and_version(monkeypatch):
    def handler(sql):
        s = sql.strip().lower()
        if s.startswith("select 1"):
            return ([("c", *[None] * 6)], [(1,)])
        if "@@version" in s:
            return ([("v", *[None] * 6)], [("Microsoft SQL Server 2022 (fake)",)])
        return (None, [])

    _install(monkeypatch, handler)
    msg = db_console.test_connection("mssql", "h", 1433, "u", "p", "d")
    assert "Connected to SQL Server at h:1433" in msg
    assert "Microsoft SQL Server 2022" in msg


def test_mssql_list_tables_uses_information_schema(monkeypatch):
    holder = _install(monkeypatch, lambda sql: (
        [("s", *[None] * 6), ("n", *[None] * 6), ("t", *[None] * 6)],
        [("dbo", "users", "BASE TABLE"), ("dbo", "v_active", "VIEW")],
    ))
    tables = db_console.list_tables("mssql", "h", 1433, "u", "p", "d")
    assert any("INFORMATION_SCHEMA.TABLES" in s for s in holder["conn"].executed)
    assert tables[0]["name"] == "users" and tables[0]["type"] == "table"
    assert tables[1]["type"] == "view"


# --- mssql: db_metadata (monkeypatched _run captures SQL) ------------------------------------


@pytest.fixture()
def capture_run(monkeypatch):
    calls = []

    def fake_run(engine, host, port, username, password, database, sql, params=None):
        calls.append({"engine": engine, "sql": sql, "params": params})
        # canned shapes keyed by which catalog is being queried
        low = sql.lower()
        # most-specific catalogs first: the index and FK queries also JOIN sys.schemas, so that
        # substring must be tested last or it would swallow them.
        if "sys.databases" in low:
            return [("appdb",), ("reporting",)]
        if "sys.foreign_keys" in low:
            return [("FK_orders_users", "user_id", "dbo", "users", "id", 1)]
        if "sys.indexes" in low:
            return [("PK_users", "id", True, True, 1), ("IX_email", "email", True, False, 1)]
        if "sys.schemas" in low:
            return [("dbo",), ("sales",)]
        return []

    monkeypatch.setattr(db_metadata, "_run", fake_run)
    return calls


def test_mssql_list_databases(capture_run):
    rows = db_metadata.list_databases("mssql", "h", 1433, "u", "p", "d")
    assert rows == [{"name": "appdb"}, {"name": "reporting"}]
    assert "sys.databases" in capture_run[-1]["sql"]
    assert "database_id > 4" in capture_run[-1]["sql"]


def test_mssql_list_schemas_filters_system(capture_run):
    rows = db_metadata.list_schemas("mssql", "h", 1433, "u", "p", "d")
    assert rows == [{"name": "dbo"}, {"name": "sales"}]
    sql = capture_run[-1]["sql"]
    assert "sys.schemas" in sql and "db_datareader" in sql


def test_mssql_list_indexes(capture_run):
    rows = db_metadata.list_indexes("mssql", "h", 1433, "u", "p", "d", "dbo", "users")
    assert capture_run[-1]["params"] == ("dbo", "users")
    assert "sys.indexes" in capture_run[-1]["sql"]
    names = {r["name"] for r in rows}
    assert names == {"PK_users", "IX_email"}
    pk = next(r for r in rows if r["name"] == "PK_users")
    assert pk["primary"] is True and pk["columns"] == ["id"]


def test_mssql_list_foreign_keys(capture_run):
    rows = db_metadata.list_foreign_keys("mssql", "h", 1433, "u", "p", "d", "dbo", "orders")
    assert "sys.foreign_keys" in capture_run[-1]["sql"]
    assert rows[0]["name"] == "FK_orders_users"
    assert rows[0]["columns"] == ["user_id"] and rows[0]["ref_table"] == "users"


def test_mssql_generate_sql_brackets_and_top(monkeypatch):
    cols = [
        {"name": "id", "data_type": "int", "nullable": False, "default": "", "is_primary_key": True, "ordinal": 1},
        {"name": "name", "data_type": "nvarchar", "nullable": True, "default": "", "is_primary_key": False, "ordinal": 2},
    ]
    monkeypatch.setattr(db_metadata, "list_columns", lambda *a, **k: cols)
    sql = db_metadata.generate_sql("mssql", "h", 1433, "u", "p", "d", "dbo", "users", "select")
    assert sql.startswith("SELECT TOP 200 ")
    assert "[id], [name]" in sql
    assert "FROM [dbo].[users]" in sql
    assert "LIMIT" not in sql


def test_mssql_quote_ident_escapes_bracket():
    assert db_metadata._quote_ident("mssql", "we[i]rd") == "[we[i]]rd]"


# --- mssql: route wiring ---------------------------------------------------------------------


def test_create_mssql_connection(client):
    r = client.post("/api/db/connections", json={
        "name": "sqlserver", "engine": "mssql", "host": "h", "port": 1433, "password": "x", "database": "appdb",
    })
    assert r.status_code == 201
    assert r.json()["engine"] == "mssql" and r.json()["port"] == 1433


# --- show_all_databases ----------------------------------------------------------------------


def test_show_all_databases_create_echo_and_update(client):
    r = client.post("/api/db/connections", json={
        "name": "browseall", "engine": "postgres", "host": "h", "port": 5432, "show_all_databases": True,
    })
    assert r.status_code == 201
    assert r.json()["show_all_databases"] is True
    cid = r.json()["id"]

    assert client.get(f"/api/db/connections/{cid}").json()["show_all_databases"] is True

    # an update that omits the field keeps the stored value
    kept = client.patch(f"/api/db/connections/{cid}", json={"name": "browseall2"})
    assert kept.json()["show_all_databases"] is True

    # explicitly flipping it to false persists
    off = client.patch(f"/api/db/connections/{cid}", json={"show_all_databases": False})
    assert off.json()["show_all_databases"] is False


def test_show_all_databases_defaults_false(client):
    r = client.post("/api/db/connections", json={"name": "def", "engine": "mysql", "host": "h", "port": 3306})
    assert r.json()["show_all_databases"] is False


# --- schema rename ---------------------------------------------------------------------------


@pytest.fixture()
def pg_conn_id(client):
    return client.post("/api/db/connections", json={
        "name": "pg", "engine": "postgres", "host": "h", "port": 5432, "password": "x", "database": "app",
    }).json()["id"]


def test_schema_rename_postgres_runs_ddl(client, pg_conn_id, monkeypatch):
    captured = {}

    def fake_ddl(engine, host, port, username, password, database, sql):
        captured["engine"] = engine
        captured["sql"] = sql

    monkeypatch.setattr(db_console, "execute_ddl", fake_ddl)
    r = client.post(f"/api/db/connections/{pg_conn_id}/schemas/public/rename", json={"new_name": "archive"})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert captured["engine"] == "postgres"
    assert captured["sql"] == 'ALTER SCHEMA "public" RENAME TO "archive"'


def test_schema_rename_rejects_bad_identifier(client, pg_conn_id, monkeypatch):
    monkeypatch.setattr(db_console, "execute_ddl", lambda *a, **k: None)
    r = client.post(f"/api/db/connections/{pg_conn_id}/schemas/public/rename", json={"new_name": "bad name;"})
    assert r.status_code == 400


def test_schema_rename_unsupported_engine_is_400(client, monkeypatch):
    monkeypatch.setattr(db_console, "execute_ddl", lambda *a, **k: None)
    for engine, port, extra in (("mysql", 3306, {}), ("sqlite", 0, {"database": "/tmp/x.db"})):
        cid = client.post("/api/db/connections", json={
            "name": f"c-{engine}", "engine": engine, "host": "h", "port": port, **extra,
        }).json()["id"]
        r = client.post(f"/api/db/connections/{cid}/schemas/public/rename", json={"new_name": "ok"})
        assert r.status_code == 400 and "not supported" in r.json()["detail"]


def test_schema_rename_ddl_error_is_400(client, pg_conn_id, monkeypatch):
    def boom(*a, **k):
        raise DbConsoleError("schema \"public\" does not exist")

    monkeypatch.setattr(db_console, "execute_ddl", boom)
    r = client.post(f"/api/db/connections/{pg_conn_id}/schemas/public/rename", json={"new_name": "archive"})
    assert r.status_code == 400 and "does not exist" in r.json()["detail"]


# --- db_backup service (fake subprocess) -----------------------------------------------------


class _FakeProc:
    def __init__(self, returncode=0, stderr=b""):
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = b""


def test_backup_binary_not_found(monkeypatch):
    monkeypatch.setattr(db_backup.shutil, "which", lambda name: None)
    monkeypatch.delenv("PG_BIN_DIR", raising=False)
    monkeypatch.delenv("PG_DUMP_PATH", raising=False)
    with pytest.raises(DbConsoleError) as ei:
        db_backup.backup({"host": "h", "port": 5432, "username": "u", "password": "p"}, "app")
    assert "pg_dump not found" in str(ei.value)


def test_backup_builds_argv_and_passes_password_via_env(monkeypatch):
    captured = {}

    def fake_run(args, env=None, capture_output=None, timeout=None):
        captured["args"] = args
        captured["env"] = env
        # pg_dump -f <path> writes the file; create it so the (path, filename) is real
        idx = args.index("-f")
        with open(args[idx + 1], "wb") as f:
            f.write(b"PGDMP-fake")
        return _FakeProc(returncode=0)

    monkeypatch.setattr(db_backup, "_resolve_binary", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(db_backup.subprocess, "run", fake_run)

    path, filename = db_backup.backup({"host": "db", "port": 5432, "username": "reader", "password": "s3cr3t"}, "appdb")
    try:
        args = captured["args"]
        assert args[0] == "/usr/bin/pg_dump"
        assert "-Fc" in args
        assert "-h" in args and args[args.index("-h") + 1] == "db"
        assert "-d" in args and args[args.index("-d") + 1] == "appdb"
        # password travels through the environment, never on the argv
        assert captured["env"]["PGPASSWORD"] == "s3cr3t"
        assert not any("s3cr3t" in str(a) for a in args)
        assert filename.startswith("appdb-") and filename.endswith(".dump")
        assert os.path.isfile(path)
    finally:
        db_backup._safe_remove(path)


def test_backup_nonzero_exit_raises_clean(monkeypatch):
    def fake_run(args, env=None, capture_output=None, timeout=None):
        return _FakeProc(returncode=1, stderr=b"pg_dump: error: connection failed\nmore detail")

    monkeypatch.setattr(db_backup, "_resolve_binary", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(db_backup.subprocess, "run", fake_run)
    with pytest.raises(DbConsoleError) as ei:
        db_backup.backup({"host": "h", "port": 5432, "username": "u", "password": "p"}, "app")
    assert str(ei.value) == "pg_dump: error: connection failed"


def test_restore_custom_format_uses_pg_restore(monkeypatch, tmp_path):
    captured = {}

    def fake_run(args, env=None, capture_output=None, timeout=None):
        captured["args"] = args
        return _FakeProc(returncode=0)

    monkeypatch.setattr(db_backup, "_resolve_binary", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(db_backup.subprocess, "run", fake_run)

    dump = tmp_path / "d.dump"
    dump.write_bytes(b"PGDMP\x00\x01rest-of-custom-dump")
    msg = db_backup.restore({"host": "h", "port": 5432, "username": "u", "password": "p"}, "app", str(dump))
    assert captured["args"][0] == "/usr/bin/pg_restore"
    assert "--clean" in captured["args"] and "--if-exists" in captured["args"]
    assert "pg_restore" in msg


def test_restore_plain_sql_uses_psql(monkeypatch, tmp_path):
    captured = {}

    def fake_run(args, env=None, capture_output=None, timeout=None):
        captured["args"] = args
        return _FakeProc(returncode=0)

    monkeypatch.setattr(db_backup, "_resolve_binary", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(db_backup.subprocess, "run", fake_run)

    sql = tmp_path / "d.sql"
    sql.write_bytes(b"-- plain sql dump\nCREATE TABLE t(x int);\n")
    msg = db_backup.restore({"host": "h", "port": 5432, "username": "u", "password": "p"}, "app", str(sql))
    assert captured["args"][0] == "/usr/bin/psql"
    assert "-f" in captured["args"]
    assert "psql" in msg


# --- backup/restore routes (service monkeypatched, no real shell-out) ------------------------


def test_backup_route_streams_file(client, pg_conn_id, monkeypatch, tmp_path):
    dump = tmp_path / "out.dump"
    dump.write_bytes(b"PGDMP-body")
    monkeypatch.setattr(db_backup, "backup", lambda fields, database: (str(dump), "app.dump"))
    r = client.post(f"/api/db/connections/{pg_conn_id}/backup")
    assert r.status_code == 200
    assert r.content == b"PGDMP-body"
    assert "attachment" in r.headers.get("content-disposition", "")


def test_backup_route_non_postgres_is_400(client, monkeypatch):
    cid = client.post("/api/db/connections", json={"name": "m", "engine": "mysql", "host": "h", "port": 3306}).json()["id"]
    r = client.post(f"/api/db/connections/{cid}/backup")
    assert r.status_code == 400 and "not supported" in r.json()["detail"]


def test_restore_route_ok(client, pg_conn_id, monkeypatch):
    monkeypatch.setattr(db_backup, "restore", lambda fields, database, path: "Restored app with pg_restore")
    r = client.post(
        f"/api/db/connections/{pg_conn_id}/restore",
        files={"file": ("d.dump", b"PGDMP-body", "application/octet-stream")},
    )
    assert r.status_code == 200 and r.json()["ok"] is True
    assert "Restored app" in r.json()["message"]


def test_restore_route_empty_upload_is_400(client, pg_conn_id, monkeypatch):
    monkeypatch.setattr(db_backup, "restore", lambda *a, **k: "should not be called")
    r = client.post(
        f"/api/db/connections/{pg_conn_id}/restore",
        files={"file": ("empty.dump", b"", "application/octet-stream")},
    )
    assert r.status_code == 400
