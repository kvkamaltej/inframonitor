"""Live Database Metadata tests against a REAL PostgreSQL.

Skipped unless the cluster is provided via env vars (INFRAMONITOR_TEST_PG_HOST, ...), exactly like
tests/test_db_console_live.py. Exercises the genuine introspection wire path: list_schemas /
list_tables_in_schema / list_columns / list_indexes and generate_sql('select') against a table this
test creates with a direct (non-console) connection.
"""

import os

import pytest

from app.services import db_metadata

_HOST = os.environ.get("INFRAMONITOR_TEST_PG_HOST")

pytestmark = pytest.mark.skipif(not _HOST, reason="no live Postgres (set INFRAMONITOR_TEST_PG_HOST)")

_PORT = int(os.environ.get("INFRAMONITOR_TEST_PG_PORT", "5432"))
_USER = os.environ.get("INFRAMONITOR_TEST_PG_USER", "postgres")
_PASSWORD = os.environ.get("INFRAMONITOR_TEST_PG_PASSWORD", "")
_DB = os.environ.get("INFRAMONITOR_TEST_PG_DB", "postgres")


def _args():
    return ["postgres", _HOST, _PORT, _USER, _PASSWORD, _DB]


@pytest.fixture(scope="module", autouse=True)
def _seed():
    """Create a schema + table with a PK and an index using a direct connection (the metadata
    queries themselves are read-only)."""
    import psycopg

    with psycopg.connect(host=_HOST, port=_PORT, user=_USER, password=_PASSWORD or None, dbname=_DB, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("CREATE SCHEMA IF NOT EXISTS meta_probe")
            cur.execute("DROP TABLE IF EXISTS meta_probe.widget")
            cur.execute(
                "CREATE TABLE meta_probe.widget ("
                "  id int PRIMARY KEY, name text NOT NULL, owner_id int, note text)"
            )
            cur.execute("CREATE INDEX ix_widget_name ON meta_probe.widget (name)")
    yield


def test_list_schemas_includes_user_schema_and_excludes_system():
    names = {s["name"] for s in db_metadata.list_schemas(*_args())}
    assert "meta_probe" in names
    assert "pg_catalog" not in names and "information_schema" not in names


def test_list_tables_in_schema():
    tables = db_metadata.list_tables_in_schema(*_args(), "meta_probe")
    by_name = {t["name"]: t for t in tables}
    assert "widget" in by_name
    assert by_name["widget"]["type"] == "table"
    assert by_name["widget"]["schema"] == "meta_probe"


def test_list_columns_with_pk_flag():
    cols = db_metadata.list_columns(*_args(), "meta_probe", "widget")
    by_name = {c["name"]: c for c in cols}
    assert set(by_name) == {"id", "name", "owner_id", "note"}
    assert by_name["id"]["is_primary_key"] is True
    assert by_name["name"]["is_primary_key"] is False
    assert by_name["name"]["nullable"] is False
    assert by_name["note"]["nullable"] is True
    # ordinals are 1-based and ascending
    assert by_name["id"]["ordinal"] == 1


def test_list_indexes_reports_pk_and_secondary():
    indexes = db_metadata.list_indexes(*_args(), "meta_probe", "widget")
    by_name = {i["name"]: i for i in indexes}
    # the PK index plus the explicit name index
    assert any(i["primary"] for i in indexes)
    assert "ix_widget_name" in by_name
    assert by_name["ix_widget_name"]["columns"] == ["name"]
    assert by_name["ix_widget_name"]["primary"] is False


def test_list_constraints_and_foreign_keys_run():
    cons = db_metadata.list_constraints(*_args(), "meta_probe", "widget")
    assert any(c["type"] == "PRIMARY KEY" for c in cons)
    # no FKs on this table, but the call must succeed and return a list
    assert db_metadata.list_foreign_keys(*_args(), "meta_probe", "widget") == []


def test_generate_select_from_live_columns():
    sql = db_metadata.generate_sql(*_args(), "meta_probe", "widget", "select")
    assert sql.startswith("SELECT ")
    assert 'FROM "meta_probe"."widget"' in sql
    assert '"id"' in sql and '"name"' in sql
    assert sql.rstrip().endswith("LIMIT 200;")
