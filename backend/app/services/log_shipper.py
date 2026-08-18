"""Ship managed-server logs into Loki by tailing over SSH -- no agent on the server.

For every server with ``log_shipping_enabled`` set, and every configured log source, this tails
the recent lines over SSH (reusing ``ssh_ops.service_logs`` -- the same reader the service-log
endpoint uses) and pushes the new ones to Loki's push API. There is no persistent agent and no new
SSH layer: it is a periodic pull driven from the app process (see the lifespan task in app.main).

Cursor / de-duplication
-----------------------
State is deliberately light: an in-memory cursor per ``(server_public_id, source_key)`` holding the
hash of the last line already shipped. Each run tails the last ``TAIL_LINES`` lines, finds where the
remembered line sits in that window, and ships only what follows it. If the remembered line is no
longer in the window (log rotated, or it grew by more than the window between runs) the whole window
is shipped -- best effort, favouring "no gaps" over "never a duplicate". The cursor lives in the
process, so a restart re-ships at most one window per source; that is acceptable for a visibility
feed and avoids a schema/table just to track byte offsets.

Everything here is synchronous (paramiko SSH + a sync httpx push); the async driver in app.main
runs it via ``asyncio.to_thread`` so it never blocks the event loop.
"""

from __future__ import annotations

import hashlib
import json
import time

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import Server
from app.schemas.contracts import CredentialPayload
from app.services import ssh_ops
from app.services.secrets import VaultError, load_credentials

# How many trailing lines to pull per source per run. The cursor trims this down to only the
# genuinely-new lines; the window just bounds how much a single run can catch up on.
TAIL_LINES = 500

PUSH_TIMEOUT_SECONDS = 8.0

JOB_LABEL = "server-logs"

# in-memory cursor: {(server_public_id, source_key): last_shipped_line_hash}
_CURSORS: dict[tuple[str, str], str] = {}


def _line_hash(line: str) -> str:
    return hashlib.sha1(line.encode("utf-8", errors="replace")).hexdigest()


def _source_key(source: str, name_or_path: str) -> str:
    return f"{source}:{name_or_path}"


def _new_lines(server_public_id: str, source_key: str, lines: list[str]) -> list[str]:
    """Return only the lines after the remembered cursor, and advance the cursor.

    The cursor is the hash of the last line shipped last time. We locate its last occurrence in the
    freshly-tailed window and return everything after it. When it is absent (first run, or the line
    has scrolled out of the window) we ship the whole window.
    """
    key = (server_public_id, source_key)
    if not lines:
        return []
    previous = _CURSORS.get(key)
    fresh = lines
    if previous is not None:
        cut = -1
        for index in range(len(lines) - 1, -1, -1):
            if _line_hash(lines[index]) == previous:
                cut = index
                break
        if cut >= 0:
            fresh = lines[cut + 1:]
    # advance the cursor to the last line we have actually seen this run (shipped or not)
    _CURSORS[key] = _line_hash(lines[-1])
    return fresh


def build_push_payload(labels: dict[str, str], lines: list[str], base_ns: int | None = None) -> dict:
    """Construct the Loki push body for one stream: ``{"streams": [{"stream", "values"}]}``.

    Loki wants nanosecond string timestamps and, within a stream, strictly ordered entries. We
    stamp each line at ``base_ns + i`` so a batch pushed in one call keeps its order and no two
    entries collide on the same nanosecond.
    """
    start = time.time_ns() if base_ns is None else base_ns
    values = [[str(start + offset), line] for offset, line in enumerate(lines)]
    return {"streams": [{"stream": labels, "values": values}]}


def _push_to_loki(loki_url: str, payload: dict, *, client: httpx.Client | None = None) -> None:
    base = (loki_url or "").strip().rstrip("/")
    url = f"{base}/loki/api/v1/push"
    owns = client is None
    active = client or httpx.Client(timeout=PUSH_TIMEOUT_SECONDS)
    try:
        response = active.post(url, json=payload)
        response.raise_for_status()
    finally:
        if owns:
            active.close()


def _labels_for(server: Server, name_or_path: str) -> dict[str, str]:
    return {
        "server": server.hostname or server.ip_address,
        "server_id": server.public_id,
        "source": name_or_path,
        "job": JOB_LABEL,
    }


def _iter_sources(server: Server):
    try:
        parsed = json.loads(server.log_sources_json or "[]")
    except (ValueError, TypeError):
        return
    if not isinstance(parsed, list):
        return
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        source = str(entry.get("source") or "journal").strip() or "journal"
        name_or_path = str(entry.get("name_or_path") or "").strip()
        if name_or_path:
            yield source, name_or_path


def ship_once(
    db: Session,
    *,
    client: httpx.Client | None = None,
    tail_fn=None,
) -> int:
    """Tail every enabled server's configured sources once and push new lines to Loki.

    Returns the number of lines shipped. Never raises for a per-server/per-source failure -- those
    are swallowed so one unreachable host cannot stall the rest (and cannot crash the driver). A
    ``tail_fn`` override (signature ``(server, credentials, source, name_or_path, tail)``) is
    accepted so tests can inject canned log output without real SSH.
    """
    settings = get_settings()
    loki_url = (settings.loki_url or "").strip()
    if not loki_url:
        return 0
    reader = tail_fn or ssh_ops.service_logs
    servers = db.scalars(select(Server).where(Server.log_shipping_enabled.is_(True))).all()
    shipped = 0
    for server in servers:
        sources = list(_iter_sources(server))
        if not sources:
            continue
        try:
            password, private_key = load_credentials(db, server)
        except VaultError:
            continue
        if not password and not private_key:
            continue
        credentials = CredentialPayload(password=password, private_key=private_key)
        for source, name_or_path in sources:
            try:
                lines = reader(server, credentials, source, name_or_path, TAIL_LINES)
            except Exception:
                # unreachable host, bad path, auth failure -- skip this source this run
                continue
            fresh = _new_lines(server.public_id, _source_key(source, name_or_path), lines)
            if not fresh:
                continue
            payload = build_push_payload(_labels_for(server, name_or_path), fresh)
            try:
                _push_to_loki(loki_url, payload, client=client)
            except Exception:
                # Loki push failed; leave the cursor advanced (best effort, no retry storm) and
                # move on. The next run ships whatever is new from here.
                continue
            shipped += len(fresh)
    return shipped
