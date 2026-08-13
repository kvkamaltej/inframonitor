"""Database console (feature/db-connect).

Opens a fresh, short-lived connection to a PostgreSQL or MySQL database using operator-supplied
credentials, runs a single read-only query, and closes the connection. Nothing is stored: every
call carries its own credentials.

Safety posture (pragmatic operator tool, not a hardened multi-tenant gateway):
  * short connect + statement timeouts so a bad host or a runaway query cannot hang the API;
  * the session is put in read-only mode where the driver allows it;
  * multiple statements in one request are rejected;
  * rows are capped by the caller (see routes.py) so a huge table cannot be pulled in full.
"""

from __future__ import annotations

import time
from typing import Any

# Drivers are imported lazily inside the engine branches so importing this module never requires
# both to be installed, and an import problem surfaces as a clean message rather than at app boot.

CONNECT_TIMEOUT_SECONDS = 8
STATEMENT_TIMEOUT_MS = 30_000
STATEMENT_TIMEOUT_SECONDS = 30

ENGINES = ("postgres", "mysql")
DEFAULT_PORTS = {"postgres": 5432, "mysql": 3306}

# JSON-safe scalar types that can go straight into the response; everything else (datetime,
# Decimal, bytes, UUID, ...) is stringified so the result always serialises.
_SCALAR_TYPES = (str, int, float, bool, type(None))


class DbConsoleError(Exception):
    """A connection or query failure with a message safe to show the operator."""


def _clean_message(exc: Exception) -> str:
    text = str(exc).strip()
    if not text:
        text = exc.__class__.__name__
    # collapse the noisy multi-line psycopg/pymysql renderings to their first meaningful line
    first = next((line.strip() for line in text.splitlines() if line.strip()), text)
    return first[:500]


def _has_multiple_statements(sql: str) -> bool:
    """True if `sql` contains more than one statement.

    Scans for a `;` that sits outside a string literal, quoted identifier, or comment and is
    followed by further non-comment/non-whitespace text, so a single trailing semicolon (or a
    semicolon inside 'a;b', inside a `-- ...`/`/* ... */` comment, or followed only by a trailing
    comment) does not count. Comments are skipped rather than parsed -- still best-effort, not a
    full SQL parser, but it no longer trips over the semicolons and comments that appear in
    ordinary single queries.
    """
    in_single = in_double = in_backtick = False
    length = len(sql)
    i = 0
    while i < length:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < length else ""
        if in_single:
            if ch == "'":
                if nxt == "'":  # escaped '' inside a literal
                    i += 2
                    continue
                in_single = False
        elif in_double:
            if ch == '"':
                in_double = False
        elif in_backtick:
            if ch == "`":
                in_backtick = False
        # comments (only recognised outside string/identifier quoting)
        elif ch == "-" and nxt == "-":  # line comment: skip to end of line
            end = sql.find("\n", i + 2)
            if end == -1:
                break  # comment runs to the end of the input
            i = end + 1
            continue
        elif ch == "/" and nxt == "*":  # block comment: skip to the closing */
            end = sql.find("*/", i + 2)
            if end == -1:
                break  # unterminated block comment runs to the end
            i = end + 2
            continue
        elif ch == "'":
            in_single = True
        elif ch == '"':
            in_double = True
        elif ch == "`":
            in_backtick = True
        elif ch == ";":
            # a second statement only if real code (not just whitespace/comments) follows
            if _significant_after(sql, i + 1):
                return True
        i += 1
    return False


def _significant_after(sql: str, start: int) -> bool:
    """True if `sql[start:]` holds anything other than whitespace and SQL comments.

    Used after a `;` so a trailing comment or blank space does not read as a second statement.
    """
    i = start
    length = len(sql)
    while i < length:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < length else ""
        if ch.isspace():
            i += 1
        elif ch == "-" and nxt == "-":
            end = sql.find("\n", i + 2)
            if end == -1:
                return False
            i = end + 1
        elif ch == "/" and nxt == "*":
            end = sql.find("*/", i + 2)
            if end == -1:
                return False
            i = end + 2
        else:
            return True
    return False


def _is_word_char(ch: str) -> bool:
    return ch.isalnum() or ch == "_"


