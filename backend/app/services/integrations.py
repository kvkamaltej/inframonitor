import asyncio

import httpx

from app.core.config import get_settings
from app.schemas.contracts import IntegrationStatus

PROBE_TIMEOUT_SECONDS = 2.5


def _configured_targets() -> list[tuple[str, str]]:
    settings = get_settings()
    candidates = [
        ("prometheus", settings.prometheus_url, "/-/ready"),
        ("grafana", settings.grafana_url, "/api/health"),
        ("loki", settings.loki_url, "/ready"),
        ("alertmanager", settings.alertmanager_url, "/-/ready"),
    ]
    targets: list[tuple[str, str]] = []
    for name, base_url, path in candidates:
        base = (base_url or "").strip().rstrip("/")
        if base:
            targets.append((name, f"{base}{path}"))
    return targets


async def _probe(client: httpx.AsyncClient, name: str, url: str) -> IntegrationStatus:
    try:
        response = await client.get(url)
        status = "healthy" if response.status_code < 500 else "warning"
    except (httpx.HTTPError, httpx.InvalidURL):
        status = "offline"
    return IntegrationStatus(name=name, url=url, status=status)


async def check_integrations() -> list[IntegrationStatus]:
    targets = _configured_targets()
    if not targets:
        return []
    async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_SECONDS) as client:
        return list(await asyncio.gather(*(_probe(client, name, url) for name, url in targets)))
