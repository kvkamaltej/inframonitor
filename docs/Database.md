# Database module (DBeaver-inspired SQL browser)

The **Database** tab is a database-management workspace inside Infra Monitor — a DBeaver-style tree
navigator, a SQL editor with tabs, and a result grid — built on **stored connections**. It reuses the
app's auth, RBAC, theme, sidebar, and notifications; it is not a separate application.

Open it from the **Databases** entry in the sidebar (a flyout that lists your connections and, when
expanded, their tables). "Open console" (or clicking a table) takes you to the full workspace at
`/databases`.

## Supported engines

| Engine | Driver | Notes |
| --- | --- | --- |
| PostgreSQL | `psycopg` | Full support, tested live. |
| MySQL / MariaDB | `pymysql` | Metadata via `information_schema`. |
| SQLite | `sqlite3` | The `database` field is the **file path** on the server host. |
| SQL Server | `pymssql` | Code-complete but **not yet verified against a live instance**. |

Connections are stored with the password **encrypted at rest** (Fernet, keyed from `JWT_SECRET`);
passwords are never returned by the API. Connecting uses driver keyword arguments, so passwords
containing `@` or `:` work correctly.

## What you can do

- **Browse** — lazy tree: connection → schemas → tables / views / routines → columns / indexes /
  constraints / foreign keys. A per-connection filter box narrows tables/functions by name.
- **Query** — CodeMirror editor with SQL highlighting; `Ctrl+Enter` runs, `Ctrl+Shift+Enter` runs the
  selection. Multiple query tabs preserve their own SQL + results; a tab right-click menu closes
  others / to the right / to the left / all.
- **Results** — sortable grid with row numbers, NULL styling, copy, and **CSV / JSON / Excel** export.
  The sticky footer shows **row count + execution time**, a **Fetch all** button, and pagination.
  Queries return **200 rows by default**; an explicit `LIMIT` in your SQL overrides it (hard cap 5000).
- **Right-click actions** — View Data (auto-runs `SELECT * … LIMIT 200`), Open SQL Editor, Generate SQL
  (SELECT/INSERT/UPDATE/DELETE/CREATE from live column metadata), Refresh, Rename schema, and
  **Backup / Restore** (PostgreSQL, via `pg_dump`/`pg_restore` — the image ships `postgresql-client`).
- **Show all databases** — a per-connection toggle that lists every database on the server and browses
  each (threaded through the metadata calls); the choice is saved on the connection.
- **Production safety** — a connection tagged environment `prod` requires **typing the database name**
  to confirm before a destructive statement (`DROP`/`TRUNCATE`/`DELETE`-without-`WHERE`/…).

## Permissions

Reads, queries, and connection management require a signed-in user (and, in the desktop app, the
loopback guest — see [Security.md](Security.md)). **Backup, restore, and schema-rename are admin-only.**
Every query is written to a searchable **query history**.

## API (under `/api`)

`GET/POST/PATCH/DELETE /db/connections`, `POST /db/connections/{id}/test`, `.../{id}/databases`,
`.../{id}/schemas[/{schema}/tables|routines]`, `.../{id}/tables/{schema}/{table}/{columns|indexes|constraints|foreign-keys}`,
`POST .../{id}/query`, `POST .../{id}/generate-sql`, `POST .../{id}/schemas/{schema}/rename`,
`POST .../{id}/backup`, `POST .../{id}/restore`, `GET/DELETE /db/query-history`. Metadata/query routes
accept an optional `?database=` to browse another database on the same server.
