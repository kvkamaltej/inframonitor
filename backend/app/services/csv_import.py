import csv
import io
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.crypto import encrypt_secret
from app.models.entities import Server, ServerStatus
from app.schemas.contracts import ServerImportResult, ServerImportRow

CSV_HEADERS = [
    "hostname",
    "ip_address",
    "username",
    "password",
    "private_key",
    "ssh_port",
    "environment",
    "server_type",
    "alias",
    "tags",
    "business_owner",
    "support_contact",
]

_KNOWN_FIELDS = set(CSV_HEADERS)
_REQUIRED_FIELDS = ("hostname", "ip_address", "username")
_MAX_LENGTHS = {
    "hostname": 255,
    "ip_address": 64,
    "username": 128,
    "alias": 255,
    "environment": 64,
    "server_type": 64,
    "business_owner": 255,
    "support_contact": 255,
}
_MAX_TAGS_LENGTH = 512
_MAX_ROWS = 1000
_PARSE_ERROR = "CSV could not be parsed. Check the header row and that quoted fields are closed."
_DISCOVERY_HINT = "Created with status unknown. Run discovery on this server to collect facts."
_VALID_HINT = "Row is valid and will be created with status unknown."
_DUPLICATE_HINT = "Hostname or IP address already exists"


class CsvImportError(ValueError):
    pass


class _RowError(ValueError):
    pass


def _normalise_field(name: object) -> str:
    if not isinstance(name, str):
        return ""
    return name.strip().lower().replace(" ", "_").replace("-", "_")


def _cell(value: object) -> str:
    if isinstance(value, list):
        value = value[0] if value else ""
    if not isinstance(value, str):
        return ""
    return value.strip()


def _row_fields(raw: dict) -> dict[str, str]:
    fields: dict[str, str] = {}
    for key, value in raw.items():
        name = _normalise_field(key)
        if name in _KNOWN_FIELDS:
            fields[name] = _cell(value)
    return fields


def _ssh_port(value: str) -> int:
    if not value:
        return 22
    if not value.isdigit():
        raise _RowError("ssh_port must be a whole number between 1 and 65535")
    port = int(value)
    if port < 1 or port > 65535:
        raise _RowError("ssh_port must be between 1 and 65535")
    return port


def _tags(value: str) -> str:
    items = {item.strip().replace(",", "") for item in value.split(";")}
    return ",".join(sorted(item for item in items if item))


def _private_key(value: str) -> str:
    if not value:
        return ""
    return value.replace("\\r\\n", "\n").replace("\\n", "\n")


def _reader(csv_text: str) -> csv.DictReader:
    text = csv_text.encode("utf-8").decode("utf-8-sig")
    if not text.strip():
        raise CsvImportError("CSV is empty")
    try:
        reader = csv.DictReader(io.StringIO(text))
        fieldnames = reader.fieldnames
    except csv.Error as exc:
        raise CsvImportError(_PARSE_ERROR) from exc
    names = {_normalise_field(name) for name in fieldnames or []}
    missing = [name for name in _REQUIRED_FIELDS if name not in names]
    if missing:
        raise CsvImportError(f"CSV header row must include: {', '.join(missing)}")
    return reader


def _existing_identifiers(db: Session) -> tuple[set[str], set[str]]:
    rows = db.execute(select(Server.hostname, Server.ip_address)).all()
    hostnames = {row[0].lower() for row in rows if row[0]}
    ip_addresses = {row[1].lower() for row in rows if row[1]}
    return hostnames, ip_addresses


def _build_server(fields: dict[str, str]) -> Server:
    missing = [name for name in _REQUIRED_FIELDS if not fields.get(name)]
    if missing:
        raise _RowError(f"Missing required values: {', '.join(missing)}")
    for name, limit in _MAX_LENGTHS.items():
        if len(fields.get(name, "")) > limit:
            raise _RowError(f"{name} is longer than {limit} characters")
    tags = _tags(fields.get("tags", ""))
    if len(tags) > _MAX_TAGS_LENGTH:
        raise _RowError(f"tags are longer than {_MAX_TAGS_LENGTH} characters")
    return Server(
        hostname=fields["hostname"],
        public_id=str(uuid.uuid4()),
        alias=fields.get("alias", ""),
        ip_address=fields["ip_address"],
        ssh_port=_ssh_port(fields.get("ssh_port", "")),
        username=fields["username"],
        environment=fields.get("environment", "") or "production",
        server_type=fields.get("server_type", "") or "application",
        tags=tags,
        business_owner=fields.get("business_owner", ""),
        support_contact=fields.get("support_contact", ""),
        encrypted_password=encrypt_secret(fields.get("password", "")),
        encrypted_private_key=encrypt_secret(_private_key(fields.get("private_key", ""))),
        status=ServerStatus.unknown,
        health_score=0,
        last_health_check=datetime.now(timezone.utc),
    )


def import_servers(db: Session, csv_text: str, dry_run: bool = False) -> ServerImportResult:
    reader = _reader(csv_text)
    existing_hostnames, existing_ips = _existing_identifiers(db)
    seen_hostnames: set[str] = set()
    seen_ips: set[str] = set()
    rows: list[ServerImportRow] = []
    pending: list[Server] = []
    created = 0
    skipped = 0
    failed = 0
    index = 0
    while True:
        try:
            raw = next(reader)
        except StopIteration:
            break
        except csv.Error as exc:
            raise CsvImportError(_PARSE_ERROR) from exc
        index += 1
        if index > _MAX_ROWS:
            raise CsvImportError(f"CSV has more than {_MAX_ROWS} data rows. Split it into smaller files.")
        fields = _row_fields(raw)
        hostname = fields.get("hostname", "")
        try:
            server = _build_server(fields)
            hostname_key = server.hostname.lower()
            ip_key = server.ip_address.lower()
            if hostname_key in existing_hostnames or ip_key in existing_ips or hostname_key in seen_hostnames or ip_key in seen_ips:
                skipped += 1
                rows.append(ServerImportRow(row=index, hostname=hostname, status="skipped", message=_DUPLICATE_HINT))
                continue
            seen_hostnames.add(hostname_key)
            seen_ips.add(ip_key)
            created += 1
            if dry_run:
                rows.append(ServerImportRow(row=index, hostname=hostname, status="valid", message=_VALID_HINT))
                continue
            pending.append(server)
            rows.append(
                ServerImportRow(
                    row=index,
                    hostname=hostname,
                    status="created",
                    message=_DISCOVERY_HINT,
                    server_id=server.public_id,
                    has_credentials=bool(server.encrypted_password or server.encrypted_private_key),
                )
            )
        except _RowError as exc:
            failed += 1
            rows.append(ServerImportRow(row=index, hostname=hostname, status="failed", message=str(exc)))
        except Exception:
            failed += 1
            rows.append(ServerImportRow(row=index, hostname=hostname, status="failed", message="Row could not be imported"))
    if pending:
        for server in pending:
            db.add(server)
        try:
            db.commit()
        except SQLAlchemyError as exc:
            db.rollback()
            raise CsvImportError("Import could not be saved. No servers were created.") from exc
    return ServerImportResult(dry_run=dry_run, total=index, created=created, skipped=skipped, failed=failed, rows=rows)
