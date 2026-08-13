from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: str
    password: str


class MeResponse(BaseModel):
    email: str
    # display name of the signed-in account, so the Profile page can show and edit it
    full_name: str = ""
    role: str
    # true while this account's password still matches ADMIN_PASSWORD (the seeded default),
    # so the UI can show a persistent "change your password" banner
    using_default_password: bool = False
    # desktop guest session (no login): the UI shows a "Guest" state and a Sign-in affordance.
    guest: bool = False


class ProfileUpdate(BaseModel):
    # only the display name is editable here; email is the login identity (JWT subject) and is
    # not changed from the profile page.
    full_name: str = Field(min_length=1, max_length=255)
    # the effective sidebar menu-item keys for this caller's role, derived from the role->menu
    # matrix (AppSetting "role_menus"). The frontend renders the rail from this rather than from
    # hardcoded role checks. A guest gets the "guest" row.
    menus: list[str] = Field(default_factory=list)


class ServerCreate(BaseModel):
    hostname: str
    ip_address: str
    username: str
    ssh_port: int = 22
    alias: str = ""
    environment: str = "production"
    server_type: str = "application"
    tags: list[str] = Field(default_factory=list)
    business_owner: str = ""
    support_contact: str = ""
    password: str = ""
    private_key: str = ""


class ServerUpdate(BaseModel):
    # Every field optional: a PATCH sends only what changed. model_dump(exclude_unset=True) in
    # the route distinguishes "field omitted" from "field set to empty", so clearing an alias
    # (alias="") and leaving it untouched are different requests.
    hostname: str | None = None
    alias: str | None = None
    ip_address: str | None = None
    ssh_port: int | None = None
    username: str | None = None
    environment: str | None = None
    server_type: str | None = None
    tags: list[str] | None = None
    business_owner: str | None = None
    support_contact: str | None = None


class ServerRead(BaseModel):
    id: str
    hostname: str
    alias: str
    ip_address: str
    ssh_port: int
    username: str
    environment: str
    server_type: str
    tags: list[str]
    operating_system: str
    kernel: str
    cpu: str
    ram_mb: int
    disk_gb: int
    architecture: str
    docker_version: str
    podman_version: str
    installed_services: list[str]
    installed_exporters: list[str]
    os_family: str = ""
    os_distro: str = ""
    os_version: str = ""
    package_manager: str = ""
    discovered_services: list[dict] = Field(default_factory=list)
    storage: list[dict] = Field(default_factory=list)
    database_logs: list[dict] = Field(default_factory=list)
    tomcat: list[dict] = Field(default_factory=list)
    has_credentials: bool = False
    business_owner: str
    support_contact: str
    status: str
    health_score: int
    # vitals: point-in-time, as of vitals_checked_at. cpu_percent is -1 when never sampled,
    # which the UI must distinguish from a real 0%.
    uptime_seconds: int = 0
    load_average: str = ""
    cpu_percent: int = -1
    ram_used_mb: int = 0
    process_count: int = 0
    vitals_checked_at: datetime | None = None
    last_health_check: datetime | None
    last_seen: datetime | None
    last_backup: datetime | None
    last_discovery: datetime | None = None
    created_at: datetime
    # EXPERIMENTAL (feature/server-folders): the public_id of the folder this server is in, or ""
    # when unassigned. A string, not an int, because the whole API speaks in public_ids -- the UI
    # matches this against FolderRead.id to bucket rows under folder headers.
    folder_id: str = ""


class FolderCreate(BaseModel):
    # only the name is client-supplied; public_id is minted server-side at creation
    name: str


class FolderRead(BaseModel):
    # id is the folder's public_id (a uuid string), matching how ServerRead.id works -- never the
    # autoincrement primary key. server_count is computed per request so the UI can label each
    # folder header with its membership without a second round-trip.
    id: str
    name: str
    server_count: int


class ServerFolderUpdate(BaseModel):
    # None or "" unassigns (folder_id -> NULL); a non-empty value is a folder public_id to resolve.
    # Optional with a None default so an assign call can send either {"folder_id": null} or
    # {"folder_id": "<uuid>"} and an unassign can even omit the field entirely.
    folder_id: str | None = None


