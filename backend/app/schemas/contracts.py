from datetime import datetime
from typing import Any

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
    # "linux" (default) or "windows" -- selects the probe/command set. Not auto-detected.
    os_kind: str = "linux"
    password: str = ""
    private_key: str = ""
    # Optional SSH jump host (bastion). jump_host "" = direct connection. jump credentials blank =
    # reuse the server's own for the bastion too.
    jump_host: str = ""
    jump_port: int = 22
    jump_username: str = ""
    jump_password: str = ""
    jump_private_key: str = ""
    # Optional reference to a reusable global SSH config (public_id), selected from a dropdown. When
    # set it supplies the jump host and its credentials, and the inline jump_* fields are ignored.
    # "" / None = no referenced config (use the inline jump_* fields, if any).
    ssh_config_id: str | None = None
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
    os_kind: str | None = None
    jump_host: str | None = None
    jump_port: int | None = None
    jump_username: str | None = None
    # blank string keeps the stored jump credential (mirrors password/private_key on the server).
    jump_password: str | None = None
    jump_private_key: str | None = None
    # referenced global SSH config public_id; "" explicitly clears the reference, None leaves it.
    ssh_config_id: str | None = None


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
    os_kind: str = "linux"
    os_distro: str = ""
    os_version: str = ""
    package_manager: str = ""
    discovered_services: list[dict] = Field(default_factory=list)
    storage: list[dict] = Field(default_factory=list)
    database_logs: list[dict] = Field(default_factory=list)
    tomcat: list[dict] = Field(default_factory=list)
    has_credentials: bool = False
    # jump host (bastion) config, read-only. jump_host "" = direct. has_jump_credentials says
    # whether a bastion-specific credential is stored (vs reusing the server's).
    jump_host: str = ""
    jump_port: int = 22
    jump_username: str = ""
    has_jump_credentials: bool = False
    # referenced global SSH config, when one is selected: its public_id and display name (name so the
    # UI can show the selection without a second lookup). "" when the jump host is inline or absent.
    ssh_config_id: str = ""
    ssh_config_name: str = ""
    business_owner: str
    support_contact: str
    # per-server monitoring ingestion state (read-only here; mutated through the dedicated
    # /servers/{id}/monitoring/* endpoints, never PATCH /servers).
    metrics_enabled: bool = False
    node_exporter_port: int = 9100
    log_shipping_enabled: bool = False
    log_sources: list[dict] = Field(default_factory=list)
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
    # optional parent group's public_id for a NESTED sub-group; None/"" = a top-level group.
    parent_id: str | None = None


class FolderUpdate(BaseModel):
    # PATCH: rename and/or MOVE. Uses model_dump(exclude_unset=True) in the route, so an omitted
    # field is left untouched, while `parent_id: null` / "" explicitly moves the group to the root.
    name: str | None = None
    parent_id: str | None = None


class FolderRead(BaseModel):
    # id is the folder's public_id (a uuid string), matching how ServerRead.id works -- never the
    # autoincrement primary key. server_count is computed per request so the UI can label each
    # folder header with its membership without a second round-trip.
    id: str
    name: str
    server_count: int          # servers assigned DIRECTLY to this group (not its sub-groups)
    parent_id: str = ""        # parent group's public_id, or "" for a top-level group
    child_count: int = 0       # number of direct sub-groups


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
    # Externally reachable published host ports (bind IP 0.0.0.0 or a routable
    # address, never 127.0.0.1/::1). The UI turns each into an "open in browser"
    # link http://<server-ip>:<port>, like Docker Desktop's port shortcuts.
    host_ports: list[int] = []


class ImageRead(BaseModel):
    runtime: str
    id: str            # short image id
    repository: str    # "<none>" for dangling
    tag: str           # "<none>" for untagged
    size: str          # human-readable, e.g. "142MB"
    created: str       # e.g. "3 days ago"


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


class MonitoringInstallRequest(BaseModel):
    # optional sudo password for the privileged install/uninstall, mirroring TomcatActionRequest;
    # blank means "try root / passwordless sudo first, then prompt".
    sudo_password: str = Field(default="", max_length=512)


