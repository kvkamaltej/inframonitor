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
    # the effective sidebar menu-item keys for this caller's role, derived from the role->menu
    # matrix (AppSetting "role_menus"). The frontend renders the rail from this rather than from
    # hardcoded role checks. A guest gets the "guest" row.
    menus: list[str] = Field(default_factory=list)


class ProfileUpdate(BaseModel):
    # only the display name is editable here; email is the login identity (JWT subject) and is
    # not changed from the profile page.
    full_name: str = Field(min_length=1, max_length=255)


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
    # optional group (folder public_id) to create the server directly into; "" / None means the
    # "Unassigned" bucket. Hostname uniqueness is scoped to this group.
    folder_id: str | None = None


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


class UserUpdate(BaseModel):
    # Every field optional: a PATCH sends only what changed. Email is immutable and any email
    # field is ignored. The password, when provided and non-empty, is validated (len>=8) and
    # re-hashed in the route.
    full_name: str | None = None
    role: str | None = None
    password: str | None = None


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


# --- saved database connections (feature/db-connect follow-on) ------------------------------
#
# A persistent, reusable version of the ad-hoc console above: the connection parameters are
# stored, the password is encrypted at rest (never echoed -- has_password says whether one is
# stored), and `group` is a folder NAME resolved to a Folder exactly as servers are grouped.
# Every id on the wire is the connection's public_id.


class DbConnectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    # engine is validated in the route against {"postgres","mysql","sqlite"} so a bad value is a
    # clean 400.
    engine: str = "postgres"
    # host is required for the networked engines (enforced in the route) but blank for sqlite, whose
    # `database` is a local file path; port has no meaning for sqlite, so both carry defaults.
    host: str = Field(default="", max_length=255)
    port: int = Field(default=0, ge=0, le=65535)
    username: str = Field(default="", max_length=255)
    password: str = Field(default="", max_length=1024)
    database: str = Field(default="", max_length=255)
    # deployment environment tag: "dev" | "qa" | "uat" | "prod" | "" (unspecified). Free-form and
    # not validated so a new value can be introduced without a code change.
    environment: str = Field(default="", max_length=32)
    # folder name (the "group"); resolved to an existing Folder in the route, else left unassigned.
    group: str | None = None


class DbConnectionUpdate(BaseModel):
    # Every field optional: a PATCH sends only what changed. The password is applied only when a
    # non-empty value is sent, so an edit that leaves it blank keeps the stored credential.
    name: str | None = None
    engine: str | None = None
    host: str | None = None
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str | None = None
    password: str | None = None
    database: str | None = None
    environment: str | None = Field(default=None, max_length=32)
    group: str | None = None


class DbConnectionRead(BaseModel):
    # id is the connection's public_id (a uuid string), never the autoincrement key. The password
    # is never present; has_password tells the UI whether one is stored.
    id: str
    name: str
    engine: str
    host: str
    port: int
    username: str = ""
    database: str = ""
    environment: str = ""
    group: str | None = None
    has_password: bool = False
    created_at: datetime


class DbTable(BaseModel):
    schema: str = ""
    name: str
    # "table" | "view"
    type: str = "table"


class DbConnectionQueryRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=100_000)
    # rows are capped at min(parse_limit(sql) or 200, 5000) in the route; this field is accepted
    # for forward-compatibility but the effective cap is derived from the SQL's own LIMIT.
    limit: int | None = Field(default=None, ge=1)


# --- database metadata / catalog browsing (DBeaver-style) -----------------------------------
#
# Read-only introspection shapes for the schema tree and the object-detail panes. Every one of
# these is produced by app.services.db_metadata from information_schema / system catalogs; nothing
# here is client-supplied on write except the generate-sql request.


class DbDatabase(BaseModel):
    name: str


class DbSchema(BaseModel):
    name: str


class DbRoutine(BaseModel):
    schema: str = ""
    name: str
    # "function" | "procedure"
    kind: str = "function"


class DbColumn(BaseModel):
    name: str
    data_type: str = ""
    nullable: bool = True
    default: str = ""
    is_primary_key: bool = False
    ordinal: int = 0


class DbIndex(BaseModel):
    name: str
    columns: list[str] = Field(default_factory=list)
    unique: bool = False
    primary: bool = False


class DbConstraint(BaseModel):
    name: str
    # PRIMARY KEY | UNIQUE | CHECK | FOREIGN KEY
    type: str = ""
    # engine DDL text where available (PostgreSQL); "" on MySQL
    definition: str = ""


class DbForeignKey(BaseModel):
    name: str
    columns: list[str] = Field(default_factory=list)
    ref_schema: str = ""
    ref_table: str = ""
    ref_columns: list[str] = Field(default_factory=list)


class DbGenerateSqlRequest(BaseModel):
    schema: str = Field(default="", max_length=255)
    table: str = Field(min_length=1, max_length=255)
    # select | insert | update | delete | create -- validated in db_metadata.generate_sql
    kind: str = "select"


class DbGenerateSqlResult(BaseModel):
    sql: str


# --- database query history (feature/db-connect follow-on) ----------------------------------
#
# One row per query run through a saved connection's console. The connection identity is snapshotted
# so the record survives the connection being deleted; nothing secret is stored (only SQL + outcome).


class DbQueryHistoryRead(BaseModel):
    id: int
    # the DbConnection.id it ran against, or null once that connection is gone
    connection_id: int | None = None
    connection_name: str = ""
    engine: str = ""
    database: str = ""
    user_email: str = ""
    sql: str = ""
    # "success" | "error"
    status: str = "success"
    error: str = ""
    row_count: int = 0
    elapsed_ms: int = 0
    created_at: datetime


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


