"""Tests for per-server monitoring ingestion (node_exporter install + Loki log shipping).

No real SSH and no real Loki/Prometheus: node_exporter.install/uninstall, the SSH log reader, and
the httpx push are all monkeypatched. Style mirrors tests/test_monitoring.py -- DATABASE_URL +
JWT_SECRET are set before app.main imports app.core.database (the engine is built at import time).

Coverage:
  * the four new Server columns persist and echo on ServerRead / the state endpoint
  * install-metrics sets metrics_enabled and calls the installer; uninstall clears it
  * the http_sd endpoint returns only metrics_enabled servers in the right shape + bearer auth
  * log-shipping PUT stores sources and the state endpoint reads them back
  * unit: the http_sd JSON shape and the log_shipper Loki push payload (labels + ns timestamps)
"""

import os
import tempfile

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_smtest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.core.crypto import encrypt_secret  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.models.entities import Server  # noqa: E402


_ADMIN = {"sub": "admin@local", "role": "admin", "guest": False}


@pytest.fixture()
def client():
    from app.core.security import require_admin, require_user
    from app.main import app

    app.dependency_overrides[require_user] = lambda: _ADMIN
    app.dependency_overrides[require_admin] = lambda: _ADMIN
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _make_server(**overrides) -> str:
    import uuid

    with SessionLocal() as db:
        server = Server(
            public_id=str(uuid.uuid4()),
            hostname=overrides.get("hostname", "web01"),
            ip_address=overrides.get("ip_address", "10.0.0.5"),
            ssh_port=22,
            username="ops",
            environment=overrides.get("environment", "production"),
            # a real Fernet-encrypted credential so _credentials_for can decrypt it in the route
            encrypted_password=overrides.get("encrypted_password", encrypt_secret("secret-pw")),
        )
        for key, value in overrides.items():
            setattr(server, key, value)
        db.add(server)
        db.commit()
        return server.public_id


def _get_server(public_id: str) -> Server:
    with SessionLocal() as db:
        return db.scalar(
            __import__("sqlalchemy").select(Server).where(Server.public_id == public_id)
        )


# --- columns persist + echo -----------------------------------------------------------------


