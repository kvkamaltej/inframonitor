"""Local tests for the global SSH configs (reusable jump host / tunnel profiles) and their
reference from a server's jump host and a database connection's SSH tunnel.

No live SSH or database is required: the whole path runs end to end against a temp SQLite database,
exercising the create_all/migration wiring (ssh_configs table + ssh_config_id columns), the CRUD
routes, and that a referenced config is surfaced on the Server/DbConnection read models.

Style mirrors tests/test_db_connections.py: DATABASE_URL + JWT_SECRET are set before app.main
imports app.core.database (the engine is built at import time).
"""

import os
import tempfile

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_sshcfgtest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

_USER = {"sub": "tester@local", "role": "admin", "guest": False}


@pytest.fixture()
def client():
    from app.core.security import require_admin, require_user
    from app.main import app

    app.dependency_overrides[require_user] = lambda: _USER
    app.dependency_overrides[require_admin] = lambda: _USER
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _create(client, name="bastion-1", host="10.0.0.9", **extra):
    body = {"name": name, "host": host, "port": 2222, "username": "ops",
            "password": "s3cret", **extra}
    r = client.post("/api/ssh-configs", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_lists_and_hides_secrets(client):
    cfg = _create(client)
    assert cfg["name"] == "bastion-1"
    assert cfg["host"] == "10.0.0.9"
    assert cfg["port"] == 2222
    assert cfg["username"] == "ops"
    assert cfg["has_password"] is True
    assert cfg["has_private_key"] is False
    # no secret is ever echoed
    assert "password" not in cfg and "encrypted_password" not in cfg

    r = client.get("/api/ssh-configs")
    assert r.status_code == 200
    assert cfg["id"] in [c["id"] for c in r.json()]


def test_duplicate_name_rejected(client):
    _create(client, name="dup")
    r = client.post("/api/ssh-configs", json={"name": "dup", "host": "h", "port": 22})
    assert r.status_code == 409


def test_update_keeps_secret_when_blank(client):
    cfg = _create(client, name="upd-secret")
    r = client.patch(f"/api/ssh-configs/{cfg['id']}", json={"host": "10.0.0.10", "password": ""})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["host"] == "10.0.0.10"
    assert body["has_password"] is True  # blank kept the stored credential


def test_server_can_reference_config(client):
    cfg = _create(client, name="server-jump")
    r = client.post("/api/servers", json={
        "hostname": "app01", "ip_address": "10.1.2.3", "username": "deploy",
        "ssh_config_id": cfg["id"],
    })
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body["ssh_config_id"] == cfg["id"]
    assert body["ssh_config_name"] == "server-jump"

    # clearing the reference ("" explicitly) unlinks it
    r = client.patch(f"/api/servers/{body['id']}", json={"ssh_config_id": ""})
    assert r.status_code == 200, r.text
    assert r.json()["ssh_config_id"] == ""


def test_db_connection_can_reference_config(client):
    cfg = _create(client, name="db-tunnel")
    r = client.post("/api/db/connections", json={
        "name": "pg-behind-bastion", "engine": "postgres", "host": "db.internal",
        "port": 5432, "username": "reader", "password": "pw", "database": "app",
        "ssh_config_id": cfg["id"],
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["ssh_config_id"] == cfg["id"]
    assert body["ssh_config_name"] == "db-tunnel"


def test_referencing_unknown_config_404s(client):
    r = client.post("/api/servers", json={
        "hostname": "app02", "ip_address": "10.1.2.4", "username": "deploy",
        "ssh_config_id": "does-not-exist",
    })
    assert r.status_code == 404


def test_delete_nulls_references(client):
    cfg = _create(client, name="to-delete")
    r = client.post("/api/servers", json={
        "hostname": "app03", "ip_address": "10.1.2.5", "username": "deploy",
        "ssh_config_id": cfg["id"],
    })
    server_id = r.json()["id"]
    assert r.json()["ssh_config_id"] == cfg["id"]

    r = client.delete(f"/api/ssh-configs/{cfg['id']}")
    assert r.status_code == 204, r.text

    # the server survives with its reference cleared, not a dangling id
    r = client.get(f"/api/servers/{server_id}")
    assert r.status_code == 200
    assert r.json()["ssh_config_id"] == ""

    r = client.get("/api/ssh-configs")
    assert cfg["id"] not in [c["id"] for c in r.json()]
