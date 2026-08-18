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

import os
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


# --- SQLite helpers -------------------------------------------------------------------------
#
# SQLite introspection is done through PRAGMAs, which cannot bind parameters -- the table name has
# to be interpolated into the statement text. To keep that safe, the name is validated against the
# live sqlite_master list first and then double-quoted, so only a real, existing object name can
# ever reach a PRAGMA.


def _sqlite_object_names(host: str, port: int, username: str, password: str, database: str) -> set[str]:
    rows = _run(
        "sqlite", host, port, username, password, database,
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
    )
    return {_s(row[0]) for row in rows}


def _sqlite_checked_table(host: str, port: int, username: str, password: str, database: str, table: str) -> str:
    """Return `table` only if it is a real table/view in this SQLite file, else raise.

    Guards the PRAGMA interpolation below against SQL injection: a PRAGMA takes no bind parameters,
    so the name must be validated against the catalog before it is quoted into the statement.
    """
    if table not in _sqlite_object_names(host, port, username, password, database):
        raise DbConsoleError(f"Unknown table {table}")
    return table


# System schemas that are noise in a browsing tree: never surfaced as user schemas.
_PG_SYSTEM_SCHEMAS = ("pg_catalog", "information_schema")
_MYSQL_SYSTEM_SCHEMAS = ("information_schema", "mysql", "performance_schema", "sys")


def list_databases(engine: str, host: str, port: int, username: str, password: str, database: str) -> list[dict]:
    """Return the databases visible on this server as `[{"name": str}, ...]`.

    Lets the UI browse/query a different database on the same server via the `database` override
    (postgres: separate databases each hold their own schemas; mysql: a database *is* a schema).
    On SQLite there is only the one file, so its basename is reported.
    """
    if engine == "postgres":
        rows = _run(
            engine, host, port, username, password, database,
            "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn ORDER BY datname",
        )
        return [{"name": _s(row[0])} for row in rows]
    if engine == "sqlite":
        base = os.path.basename(database) if database else ""
        return [{"name": base or "main"}]
    if engine == "mssql":
        # sys.databases lists every database; database_id 1-4 are the system databases
        # (master/tempdb/model/msdb), skipped so only user databases surface.
        rows = _run(
            engine, host, port, username, password, database,
            "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name",
        )
        return [{"name": _s(row[0])} for row in rows]
    # mysql: SHOW DATABASES, hiding the server-internal schemas
    rows = _run(engine, host, port, username, password, database, "SHOW DATABASES")
    excluded = {"information_schema", "mysql", "performance_schema", "sys"}
    return [{"name": _s(row[0])} for row in rows if _s(row[0]).lower() not in excluded]


