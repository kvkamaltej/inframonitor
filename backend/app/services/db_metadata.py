"""Database metadata / introspection (DBeaver-style catalog browsing).

A companion to db_console.py: where that module runs an operator's ad-hoc query, this one runs
fixed, read-only introspection queries against the information_schema / system catalogs so the UI
can render a schema tree (schemas -> tables/views/routines -> columns/indexes/constraints/FKs) and
generate boilerplate SQL from a table's real columns.

Same posture as db_console: connections are short-lived (opened via db_console._connect with keyword
args so `@`/`:` passwords work), every failure surfaces as a DbConsoleError with a cleaned message,
and non-scalar cell values are pushed through db_console._jsonable. Schema/table names arrive from
the URL; they are always passed as BOUND PARAMETERS in the WHERE clause -- never string-formatted
into executed SQL -- and generate_sql only ever quotes identifiers it looked up from the live
catalog, so there is no SQL-injection surface here.
"""

from __future__ import annotations

from typing import Any

from app.services import db_console
from app.services.db_console import DbConsoleError


def _run(engine: str, host: str, port: int, username: str, password: str, database: str, sql: str, params: Any = None) -> list[tuple]:
    """Open a short-lived connection, run one introspection query, return the raw rows.

    Parameters are passed through the driver's own placeholder binding (psycopg / pymysql both use
    `%s`), so schema/table values from the URL never touch the SQL text. Raises DbConsoleError with
    a cleaned message on any failure.
    """
    conn = None
    try:
        conn = db_console._connect(engine, host, port, username, password, database)
        with conn.cursor() as cur:
            if params is None:
                cur.execute(sql)
            else:
                cur.execute(sql, params)
            rows = list(cur.fetchall()) if cur.description else []
        return rows
    except DbConsoleError:
        raise
    except Exception as exc:  # driver/connection/query errors
        raise DbConsoleError(db_console._clean_message(exc)) from exc
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _s(value: Any) -> str:
    return "" if value is None else str(value)


# System schemas that are noise in a browsing tree: never surfaced as user schemas.
_PG_SYSTEM_SCHEMAS = ("pg_catalog", "information_schema")
_MYSQL_SYSTEM_SCHEMAS = ("information_schema", "mysql", "performance_schema", "sys")


def list_schemas(engine: str, host: str, port: int, username: str, password: str, database: str) -> list[dict]:
    """Return the user-visible schemas as `[{"name": str}, ...]`, system schemas excluded."""
    if engine == "postgres":
        sql = (
            "SELECT schema_name FROM information_schema.schemata "
            "WHERE schema_name NOT IN ('pg_catalog','information_schema') "
            "AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%' "
            "ORDER BY schema_name"
        )
    else:
        sql = (
            "SELECT schema_name FROM information_schema.schemata "
            "WHERE schema_name NOT IN ('information_schema','mysql','performance_schema','sys') "
            "ORDER BY schema_name"
        )
    rows = _run(engine, host, port, username, password, database, sql)
    return [{"name": _s(row[0])} for row in rows]


def list_tables_in_schema(engine: str, host: str, port: int, username: str, password: str, database: str, schema: str) -> list[dict]:
    """Return `[{"schema","name","type"}]` for one schema; type is "view" for a VIEW else "table"."""
    sql = (
        "SELECT table_schema, table_name, table_type FROM information_schema.tables "
        "WHERE table_schema = %s ORDER BY table_name"
    )
    rows = _run(engine, host, port, username, password, database, sql, (schema,))
    out = []
    for row in rows:
        ttype = _s(row[2]).upper()
        out.append({"schema": _s(row[0]), "name": _s(row[1]), "type": "view" if "VIEW" in ttype else "table"})
    return out


