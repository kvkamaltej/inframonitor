import json
import os
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import func, inspect, select, text
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import JSONResponse, Response
from starlette.routing import Match, Mount

import secrets

from app.api.routes import router
from app.core.config import Settings, get_settings
from app.core.database import Base, SessionLocal, engine
from app.core.menus import DEFAULT_ROLE_MENUS, MENU_ITEMS, ROLE_MENUS_KEY
from app.core.security import SEEDED_GUEST_EMAIL, hash_password, verify_password
from app.models.entities import AppSetting, DbConnection, Role, Server, User


settings = get_settings()

# (column name, SQL default) for columns added after the first release. The DDL *type* is
# not hardcoded here -- it is compiled from the ORM column for the connected dialect by
# _column_ddl_type below, so the same loop is correct on SQLite and PostgreSQL.
EXPECTED_SERVER_COLUMNS: list[tuple[str, str]] = [
    ("encrypted_password", "''"),
    ("encrypted_private_key", "''"),
    ("public_id", "''"),
    ("server_type", "'application'"),
    ("discovered_services_json", "'[]'"),
    ("storage_json", "'[]'"),
    ("database_logs_json", "'[]'"),
    ("last_discovery", "NULL"),
    ("os_family", "''"),
    ("os_distro", "''"),
    ("os_version", "''"),
    ("package_manager", "''"),
    ("tomcat_json", "'[]'"),
    ("uptime_seconds", "0"),
    ("load_average", "''"),
    # -1 distinguishes "never sampled" from a genuine 0% reading
    ("cpu_percent", "-1"),
    ("ram_used_mb", "0"),
    ("process_count", "0"),
    ("vitals_checked_at", "NULL"),
    # EXPERIMENTAL (feature/server-folders): the FK to folders.id. The `folders` table itself is
    # created by create_all(); this line ALTERs the pre-existing servers table on an already
    # populated database. DEFAULT NULL matches the nullable ORM column -- every existing server
    # starts life "Unassigned". The DDL type is compiled from the ORM column by _column_ddl_type,
    # so this works unchanged on SQLite and PostgreSQL.
    ("folder_id", "NULL"),
]

DEFAULT_APP_SETTINGS: dict[str, list[str]] = {
    "environments": ["production", "development", "testing", "qa"],
    "server_types": ["application", "database", "web server", "repository", "tools", "other"],
    "application_types": ["java", "python", "nodejs", "php", "go", "other"],
}


def _column_ddl_type(name: str) -> str:
    # TEXT and VARCHAR(n) happen to be spelled the same on both backends, but
    # last_discovery is DateTime(timezone=True): create_all makes it TIMESTAMP WITH TIME
    # ZONE on PostgreSQL, so adding it as a bare TIMESTAMP would produce a column that
    # silently drops the UTC offset on write. Let SQLAlchemy render the type instead.
    column = Server.__table__.columns.get(name)
    if column is None:
        return "TEXT"
    return column.type.compile(dialect=engine.dialect)


def _migrate_server_columns() -> None:
    existing = {column["name"] for column in inspect(engine).get_columns("servers")}
    missing = [entry for entry in EXPECTED_SERVER_COLUMNS if entry[0] not in existing]
    if not missing:
        return
    with engine.begin() as conn:
        for name, default in missing:
            conn.execute(
                text(f"ALTER TABLE servers ADD COLUMN {name} {_column_ddl_type(name)} DEFAULT {default}")
            )


# (column name, SQL default) for db_connections columns added after the first release. The DDL
# *type* is compiled from the ORM column for the connected dialect, exactly like the servers loop
# above, so the same statements are correct on SQLite and PostgreSQL.
EXPECTED_DB_CONNECTION_COLUMNS: list[tuple[str, str]] = [
    ("environment", "''"),
    # feature/db-connect follow-on: browse every database on the server, not just the connection's
    # own `database`. A boolean, so the DEFAULT literal is dialect-specific -- see _db_connection_ddl.
    ("show_all_databases", "0"),
]


def _db_connection_ddl(name: str, default: str) -> tuple[str, str]:
    # Render the DDL type from the ORM column, and fix up the default literal for the dialect: a
    # BOOLEAN column takes DEFAULT false on PostgreSQL and DEFAULT 0 on SQLite/MySQL, so a bare "0"
    # would be rejected by PostgreSQL. Text/varchar defaults ('') are spelled the same everywhere.
    column = DbConnection.__table__.columns.get(name)
    if column is None:
        return "VARCHAR(32)", default
    ddl_type = column.type.compile(dialect=engine.dialect)
    literal = default
    if column.type.python_type is bool and default in ("0", "false", "False"):
        literal = "false" if engine.dialect.name == "postgresql" else "0"
    return ddl_type, literal