class LogSourceEntry(BaseModel):
    # same shape the service-log endpoint accepts: source is "journal" (a unit name) or "file"
    # (an absolute path), name_or_path is the unit or path to tail.
    source: str = Field(default="journal", max_length=32)
    name_or_path: str = Field(max_length=4096)


class LogShippingUpdate(BaseModel):
    enabled: bool = False
    sources: list[LogSourceEntry] = Field(default_factory=list)


class ServerMonitoringState(BaseModel):
    metrics_enabled: bool = False
    node_exporter_port: int = 9100
    # best-effort: whether Prometheus currently reports this server's node_exporter as up. False
    # when Prometheus is not configured or the query fails, so the UI never blocks on it.
    scraped: bool = False
    log_shipping_enabled: bool = False
    log_sources: list[LogSourceEntry] = Field(default_factory=list)


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
    # "global" (every server) or "server" (only the server named below). server_public_id is "" for a
    # global favorite, else the Server.public_id it is scoped to.
    scope: str = "global"
    server_public_id: str = ""
    created_at: datetime


class ShellFavoriteCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    command: str = Field(min_length=1, max_length=4000)
    # "global" (default) or "server". When "server", server_public_id must be the current server.
    scope: str = "global"
    server_public_id: str = Field(default="", max_length=36)


class ShellFavoriteUpdate(BaseModel):
    # PATCH: either field may be sent on its own. Both are validated non-empty when present.
    name: str | None = Field(default=None, min_length=1, max_length=128)
    command: str | None = Field(default=None, min_length=1, max_length=4000)
    # scope may be re-targeted between global and a server; server_public_id accompanies "server".
    scope: str | None = None
    server_public_id: str | None = Field(default=None, max_length=36)


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
    # when true the schema browser lists every database on the server, not just this connection's
    # own `database`. Persisted on the connection; defaults False.
    show_all_databases: bool = False
    # Optional SSH tunnel (bastion). ssh_host "" = direct connection. Credentials blank = none.
    ssh_host: str = Field(default="", max_length=255)
    ssh_port: int = Field(default=22, ge=1, le=65535)
    ssh_username: str = Field(default="", max_length=255)
    ssh_password: str = Field(default="", max_length=1024)
    ssh_private_key: str = Field(default="", max_length=32768)
    # Optional reference to a reusable global SSH config (public_id), selected from a dropdown. When
    # set it supplies the tunnel host and its credentials, and the inline ssh_* fields are ignored.
    ssh_config_id: str | None = None
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
    show_all_databases: bool | None = None
    ssh_host: str | None = None
    ssh_port: int | None = Field(default=None, ge=1, le=65535)
    ssh_username: str | None = None
    # blank keeps the stored ssh credential (mirrors password)
    ssh_password: str | None = None
    ssh_private_key: str | None = None
    # referenced global SSH config public_id; "" explicitly clears the reference, None leaves it.
    ssh_config_id: str | None = None
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
    show_all_databases: bool = False
    # SSH tunnel config, read-only. ssh_host "" = direct. has_ssh_credentials says whether a tunnel
    # credential is stored.
    ssh_host: str = ""
    ssh_port: int = 22
    ssh_username: str = ""
    has_ssh_credentials: bool = False
    # referenced global SSH config, when one is selected: its public_id and display name. "" when the
    # tunnel is inline or absent.
    ssh_config_id: str = ""
    ssh_config_name: str = ""
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


class DbSchemaRenameRequest(BaseModel):
    # the target schema name. Validated in the route as a plain identifier (letters/digits/
    # underscore) before it is quoted into an ALTER SCHEMA statement.
    new_name: str = Field(min_length=1, max_length=63)


# --- redis engine (feature/redis-view) ------------------------------------------------------
# Redis is key/value, not SQL, so it has its own read models: the logical databases, one SCAN
# page of keys, one key's detail, and a raw-command reply. `value`/`reply` are arbitrary JSON.