def list_schemas(engine: str, host: str, port: int, username: str, password: str, database: str) -> list[dict]:
    """Return the user-visible schemas as `[{"name": str}, ...]`, system schemas excluded."""
    if engine == "sqlite":
        # SQLite has a single namespace for the main database file.
        return [{"name": "main"}]
    if engine == "postgres":
        sql = (
            "SELECT schema_name FROM information_schema.schemata "
            "WHERE schema_name NOT IN ('pg_catalog','information_schema') "
            "AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%' "
            "ORDER BY schema_name"
        )
    elif engine == "mssql":
        # sys.schemas carries the built-in roles/system schemas alongside user schemas; the
        # fixed database roles and sys/INFORMATION_SCHEMA/guest are noise in a browsing tree.
        sql = (
            "SELECT name FROM sys.schemas WHERE name NOT IN "
            "('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin','db_securityadmin',"
            "'db_ddladmin','db_backupoperator','db_datareader','db_datawriter','db_denydatareader',"
            "'db_denydatawriter') ORDER BY name"
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
    if engine == "sqlite":
        rows = _run(
            engine, host, port, username, password, database,
            "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
        )
        return [{"schema": "main", "name": _s(row[0]), "type": "view" if _s(row[1]).lower() == "view" else "table"} for row in rows]
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
    if engine == "sqlite":
        # SQLite has no stored functions/procedures.
        return []
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
    if engine == "sqlite":
        tbl = _sqlite_checked_table(host, port, username, password, database, table)
        rows = _run(
            engine, host, port, username, password, database,
            f"PRAGMA table_info({_quote_ident(engine, tbl)})",
        )
        out = []
        for row in rows:
            # PRAGMA table_info: (cid, name, type, notnull, dflt_value, pk)
            try:
                cid = int(row[0]) if row[0] is not None else 0
            except (TypeError, ValueError):
                cid = 0
            default = db_console._jsonable(row[4]) if row[4] is not None else ""
            out.append({
                "name": _s(row[1]),
                "data_type": _s(row[2]),
                "nullable": not bool(int(row[3] or 0)),
                "default": _s(default),
                "is_primary_key": int(row[5] or 0) != 0,
                "ordinal": cid,
            })
        return out
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
    if engine == "sqlite":
        tbl = _sqlite_checked_table(host, port, username, password, database, table)
        index_rows = _run(
            engine, host, port, username, password, database,
            f"PRAGMA index_list({_quote_ident(engine, tbl)})",
        )
        out = []
        for irow in index_rows:
            # PRAGMA index_list: (seq, name, unique, origin, partial)
            index_name = _s(irow[1])
            info_rows = _run(
                engine, host, port, username, password, database,
                f"PRAGMA index_info({_quote_ident(engine, index_name)})",
            )
            # PRAGMA index_info: (seqno, cid, name)
            columns = [_s(info[2]) for info in info_rows if info[2] is not None]
            out.append({
                "name": index_name,
                "columns": columns,
                "unique": bool(int(irow[2] or 0)),
                "primary": _s(irow[3]) == "pk",
            })
        return out
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
    if engine == "mssql":
        # SQL Server has no information_schema.statistics: sys.indexes + sys.index_columns carry
        # the index rows, joined to sys.tables/sys.schemas to scope by schema.table. Heap and the
        # unnamed default rows (name IS NULL, is_hypothetical) are excluded.
        sql = (
            "SELECT i.name AS index_name, c.name AS column_name, i.is_unique, i.is_primary_key, "
            "       ic.key_ordinal "
            "FROM sys.indexes i "
            "JOIN sys.tables t ON t.object_id = i.object_id "
            "JOIN sys.schemas s ON s.schema_id = t.schema_id "
            "JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
            "JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
            "WHERE i.name IS NOT NULL AND s.name = %s AND t.name = %s "
            "ORDER BY i.name, ic.key_ordinal"
        )
        rows = _run(engine, host, port, username, password, database, sql, (schema, table))
        grouped = {}
        for row in rows:
            name = _s(row[0])
            entry = grouped.setdefault(name, {
                "name": name, "columns": [], "unique": bool(row[2]), "primary": bool(row[3]),
            })
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
    if engine == "sqlite":
        # SQLite exposes no constraint catalog; derive PRIMARY KEY + FOREIGN KEY from the pragmas.
        tbl = _sqlite_checked_table(host, port, username, password, database, table)
        out: list[dict] = []
        pk_cols = [c["name"] for c in list_columns(engine, host, port, username, password, database, "main", tbl) if c["is_primary_key"]]
        if pk_cols:
            out.append({"name": f"pk_{tbl}", "type": "PRIMARY KEY", "definition": f"PRIMARY KEY ({', '.join(pk_cols)})"})
        for fk in list_foreign_keys(engine, host, port, username, password, database, "main", tbl):
            definition = (
                f"FOREIGN KEY ({', '.join(fk['columns'])}) "
                f"REFERENCES {fk['ref_table']} ({', '.join(fk['ref_columns'])})"
            )
            out.append({"name": fk["name"], "type": "FOREIGN KEY", "definition": definition})
        return out
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
    if engine == "sqlite":
        tbl = _sqlite_checked_table(host, port, username, password, database, table)
        rows = _run(
            engine, host, port, username, password, database,
            f"PRAGMA foreign_key_list({_quote_ident(engine, tbl)})",
        )
        grouped: dict[str, dict] = {}
        for row in rows:
            # PRAGMA foreign_key_list: (id, seq, table, from, to, on_update, on_delete, match)
            fid = _s(row[0])
            entry = grouped.setdefault(fid, {
                "name": f"fk_{tbl}_{fid}", "columns": [], "ref_schema": "main",
                "ref_table": _s(row[2]), "ref_columns": [],
            })
            entry["columns"].append(_s(row[3]))
            entry["ref_columns"].append(_s(row[4]))
        return list(grouped.values())
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
    if engine == "mssql":
        # SQL Server: sys.foreign_keys + sys.foreign_key_columns map each constrained column to its
        # referenced column; joins to sys.tables/sys.columns/sys.schemas resolve the names.
        sql = (
            "SELECT fk.name, pc.name AS column_name, rs.name AS ref_schema, rt.name AS ref_table, "
            "       rc.name AS ref_column, fkc.constraint_column_id "
            "FROM sys.foreign_keys fk "
            "JOIN sys.tables pt ON pt.object_id = fk.parent_object_id "
            "JOIN sys.schemas ps ON ps.schema_id = pt.schema_id "
            "JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id "
            "JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id "
            "JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id "
            "JOIN sys.schemas rs ON rs.schema_id = rt.schema_id "
            "JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id "
            "WHERE ps.name = %s AND pt.name = %s "
            "ORDER BY fk.name, fkc.constraint_column_id"
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
    """Quote an identifier for the engine, escaping the quote char (pg/sqlite: "..", mysql: `..`,
    mssql: [..] with a doubled closing bracket)."""
    if engine in ("postgres", "sqlite"):
        return '"' + name.replace('"', '""') + '"'
    if engine == "mssql":
        return "[" + name.replace("]", "]]") + "]"
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

    # SQLite has one namespace ("main"); qualify only the (already catalog-validated) table name.
    if engine == "sqlite":
        qualified = _quote_ident(engine, table)
    else:
        qualified = _qualified(engine, schema, table)
    col_names = [c["name"] for c in columns]
    pk_cols = [c["name"] for c in columns if c["is_primary_key"]]
    non_pk = [c["name"] for c in columns if not c["is_primary_key"]]

    def q(name: str) -> str:
        return _quote_ident(engine, name)

    if normalized == "select":
        cols = ", ".join(q(c) for c in col_names)
        # SQL Server has no LIMIT clause; the row cap goes at the front as SELECT TOP N.
        if engine == "mssql":
            return f"SELECT TOP 200 {cols}\nFROM {qualified};"
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
