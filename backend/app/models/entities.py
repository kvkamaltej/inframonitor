from datetime import datetime
from enum import Enum

from sqlalchemy import DateTime, Enum as SqlEnum, ForeignKey, Integer, String, Text, UniqueConstraint, func
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