class RedisKeyspace(BaseModel):
    db: int
    keys: int = 0
    expires: int = 0


class RedisKeyEntry(BaseModel):
    key: str
    type: str = ""
    ttl: int = -1  # -1 = no expiry, -2 = missing, else seconds remaining


class RedisScanResult(BaseModel):
    keys: list[RedisKeyEntry] = []
    cursor: int = 0  # 0 means the SCAN sweep is complete


class RedisKeyDetail(BaseModel):
    key: str
    type: str
    ttl: int = -1
    size_bytes: int | None = None
    length: int | None = None
    value: Any = None
    truncated: bool = False


class RedisCommandRequest(BaseModel):
    command: str = Field(min_length=1)
    db: int | None = None


class RedisCommandResult(BaseModel):
    command: str
    reply: Any = None


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
    # Optional SSH tunnel (jump host) for reaching the API server: a referenced global SSH config
    # (ssh_config_id) OR inline details. All blank = direct connection.
    ssh_host: str = Field(default="", max_length=255)
    ssh_port: int = Field(default=22, ge=1, le=65535)
    ssh_username: str = Field(default="", max_length=128)
    ssh_password: str = Field(default="", max_length=1024)
    ssh_private_key: str = Field(default="", max_length=32768)
    ssh_config_id: str | None = None
    # Optional SECOND hop: a saved SSH config (public_id) used as a jump host IN FRONT of the tunnel
    # host, so the API server is reached app -> jump -> tunnel host -> API. "" / None = no jump.
    ssh_jump_config_id: str | None = None
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
    ssh_host: str | None = None
    ssh_port: int | None = Field(default=None, ge=1, le=65535)
    ssh_username: str | None = None
    # blank keeps the stored ssh credential (mirrors token/kubeconfig)
    ssh_password: str | None = None
    ssh_private_key: str | None = None
    # referenced global SSH config public_id; "" clears the reference, None leaves it.
    ssh_config_id: str | None = None
    # second-hop jump host (saved SSH config public_id); "" clears, None leaves.
    ssh_jump_config_id: str | None = None
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
    # SSH tunnel config, read-only. ssh_host "" = direct. has_ssh_credentials says whether a tunnel
    # credential is stored; ssh_config_id/name name a referenced global SSH config.
    ssh_host: str = ""
    ssh_port: int = 22
    ssh_username: str = ""
    has_ssh_credentials: bool = False
    ssh_config_id: str = ""
    ssh_config_name: str = ""
    # second-hop jump host (a saved SSH config) in front of the tunnel host, when set.
    ssh_jump_config_id: str = ""
    ssh_jump_config_name: str = ""
    # feature/k8s-log-shipping: whether this cluster's pod logs are tailed into Loki, and the
    # namespaces shipped ([] = all). Present on read so the UI can render the toggle state.
    log_shipping_enabled: bool = False
    log_namespaces: list[str] = Field(default_factory=list)
    created_at: datetime


class KubeLogShippingUpdate(BaseModel):
    # Enable/disable tailing this cluster's pod logs into Loki, and which namespaces to ship.
    # An empty list means every namespace.
    enabled: bool = False
    namespaces: list[str] = Field(default_factory=list)


class AlertRuleCreate(BaseModel):
    # A user-defined Prometheus alert rule. `name` is the alert name (Prometheus identifier rules
    # apply); `expr` is a PromQL expression; `for_duration` like "5m"; severity feeds the label.
    name: str
    expr: str
    for_duration: str = "5m"
    severity: str = "warning"
    summary: str = ""
    description: str = ""


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


class KubeService(BaseModel):
    name: str
    namespace: str = ""
    type: str = ""          # ClusterIP | NodePort | LoadBalancer | ExternalName
    cluster_ip: str = ""
    ports: str = ""         # "80:8080/TCP, 443:8443/TCP"
    # label selector that maps the service to its pods ("k=v,k2=v2"); "" for a selector-less service
    selector: str = ""
    age: str = ""


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


# --------------------------------------------------------------- gateway traffic

