from datetime import datetime, timezone
import json
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import Server, ServerStatus
from app.schemas.contracts import ServerCreate, ServerRead


def _join(values: list[str]) -> str:
    return ",".join(sorted({value.strip() for value in values if value.strip()}))


def _split(value: str) -> list[str]:
    return [item for item in value.split(",") if item]


def _json_list(value: str) -> list[dict]:
    try:
        parsed = json.loads(value or "[]")
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []


def to_read(server: Server) -> ServerRead:
    return ServerRead(
        id=server.public_id,
        hostname=server.hostname,
        alias=server.alias,
        ip_address=server.ip_address,
        ssh_port=server.ssh_port,
        username=server.username,
        environment=server.environment,
        server_type=server.server_type,
        tags=_split(server.tags),
        operating_system=server.operating_system,
        kernel=server.kernel,
        cpu=server.cpu,
        ram_mb=server.ram_mb,
        disk_gb=server.disk_gb,
        architecture=server.architecture,
        os_family=server.os_family,
        os_distro=server.os_distro,
        os_version=server.os_version,
        package_manager=server.package_manager,
        tomcat=_json_list(server.tomcat_json),
        docker_version=server.docker_version,
        podman_version=server.podman_version,
        installed_services=_split(server.installed_services),
        installed_exporters=_split(server.installed_exporters),
        discovered_services=_json_list(server.discovered_services_json),
        storage=_json_list(server.storage_json),
        database_logs=_json_list(server.database_logs_json),
        has_credentials=bool(server.encrypted_password or server.encrypted_private_key),
        business_owner=server.business_owner,
        support_contact=server.support_contact,
        status=server.status.value,
        health_score=server.health_score,
        uptime_seconds=server.uptime_seconds,
        load_average=server.load_average,
        cpu_percent=server.cpu_percent,
        ram_used_mb=server.ram_used_mb,
        process_count=server.process_count,
        vitals_checked_at=server.vitals_checked_at,
        last_health_check=server.last_health_check,
        last_seen=server.last_seen,
        last_backup=server.last_backup,
        last_discovery=server.last_discovery,
        created_at=server.created_at,
        # EXPERIMENTAL (feature/server-folders): expose the folder as its public_id, or "" when
        # unassigned. Reading server.folder lazy-loads the related row; that is fine for the
        # inventory list sizes here, and keeps to_read a pure function of the ORM object.
        folder_id=server.folder.public_id if server.folder else "",
    )


class InventoryService:
    def __init__(self, db: Session):
        self.db = db

    def list_servers(self, server_ids: set[int] | None = None) -> list[ServerRead]:
        query = select(Server).order_by(Server.environment, Server.hostname)
        if server_ids is not None:
            if not server_ids:
                return []
            query = query.where(Server.id.in_(server_ids))
        servers = self.db.scalars(query).all()
        return [to_read(server) for server in servers]

    def create_server(self, payload: ServerCreate) -> ServerRead:
        now = datetime.now(timezone.utc)
        server = Server(
            hostname=payload.hostname,
            public_id=str(uuid.uuid4()),
            alias=payload.alias,
            ip_address=payload.ip_address,
            ssh_port=payload.ssh_port,
            username=payload.username,
            environment=payload.environment,
            server_type=payload.server_type,
            tags=_join(payload.tags),
            business_owner=payload.business_owner,
            support_contact=payload.support_contact,
            status=ServerStatus.unknown,
            health_score=0,
            last_health_check=now,
        )
        self.db.add(server)
        self.db.commit()
        self.db.refresh(server)
        return to_read(server)