class Summary(BaseModel):
    server_count: int
    healthy_servers: int
    warning_servers: int
    critical_servers: int
    offline_servers: int
    # servers with no measurement yet (freshly added or imported, never discovered or probed).
    # Without this the four buckets above add up to less than server_count.
    unknown_servers: int = 0
    # hosts with a container runtime; a count of running containers needs a live probe per host
    total_containers: int
    databases: int
    running_services: int
    # averaged over measured_servers only, so unprobed servers do not drag it toward zero
    average_health_score: int
    measured_servers: int = 0


class IntegrationStatus(BaseModel):
    name: str
    url: str
    status: str


class CredentialPayload(BaseModel):
    password: str = ""
    private_key: str = ""
    tail: int = 200


class ConnectionResult(BaseModel):
    ok: bool
    message: str


class ContainerRead(BaseModel):
    runtime: str
    id: str
    name: str
    image: str
    status: str
    ports: str = ""


class LogResponse(BaseModel):
    runtime: str
    container: str
    lines: list[str]


class ServiceLogRequest(BaseModel):
    source: str = "journal"
    name_or_path: str
    tail: int = 200


class TomcatLogFile(BaseModel):
    name: str
    path: str
    size_bytes: str = ""
    modified: str = ""


class TomcatWebapp(BaseModel):
    # size_bytes/modified come straight from shell output, so accept a number for size too
    model_config = ConfigDict(coerce_numbers_to_str=True)

    name: str
    path: str = ""
    type: str = ""  # war | dir
    size_bytes: str = ""
    modified: str = ""


class TomcatPrerequisite(BaseModel):
    name: str
    required: str = ""
    detected: str = ""
    status: str = "unknown"  # ok | missing | unsupported | unknown


class TomcatInstance(BaseModel):
    name: str
    unit: str = ""
    source: str = ""
    status: str = "unknown"
    enabled: str = ""
    pid: str = ""
    catalina_base: str = ""
    catalina_home: str = ""
    log_dir: str = ""
    version: str = ""
    java: str = ""
    ports: str = ""
    log_files: list[TomcatLogFile] = Field(default_factory=list)
    # enriched discovery fields; absent on instances discovered before the upgrade
    server_number: str = ""
    jvm_version: str = ""
    jvm_vendor: str = ""
    os_name: str = ""
    java_home: str = ""
    configured_log_dir: str = ""
    configured_log_prefix: str = ""
    primary_log_file: str = ""
    webapps: list[TomcatWebapp] = Field(default_factory=list)
    prerequisites: list[TomcatPrerequisite] = Field(default_factory=list)


class TomcatLogRequest(BaseModel):
    instance: str = Field(max_length=128)
    log_file: str = Field(max_length=4096)
    tail: int = Field(default=200, ge=10, le=1000)


class TomcatActionRequest(BaseModel):
    instance: str = Field(max_length=128)
    action: str = Field(default="restart", max_length=16)
    sudo_password: str = Field(default="", max_length=512)


class PrivilegedOperationResult(BaseModel):
    ok: bool
    message: str
    needs_sudo_password: bool = False
    output: str = ""


class WarDeployResult(BaseModel):
    ok: bool
    message: str
    target_path: str = ""
    backup_path: str = ""
    bytes_written: int = 0
    restarted: bool = False
    # ok=True with restarted=False and needs_sudo_password=True means the WAR is in place
    # and only the restart needs to be retried -- the upload must not be repeated
    needs_sudo_password: bool = False


class AlertRecord(BaseModel):
    alertname: str = ""
    severity: str = ""
    status: str = ""
    instance: str = ""
    summary: str = ""
    starts_at: str = ""
    received_at: datetime | None = None


class AlertWebhookResult(BaseModel):
    ok: bool
    received: int = 0
    stored: int = 0
    message: str = ""


class AlertBufferResponse(BaseModel):
    alerts: list[AlertRecord] = Field(default_factory=list)
    count: int = 0
    capacity: int = 0
    # always false: the buffer lives in the API process only
    persistent: bool = False
    note: str = ""


