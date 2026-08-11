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

from app.api.routes import router
from app.core.config import Settings, get_settings
from app.core.database import Base, SessionLocal, engine
from app.core.security import hash_password, verify_password
from app.models.entities import AppSetting, Role, Server, User


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


def _seed_defaults() -> None:
    with SessionLocal() as db:
        for key, value in DEFAULT_APP_SETTINGS.items():
            if not db.get(AppSetting, key):
                db.add(AppSetting(key=key, value=json.dumps(value)))
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
    _ensure_shell_favorites_unique()
    _backfill_public_ids()
    _seed_defaults()
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


if os.path.isdir(settings.static_dir):
    app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="ui")