# --- kubernetes (feature/kubernetes) -------------------------------------------------------
#
# A saved Kubernetes cluster connection plus the live read/action shapes. Credentials (kubeconfig
# YAML or bearer token) are write-only: they are supplied on create/update and encrypted at rest,
# and no read model ever echoes them back -- KubeClusterRead exposes has_credentials instead. The
# CA certificate is a public cert; it is accepted here but likewise not echoed. `group` is a folder
# NAME (resolved to a Folder, mirroring how servers are grouped); every id on the wire is a public_id.


class KubeClusterCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    api_server_url: str = Field(default="", max_length=512)
    # kubeconfig | token -- validated in the route so a bad value is a clean 400.
    auth_method: str = "kubeconfig"
    # write-only secrets: full kubeconfig YAML, or a bearer token (+ optional CA PEM).
    kubeconfig: str = ""
    token: str = ""
    ca_cert: str = ""
    verify_tls: bool = True
    default_namespace: str = Field(default="", max_length=255)
    # folder name (the "group"); resolved to an existing Folder in the route, else left unassigned.
    group: str | None = None


class KubeClusterUpdate(BaseModel):
    # Every field optional: a PATCH sends only what changed. Secret fields (kubeconfig, token,
    # ca_cert) are only applied when a non-empty value is sent, so an edit that leaves them blank
    # keeps the stored credentials rather than wiping them.
    name: str | None = None
    api_server_url: str | None = None
    auth_method: str | None = None
    kubeconfig: str | None = None
    token: str | None = None
    ca_cert: str | None = None
    verify_tls: bool | None = None
    default_namespace: str | None = None
    group: str | None = None


class KubeClusterRead(BaseModel):
    # id is the cluster's public_id (a uuid string), never the autoincrement primary key. Secrets
    # are never present; has_credentials tells the UI whether a kubeconfig or token is stored.
    id: str
    name: str
    api_server_url: str = ""
    auth_method: str
    verify_tls: bool = True
    default_namespace: str = ""
    group: str | None = None
    has_credentials: bool = False
    created_at: datetime


class KubeTestResult(BaseModel):
    ok: bool
    message: str
    version: str = ""


class KubeNodeCondition(BaseModel):
    type: str
    status: str


class KubeNode(BaseModel):
    name: str
    status: str = ""  # "Ready" | "NotReady" | other
    roles: list[str] = Field(default_factory=list)
    kubelet_version: str = ""
    os_image: str = ""
    internal_ip: str = ""
    cpu_capacity: str = ""
    memory_capacity: str = ""
    cpu_allocatable: str = ""
    memory_allocatable: str = ""
    age: str = ""
    schedulable: bool = True
    conditions: list[KubeNodeCondition] = Field(default_factory=list)
    # SSH linkage: when a managed Server matches this node (by internal IP, else name/alias),
    # its public_id + display label are attached so the UI can deep-link node -> server.
    linked_server_id: str | None = None
    linked_server_alias: str | None = None


class KubePod(BaseModel):
    name: str
    namespace: str = ""
    phase: str = ""
    ready: str = ""  # "1/1"
    restarts: int = 0
    node: str = ""
    pod_ip: str = ""
    age: str = ""
    containers: list[str] = Field(default_factory=list)


class KubePodLogs(BaseModel):
    container: str = ""
    log: str = ""
    tail: int = 0


class KubeDeployment(BaseModel):
    name: str
    namespace: str = ""
    ready: str = ""  # "2/3"
    replicas: int = 0
    available: int = 0
    updated: int = 0
    age: str = ""


class KubeReadyzCheck(BaseModel):
    name: str
    ok: bool


class KubeComponentStatus(BaseModel):
    name: str
    healthy: bool
    message: str = ""


class KubeControlPlanePod(BaseModel):
    name: str
    namespace: str = ""
    phase: str = ""
    ready: bool = False
    restarts: int = 0


class KubeAddon(BaseModel):
    name: str
    healthy: bool
    detail: str = ""


class KubeHealth(BaseModel):
    livez_ok: bool = False
    readyz_ok: bool = False
    readyz: list[KubeReadyzCheck] = Field(default_factory=list)
    component_statuses: list[KubeComponentStatus] = Field(default_factory=list)
    control_plane_pods: list[KubeControlPlanePod] = Field(default_factory=list)
    addons: list[KubeAddon] = Field(default_factory=list)


class KubeEvent(BaseModel):
    type: str = ""  # "Normal" | "Warning"
    reason: str = ""
    message: str = ""
    object: str = ""
    namespace: str = ""
    count: int = 0
    last_seen: str = ""


class KubePodsByPhase(BaseModel):
    Running: int = 0
    Pending: int = 0
    Failed: int = 0
    Succeeded: int = 0
    Unknown: int = 0


class KubeOverview(BaseModel):
    version: str = ""
    platform: str = ""
    node_count: int = 0
    nodes_ready: int = 0
    namespace_count: int = 0
    pod_count: int = 0
    pods_by_phase: KubePodsByPhase = Field(default_factory=KubePodsByPhase)
    cpu_capacity: str = ""
    memory_capacity: str = ""
    health_ok: bool = False
    warnings: list[KubeEvent] = Field(default_factory=list)


class KubeScaleRequest(BaseModel):
    replicas: int = Field(ge=0, le=1000)


class KubeCordonRequest(BaseModel):
    cordon: bool = True


class ActionResult(BaseModel):
    ok: bool
    message: str