def _parse_limit_value(sql: str, start: int) -> int | None:
    """Parse the row-count that follows a `LIMIT` keyword at `sql[start:]`.

    Returns the plain integer row count, or None when it is not a plain integer (a bind
    parameter like `LIMIT :n` / `LIMIT ?`, or an expression). Handles both the MySQL
    `LIMIT <offset>, <row_count>` form (returns row_count) and `LIMIT <row_count> OFFSET <n>`
    (returns row_count -- OFFSET does not change the cap).
    """
    length = len(sql)
    i = start
    while i < length and sql[i].isspace():
        i += 1
    j = i
    while j < length and sql[j].isdigit():
        j += 1
    if j == i:
        return None  # not a plain integer: a bind parameter or an expression
    first = int(sql[i:j])
    # a MySQL `LIMIT <offset>, <row_count>` puts the real cap in the second value
    k = j
    while k < length and sql[k].isspace():
        k += 1
    if k < length and sql[k] == ",":
        k += 1
        while k < length and sql[k].isspace():
            k += 1
        m = k
        while m < length and sql[m].isdigit():
            m += 1
        if m == k:
            return None  # `LIMIT 5, :param` -- not a simple integer
        return int(sql[k:m])
    return first


def parse_limit(sql: str) -> int | None:
    """Return the integer row count of a top-level `LIMIT <n>` clause in `sql`, else None.

    Uses the same quote/comment-aware scan as `_has_multiple_statements`: a `limit` that sits
    inside a string literal, quoted identifier, or comment is ignored. Only a plain-integer row
    count is honoured (`LIMIT :param`, `LIMIT ?`, expressions -> None). The last top-level LIMIT
    wins, so an outer clause takes precedence over one inside a subquery.
    """
    in_single = in_double = in_backtick = False
    length = len(sql)
    i = 0
    found: int | None = None
    while i < length:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < length else ""
        if in_single:
            if ch == "'":
                if nxt == "'":  # escaped '' inside a literal
                    i += 2
                    continue
                in_single = False
        elif in_double:
            if ch == '"':
                in_double = False
        elif in_backtick:
            if ch == "`":
                in_backtick = False
        elif ch == "-" and nxt == "-":  # line comment
            end = sql.find("\n", i + 2)
            if end == -1:
                break
            i = end + 1
            continue
        elif ch == "/" and nxt == "*":  # block comment
            end = sql.find("*/", i + 2)
            if end == -1:
                break
            i = end + 2
            continue
        elif ch == "'":
            in_single = True
        elif ch == '"':
            in_double = True
        elif ch == "`":
            in_backtick = True
        elif ch in ("l", "L") and sql[i : i + 5].lower() == "limit":
            before = sql[i - 1] if i > 0 else ""
            after = sql[i + 5] if i + 5 < length else ""
            if not _is_word_char(before) and not _is_word_char(after):
                parsed = _parse_limit_value(sql, i + 5)
                if parsed is not None:
                    found = parsed
                i += 5
                continue
        i += 1
    return found


def _jsonable(value: Any) -> Any:
    if isinstance(value, bool):  # bool is an int subclass; keep it a bool
        return value
    if isinstance(value, _SCALAR_TYPES):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        try:
            return bytes(value).decode("utf-8", "replace")
        except Exception:
            return str(bytes(value))
    return str(value)


# --- PostgreSQL (psycopg 3) -----------------------------------------------------------------


def _pg_connect(host: str, port: int, username: str, password: str, database: str):
    import psycopg

    return psycopg.connect(
        host=host,
        port=port,
        user=username or None,
        password=password or None,
        dbname=database or None,
        connect_timeout=CONNECT_TIMEOUT_SECONDS,
        autocommit=True,
        # statement_timeout bounds a runaway query; default_transaction_read_only makes the
        # session refuse writes even in autocommit mode.
        options=f"-c statement_timeout={STATEMENT_TIMEOUT_MS} -c default_transaction_read_only=on",
    )


# --- MySQL (PyMySQL) ------------------------------------------------------------------------


def _mysql_connect(host: str, port: int, username: str, password: str, database: str):
    import pymysql

    conn = pymysql.connect(
        host=host,
        port=port,
        user=username or None,
        password=password or "",
        database=database or None,
        connect_timeout=CONNECT_TIMEOUT_SECONDS,
        read_timeout=STATEMENT_TIMEOUT_SECONDS,
        write_timeout=STATEMENT_TIMEOUT_SECONDS,
        autocommit=True,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.Cursor,
    )
    # Best-effort read-only + server-side timeout. Both are version dependent (MAX_EXECUTION_TIME
    # is MySQL 5.7.8+, absent on MariaDB), so a failure here must not sink the connection.
    for stmt in ("SET SESSION TRANSACTION READ ONLY", f"SET SESSION MAX_EXECUTION_TIME={STATEMENT_TIMEOUT_MS}"):
        try:
            with conn.cursor() as cur:
                cur.execute(stmt)
        except Exception:
            pass
    return conn


