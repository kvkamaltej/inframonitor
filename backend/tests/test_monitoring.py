"""Local tests for the monitoring proxy routes (Prometheus / Loki / Alertmanager).

No live upstream is required: the app.services.monitoring proxy functions are monkeypatched to
return canned data (or raise MonitoringError), so the route wiring, the guest-allowed auth, the
/monitoring/enabled capability probe, and the MonitoringError -> 502 mapping are all exercised
without a real Prometheus/Loki/Alertmanager.

Style mirrors tests/test_db_connections.py: DATABASE_URL + JWT_SECRET are set before app.main
imports app.core.database (the engine is built at import time).
"""

import os
import tempfile
from types import SimpleNamespace

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_montest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.services import monitoring  # noqa: E402
from app.services.monitoring import MonitoringError  # noqa: E402


_USER = {"sub": "tester@local", "role": "admin", "guest": False}
_GUEST = {"sub": "guest@localhost", "role": "admin", "guest": True}


@pytest.fixture()
def client():
    from app.core.security import require_user
    from app.main import app

    app.dependency_overrides[require_user] = lambda: _USER
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture()
def guest_client():
    from app.core.security import require_user
    from app.main import app

    app.dependency_overrides[require_user] = lambda: _GUEST
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# --- /monitoring/enabled --------------------------------------------------------------------


def _fake_settings(prometheus="", loki="", alertmanager="", grafana=""):
    return SimpleNamespace(
        prometheus_url=prometheus, loki_url=loki, alertmanager_url=alertmanager, grafana_url=grafana
    )


def test_enabled_all_off_by_default(client, monkeypatch):
    monkeypatch.setattr(monitoring, "get_settings", lambda: _fake_settings())
    r = client.get("/api/monitoring/enabled")
    assert r.status_code == 200
    body = r.json()
    assert body == {"prometheus": False, "loki": False, "alertmanager": False, "grafana_url": ""}


def test_enabled_reflects_configured_urls(client, monkeypatch):
    monkeypatch.setattr(
        monitoring,
        "get_settings",
        lambda: _fake_settings(
            prometheus="http://prometheus:9090",
            loki="http://loki:3100",
            grafana="http://grafana:3000",
        ),
    )
    r = client.get("/api/monitoring/enabled")
    assert r.status_code == 200
    body = r.json()
    assert body["prometheus"] is True
    assert body["loki"] is True
    assert body["alertmanager"] is False  # not set
    assert body["grafana_url"] == "http://grafana:3000"


def test_enabled_allowed_for_guest(guest_client, monkeypatch):
    monkeypatch.setattr(monitoring, "get_settings", lambda: _fake_settings())
    assert guest_client.get("/api/monitoring/enabled").status_code == 200


# --- prometheus -----------------------------------------------------------------------------


def test_prometheus_query_proxies(client, monkeypatch):
    captured = {}

    async def fake(query):
        captured["query"] = query
        return {"status": "success", "data": {"resultType": "vector", "result": []}}

    monkeypatch.setattr(monitoring, "prometheus_query", fake)
    r = client.get("/api/monitoring/prometheus/query", params={"query": "up"})
    assert r.status_code == 200
    assert r.json()["status"] == "success"
    assert captured["query"] == "up"


def test_prometheus_query_range_proxies(client, monkeypatch):
    captured = {}

    async def fake(query, start, end, step):
        captured.update(query=query, start=start, end=end, step=step)
        return {"status": "success", "data": {"resultType": "matrix", "result": []}}

    monkeypatch.setattr(monitoring, "prometheus_query_range", fake)
    r = client.get(
        "/api/monitoring/prometheus/query_range",
        params={"query": "up", "start": "1", "end": "2", "step": "15s"},
    )
    assert r.status_code == 200
    assert captured == {"query": "up", "start": "1", "end": "2", "step": "15s"}