def test_new_columns_default_and_echo_on_serverread(client):
    public_id = _make_server()
    r = client.get(f"/api/servers/{public_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["metrics_enabled"] is False
    assert body["node_exporter_port"] == 9100
    assert body["log_shipping_enabled"] is False
    assert body["log_sources"] == []


# --- install / uninstall metrics ------------------------------------------------------------


def test_install_metrics_sets_flag_and_calls_installer(client, monkeypatch):
    public_id = _make_server()
    from app.services import node_exporter

    called = {}

    def fake_install(server, credentials, sudo_password="", **kwargs):
        called["server"] = server.public_id
        called["sudo"] = sudo_password
        return True, "node_exporter 1.8.2 installed and listening on :9100"

    monkeypatch.setattr(node_exporter, "install", fake_install)

    r = client.post(f"/api/servers/{public_id}/monitoring/install-metrics", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "installed" in body["message"]
    assert called["server"] == public_id
    # DB flag flipped
    assert _get_server(public_id).metrics_enabled is True


def test_install_metrics_needs_sudo_password(client, monkeypatch):
    public_id = _make_server()
    from app.services import node_exporter
    from app.services.ssh_ops import SudoPasswordRequired

    def fake_install(server, credentials, sudo_password="", **kwargs):
        raise SudoPasswordRequired("Sudo password required")

    monkeypatch.setattr(node_exporter, "install", fake_install)

    r = client.post(f"/api/servers/{public_id}/monitoring/install-metrics", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert body["needs_sudo_password"] is True
    # flag must NOT have been set
    assert _get_server(public_id).metrics_enabled is False


def test_uninstall_metrics_clears_flag(client, monkeypatch):
    public_id = _make_server(metrics_enabled=True)
    from app.services import node_exporter

    monkeypatch.setattr(node_exporter, "uninstall", lambda s, c, sudo_password="", **k: (True, "node_exporter removed"))

    r = client.post(f"/api/servers/{public_id}/monitoring/uninstall-metrics", json={})
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert _get_server(public_id).metrics_enabled is False


# --- http_sd target list --------------------------------------------------------------------


def test_prometheus_targets_returns_only_enabled_in_correct_shape(client):
    enabled = _make_server(hostname="metrics-on", ip_address="10.1.1.1", environment="qa", metrics_enabled=True, node_exporter_port=9101)
    _make_server(hostname="metrics-off", ip_address="10.1.1.2", metrics_enabled=False)

    r = client.get("/api/monitoring/prometheus/targets")
    assert r.status_code == 200
    body = r.json()
    entries = [e for e in body if e["labels"]["server_id"] == enabled]
    assert len(entries) == 1
    entry = entries[0]
    assert entry["targets"] == ["10.1.1.1:9101"]
    assert entry["labels"] == {"server": "metrics-on", "server_id": enabled, "env": "qa", "job": "node"}
    # the disabled server must not appear
    assert all(e["labels"]["server"] != "metrics-off" for e in body)


def test_prometheus_targets_enforces_bearer_token(client, monkeypatch):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "monitoring_sd_token", "s3cr3t", raising=False)

    # missing token -> 401
    assert client.get("/api/monitoring/prometheus/targets").status_code == 401
    # wrong token -> 401
    assert client.get(
        "/api/monitoring/prometheus/targets", headers={"Authorization": "Bearer nope"}
    ).status_code == 401
    # correct token -> 200
    assert client.get(
        "/api/monitoring/prometheus/targets", headers={"Authorization": "Bearer s3cr3t"}
    ).status_code == 200


# --- log shipping config --------------------------------------------------------------------


def test_log_shipping_put_stores_sources_and_state_reads_them_back(client):
    public_id = _make_server()
    payload = {
        "enabled": True,
        "sources": [
            {"source": "journal", "name_or_path": "nginx"},
            {"source": "file", "name_or_path": "/var/log/app/app.log"},
        ],
    }
    r = client.put(f"/api/servers/{public_id}/monitoring/log-shipping", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["log_shipping_enabled"] is True
    assert len(body["log_sources"]) == 2

    # state endpoint reflects the stored config
    state = client.get(f"/api/servers/{public_id}/monitoring").json()
    assert state["log_shipping_enabled"] is True
    names = {s["name_or_path"] for s in state["log_sources"]}
    assert names == {"nginx", "/var/log/app/app.log"}


def test_monitoring_state_scraped_false_without_prometheus(client):
    public_id = _make_server(metrics_enabled=True)
    # prometheus_url unset by default -> prometheus_query raises MonitoringError -> scraped False
    state = client.get(f"/api/servers/{public_id}/monitoring").json()
    assert state["metrics_enabled"] is True
    assert state["scraped"] is False


# --- unit: log_shipper push payload ---------------------------------------------------------


def test_build_push_payload_labels_and_ns_timestamps():
    from app.services import log_shipper

    labels = {"server": "web01", "server_id": "abc", "source": "nginx", "job": "server-logs"}
    payload = log_shipper.build_push_payload(labels, ["line a", "line b"], base_ns=1000)
    assert payload["streams"][0]["stream"] == labels
    values = payload["streams"][0]["values"]
    assert values == [["1000", "line a"], ["1001", "line b"]]
    # timestamps are strings (Loki requirement) and strictly increasing
    assert all(isinstance(ts, str) for ts, _ in values)
    assert int(values[1][0]) > int(values[0][0])


def test_ship_once_pushes_new_lines_with_fake_httpx(monkeypatch):
    import sqlalchemy

    from app.services import log_shipper

    # isolate: this shared-file DB may hold log-shipping-enabled servers from earlier tests, so
    # disable them all first and enable only the one under test
    with SessionLocal() as db:
        db.execute(sqlalchemy.update(Server).values(log_shipping_enabled=False))
        db.commit()

    public_id = _make_server(hostname="loghost", log_shipping_enabled=True, log_sources_json='[{"source": "journal", "name_or_path": "nginx"}]')

    # force a Loki URL so ship_once proceeds
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "loki_url", "http://loki:3100", raising=False)
    monkeypatch.setattr(log_shipper, "get_settings", lambda: settings)

    # credentials load: bypass real secrets by patching load_credentials
    monkeypatch.setattr(log_shipper, "load_credentials", lambda db, server: ("pw", ""))

    # fake SSH tail reader
    def fake_reader(server, credentials, source, name_or_path, tail):
        return ["log line 1", "log line 2"]

    # fake httpx client capturing the push
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

    class FakeClient:
        def post(self, url, json):
            captured["url"] = url
            captured["json"] = json
            return FakeResponse()

    # reset cursor for a clean assertion
    log_shipper._CURSORS.clear()

    with SessionLocal() as db:
        shipped = log_shipper.ship_once(db, client=FakeClient(), tail_fn=fake_reader)

    assert shipped == 2
    assert captured["url"] == "http://loki:3100/loki/api/v1/push"
    stream = captured["json"]["streams"][0]
    assert stream["stream"] == {"server": "loghost", "server_id": public_id, "source": "nginx", "job": "server-logs"}
    assert [v[1] for v in stream["values"]] == ["log line 1", "log line 2"]

    # a second run with the same lines ships nothing (cursor dedupe)
    with SessionLocal() as db:
        shipped2 = log_shipper.ship_once(db, client=FakeClient(), tail_fn=fake_reader)
    assert shipped2 == 0