def _connect(engine: str, host: str, port: int, username: str, password: str, database: str):
    if engine == "postgres":
        return _pg_connect(host, port, username, password, database)
    return _mysql_connect(host, port, username, password, database)


def _server_version(engine: str, conn) -> str:
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT version()")
            row = cur.fetchone()
        if row and row[0]:
            return str(row[0]).split("\n")[0][:200]
    except Exception:
        pass
    return ""


def test_connection(engine: str, host: str, port: int, username: str, password: str, database: str) -> str:
    """Open a connection, confirm it works, and return a human-readable success message.

    Raises DbConsoleError on any failure with a message safe to display.
    """
    conn = None
    try:
        conn = _connect(engine, host, port, username, password, database)
        # Actually run a query. Opening the socket + authenticating is not enough: a green
        # "Connected" must mean queries work, otherwise a session that connects but cannot
        # execute (read-only routing, permissions, timeouts) reports success and then every
        # query in the console fails -- exactly the confusing case this avoids.
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        version = _server_version(engine, conn)
        label = "PostgreSQL" if engine == "postgres" else "MySQL"
        where = f"{host}:{port}"
        return f"Connected to {label} at {where}" + (f" — {version}" if version else "")
    except DbConsoleError:
        raise
    except Exception as exc:  # driver connection errors, DNS failures, auth failures, ...
        raise DbConsoleError(_clean_message(exc)) from exc
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def run_query(
    engine: str,
    host: str,
    port: int,
    username: str,
    password: str,
    database: str,
    sql: str,
    row_cap: int,
) -> dict:
    """Run a single read-only query and return {columns, rows, row_count, truncated, elapsed_ms}.

    Fetches at most row_cap rows (one extra is read to detect truncation). Raises DbConsoleError
    on any connection or query failure.
    """
    statement = sql.strip()
    if not statement:
        raise DbConsoleError("SQL statement is empty")
    if _has_multiple_statements(statement):
        raise DbConsoleError("Multiple statements are not allowed. Run one statement at a time.")

    conn = None
    started = time.perf_counter()
    try:
        conn = _connect(engine, host, port, username, password, database)
        with conn.cursor() as cur:
            cur.execute(statement)
            columns = [str(desc[0]) for desc in cur.description] if cur.description else []
            fetched = list(cur.fetchmany(row_cap + 1)) if columns else []
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        truncated = len(fetched) > row_cap
        rows = fetched[:row_cap]
        return {
            "columns": columns,
            "rows": [[_jsonable(cell) for cell in row] for row in rows],
            "row_count": len(rows),
            "truncated": truncated,
            "elapsed_ms": elapsed_ms,
        }
    except DbConsoleError:
        raise
    except Exception as exc:
        raise DbConsoleError(_clean_message(exc)) from exc
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


# Read-only introspection queries: PostgreSQL scans every user schema; MySQL is single-database,
# so it lists only the connected database's tables (DATABASE()).
_LIST_TABLES_SQL = {
    "postgres": (
        "SELECT table_schema, table_name, table_type FROM information_schema.tables "
        "WHERE table_schema NOT IN ('pg_catalog','information_schema') "
        "ORDER BY table_schema, table_name"
    ),
    "mysql": (
        "SELECT table_schema, table_name, table_type FROM information_schema.tables "
        "WHERE table_schema = DATABASE() ORDER BY table_name"
    ),
}


def list_tables(engine: str, host: str, port: int, username: str, password: str, database: str) -> list[dict]:
    """List the tables and views visible to the connection.

    Returns `[{"schema", "name", "type"}, ...]` sorted by (schema, name), where type is "view"
    when the catalog reports a VIEW and "table" otherwise. Raises DbConsoleError on failure.
    """
    sql = _LIST_TABLES_SQL["postgres"] if engine == "postgres" else _LIST_TABLES_SQL["mysql"]
    conn = None
    try:
        conn = _connect(engine, host, port, username, password, database)
        with conn.cursor() as cur:
            cur.execute(sql)
            rows = list(cur.fetchall()) if cur.description else []
        tables = []
        for row in rows:
            schema = str(row[0]) if row[0] is not None else ""
            name = str(row[1]) if row[1] is not None else ""
            ttype = str(row[2]) if len(row) > 2 and row[2] is not None else ""
            kind = "view" if "VIEW" in ttype.upper() else "table"
            tables.append({"schema": schema, "name": name, "type": kind})
        tables.sort(key=lambda t: (t["schema"], t["name"]))
        return tables
    except DbConsoleError:
        raise
    except Exception as exc:
        raise DbConsoleError(_clean_message(exc)) from exc
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