def test_prometheus_error_maps_to_502(client, monkeypatch):
    async def boom(query):
        raise MonitoringError("Prometheus is not configured -- full profile only")

    monkeypatch.setattr(monitoring, "prometheus_query", boom)
    r = client.get("/api/monitoring/prometheus/query", params={"query": "up"})
    assert r.status_code == 502
    assert "not configured" in r.json()["detail"]


# --- loki -----------------------------------------------------------------------------------


def test_loki_query_range_proxies_and_defaults(client, monkeypatch):
    captured = {}

    async def fake(query, start, end, limit, direction):
        captured.update(query=query, start=start, end=end, limit=limit, direction=direction)
        return {"status": "success", "data": {"resultType": "streams", "result": []}}

    monkeypatch.setattr(monitoring, "loki_query_range", fake)
    r = client.get(
        "/api/monitoring/loki/query_range",
        params={"query": '{job="app"}', "start": "1", "end": "2"},
    )
    assert r.status_code == 200
    assert captured["limit"] == 1000  # default, parsed to int
    assert captured["direction"] == "backward"  # default


def test_loki_query_range_bad_limit_is_400(client, monkeypatch):
    async def fake(query, start, end, limit, direction):
        return {}

    monkeypatch.setattr(monitoring, "loki_query_range", fake)
    r = client.get(
        "/api/monitoring/loki/query_range",
        params={"query": "{}", "start": "1", "end": "2", "limit": "notanint"},
    )
    assert r.status_code == 400
    assert "limit" in r.json()["detail"]


def test_loki_labels_proxies(client, monkeypatch):
    async def fake():
        return {"status": "success", "data": ["job", "instance"]}

    monkeypatch.setattr(monitoring, "loki_labels", fake)
    r = client.get("/api/monitoring/loki/labels")
    assert r.status_code == 200
    assert r.json()["data"] == ["job", "instance"]


def test_loki_label_values_proxies(client, monkeypatch):
    captured = {}

    async def fake(name):
        captured["name"] = name
        return {"status": "success", "data": ["app", "web"]}

    monkeypatch.setattr(monitoring, "loki_label_values", fake)
    r = client.get("/api/monitoring/loki/label/job/values")
    assert r.status_code == 200
    assert captured["name"] == "job"
    assert r.json()["data"] == ["app", "web"]


def test_loki_error_maps_to_502(client, monkeypatch):
    async def boom():
        raise MonitoringError("Loki is unreachable or returned an invalid response")

    monkeypatch.setattr(monitoring, "loki_labels", boom)
    r = client.get("/api/monitoring/loki/labels")
    assert r.status_code == 502
    assert "Loki" in r.json()["detail"]


# --- alertmanager ---------------------------------------------------------------------------


def test_alerts_proxies_list(client, monkeypatch):
    canned = [{"labels": {"alertname": "HighCPU"}, "status": {"state": "active"}}]

    async def fake():
        return canned

    monkeypatch.setattr(monitoring, "alertmanager_alerts", fake)
    r = client.get("/api/monitoring/alerts")
    assert r.status_code == 200
    assert r.json()[0]["labels"]["alertname"] == "HighCPU"


def test_alerts_allowed_for_guest(guest_client, monkeypatch):
    async def fake():
        return []

    monkeypatch.setattr(monitoring, "alertmanager_alerts", fake)
    assert guest_client.get("/api/monitoring/alerts").status_code == 200


def test_alerts_error_maps_to_502(client, monkeypatch):
    async def boom():
        raise MonitoringError("Alertmanager is not configured -- full profile only")

    monkeypatch.setattr(monitoring, "alertmanager_alerts", boom)
    r = client.get("/api/monitoring/alerts")
    assert r.status_code == 502
    assert "Alertmanager" in r.json()["detail"]


# --- service-level: missing URL raises MonitoringError -------------------------------------


def test_service_raises_when_unconfigured(monkeypatch):
    import asyncio

    monkeypatch.setattr(monitoring, "get_settings", lambda: _fake_settings())
    with pytest.raises(MonitoringError) as exc:
        asyncio.run(monitoring.prometheus_query("up"))
    assert "not configured" in str(exc.value)