def list_routines(engine: str, host: str, port: int, username: str, password: str, database: str, schema: str) -> list[dict]:
    """Return stored functions/procedures in a schema as `[{"schema","name","kind"}]`.

    kind is "procedure" when the catalog reports a PROCEDURE, else "function".
    """
    sql = (
        "SELECT routine_schema, routine_name, routine_type FROM information_schema.routines "
        "WHERE routine_schema = %s ORDER BY routine_name"
    )
    rows = _run(engine, host, port, username, password, database, sql, (schema,))
    out = []
    for row in rows:
        rtype = _s(row[2]).upper()
        out.append({"schema": _s(row[0]), "name": _s(row[1]), "kind": "procedure" if "PROCEDURE" in rtype else "function"})
    return out


def _primary_key_columns(engine: str, host: str, port: int, username: str, password: str, database: str, schema: str, table: str) -> set[str]:
    """Return the set of column names that make up the table's PRIMARY KEY (may be empty)."""
    if engine == "postgres":
        sql = (
            "SELECT kcu.column_name FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu "
            "  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema "
            "WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = %s AND tc.table_name = %s"
        )
    else:
        sql = (
            "SELECT kcu.column_name FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu "
            "  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema "
            "     AND tc.table_name = kcu.table_name "
            "WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = %s AND tc.table_name = %s"
        )
    rows = _run(engine, host, port, username, password, database, sql, (schema, table))
    return {_s(row[0]) for row in rows}


def list_columns(engine: str, host: str, port: int, username: str, password: str, database: str, schema: str, table: str) -> list[dict]:
    """Return the table's columns, PK-flagged, ordered by ordinal position.

    Each row: `{"name","data_type","nullable":bool,"default":str,"is_primary_key":bool,"ordinal":int}`.
    """
    pk_cols = _primary_key_columns(engine, host, port, username, password, database, schema, table)
    sql = (
        "SELECT column_name, data_type, is_nullable, column_default, ordinal_position "
        "FROM information_schema.columns WHERE table_schema = %s AND table_name = %s "
        "ORDER BY ordinal_position"
    )
    rows = _run(engine, host, port, username, password, database, sql, (schema, table))
    out = []
    for row in rows:
        name = _s(row[0])
        nullable = _s(row[2]).upper() == "YES"
        default = db_console._jsonable(row[3]) if row[3] is not None else ""
        try:
            ordinal = int(row[4]) if row[4] is not None else 0
        except (TypeError, ValueError):
            ordinal = 0
        out.append({
            "name": name,
            "data_type": _s(row[1]),
            "nullable": nullable,
            "default": _s(default),
            "is_primary_key": name in pk_cols,
            "ordinal": ordinal,
        })
    return out


def list_indexes(engine: str, host: str, port: int, username: str, password: str, database: str, schema: str, table: str) -> list[dict]:
    """Return the table's indexes as `[{"name","columns":[str],"unique":bool,"primary":bool}]`."""
    if engine == "postgres":
        sql = (
            "SELECT ic.relname AS index_name, a.attname AS column_name, "
            "       ix.indisunique AS is_unique, ix.indisprimary AS is_primary, "
            "       array_position(ix.indkey, a.attnum) AS ord "
            "FROM pg_index ix "
            "JOIN pg_class tc ON tc.oid = ix.indrelid "
            "JOIN pg_class ic ON ic.oid = ix.indexrelid "
            "JOIN pg_namespace n ON n.oid = tc.relnamespace "
            "JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = ANY(ix.indkey) "
            "WHERE n.nspname = %s AND tc.relname = %s "
            "ORDER BY ic.relname, ord"
        )
        rows = _run(engine, host, port, username, password, database, sql, (schema, table))
        grouped: dict[str, dict] = {}
        for row in rows:
            name = _s(row[0])
            entry = grouped.setdefault(name, {"name": name, "columns": [], "unique": bool(row[2]), "primary": bool(row[3])})
            col = _s(row[1])
            if col and col not in entry["columns"]:
                entry["columns"].append(col)
        return list(grouped.values())
    # mysql: information_schema.statistics, one row per (index, column) with SEQ_IN_INDEX ordering
    sql = (
        "SELECT index_name, column_name, non_unique, seq_in_index "
        "FROM information_schema.statistics "
        "WHERE table_schema = %s AND table_name = %s "
        "ORDER BY index_name, seq_in_index"
    )
    rows = _run(engine, host, port, username, password, database, sql, (schema, table))
    grouped = {}
    for row in rows:
        name = _s(row[0])
        try:
            non_unique = int(row[2])
        except (TypeError, ValueError):
            non_unique = 1
        entry = grouped.setdefault(name, {
            "name": name, "columns": [], "unique": non_unique == 0, "primary": name.upper() == "PRIMARY",
        })
        col = _s(row[1])
        if col:
            entry["columns"].append(col)
    return list(grouped.values())