class ServerImportRow(BaseModel):
    row: int
    hostname: str
    status: str
    message: str
    # public_id of a created server, so the UI can trigger discovery on it; "" for
    # skipped/failed/valid rows. has_credentials tells the UI whether discovery can even run
    # (a credential-less server would just 400), so it does not fire a doomed request.
    server_id: str = ""
    has_credentials: bool = False


class ServerImportResult(BaseModel):
    dry_run: bool
    total: int
    created: int
    skipped: int
    failed: int
    rows: list[ServerImportRow]


class ServerImportRequest(BaseModel):
    csv_text: str = Field(max_length=4_000_000)
    dry_run: bool = False


class UserRead(BaseModel):
    id: int
    email: str
    full_name: str
    role: str
    created_at: datetime


class UserCreate(BaseModel):
    email: str
    full_name: str
    password: str
    role: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)


class ServerAccessUpdate(BaseModel):
    server_ids: list[str] = Field(default_factory=list)


class UserServerAccessRead(BaseModel):
    user_id: int
    server_ids: list[str]


class AccessPolicyCreate(BaseModel):
    name: str
    description: str = ""
    environments: list[str] = Field(default_factory=list)
    server_types: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    server_ids: list[str] = Field(default_factory=list)


class AccessPolicyRead(AccessPolicyCreate):
    id: int
    assigned_user_ids: list[int] = Field(default_factory=list)


class PolicyAssignmentUpdate(BaseModel):
    user_ids: list[int] = Field(default_factory=list)


class OptionList(BaseModel):
    environments: list[str]
    server_types: list[str]
    application_types: list[str]


class OptionCreate(BaseModel):
    value: str


class RoleMenusResponse(BaseModel):
    # roles: the full ordered list of role keys the grid has a column/row for.
    # items: the full ordered menu-item vocabulary. Together they let the editor render the
    # complete role x item grid, while `menus` holds the currently-saved selections.
    roles: list[str]
    items: list[str]
    menus: dict[str, list[str]]


class RoleMenusUpdate(BaseModel):
    # role key -> selected menu-item keys. Unknown roles/items are dropped server-side; a role
    # omitted here is reset to its default row.
    menus: dict[str, list[str]] = Field(default_factory=dict)


class VaultConfigRead(BaseModel):
    # The token is never echoed back; token_set tells the UI whether one is stored.
    enabled: bool
    address: str
    kv_mount: str
    path_prefix: str
    token_set: bool


class VaultConfigWrite(BaseModel):
    enabled: bool = False
    address: str = ""
    kv_mount: str = "secret"
    path_prefix: str = "inframonitor"
    # Write-only. Omitted or empty -> keep the stored token; a non-empty value replaces it.
    token: str = ""


class VaultTestResult(BaseModel):
    ok: bool
    message: str


class ShellFavoriteRead(BaseModel):
    id: int
    name: str
    command: str
    created_at: datetime


class ShellFavoriteCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    command: str = Field(min_length=1, max_length=4000)


class SftpEntry(BaseModel):
    # name/path are text, but size_bytes and modified arrive from the SFTP layer as either
    # an int (paramiko st_size / st_mtime) or an already-formatted string, same as TomcatWebapp
    model_config = ConfigDict(coerce_numbers_to_str=True)

    name: str
    path: str = ""
    type: str = ""  # file | dir | link
    size_bytes: str = ""
    modified: str = ""
    mode: str = ""
    # raw st_mtime, kept as a number on purpose: `modified` is a formatted string and sorting
    # it as text orders "Jan" before "Feb". Declaring it int (not str) means coerce_numbers_to_str
    # above leaves it alone, so the client receives a number it can compare directly. 0 when the
    # SFTP server reported no usable mtime.
    modified_epoch: int = 0


class SftpListing(BaseModel):
    # no length caps on any of this: it is a response model, and a real directory whose
    # path or entry count exceeds an arbitrary bound must render, not 500 on serialisation
    path: str
    parent: str = ""
    entries: list[SftpEntry] = Field(default_factory=list)
    # true when the listing hit the 2000-entry cap, so the UI can say so instead of
    # silently presenting a partial directory as complete
    truncated: bool = False


class SftpUploadResult(BaseModel):
    ok: bool
    message: str = ""
    path: str = ""
    bytes_written: int = 0