def _migrate_db_connection_columns() -> None:
    # db_connections is created by create_all() on a fresh install (with all columns already
    # present), but a database whose db_connections table predates a column needs it ALTERed in.
    # Same compile-the-type-from-the-ORM approach as _migrate_server_columns so the DDL is correct
    # on SQLite and PostgreSQL alike. A no-op once every column exists.
    inspector = inspect(engine)
    if "db_connections" not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns("db_connections")}
    missing = [entry for entry in EXPECTED_DB_CONNECTION_COLUMNS if entry[0] not in existing]
    if not missing:
        return
    with engine.begin() as conn:
        for name, default in missing:
            ddl_type, literal = _db_connection_ddl(name, default)
            conn.execute(text(f"ALTER TABLE db_connections ADD COLUMN {name} {ddl_type} DEFAULT {literal}"))


def _ensure_shell_favorites_unique() -> None:
    # create_all() DOES create a newly added table on an already-populated database
    # (checkfirst=True: missing tables are created, existing ones are left completely
    # alone) -- verified against the live SQLite file, rows and all other tables intact.
    # What it will never do is add a constraint to a shell_favorites that already exists,
    # so a database whose table predates the UniqueConstraint would silently keep
    # accepting duplicate (user_id, name) pairs. Same CREATE UNIQUE INDEX IF NOT EXISTS
    # approach as _backfill_public_ids below; a no-op on a table create_all just built.
    inspector = inspect(engine)
    if "shell_favorites" not in inspector.get_table_names():
        return
    target = {"user_id", "name"}
    for constraint in inspector.get_unique_constraints("shell_favorites"):
        if set(constraint.get("column_names") or ()) == target:
            return
    for index in inspector.get_indexes("shell_favorites"):
        if index.get("unique") and set(index.get("column_names") or ()) == target:
            return
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_shell_favorites_user_name "
                "ON shell_favorites (user_id, name)"
            )
        )


def _backfill_public_ids() -> None:
    with engine.begin() as conn:
        rows = conn.execute(text("SELECT id FROM servers WHERE public_id IS NULL OR public_id = ''")).fetchall()
        for row in rows:
            conn.execute(
                text("UPDATE servers SET public_id = :public_id WHERE id = :id"),
                {"public_id": str(uuid.uuid4()), "id": row.id},
            )
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_servers_public_id ON servers(public_id)"))


_ROLE_MENUS_PROVISIONED_KEY = "role_menus_provisioned"


def _backfill_role_menus() -> None:
    """Make newly-added menu items visible to existing installs without clobbering admin edits.

    The role->menu matrix is seeded once, so a menu item added to MENU_ITEMS in a later release
    would never appear for a database that was seeded before it existed (the App Database item is
    the case that surfaced this). We track the set of already-"provisioned" items; anything in
    MENU_ITEMS not yet provisioned is appended to each role whose DEFAULT_ROLE_MENUS row includes
    it, then the provisioned marker is advanced. Items an admin explicitly removed stay removed,
    because they are already in the provisioned set. First run against a pre-existing matrix (no
    marker) treats the union of the stored rows as provisioned, so only genuinely-new vocabulary
    is added.
    """
    with SessionLocal() as db:
        setting = db.get(AppSetting, ROLE_MENUS_KEY)
        if not setting:
            return  # not seeded yet; _seed_defaults writes a fresh, complete matrix
        try:
            matrix = json.loads(setting.value)
        except (ValueError, TypeError):
            return
        if not isinstance(matrix, dict):
            return
        marker = db.get(AppSetting, _ROLE_MENUS_PROVISIONED_KEY)
        if marker:
            try:
                provisioned = set(json.loads(marker.value))
            except (ValueError, TypeError):
                provisioned = set()
        else:
            provisioned = {item for row in matrix.values() if isinstance(row, list) for item in row}
        new_items = [item for item in MENU_ITEMS if item not in provisioned]
        changed = False
        if new_items:
            for role, defaults in DEFAULT_ROLE_MENUS.items():
                row = matrix.get(role)
                row = row if isinstance(row, list) else []
                for item in new_items:
                    if item in defaults and item not in row:
                        row.append(item)
                matrix[role] = row
            setting.value = json.dumps(matrix)
            changed = True
        full = json.dumps(list(MENU_ITEMS))
        if marker is None:
            db.add(AppSetting(key=_ROLE_MENUS_PROVISIONED_KEY, value=full))
            changed = True
        elif marker.value != full:
            marker.value = full
            changed = True
        if changed:
            db.commit()


_GUEST_MENU_ADDITIONS = ("databases", "kubernetes", "appdatabase")
_GUEST_MENU_ADDED_KEY = "guest_menu_additions_v1"