def list_constraints(engine: str, host: str, port: int, username: str, password: str, database: str, schema: str, table: str) -> list[dict]:
    """Return the table's constraints as `[{"name","type","definition":str}]`.

    type is one of PRIMARY KEY / UNIQUE / CHECK / FOREIGN KEY. On PostgreSQL `definition` is the
    real `pg_get_constraintdef` text; on MySQL, which has no equivalent, it is left blank.
    """
    if engine == "postgres":
        sql = (
            "SELECT con.conname, "
            "       CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE' "
            "                        WHEN 'c' THEN 'CHECK' WHEN 'f' THEN 'FOREIGN KEY' ELSE con.contype::text END, "
            "       pg_get_constraintdef(con.oid) "
            "FROM pg_constraint con "
            "JOIN pg_class rel ON rel.oid = con.conrelid "
            "JOIN pg_namespace n ON n.oid = rel.relnamespace "
            "WHERE n.nspname = %s AND rel.relname = %s "
            "ORDER BY con.conname"
        )
        rows = _run(engine, host, port, username, password, database, sql, (schema, table))
        return [{"name": _s(row[0]), "type": _s(row[1]), "definition": _s(row[2])} for row in rows]
    sql = (
        "SELECT tc.constraint_name, tc.constraint_type "
        "FROM information_schema.table_constraints tc "
        "WHERE tc.table_schema = %s AND tc.table_name = %s "
        "ORDER BY tc.constraint_name"
    )
    rows = _run(engine, host, port, username, password, database, sql, (schema, table))
    return [{"name": _s(row[0]), "type": _s(row[1]), "definition": ""} for row in rows]


def list_foreign_keys(engine: str, host: str, port: int, username: str, password: str, database: str, schema: str, table: str) -> list[dict]:
    """Return the table's foreign keys as
    `[{"name","columns":[str],"ref_schema","ref_table","ref_columns":[str]}]`.
    """
    if engine == "postgres":
        sql = (
            "SELECT con.conname, att.attname, nf.nspname, cf.relname, attf.attname, k.ord "
            "FROM pg_constraint con "
            "JOIN pg_class rel ON rel.oid = con.conrelid "
            "JOIN pg_namespace n ON n.oid = rel.relnamespace "
            "JOIN pg_class cf ON cf.oid = con.confrelid "
            "JOIN pg_namespace nf ON nf.oid = cf.relnamespace "
            "JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(conkey, confkey, ord) ON TRUE "
            "JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.conkey "
            "JOIN pg_attribute attf ON attf.attrelid = con.confrelid AND attf.attnum = k.confkey "
            "WHERE con.contype = 'f' AND n.nspname = %s AND rel.relname = %s "
            "ORDER BY con.conname, k.ord"
        )
        rows = _run(engine, host, port, username, password, database, sql, (schema, table))
        grouped: dict[str, dict] = {}
        for row in rows:
            name = _s(row[0])
            entry = grouped.setdefault(name, {
                "name": name, "columns": [], "ref_schema": _s(row[2]), "ref_table": _s(row[3]), "ref_columns": [],
            })
            entry["columns"].append(_s(row[1]))
            entry["ref_columns"].append(_s(row[4]))
        return list(grouped.values())
    # mysql: key_column_usage carries the referenced schema/table/column for FK rows
    sql = (
        "SELECT constraint_name, column_name, referenced_table_schema, referenced_table_name, "
        "       referenced_column_name, ordinal_position "
        "FROM information_schema.key_column_usage "
        "WHERE table_schema = %s AND table_name = %s AND referenced_table_name IS NOT NULL "
        "ORDER BY constraint_name, ordinal_position"
    )
    rows = _run(engine, host, port, username, password, database, sql, (schema, table))
    grouped = {}
    for row in rows:
        name = _s(row[0])
        entry = grouped.setdefault(name, {
            "name": name, "columns": [], "ref_schema": _s(row[2]), "ref_table": _s(row[3]), "ref_columns": [],
        })
        entry["columns"].append(_s(row[1]))
        entry["ref_columns"].append(_s(row[4]))
    return list(grouped.values())


