"""Live Database Console tests against a REAL PostgreSQL.

Skipped unless the cluster is provided via env vars (INFRAMONITOR_TEST_PG_HOST, ...). The
scratchpad harness run_live_pg.sh stands up a throwaway portable Postgres, sets these vars, and
invokes pytest on this module. This exercises the genuine psycopg wire path: the read-only
session options, real error text, and value serialisation -- the parts the fake-connection
suite (test_db_console.py) cannot cover.
"""

import os

import pytest

from app.services import db_console
from app.services.db_console import DbConsoleError

_HOST = os.environ.get("INFRAMONITOR_TEST_PG_HOST")

pytestmark = pytest.mark.skipif(not _HOST, reason="no live Postgres (set INFRAMONITOR_TEST_PG_HOST)")

_PORT = int(os.environ.get("INFRAMONITOR_TEST_PG_PORT", "5432"))
_USER = os.environ.get("INFRAMONITOR_TEST_PG_USER", "postgres")
_PASSWORD = os.environ.get("INFRAMONITOR_TEST_PG_PASSWORD", "")
_DB = os.environ.get("INFRAMONITOR_TEST_PG_DB", "postgres")


def _args(sql=None):
    base = ["postgres", _HOST, _PORT, _USER, _PASSWORD, _DB]
    return base + ([sql] if sql is not None else [])


@pytest.fixture(scope="module", autouse=True)
def _seed():
    """Create a table with rich types using a direct (non-console) connection, since the console
    session is read-only and cannot create/insert."""
    import psycopg

    with psycopg.connect(host=_HOST, port=_PORT, user=_USER, password=_PASSWORD or None, dbname=_DB, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("DROP TABLE IF EXISTS console_probe")
            cur.execute(
                "CREATE TABLE console_probe ("
                "  id int PRIMARY KEY, name text, created timestamptz, amount numeric, active bool, blob bytea, note text)"
            )
            cur.execute(
                "INSERT INTO console_probe VALUES "
                "(1,'alpha','2026-08-13 09:30:00+00', 9.99, true, '\\x68656c6c6f', NULL),"
                "(2,'beta', '2026-01-01 00:00:00+00', 0.00, false, NULL, 'ok')"
            )
    yield


def test_connection_real():
    msg = db_console.test_connection(*_args())
    assert "Connected to PostgreSQL" in msg
    assert "PostgreSQL" in msg  # version string appended


def test_select_serialises_rich_types():
    out = db_console.run_query(*_args("SELECT id,name,created,amount,active,blob,note FROM console_probe ORDER BY id"), 1000)
    assert out["columns"] == ["id", "name", "created", "amount", "active", "blob", "note"]
    assert out["row_count"] == 2
    row = out["rows"][0]
    assert row[0] == 1 and row[1] == "alpha"
    assert "2026-08-13" in row[2]         # timestamptz stringified
    assert row[3] == "9.99"               # numeric stringified
    assert row[4] is True                 # bool preserved
    assert row[5] == "hello"              # bytea decoded
    assert row[6] is None                 # NULL preserved
    assert out["rows"][1][6] == "ok"


def test_commented_single_statement_runs():
    # the exact query class the guard used to reject; must run against a real server
    out = db_console.run_query(*_args("SELECT count(*) FROM console_probe; -- how many?\n"), 1000)
    assert out["rows"][0][0] == 2


def test_multiple_statements_rejected():
    with pytest.raises(DbConsoleError) as ei:
        db_console.run_query(*_args("SELECT 1; SELECT 2"), 1000)
    assert "one statement" in str(ei.value).lower()


def test_truncation_real():
    out = db_console.run_query(*_args("SELECT g FROM generate_series(1,50) g"), 10)
    assert out["row_count"] == 10
    assert out["truncated"] is True


def test_readonly_session_blocks_writes():
    # the console opens a read-only session; a write must fail with a clean, surfaced reason
    with pytest.raises(DbConsoleError) as ei:
        db_console.run_query(*_args("INSERT INTO console_probe VALUES (3,'x',now(),1,true,NULL,NULL)"), 1000)
    assert "read-only" in str(ei.value).lower()


def test_bad_sql_clean_error():
    with pytest.raises(DbConsoleError) as ei:
        db_console.run_query(*_args("SELECT * FROM does_not_exist_xyz"), 1000)
    msg = str(ei.value).lower()
    assert "does_not_exist_xyz" in msg or "does not exist" in msg