def _backfill_guest_menu_additions() -> None:
    """One-time: give the desktop guest the Databases, Kubernetes and App Database sections.

    These items were already "provisioned" (present for admin/developer) before the guest default
    gained them, so _backfill_role_menus never adds them to the guest row. Apply once, tracked by a
    marker, so an admin who later removes one keeps it removed. Fresh installs already get them from
    DEFAULT_ROLE_MENUS, so this is a no-op there beyond stamping the marker.
    """
    with SessionLocal() as db:
        if db.get(AppSetting, _GUEST_MENU_ADDED_KEY):
            return  # already applied
        setting = db.get(AppSetting, ROLE_MENUS_KEY)
        if setting:
            try:
                matrix = json.loads(setting.value)
            except (ValueError, TypeError):
                matrix = None
            if isinstance(matrix, dict):
                row = matrix.get("guest")
                row = row if isinstance(row, list) else []
                for item in _GUEST_MENU_ADDITIONS:
                    if item not in row:
                        row.append(item)
                matrix["guest"] = row
                setting.value = json.dumps(matrix)
        db.add(AppSetting(key=_GUEST_MENU_ADDED_KEY, value="1"))
        db.commit()


def _seed_defaults() -> None:
    with SessionLocal() as db:
        for key, value in DEFAULT_APP_SETTINGS.items():
            if not db.get(AppSetting, key):
                db.add(AppSetting(key=key, value=json.dumps(value)))
        # the role -> sidebar-menu matrix, seeded once with defaults that reproduce the
        # previous hardcoded sidebar behaviour; admins edit it from the Access Control page
        if not db.get(AppSetting, ROLE_MENUS_KEY):
            db.add(AppSetting(key=ROLE_MENUS_KEY, value=json.dumps(DEFAULT_ROLE_MENUS)))
        admin = db.scalar(select(User).where(User.email == settings.admin_email))
        if not admin:
            db.add(
                User(
                    email=settings.admin_email,
                    full_name="Infra Monitor Administrator",
                    password_hash=hash_password(settings.admin_password),
                    role=Role.administrator,
                )
            )
        # the built-in guest account: a real row so it shows in User Management and gives the
        # "guest" role a home. Its password is a throwaway random hash -- nothing can verify
        # against it, so this account can never actually sign in via /auth/login. The desktop's
        # login-less loopback guest is a separate synthetic session, not this row.
        guest = db.scalar(select(User).where(User.email == SEEDED_GUEST_EMAIL))
        if not guest:
            db.add(
                User(
                    email=SEEDED_GUEST_EMAIL,
                    full_name="Guest",
                    password_hash=hash_password(secrets.token_urlsafe(32)),
                    role=Role.guest,
                )
            )
        db.commit()


def _warn_if_default_admin_password() -> None:
    # Printed on EVERY boot for as long as the configured admin password still verifies
    # against the stored hash -- a first-boot-only notice scrolls away and the install
    # then sits on a published default forever. Silent once the password is changed.
    try:
        with SessionLocal() as db:
            admin = db.scalar(select(User).where(User.email == settings.admin_email))
        if admin is None or not verify_password(settings.admin_password, admin.password_hash):
            return
    except Exception:
        # never let a banner stop the app from starting
        return
    # read the shipped literal off the field rather than repeating it here, so the two
    # cannot drift apart
    shipped_default = Settings.model_fields["admin_password"].default
    is_shipped_default = settings.admin_password == shipped_default
    rule = "=" * 78
    lines = [
        "",
        rule,
        "  ADMIN ACCOUNT IS STILL USING THE DEFAULT PASSWORD"
        if is_shipped_default
        else "  ADMIN ACCOUNT IS STILL USING THE PASSWORD SEEDED FROM ADMIN_PASSWORD",
        rule,
        f"    URL:       {settings.public_url}",
        f"    Email:     {settings.admin_email}",
        f"    Password:  {settings.admin_password}",
        "",
        "  Sign in and change this password now (Profile -> Change password).",
    ]
    if is_shipped_default:
        lines += [
            "  To seed different credentials instead, set ADMIN_EMAIL and",
            "  ADMIN_PASSWORD before the first boot.",
        ]
    lines += [
        "",
        "  This banner is printed on every start until the password is changed.",
        rule,
        "",
    ]
    print("\n".join(lines), flush=True)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    Base.metadata.create_all(bind=engine)
    _migrate_server_columns()
    _migrate_db_connection_columns()
    _ensure_shell_favorites_unique()
    _backfill_public_ids()
    _seed_defaults()
    _backfill_role_menus()
    _backfill_guest_menu_additions()
    _warn_if_default_admin_password()
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