# --- SQL generation ---------------------------------------------------------------------------


def _quote_ident(engine: str, name: str) -> str:
    """Quote an identifier for the engine, escaping the quote char (pg: "..", mysql: `..`)."""
    if engine == "postgres":
        return '"' + name.replace('"', '""') + '"'
    return "`" + name.replace("`", "``") + "`"


def _qualified(engine: str, schema: str, table: str) -> str:
    return f"{_quote_ident(engine, schema)}.{_quote_ident(engine, table)}"


GENERATE_KINDS = ("select", "insert", "update", "delete", "create")


def generate_sql(engine: str, host: str, port: int, username: str, password: str, database: str, schema: str, table: str, kind: str) -> str:
    """Return boilerplate SQL of one `kind` for a table, built from its live columns.

    kind in {"select","insert","update","delete","create"}. This is generated TEXT for the editor;
    it is never executed here. Raises DbConsoleError if the kind is unknown or the table has no
    columns (the introspection itself raises DbConsoleError on connection/query failure).
    """
    normalized = (kind or "").strip().lower()
    if normalized not in GENERATE_KINDS:
        raise DbConsoleError(f"Unknown SQL kind: {kind}")
    columns = list_columns(engine, host, port, username, password, database, schema, table)
    if not columns:
        raise DbConsoleError(f"Table {schema}.{table} has no columns")

    qualified = _qualified(engine, schema, table)
    col_names = [c["name"] for c in columns]
    pk_cols = [c["name"] for c in columns if c["is_primary_key"]]
    non_pk = [c["name"] for c in columns if not c["is_primary_key"]]

    def q(name: str) -> str:
        return _quote_ident(engine, name)

    if normalized == "select":
        cols = ", ".join(q(c) for c in col_names)
        return f"SELECT {cols}\nFROM {qualified}\nLIMIT 200;"

    if normalized == "insert":
        cols = ", ".join(q(c) for c in col_names)
        placeholders = ", ".join(f":{c}" for c in col_names)
        return f"INSERT INTO {qualified} ({cols})\nVALUES ({placeholders});"

    if normalized == "update":
        settable = non_pk or col_names
        set_clause = ",\n    ".join(f"{q(c)} = :{c}" for c in settable)
        if pk_cols:
            where = " AND ".join(f"{q(c)} = :{c}" for c in pk_cols)
        else:
            where = "/* no primary key: add a WHERE condition */ 1 = 0"
        return f"UPDATE {qualified}\nSET {set_clause}\nWHERE {where};"

    if normalized == "delete":
        if pk_cols:
            where = " AND ".join(f"{q(c)} = :{c}" for c in pk_cols)
            return f"DELETE FROM {qualified}\nWHERE {where};"
        return f"-- no primary key detected; add a WHERE clause before running\nDELETE FROM {qualified}\nWHERE 1 = 0;"

    # create: best-effort CREATE TABLE from the columns' types + NOT NULL + PK
    lines = []
    for c in columns:
        piece = f"    {q(c['name'])} {c['data_type']}"
        if not c["nullable"]:
            piece += " NOT NULL"
        lines.append(piece)
    if pk_cols:
        lines.append(f"    PRIMARY KEY ({', '.join(q(c) for c in pk_cols)})")
    body = ",\n".join(lines)
    return f"CREATE TABLE {qualified} (\n{body}\n);"
