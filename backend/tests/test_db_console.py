"""Local tests for the Database Console (feature/db-connect) and the bug fixes for
'query fails even after a successful connect'.

No live database is required: the DB-API connection is replaced with a fake so the real
service logic (test_connection, run_query, the multi-statement guard, serialisation, and the
route error contract) runs end to end. A separate module, test_db_console_live.py, runs the
same paths against a real Postgres when one is available.
"""

import os
import tempfile
from datetime import datetime
from decimal import Decimal

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_dbtest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.services import db_console  # noqa: E402
from app.services.db_console import DbConsoleError  # noqa: E402


# --- a minimal DB-API 2.0 fake -------------------------------------------------------------
#
# handler(sql) -> (description, rows) or raises. description mirrors DB-API: a sequence of
# 7-tuples whose [0] is the column name; None means "no result set" (e.g. DDL/DML).


class _FakeCursor:
    def __init__(self, conn):
        self._conn = conn
        self.description = None
        self._rows = []
        self._pos = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, *args, **kwargs):
        self._conn.executed.append(sql)
        desc, rows = self._conn.handler(sql)
        self.description = desc
        self._rows = list(rows)
        self._pos = 0

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchmany(self, size):
        chunk = self._rows[self._pos : self._pos + size]
        self._pos += len(chunk)
        return chunk

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


def _default_handler(sql):
    s = sql.strip().lower()
    if s.startswith("select 1"):
        return ([("?column?", None, None, None, None, None, None)], [(1,)])
    if "version()" in s:
        return ([("version", None, None, None, None, None, None)], [("PostgreSQL 16.0 (fake)",)])
    return (None, [])


def _install(monkeypatch, handler):
    """Route db_console._connect to a fake connection built from `handler`, and hand the test
    the connection object so it can assert on what was executed / that it was closed."""
    holder = {}

    def fake_connect(*args, **kwargs):
        conn = _FakeConn(handler)
        holder["conn"] = conn
        return conn

    monkeypatch.setattr(db_console, "_connect", fake_connect)
    return holder


# --- _has_multiple_statements: the guard that was falsely rejecting commented queries -------


@pytest.mark.parametrize(
    "sql,expected",
    [
        ("SELECT 1", False),
        ("SELECT 1;", False),
        ("SELECT 1;\n", False),
        ("SELECT * FROM t WHERE a='x';", False),
        ("SELECT * FROM t; -- trailing comment", False),          # was falsely True (bug)
        ("SELECT * FROM t -- note; has semicolon", False),        # was falsely True (bug)
        ("SELECT 1 /* a; b */ FROM t", False),                    # was falsely True (bug)
        ("SELECT 1;\n-- done", False),                            # was falsely True (bug)
        ("SELECT 1; SELECT 2", True),
        ("SELECT 1; SELECT 2;", True),
        ("SELECT ';' AS x; DROP TABLE t", True),                  # ; in a literal is not a split
        ("SELECT 1; /* c */ SELECT 2", True),
        ("UPDATE t SET a=1; DELETE FROM t", True),
    ],
)
def test_multi_statement_guard(sql, expected):
    assert db_console._has_multiple_statements(sql) is expected


# --- _jsonable: every non-scalar becomes JSON-safe -----------------------------------------


def test_jsonable_scalars_passthrough():
    assert db_console._jsonable(1) == 1
    assert db_console._jsonable(1.5) == 1.5
    assert db_console._jsonable("x") == "x"
    assert db_console._jsonable(None) is None
    assert db_console._jsonable(True) is True and isinstance(db_console._jsonable(True), bool)


def test_jsonable_stringifies_rich_types():
    assert db_console._jsonable(datetime(2026, 8, 13, 9, 30)) == "2026-08-13 09:30:00"
    assert db_console._jsonable(Decimal("3.14")) == "3.14"
    assert db_console._jsonable(b"hello") == "hello"
    assert db_console._jsonable(memoryview(b"abc")) == "abc"


# --- _clean_message ------------------------------------------------------------------------


def test_clean_message_collapses_and_caps():
    assert db_console._clean_message(Exception("boom\nsecond line")) == "boom"
    assert db_console._clean_message(Exception("")) == "Exception"
    assert len(db_console._clean_message(Exception("x" * 900))) == 500


# --- test_connection: FIX #1 — success must mean a query actually ran ----------------------


def test_test_connection_success_runs_a_query(monkeypatch):
    holder = _install(monkeypatch, _default_handler)
    msg = db_console.test_connection("postgres", "h", 5432, "u", "p", "d")
    assert "Connected to PostgreSQL at h:5432" in msg
    # the SELECT 1 validation query really executed (this is the fix)
    assert any(s.strip().lower().startswith("select 1") for s in holder["conn"].executed)
    assert holder["conn"].closed is True


def test_test_connection_fails_when_query_cannot_run(monkeypatch):
    # a session that connects but cannot execute (read-only routing, perms, ...). Before the
    # fix, _server_version swallowed this and test_connection wrongly returned success.
    def handler(sql):
        raise RuntimeError("permission denied for schema public")

    _install(monkeypatch, handler)
    with pytest.raises(DbConsoleError) as ei:
        db_console.test_connection("postgres", "h", 5432, "u", "p", "d")
    assert "permission denied" in str(ei.value)


