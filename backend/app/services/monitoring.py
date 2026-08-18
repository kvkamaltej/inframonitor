"""Server-side query proxies for the observability stack (full profile only).

Each function calls the CONFIGURED upstream (prometheus_url / loki_url / alertmanager_url from
settings) and never a caller-supplied host: the base URL is fixed, only query params and label
names vary, so these proxies are not an SSRF vector. The app's own UI hits these routes to show
metrics, logs and alerts without exposing the compose-network services to the browser.

Every function raises MonitoringError with a clean, user-facing message when the relevant *_url
setting is empty ("... is not configured -- full profile only") or when the upstream call fails.
The upstream JSON is returned as-is so the frontend can speak the native Prometheus/Loki/
Alertmanager response shapes.
"""

import httpx

from app.core.config import get_settings

# Short timeout: these are interactive UI calls, not batch jobs. A slow/unreachable upstream
# should surface as a clean 502 quickly rather than hang the request.
QUERY_TIMEOUT_SECONDS = 8.0


class MonitoringError(Exception):
    """Raised for a missing upstream URL or any upstream/transport failure. The message is
    safe to show to the user (no internal URLs or stack detail)."""


def _base(url: str, name: str) -> str:
    base = (url or "").strip().rstrip("/")
    if not base:
        raise MonitoringError(f"{name} is not configured -- full profile only")
    return base


async def _get_json(url: str, params: dict | None, upstream: str):
    try:
        async with httpx.AsyncClient(timeout=QUERY_TIMEOUT_SECONDS) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            return response.json()
    except httpx.HTTPStatusError as exc:
        raise MonitoringError(
            f"{upstream} returned HTTP {exc.response.status_code}"
        ) from exc
    except (httpx.HTTPError, httpx.InvalidURL, ValueError) as exc:
        raise MonitoringError(f"{upstream} is unreachable or returned an invalid response") from exc


# --- Prometheus -----------------------------------------------------------------------------


async def prometheus_query(query: str) -> dict:
    base = _base(get_settings().prometheus_url, "Prometheus")
    return await _get_json(f"{base}/api/v1/query", {"query": query}, "Prometheus")


async def prometheus_query_range(query: str, start: str, end: str, step: str) -> dict:
    base = _base(get_settings().prometheus_url, "Prometheus")
    params = {"query": query, "start": start, "end": end, "step": step}
    return await _get_json(f"{base}/api/v1/query_range", params, "Prometheus")


# --- Loki -----------------------------------------------------------------------------------


async def loki_query_range(query: str, start: str, end: str, limit: int, direction: str) -> dict:
    base = _base(get_settings().loki_url, "Loki")
    params = {"query": query, "start": start, "end": end, "limit": limit, "direction": direction}
    return await _get_json(f"{base}/loki/api/v1/query_range", params, "Loki")


async def loki_labels() -> dict:
    base = _base(get_settings().loki_url, "Loki")
    return await _get_json(f"{base}/loki/api/v1/labels", None, "Loki")


async def loki_label_values(name: str) -> dict:
    base = _base(get_settings().loki_url, "Loki")
    return await _get_json(f"{base}/loki/api/v1/label/{name}/values", None, "Loki")


# --- Alertmanager ---------------------------------------------------------------------------


async def alertmanager_alerts() -> list:
    base = _base(get_settings().alertmanager_url, "Alertmanager")
    return await _get_json(f"{base}/api/v2/alerts", None, "Alertmanager")


# --- capability probe -----------------------------------------------------------------------


def configured() -> dict:
    """Which upstreams are wired up, plus the Grafana base URL so the UI can offer an
    "open in Grafana" link. No network calls -- purely reads settings."""
    settings = get_settings()
    return {
        "prometheus": bool((settings.prometheus_url or "").strip()),
        "loki": bool((settings.loki_url or "").strip()),
        "alertmanager": bool((settings.alertmanager_url or "").strip()),
        "grafana_url": (settings.grafana_url or "").strip(),
    }
