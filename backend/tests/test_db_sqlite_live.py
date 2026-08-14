"""Live SQLite tests for the Database Console + Metadata services.

Unlike the Postgres/MySQL live suites, SQLite needs no external server: the test writes a real temp
.sqlite file with two tables (a PK, a secondary index, and a foreign key) using the stdlib driver,
then exercises the genuine wire path -- db_console.test_connection / run_query and every db_metadata
introspection function -- against engine "sqlite". host/port/username/password are ignored; the
`database` argument is the file PATH.
"""

import os
import sqlite3
import tempfile

import pytest

from app.services import db_console, db_metadata
from app.services.db_console import DbConsoleError


@pytest.fixture(scope="module")
def sqlite_db():
    tmp = tempfile.mkdtemp(prefix="inframonitor_sqlitelive_")
    path = os.path.join(tmp, "library.sqlite")
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE author (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE book (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                author_id INTEGER REFERENCES author(id)
            );
            CREATE INDEX ix_book_title ON book(title);
            INSERT INTO author (id, name) VALUES (1, 'Ada'), (2, 'Grace');
            INSERT INTO book (id, title, author_id) VALUES (1, 'Notes', 1), (2, 'Papers', 2);
            """
        )
        conn.commit()
    finally:
        conn.close()
    yield path


def _args(path):
    # engine, host, port, username, password, database(file path)
    return ["sqlite", "", 0, "", "", path]


# --- db_console ------------------------------------------------------------------------------


def test_sqlite_test_connection(sqlite_db):
    msg = db_console.test_connection(*_args(sqlite_db))
    assert "Connected to SQLite" in msg
    assert sqlite_db in msg  # the file path is the "where"


def test_sqlite_test_connection_missing_path_errors():
    with pytest.raises(DbConsoleError):
        db_console.test_connection("sqlite", "", 0, "", "", "")


def test_sqlite_run_query(sqlite_db):
    out = db_console.run_query(*_args(sqlite_db), "SELECT id, name FROM author ORDER BY id", 1000)
    assert out["columns"] == ["id", "name"]
    assert out["rows"] == [[1, "Ada"], [2, "Grace"]]
    assert out["row_count"] == 2
    assert out["truncated"] is False


def test_sqlite_run_query_row_cap(sqlite_db):
    out = db_console.run_query(*_args(sqlite_db), "SELECT id FROM book ORDER BY id", 1)
    assert out["row_count"] == 1 and out["truncated"] is True


def test_sqlite_list_tables(sqlite_db):
    tables = db_console.list_tables(*_args(sqlite_db))
    by_name = {t["name"]: t for t in tables}
    assert "author" in by_name and "book" in by_name
    assert by_name["author"]["type"] == "table"


# --- db_metadata -----------------------------------------------------------------------------


def test_sqlite_list_schemas(sqlite_db):
    assert db_metadata.list_schemas(*_args(sqlite_db)) == [{"name": "main"}]


def test_sqlite_list_tables_in_schema(sqlite_db):
    tables = db_metadata.list_tables_in_schema(*_args(sqlite_db), "main")
    names = {t["name"] for t in tables}
    assert names == {"author", "book"}
    assert all(t["schema"] == "main" for t in tables)


def test_sqlite_list_routines_empty(sqlite_db):
    assert db_metadata.list_routines(*_args(sqlite_db), "main") == []


def test_sqlite_list_columns(sqlite_db):
    cols = db_metadata.list_columns(*_args(sqlite_db), "main", "book")
    by_name = {c["name"]: c for c in cols}
    assert set(by_name) == {"id", "title", "author_id"}
    assert by_name["id"]["is_primary_key"] is True
    assert by_name["title"]["is_primary_key"] is False
    assert by_name["title"]["nullable"] is False
    assert by_name["author_id"]["nullable"] is True
    # ordinals are the sqlite cid, ascending from 0
    assert by_name["id"]["ordinal"] == 0


def test_sqlite_list_columns_unknown_table_rejected(sqlite_db):
    # the table name is validated against sqlite_master before it is interpolated into a PRAGMA
    with pytest.raises(DbConsoleError):
        db_metadata.list_columns(*_args(sqlite_db), "main", "book); DROP TABLE author;--")


def test_sqlite_list_indexes(sqlite_db):
    indexes = db_metadata.list_indexes(*_args(sqlite_db), "main", "book")
    by_name = {i["name"]: i for i in indexes}
    assert "ix_book_title" in by_name
    assert by_name["ix_book_title"]["columns"] == ["title"]
    assert by_name["ix_book_title"]["unique"] is False
    assert by_name["ix_book_title"]["primary"] is False


def test_sqlite_list_foreign_keys(sqlite_db):
    fks = db_metadata.list_foreign_keys(*_args(sqlite_db), "main", "book")
    assert len(fks) == 1
    fk = fks[0]
    assert fk["columns"] == ["author_id"]
    assert fk["ref_table"] == "author"
    assert fk["ref_columns"] == ["id"]


def test_sqlite_list_constraints(sqlite_db):
    cons = db_metadata.list_constraints(*_args(sqlite_db), "main", "book")
    types = {c["type"] for c in cons}
    assert "PRIMARY KEY" in types
    assert "FOREIGN KEY" in types


def test_sqlite_generate_select(sqlite_db):
    sql = db_metadata.generate_sql(*_args(sqlite_db), "main", "book", "select")
    assert sql.startswith("SELECT ")
    assert '"book"' in sql
    assert '"title"' in sql
    assert sql.rstrip().endswith("LIMIT 200;")


# --- list_databases (sqlite is real) ---------------------------------------------------------


def test_sqlite_list_databases(sqlite_db):
    dbs = db_metadata.list_databases(*_args(sqlite_db))
    assert dbs == [{"name": "library.sqlite"}]