if settings.cors_origin_list:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(router, prefix="/api")


@app.get("/health")
def health() -> JSONResponse:
    try:
        # must touch real stored data -- "SELECT 1" is a constant expression, so SQLite
        # never opens the file and a corrupt or deleted database still reported healthy
        with engine.connect() as conn:
            conn.execute(text("SELECT 1 FROM users LIMIT 1"))
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"status": "degraded", "service": "inframonitor-backend", "database": "unavailable"},
        )
    return JSONResponse(
        status_code=200,
        content={"status": "ok", "service": "inframonitor-backend", "database": "ok"},
    )


if settings.metrics_enabled:
    # Imported lazily so the lite profile never needs prometheus_client at runtime, and
    # registered before the static mount below, which would otherwise swallow /metrics.
    from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

    HTTP_REQUESTS = Counter(
        "inframonitor_http_requests_total",
        "HTTP requests handled, by method, route template and response status.",
        ("method", "route", "status"),
    )
    HTTP_LATENCY = Histogram(
        "inframonitor_http_request_duration_seconds",
        "HTTP request latency in seconds, by method, route template and response status.",
        ("method", "route", "status"),
        # explicit buckets: the default 15 are tuned for sub-second web calls, and SSH
        # discovery routes here legitimately run for tens of seconds
        buckets=(0.005, 0.025, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0),
    )
    SERVERS_TOTAL = Gauge(
        "inframonitor_inventory_servers_total",
        "Servers currently in the inventory.",
    )

    def _route_template(scope) -> str:
        # Label with the registered path template, never scope["path"]: raw paths embed
        # per-server UUIDs, so one series per server per endpoint would be created.
        # Starlette 0.41 does not put the matched route in the scope, so match here --
        # against the pristine scope, before dispatch mutates root_path/path_params.
        partial = ""
        for route in getattr(scope.get("app"), "routes", ()) or ():
            match, _ = route.matches(scope)
            if match is Match.FULL:
                if isinstance(route, Mount):
                    # the static-UI mount: every asset collapses onto one series
                    return f"{route.path}/{{path}}"
                return getattr(route, "path", "unmatched")
            if match is Match.PARTIAL and not partial:
                # path matched but the method did not -- this is the 405 case
                partial = getattr(route, "path", "")
        return partial or "unmatched"

    class MetricsMiddleware:
        """Records count and latency for every HTTP request.

        The previous implementation incremented a counter inside the /health and
        /metrics handlers only, so it measured nothing but its own probes.
        """

        def __init__(self, app) -> None:
            self.app = app

        async def __call__(self, scope, receive, send) -> None:
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return
            route = _route_template(scope)
            method = scope.get("method", "UNKNOWN")
            status = "500"

            async def send_wrapper(message) -> None:
                nonlocal status
                if message["type"] == "http.response.start":
                    status = str(message["status"])
                await send(message)

            started = time.perf_counter()
            try:
                await self.app(scope, receive, send_wrapper)
            finally:
                # in a finally block so an unhandled exception still records the 500
                elapsed = time.perf_counter() - started
                HTTP_REQUESTS.labels(method, route, status).inc()
                HTTP_LATENCY.labels(method, route, status).observe(elapsed)

    # added last, so it is the outermost user middleware and times the whole response
    app.add_middleware(MetricsMiddleware)

    @app.get("/metrics", include_in_schema=False)
    def metrics() -> Response:
        try:
            with SessionLocal() as db:
                # counted in the database; the old gauge loaded every server row into
                # Python and called len() on the result
                SERVERS_TOTAL.set(db.scalar(select(func.count()).select_from(Server)) or 0)
        except Exception:
            # a scrape must still return the HTTP metrics if the database is unreachable
            pass
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


class _CachedStaticFiles(StaticFiles):
    """StaticFiles that sets Cache-Control so a redeploy never strands a browser on stale chunks.

    Next.js code-splits each route into content-hashed chunk files that its HTML references by
    name. With no explicit Cache-Control the browser caches the HTML heuristically and can keep
    serving an old index that points at chunk hashes the new build no longer has -- a ChunkLoadError
    when navigating (e.g. clicking Servers after a deploy). Fix: hashed assets under _next/static
    are immutable and cached for a year; every other response (the HTML shells) must revalidate, so
    a new deploy is picked up on the next request.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        # StaticFiles normalises the path with the OS separator (backslashes on Windows), so
        # compare on forward slashes to match _next/static on every platform.
        if path.replace("\\", "/").startswith("_next/static/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


if os.path.isdir(settings.static_dir):
    app.mount("/", _CachedStaticFiles(directory=settings.static_dir, html=True), name="ui")