# --- run_query -----------------------------------------------------------------------------


def test_run_query_returns_rows(monkeypatch):
    def handler(sql):
        return ([("id", *[None] * 6), ("name", *[None] * 6)], [(1, "a"), (2, "b")])

    _install(monkeypatch, handler)
    out = db_console.run_query("postgres", "h", 5432, "u", "p", "d", "SELECT id,name FROM t", 1000)
    assert out["columns"] == ["id", "name"]
    assert out["rows"] == [[1, "a"], [2, "b"]]
    assert out["row_count"] == 2
    assert out["truncated"] is False
    assert isinstance(out["elapsed_ms"], int)


def test_run_query_truncates_at_row_cap(monkeypatch):
    def handler(sql):
        return ([("n", *[None] * 6)], [(i,) for i in range(10)])

    _install(monkeypatch, handler)
    out = db_console.run_query("postgres", "h", 5432, "u", "p", "d", "SELECT n FROM t", 3)
    assert out["row_count"] == 3
    assert out["truncated"] is True
    assert out["rows"] == [[0], [1], [2]]


def test_run_query_no_result_set(monkeypatch):
    def handler(sql):
        return (None, [])  # e.g. a statement with no columns

    _install(monkeypatch, handler)
    out = db_console.run_query("postgres", "h", 5432, "u", "p", "d", "CREATE TEMP TABLE t(x int)", 1000)
    assert out["columns"] == []
    assert out["rows"] == []
    assert out["row_count"] == 0


def test_run_query_serialises_rich_types(monkeypatch):
    def handler(sql):
        return ([("t", *[None] * 6), ("amount", *[None] * 6)], [(datetime(2026, 8, 13), Decimal("9.99"))])

    _install(monkeypatch, handler)
    out = db_console.run_query("postgres", "h", 5432, "u", "p", "d", "SELECT t,amount FROM t", 1000)
    assert out["rows"] == [["2026-08-13 00:00:00", "9.99"]]


def test_run_query_rejects_multiple_statements(monkeypatch):
    _install(monkeypatch, _default_handler)
    with pytest.raises(DbConsoleError) as ei:
        db_console.run_query("postgres", "h", 5432, "u", "p", "d", "SELECT 1; DROP TABLE t", 1000)
    assert "one statement" in str(ei.value).lower()


def test_run_query_allows_commented_single_statement(monkeypatch):
    # the exact class of query the guard used to reject
    _install(monkeypatch, lambda sql: ([("n", *[None] * 6)], [(1,)]))
    out = db_console.run_query("postgres", "h", 5432, "u", "p", "d", "SELECT n FROM t; -- latest\n", 1000)
    assert out["row_count"] == 1


def test_run_query_empty_sql(monkeypatch):
    _install(monkeypatch, _default_handler)
    with pytest.raises(DbConsoleError):
        db_console.run_query("postgres", "h", 5432, "u", "p", "d", "   ", 1000)


def test_run_query_driver_error_is_cleaned(monkeypatch):
    def handler(sql):
        raise RuntimeError('relation "nope" does not exist\nLINE 1: ...')

    _install(monkeypatch, handler)
    with pytest.raises(DbConsoleError) as ei:
        db_console.run_query("postgres", "h", 5432, "u", "p", "d", "SELECT * FROM nope", 1000)
    assert str(ei.value) == 'relation "nope" does not exist'  # cleaned to first line


# --- route contract: the API surface the UI actually calls ---------------------------------


@pytest.fixture()
def client(monkeypatch):
    from app.core.security import require_user_not_guest
    from app.main import app

    app.dependency_overrides[require_user_not_guest] = lambda: {"sub": "tester@local", "role": "admin", "guest": False}
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def test_route_test_connection_ok(client, monkeypatch):
    _install(monkeypatch, _default_handler)
    r = client.post("/api/db/test-connection", json={"engine": "postgres", "host": "h", "port": 5432})
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_route_test_connection_failure_is_200_ok_false(client, monkeypatch):
    _install(monkeypatch, lambda sql: (_ for _ in ()).throw(RuntimeError("auth failed")))
    r = client.post("/api/db/test-connection", json={"engine": "postgres", "host": "h", "port": 5432})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False and "auth failed" in body["message"]


def test_route_query_ok(client, monkeypatch):
    _install(monkeypatch, lambda sql: ([("n", *[None] * 6)], [(42,)]))
    r = client.post("/api/db/query", json={"engine": "postgres", "host": "h", "port": 5432, "sql": "SELECT n FROM t"})
    assert r.status_code == 200
    body = r.json()
    assert body["columns"] == ["n"] and body["rows"] == [[42]]


def test_route_query_error_is_400_with_clean_detail(client, monkeypatch):
    _install(monkeypatch, lambda sql: (_ for _ in ()).throw(RuntimeError("syntax error at or near\nLINE 1")))
    r = client.post("/api/db/query", json={"engine": "postgres", "host": "h", "port": 5432, "sql": "SELCT 1"})
    assert r.status_code == 400
    assert r.json()["detail"] == "syntax error at or near"


def test_route_query_bad_engine_is_400(client):
    r = client.post("/api/db/query", json={"engine": "oracle", "host": "h", "port": 1521, "sql": "SELECT 1"})
    assert r.status_code == 400
    assert "postgres or mysql" in r.json()["detail"]
