"""Outbound control channel to a Kong gateway: list configured routes (+ their rate-limit plugins)
via the Admin API, and RESET a route's live rate-limit counter.

Kong's `rate-limiting` plugin (policy: redis, verified against Kong 3.9.3) keeps its counters in Redis
as keys `ratelimit:<route_id>:<consumer>:<identifier>:<window_start_ms>:<window_name>`. There is no
Admin API to clear a counter, so a reset = deleting every `ratelimit:<route_id>:*` key for the route
in that Redis. Listing routes uses the Admin API (usually behind an nginx basic-auth proxy with a
self-signed cert, hence basic auth + optional TLS verification off).
"""

from __future__ import annotations

from typing import Any


class KongAdminError(RuntimeError):
    pass


_TIMEOUT = 8.0
_PERIODS = (("second", "s"), ("minute", "min"), ("hour", "hr"), ("day", "day"), ("month", "mo"), ("year", "yr"))


def _basic_auth(credentials: str):
    cred = (credentials or "").strip()
    if not cred or ":" not in cred:
        return None
    import httpx  # noqa: PLC0415

    user, _, password = cred.partition(":")
    return httpx.BasicAuth(user, password)


def _get_all(client, base: str, path: str) -> list[dict]:
    """Fetch every page of a Kong Admin collection (follows the `next` cursor)."""
    items: list[dict] = []
    url: str | None = base.rstrip("/") + path
    guard = 0
    while url and guard < 100:
        guard += 1
        resp = client.get(url)
        if resp.status_code == 401:
            raise KongAdminError("Kong Admin API rejected the credentials (401).")
        if resp.status_code >= 400:
            raise KongAdminError(f"Kong Admin API returned HTTP {resp.status_code}.")
        body = resp.json()
        items.extend(body.get("data") or [])
        nxt = body.get("next")
        url = (base.rstrip("/") + nxt) if nxt else None
    return items


def _rate_limit_summary(config: dict) -> str:
    parts = [f"{int(config[k])}/{short}" for k, short in _PERIODS if config.get(k)]
    return ", ".join(parts)


def list_routes(admin_url: str, credentials: str, verify_tls: bool) -> list[dict]:
    """Configured routes joined with their rate-limiting plugin. Each item:
    {id, name, methods, paths, hosts, service, rate_limit (summary), limit_by, policy, has_rate_limit}."""
    base = (admin_url or "").strip()
    if not base:
        raise KongAdminError("No Kong Admin API URL is configured for this gateway.")
    import httpx  # noqa: PLC0415

    try:
        with httpx.Client(timeout=_TIMEOUT, verify=bool(verify_tls), auth=_basic_auth(credentials), follow_redirects=True) as client:
            routes = _get_all(client, base, "/routes")
            plugins = _get_all(client, base, "/plugins?name=rate-limiting")
    except KongAdminError:
        raise
    except Exception as exc:  # connection, TLS, timeout, ...
        raise KongAdminError(f"Could not reach the Kong Admin API: {str(exc).splitlines()[0][:300]}") from exc

    # map route id -> its rate-limiting plugin config
    rl_by_route: dict[str, dict] = {}
    for p in plugins:
        route = p.get("route") or {}
        rid = route.get("id") if isinstance(route, dict) else None
        if rid and p.get("enabled", True):
            rl_by_route[str(rid)] = p.get("config") or {}

    out: list[dict] = []
    for r in routes:
        rid = str(r.get("id") or "")
        svc = r.get("service") or {}
        cfg = rl_by_route.get(rid)
        out.append({
            "id": rid,
            "name": str(r.get("name") or ""),
            "methods": [str(m) for m in (r.get("methods") or [])],
            "paths": [str(p) for p in (r.get("paths") or [])],
            "hosts": [str(h) for h in (r.get("hosts") or [])],
            "service": str((svc.get("name") or svc.get("id") or "")) if isinstance(svc, dict) else "",
            "has_rate_limit": cfg is not None,
            "rate_limit": _rate_limit_summary(cfg) if cfg else "",
            "limit_by": str(cfg.get("limit_by") or "") if cfg else "",
            "policy": str(cfg.get("policy") or "") if cfg else "",
        })
    # routes that HAVE a rate limit first, then by name/path
    out.sort(key=lambda x: (not x["has_rate_limit"], x["name"] or (x["paths"][0] if x["paths"] else "")))
    return out


def reset_route_counters(host: str, port: int, db: int, password: str, route_ids: list[str]) -> dict[str, int]:
    """Delete every `ratelimit:<route_id>:*` counter key in Kong's rate-limit Redis for each route id.
    Returns {route_id: number_of_keys_deleted}. Raises KongAdminError on a connection/driver problem."""
    if not (host or "").strip():
        raise KongAdminError("No rate-limit Redis is configured for this gateway.")
    try:
        import redis  # noqa: PLC0415
    except ModuleNotFoundError as exc:  # pragma: no cover
        raise KongAdminError("The redis driver is not installed on the server.") from exc

    client = redis.Redis(
        host=host.strip(), port=int(port or 6379), db=int(db or 0),
        password=password or None, socket_connect_timeout=5, socket_timeout=5,
        decode_responses=False,
    )
    deleted: dict[str, int] = {}
    try:
        for rid in route_ids:
            rid = str(rid).strip()
            if not rid:
                continue
            count = 0
            batch: list = []
            for key in client.scan_iter(match=f"ratelimit:{rid}:*", count=500):
                batch.append(key)
                if len(batch) >= 500:
                    count += int(client.delete(*batch) or 0)
                    batch = []
            if batch:
                count += int(client.delete(*batch) or 0)
            deleted[rid] = count
    except KongAdminError:
        raise
    except Exception as exc:
        raise KongAdminError(f"Could not reach the rate-limit Redis: {str(exc).splitlines()[0][:300]}") from exc
    finally:
        try:
            client.close()
        except Exception:
            pass
    return deleted


def test_admin(admin_url: str, credentials: str, verify_tls: bool) -> str:
    """Probe the Admin API (GET /) and return the Kong version. Raises KongAdminError on failure."""
    base = (admin_url or "").strip()
    if not base:
        raise KongAdminError("No Kong Admin API URL is configured.")
    import httpx  # noqa: PLC0415

    try:
        with httpx.Client(timeout=_TIMEOUT, verify=bool(verify_tls), auth=_basic_auth(credentials), follow_redirects=True) as client:
            resp = client.get(base.rstrip("/") + "/")
            if resp.status_code == 401:
                raise KongAdminError("Kong Admin API rejected the credentials (401).")
            if resp.status_code >= 400:
                raise KongAdminError(f"Kong Admin API returned HTTP {resp.status_code}.")
            return str((resp.json() or {}).get("version") or "unknown")
    except KongAdminError:
        raise
    except Exception as exc:
        raise KongAdminError(f"Could not reach the Kong Admin API: {str(exc).splitlines()[0][:300]}") from exc