class GatewayIngestEvent(BaseModel):
    """One entry of Kong's http-log payload, reduced to what this feature reads."""

    ts: float
    client_ip: str
    method: str = ""
    path: str = ""
    route_name: str = ""
    tier: str = ""
    status: int = 0
    limit_rule: str = ""
    latency_ms: int = 0
    user_agent: str = ""


class GatewayIngestResult(BaseModel):
    accepted: int
    gateway: str


class GatewaySourceRead(BaseModel):
    client_ip: str
    requests: int
    allowed: int
    throttled: int
    endpoints: int
    rate_per_min: float
    throttled_share: float
    last_seen: datetime


class GatewayEndpointRead(BaseModel):
    path: str
    tier: str
    limit_rule: str
    hits: int
    allowed: int
    throttled: int
    last_hit: datetime


class GatewayEventRead(BaseModel):
    ts: datetime
    client_ip: str
    method: str
    path: str
    tier: str
    status: int
    limit_rule: str
    latency_ms: int


class GatewayRead(BaseModel):
    id: int
    name: str
    environment: str
    enabled: bool
    last_event_at: datetime | None


class GatewayOverviewRead(BaseModel):
    """One landing tile: a registered gateway plus its activity in the window."""
    id: int
    name: str
    environment: str = ""
    enabled: bool = True
    requests: int = 0
    throttled: int = 0
    endpoints: int = 0
    sources: int = 0
    last_event_at: datetime | None = None


class GatewayCreate(BaseModel):
    name: str
    environment: str = ""


# --- global SSH configs (reusable jump host / tunnel profiles) -------------------------------
#
# A named, reusable SSH bastion profile. A managed server's jump host and a database connection's
# SSH tunnel can each REFERENCE one of these (by public_id) instead of typing the bastion details
# inline, so the same jump host is defined once and picked from a dropdown. Credentials are
# write-only: supplied on create/update, encrypted at rest, and never echoed (has_* flags say
# whether one is stored). Every id on the wire is the config's public_id.


class SshConfigCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="", max_length=128)
    password: str = Field(default="", max_length=1024)
    private_key: str = Field(default="", max_length=32768)


class SshConfigUpdate(BaseModel):
    # PATCH: only sent fields change. Secret fields are applied only when non-empty, so a blank keeps
    # the stored credential rather than wiping it.
    name: str | None = Field(default=None, min_length=1, max_length=128)
    host: str | None = Field(default=None, min_length=1, max_length=255)
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str | None = None
    password: str | None = None
    private_key: str | None = None


class ServerTestRequest(BaseModel):
    # Probe an UNSAVED server's SSH login while adding it (host/user + typed credentials), optionally
    # THROUGH a jump host — either a referenced saved config (ssh_config_id) or the inline jump_* fields.
    ip_address: str = Field(default="", max_length=255)
    ssh_port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="", max_length=128)
    password: str = Field(default="", max_length=1024)
    private_key: str = Field(default="", max_length=32768)
    ssh_config_id: str | None = None
    jump_host: str = Field(default="", max_length=255)
    jump_port: int = Field(default=22, ge=1, le=65535)
    jump_username: str = Field(default="", max_length=128)
    jump_password: str = Field(default="", max_length=1024)
    jump_private_key: str = Field(default="", max_length=32768)


class SshTestRequest(BaseModel):
    # Probe a bastion / jump host in isolation. Either name a saved config by id (its stored, encrypted
    # credentials are used) OR pass the inline host/port/user + write-only credentials as typed.
    ssh_config_id: str | None = None
    host: str = Field(default="", max_length=255)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="", max_length=128)
    password: str = Field(default="", max_length=1024)
    private_key: str = Field(default="", max_length=32768)


class SshConfigRead(BaseModel):
    # id is the config's public_id (a uuid string), never the autoincrement key. Secrets are never
    # present; has_password / has_private_key tell the UI whether a credential is stored.
    id: str
    name: str
    host: str
    port: int = 22
    username: str = ""
    has_password: bool = False
    has_private_key: bool = False
    created_at: datetime