class SftpDeleteRequest(BaseModel):
    # request model, so bounded: min_length rejects the empty path before an SSH connection is
    # opened, and 4096 matches _SFTP_PATH_MAX in api/routes.py (PATH_MAX on Linux)
    path: str = Field(min_length=1, max_length=4096)
    # opt-in, and required for a directory. The default has to be False: a delete that quietly
    # recursed because the flag was absent is the one mistake this endpoint cannot take back.
    recursive: bool = False


class SftpDeleteResult(BaseModel):
    # no length caps on any of this, same as SftpListing: it is a response model, and a real
    # remote path longer than an arbitrary bound must render rather than 500 on serialisation
    #
    # ok is declared explicitly rather than inferred client-side. ssh_ops.sftp_delete returns no
    # ok field of its own, and a client defaulting a missing one to false would report every
    # successful delete as a failure. Every non-success path on this endpoint is an HTTP 4xx with
    # the reason in `detail`, so a 200 here always carries ok=True.
    ok: bool = True
    message: str = ""
    path: str = ""
    deleted: str = ""  # file | dir | link -- what was actually removed, from lstat
    # echoed back so the audit trail, the response and the UI confirmation all agree on whether
    # this was a recursive removal
    recursive: bool = False
    entries_removed: int = 0


# --- database console (feature/db-connect) -------------------------------------------------
#
# A standalone connection to a PostgreSQL or MySQL database, not tied to a managed server.
# Credentials are per-request only and never stored: every field is supplied by the caller on
# each call, the backend opens a fresh connection, runs the work, and closes it.


class DbConnectionRequest(BaseModel):
    # engine is validated in the route against {"postgres","mysql"} so a bad value is a clean 400
    # rather than a driver import error.
    engine: str
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    username: str = Field(default="", max_length=255)
    password: str = Field(default="", max_length=1024)
    database: str = Field(default="", max_length=255)


class DbQueryRequest(DbConnectionRequest):
    sql: str = Field(min_length=1, max_length=100_000)
    # rows are capped at min(limit or 1000, 5000) in the route; None means "use the default".
    limit: int | None = Field(default=None, ge=1)


class DbConnectionResult(BaseModel):
    ok: bool
    message: str


class DbQueryResult(BaseModel):
    columns: list[str] = Field(default_factory=list)
    # rows are lists (row-major), matching the columns order; cell values are JSON-safe scalars
    # (str/int/float/bool/None) with anything else stringified by the route.
    rows: list[list] = Field(default_factory=list)
    row_count: int = 0
    # true when the result was cut to the row cap, so the UI can say "showing first N".
    truncated: bool = False
    elapsed_ms: int = 0


class OperationRequest(BaseModel):
    runtime: str = "docker"
    name: str


class ServiceRestartRequest(BaseModel):
    name: str
    sudo_password: str = ""


# --- app database backend switch (feature/app-db-backend) ----------------------------------
#
# Switching Infra Monitor's OWN backing database from SQLite to an external PostgreSQL/MySQL.
# The credentials here are for the target database and are only used to build the connection
# URL and, on migrate, written to the override file next to the SQLite database; they are not
# echoed back by any GET.


class AppDbConfigRead(BaseModel):
    # Friendly backend name ("SQLite" / "PostgreSQL" / "MySQL"), the connection URL with the
    # password masked, and whether an override file is currently in force.
    backend: str
    url_masked: str
    is_override: bool


class AppDbConnectionRequest(BaseModel):
    # Either a fully-formed SQLAlchemy `url`, or the discrete fields the route assembles into one.
    # engine is validated in the route against {"postgres","mysql"}.
    engine: str = "postgres"
    host: str = Field(default="", max_length=255)
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str = Field(default="", max_length=255)
    password: str = Field(default="", max_length=1024)
    database: str = Field(default="", max_length=255)
    # When provided, takes precedence over the discrete fields above.
    url: str = Field(default="", max_length=2048)


class AppDbTestResult(BaseModel):
    ok: bool
    message: str


class AppDbMigrateResult(BaseModel):
    ok: bool
    message: str
    # table name -> number of rows copied
    tables: dict[str, int] = Field(default_factory=dict)
    # always true on success: the running process keeps using the old engine until it restarts.
    restart_required: bool = False
