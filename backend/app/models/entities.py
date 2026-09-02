from datetime import datetime
from enum import Enum

from sqlalchemy import Boolean, DateTime, Enum as SqlEnum, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Role(str, Enum):
    admin = "admin"
    administrator = "administrator"
    developer = "developer"
    support = "support"
    # A real, seeded account (guest@local) that carries the "guest" menu row and is otherwise
    # a normal user row an admin can see in User Management. Distinct from the desktop's
    # synthetic loopback guest session (sub guest@localhost), which has no backing row.
    guest = "guest"


class ServerStatus(str, Enum):
    healthy = "healthy"
    warning = "warning"
    critical = "critical"
    offline = "offline"
    unknown = "unknown"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[Role] = mapped_column(SqlEnum(Role), default=Role.administrator)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    server_access: Mapped[list["UserServerAccess"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    policy_assignments: Mapped[list["UserPolicyAssignment"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    # delete-orphan is load-bearing, not tidiness: SQLite runs with PRAGMA foreign_keys=ON
    # here, so a leftover shell_favorites row turns DELETE /users/{id} into an IntegrityError
    shell_favorites: Mapped[list["ShellFavorite"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Folder(Base):
    # EXPERIMENTAL (feature/server-folders): a flat, optional grouping over servers -- think
    # "BH", "MH", "EMS". A server belongs to at most one folder, and a folder is nothing more
    # than a named bucket, so there is deliberately no hierarchy, colour, or ordering here yet.
    __tablename__ = "folders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # public_id is what the API and every URL speak in, never the autoincrement id -- same rule
    # the Server model already follows. It is set at creation from uuid4(); folders are only ever
    # born through the API, so there is no legacy row that could sneak in without one.
    public_id: Mapped[str] = mapped_column(String(36), unique=True, index=True, default="")
    # unique + case-insensitive-checked in the route: two folders named "BH" and "bh" would be a
    # confusing pair, so the route rejects the second before it reaches this constraint.
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    # Self-referential parent for NESTED groups (a group can hold sub-groups to any depth). NULL =
    # a top-level group. Names stay globally unique for now (v1), so a subgroup can't reuse a name
    # that exists elsewhere in the tree -- relax the `name` unique index later if siblings need it.
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("folders.id"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # No cascade: deleting a folder must UNASSIGN its servers (folder_id -> NULL), never delete
    # them. That un-assignment is done explicitly in the DELETE route, so this relationship exists
    # only to read a folder's members and their count.
    servers: Mapped[list["Server"]] = relationship(back_populates="folder")


class Server(Base):
    __tablename__ = "servers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    public_id: Mapped[str] = mapped_column(String(36), unique=True, index=True, default="")
    hostname: Mapped[str] = mapped_column(String(255), index=True)
    alias: Mapped[str] = mapped_column(String(255), default="")
    ip_address: Mapped[str] = mapped_column(String(64), index=True)
    ssh_port: Mapped[int] = mapped_column(Integer, default=22)
    username: Mapped[str] = mapped_column(String(128))
    environment: Mapped[str] = mapped_column(String(64), index=True)
    server_type: Mapped[str] = mapped_column(String(64), default="application", index=True)
    tags: Mapped[str] = mapped_column(String(512), default="")
    operating_system: Mapped[str] = mapped_column(String(255), default="")
    kernel: Mapped[str] = mapped_column(String(255), default="")
    cpu: Mapped[str] = mapped_column(String(255), default="")
    ram_mb: Mapped[int] = mapped_column(Integer, default=0)
    disk_gb: Mapped[int] = mapped_column(Integer, default=0)
    architecture: Mapped[str] = mapped_column(String(64), default="")
    os_family: Mapped[str] = mapped_column(String(32), default="")
    # High-level OS kind that decides which probe/command set runs: "linux" (POSIX, the default)
    # or "windows" (PowerShell over SSH). Set by the operator when adding/editing a server, NOT
    # auto-detected. Distinct from os_family, which is the Linux DISTRO family (rhel/debian/…).
    os_kind: Mapped[str] = mapped_column(String(16), default="linux")
    os_distro: Mapped[str] = mapped_column(String(64), default="")
    os_version: Mapped[str] = mapped_column(String(64), default="")
    package_manager: Mapped[str] = mapped_column(String(32), default="")
    docker_version: Mapped[str] = mapped_column(String(128), default="")
    podman_version: Mapped[str] = mapped_column(String(128), default="")
    installed_services: Mapped[str] = mapped_column(Text, default="")
    installed_exporters: Mapped[str] = mapped_column(Text, default="")
    encrypted_password: Mapped[str] = mapped_column(Text, default="")
    encrypted_private_key: Mapped[str] = mapped_column(Text, default="")
    discovered_services_json: Mapped[str] = mapped_column(Text, default="[]")
    storage_json: Mapped[str] = mapped_column(Text, default="[]")
    database_logs_json: Mapped[str] = mapped_column(Text, default="[]")
    tomcat_json: Mapped[str] = mapped_column(Text, default="[]")
    business_owner: Mapped[str] = mapped_column(String(255), default="")
    support_contact: Mapped[str] = mapped_column(String(255), default="")
    # Per-server monitoring ingestion (feature/per-server-monitoring). metrics_enabled means
    # node_exporter is installed and this host should appear in the Prometheus http_sd target
    # list; node_exporter_port is where that exporter listens. log_shipping_enabled turns on the
    # background SSH log tail into Loki, and log_sources_json is a JSON list of {source,
    # name_or_path} entries (the same shape the service-log endpoint accepts) to tail. All four
    # are added after first release -> see the startup migration in app/main.py.
    metrics_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    node_exporter_port: Mapped[int] = mapped_column(Integer, default=9100)
    log_shipping_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    log_sources_json: Mapped[str] = mapped_column(Text, default="[]")
    # point-in-time vitals from the last probe. ram_mb above is total installed RAM from
    # discovery; ram_used_mb is what was in use when vitals were last sampled.
    uptime_seconds: Mapped[int] = mapped_column(Integer, default=0)
    load_average: Mapped[str] = mapped_column(String(64), default="")
    cpu_percent: Mapped[int] = mapped_column(Integer, default=-1)
    ram_used_mb: Mapped[int] = mapped_column(Integer, default=0)
    process_count: Mapped[int] = mapped_column(Integer, default=0)
    vitals_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[ServerStatus] = mapped_column(SqlEnum(ServerStatus), default=ServerStatus.unknown)
    health_score: Mapped[int] = mapped_column(Integer, default=0)
    last_health_check: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_backup: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_discovery: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # EXPERIMENTAL (feature/server-folders): the folder this server sits in, or NULL for the
    # "Unassigned" group the UI renders last. Nullable and indexed: most inventory reads either
    # group by this column or filter to one folder, and a server with no folder is the norm, not
    # an error. On the parent folder's delete this is set back to NULL rather than cascading.
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("folders.id"), nullable=True, index=True)

    audit_events: Mapped[list["AuditLog"]] = relationship(back_populates="server", cascade="all, delete-orphan")
    server_access: Mapped[list["UserServerAccess"]] = relationship(back_populates="server", cascade="all, delete-orphan")
    folder: Mapped["Folder | None"] = relationship(back_populates="servers")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    actor: Mapped[str] = mapped_column(String(255))
    action: Mapped[str] = mapped_column(String(128))
    resource_type: Mapped[str] = mapped_column(String(128))
    resource_id: Mapped[str] = mapped_column(String(128))
    details: Mapped[str] = mapped_column(Text, default="")
    server_id: Mapped[int | None] = mapped_column(ForeignKey("servers.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    server: Mapped[Server | None] = relationship(back_populates="audit_events")


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


class UserServerAccess(Base):
    __tablename__ = "user_server_access"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped[User] = relationship(back_populates="server_access")
    server: Mapped[Server] = relationship(back_populates="server_access")


class AccessPolicy(Base):
    __tablename__ = "access_policies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    environments: Mapped[str] = mapped_column(Text, default="")
    server_types: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[str] = mapped_column(Text, default="")
    server_ids: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    assignments: Mapped[list["UserPolicyAssignment"]] = relationship(back_populates="policy", cascade="all, delete-orphan")


class UserPolicyAssignment(Base):
    __tablename__ = "user_policy_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    policy_id: Mapped[int] = mapped_column(ForeignKey("access_policies.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped[User] = relationship(back_populates="policy_assignments")
    policy: Mapped[AccessPolicy] = relationship(back_populates="assignments")


class KubeCluster(Base):
    # A saved Kubernetes cluster connection. Like Server, the API and every URL speak in the
    # public_id (a uuid string), never the autoincrement id. Credentials are encrypted at rest
    # with the same Fernet path the Server model uses (app.core.crypto); the CA certificate is a
    # PUBLIC cert and is stored as plain text. A cluster may sit in a Folder (the "group"), exactly
    # like a server, or be unassigned (folder_id NULL).
    __tablename__ = "kube_clusters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    public_id: Mapped[str] = mapped_column(String(36), unique=True, index=True, default="")
    name: Mapped[str] = mapped_column(String(255), index=True)
    # kubeconfig | token -- how the client authenticates. With "kubeconfig" the pasted YAML holds
    # the server URL and credentials; with "token" the api_server_url + bearer token + CA are used.
    auth_method: Mapped[str] = mapped_column(String(32), default="kubeconfig")
    api_server_url: Mapped[str] = mapped_column(String(512), default="")
    encrypted_kubeconfig: Mapped[str] = mapped_column(Text, default="")
    encrypted_token: Mapped[str] = mapped_column(Text, default="")
    # PEM CA bundle -- a public certificate, so stored verbatim (not encrypted).
    ca_cert: Mapped[str] = mapped_column(Text, default="")
    verify_tls: Mapped[bool] = mapped_column(Boolean, default=True)
    default_namespace: Mapped[str] = mapped_column(String(255), default="")
    # feature/k8s-log-shipping: tail this cluster's pod logs into Loki. log_namespaces_json is a
    # JSON list of namespace names ("[]" = every namespace). Mirrors the Server log-shipping
    # columns; ALTERed into an existing table by _migrate_kube_cluster_columns in app.main.
    log_shipping_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    log_namespaces_json: Mapped[str] = mapped_column(Text, default="[]")
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("folders.id"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DbConnection(Base):
    # A saved, reusable database connection (feature/db-connect follow-on). Like Server and
    # KubeCluster, the API and every URL speak in the public_id (a uuid string), never the
    # autoincrement id. The password is encrypted at rest with the same Fernet path
    # (app.core.crypto) and is never echoed back by any read model. A connection may sit in a
    # Folder (the "group"), exactly like a server, or be unassigned (folder_id NULL).
    __tablename__ = "db_connections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    public_id: Mapped[str] = mapped_column(String(36), unique=True, index=True, default="")
    name: Mapped[str] = mapped_column(String(255), index=True)
    # postgres | mysql -- validated in the route so a bad value is a clean 400.
    engine: Mapped[str] = mapped_column(String(32), default="postgres")
    host: Mapped[str] = mapped_column(String(255), default="")
    port: Mapped[int] = mapped_column(Integer, default=5432)
    username: Mapped[str] = mapped_column(String(255), default="")
    encrypted_password: Mapped[str] = mapped_column(Text, default="")
    database: Mapped[str] = mapped_column(String(255), default="")
    # free-form environment tag ("dev" | "qa" | "uat" | "prod" | ""), so the UI can badge and
    # group saved connections the way servers are tagged. "" means unspecified.
    environment: Mapped[str] = mapped_column(String(32), default="")
    # when true the schema browser lists every database on the server (not just the connection's
    # own `database`), so an operator can browse siblings without editing the saved connection.
    # Persisted per connection; defaults False. Added after first release -> see the startup
    # migration in app/main.py.
    show_all_databases: Mapped[bool] = mapped_column(Boolean, default=False)
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("folders.id"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DbQueryHistory(Base):
    # A record of one query run through a saved DbConnection's console. Kept independent of the
    # DbConnection row: connection_id is a plain nullable int (not an FK with a cascade), and the
    # connection_name/engine/database are snapshotted at run time, so the history survives even
    # after the underlying connection is deleted. Nothing here is secret -- only the SQL text and
    # its outcome are stored, never credentials.
    __tablename__ = "db_query_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # the DbConnection.id this ran against, or NULL once that connection is gone. No FK on purpose:
    # deleting a connection must not delete or block on its history rows.
    connection_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    connection_name: Mapped[str] = mapped_column(String(255), default="")
    engine: Mapped[str] = mapped_column(String(32), default="")
    database: Mapped[str] = mapped_column(String(255), default="")
    # the signed-in user (JWT sub) who ran it, so history reads/clears can be scoped per caller.
    user_email: Mapped[str] = mapped_column(String(255), default="", index=True)
    sql: Mapped[str] = mapped_column(Text, default="")
    # "success" | "error"
    status: Mapped[str] = mapped_column(String(16), default="success")
    error: Mapped[str] = mapped_column(Text, default="")
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    elapsed_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ShellFavorite(Base):
    __tablename__ = "shell_favorites"
    # one name per user, not globally: two people may both keep a "tail catalina" entry
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_shell_favorites_user_name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    # stored verbatim -- this is a command the user types into their own shell, so there is
    # nothing meaningful to sanitise here and pretending otherwise would be theatre
    command: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped[User] = relationship(back_populates="shell_favorites")
