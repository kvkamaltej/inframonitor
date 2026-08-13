"""Local tests for the Kubernetes clusters feature (feature/kubernetes).

No real cluster is required. The CRUD path runs end to end against a temp SQLite database; the
live reads and actions monkeypatch the functions in app.services.kube to return canned dicts, so
we exercise the route serialisation and the auth wiring without ever building a real client.

Style mirrors tests/test_db_console.py: DATABASE_URL + JWT_SECRET are set before app.main imports
app.core.database (the engine is built at import time).
"""

import os
import tempfile

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_kubetest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.services import kube  # noqa: E402
from app.services.kube import KubeError  # noqa: E402


_ADMIN = {"sub": "tester@local", "role": "admin", "guest": False}


@pytest.fixture()
def client():
    from app.core.security import require_admin, require_admin_not_guest, require_user_not_guest
    from app.main import app

    app.dependency_overrides[require_admin] = lambda: _ADMIN
    app.dependency_overrides[require_admin_not_guest] = lambda: _ADMIN
    app.dependency_overrides[require_user_not_guest] = lambda: _ADMIN
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# --- CRUD ------------------------------------------------------------------------------------


def test_create_cluster_kubeconfig_mode(client):
    r = client.post("/api/kube/clusters", json={
        "name": "prod-cluster",
        "auth_method": "kubeconfig",
        "kubeconfig": "apiVersion: v1\nkind: Config\n",
        "default_namespace": "default",
        "group": "EMS",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "prod-cluster"
    assert body["auth_method"] == "kubeconfig"
    assert body["has_credentials"] is True
    assert body["group"] == "EMS"
    assert body["id"]  # a public_id was minted
    # the secret is never echoed back
    assert "kubeconfig" not in body and "token" not in body


def test_create_cluster_token_mode(client):
    r = client.post("/api/kube/clusters", json={
        "name": "token-cluster",
        "auth_method": "token",
        "api_server_url": "https://10.0.0.1:6443",
        "token": "super-secret-bearer",
        "ca_cert": "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
        "verify_tls": False,
    })
    assert r.status_code == 201
    body = r.json()
    assert body["auth_method"] == "token"
    assert body["api_server_url"] == "https://10.0.0.1:6443"
    assert body["has_credentials"] is True
    assert body["verify_tls"] is False


def test_create_persists_and_encrypts(client):
    r = client.post("/api/kube/clusters", json={
        "name": "persist-me", "auth_method": "token",
        "api_server_url": "https://h:6443", "token": "plaintext-token",
    })
    cid = r.json()["id"]

    # read straight from the DB and confirm the token is not stored in the clear
    from app.core.database import SessionLocal
    from app.core.crypto import decrypt_secret
    from app.models.entities import KubeCluster
    from sqlalchemy import select

    with SessionLocal() as db:
        row = db.scalar(select(KubeCluster).where(KubeCluster.public_id == cid))
        assert row is not None
        assert row.encrypted_token and row.encrypted_token != "plaintext-token"
        assert decrypt_secret(row.encrypted_token) == "plaintext-token"


def test_create_rejects_bad_auth_method(client):
    r = client.post("/api/kube/clusters", json={"name": "x", "auth_method": "oauth"})
    assert r.status_code == 400
    assert "auth_method" in r.json()["detail"]


def test_list_get_patch_delete(client):
    created = client.post("/api/kube/clusters", json={
        "name": "lifecycle", "auth_method": "kubeconfig", "kubeconfig": "apiVersion: v1\n",
    }).json()
    cid = created["id"]

    # list
    listing = client.get("/api/kube/clusters")
    assert listing.status_code == 200
    assert any(c["id"] == cid for c in listing.json())

    # get
    got = client.get(f"/api/kube/clusters/{cid}")
    assert got.status_code == 200 and got.json()["name"] == "lifecycle"

    # patch: rename + move group, leaving credentials untouched
    patched = client.patch(f"/api/kube/clusters/{cid}", json={"name": "renamed", "group": "BH"})
    assert patched.status_code == 200
    assert patched.json()["name"] == "renamed"
    assert patched.json()["group"] == "BH"
    assert patched.json()["has_credentials"] is True  # blank secret fields did not wipe it

    # delete
    assert client.delete(f"/api/kube/clusters/{cid}").status_code == 204
    assert client.get(f"/api/kube/clusters/{cid}").status_code == 404


def test_patch_blank_secret_keeps_credentials(client):
    created = client.post("/api/kube/clusters", json={
        "name": "keepcreds", "auth_method": "token", "api_server_url": "https://h:6443", "token": "tok",
    }).json()
    cid = created["id"]
    # a PATCH that sends an empty token must not clear the stored credential
    r = client.patch(f"/api/kube/clusters/{cid}", json={"token": "", "default_namespace": "kube-system"})
    assert r.status_code == 200
    assert r.json()["has_credentials"] is True
    assert r.json()["default_namespace"] == "kube-system"


def test_get_missing_is_404(client):
    assert client.get("/api/kube/clusters/does-not-exist").status_code == 404


# --- /test (unsaved) -------------------------------------------------------------------------


def test_test_endpoint_ok(client, monkeypatch):
    monkeypatch.setattr(kube, "test_connection", lambda conn: "v1.29.4")
    r = client.post("/api/kube/clusters/test", json={
        "name": "t", "auth_method": "token", "api_server_url": "https://h:6443", "token": "x",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["version"] == "v1.29.4"


def test_test_endpoint_failure_is_200_ok_false(client, monkeypatch):
    def boom(conn):
        raise KubeError("connection refused")

    monkeypatch.setattr(kube, "test_connection", boom)
    r = client.post("/api/kube/clusters/test", json={
        "name": "t", "auth_method": "token", "api_server_url": "https://h:6443", "token": "x",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False and "connection refused" in body["message"]


# --- live reads (monkeypatched service) ------------------------------------------------------


@pytest.fixture()
def cluster_id(client):
    return client.post("/api/kube/clusters", json={
        "name": "live", "auth_method": "token", "api_server_url": "https://h:6443", "token": "x",
    }).json()["id"]


def test_overview_route(client, cluster_id, monkeypatch):
    canned = {
        "version": "v1.29.4", "platform": "linux/amd64", "node_count": 3, "nodes_ready": 3,
        "namespace_count": 5, "pod_count": 12,
        "pods_by_phase": {"Running": 10, "Pending": 1, "Failed": 1, "Succeeded": 0, "Unknown": 0},
        "cpu_capacity": "12", "memory_capacity": "48.0 Gi", "health_ok": True, "warnings": [],
    }
    monkeypatch.setattr(kube, "overview", lambda conn: canned)
    r = client.get(f"/api/kube/clusters/{cluster_id}/overview")
    assert r.status_code == 200
    body = r.json()
    assert body["node_count"] == 3 and body["pods_by_phase"]["Running"] == 10
    assert body["memory_capacity"] == "48.0 Gi"


def test_nodes_route_and_ssh_linking(client, cluster_id, monkeypatch):
    # seed a managed Server whose IP matches the node's internal_ip
    from app.core.database import SessionLocal
    from app.models.entities import Server
    import uuid as _uuid

    with SessionLocal() as db:
        db.add(Server(
            public_id=str(_uuid.uuid4()), hostname="worker-1", alias="Worker One",
            ip_address="10.0.0.5", username="ops", environment="production",
        ))
        db.commit()

    node = {
        "name": "worker-1", "status": "Ready", "roles": ["worker"], "kubelet_version": "v1.29.4",
        "os_image": "Ubuntu 22.04", "internal_ip": "10.0.0.5", "cpu_capacity": "4",
        "memory_capacity": "16.0 Gi", "cpu_allocatable": "4", "memory_allocatable": "15.0 Gi",
        "age": "5d", "schedulable": True, "conditions": [{"type": "Ready", "status": "True"}],
        "linked_server_id": None, "linked_server_alias": None,
    }
    monkeypatch.setattr(kube, "list_nodes", lambda conn: [dict(node)])
    r = client.get(f"/api/kube/clusters/{cluster_id}/nodes")
    assert r.status_code == 200
    got = r.json()[0]
    assert got["name"] == "worker-1"
    assert got["linked_server_id"] is not None
    assert got["linked_server_alias"] == "Worker One"


def test_pods_route(client, cluster_id, monkeypatch):
    pods = [{
        "name": "api-abc", "namespace": "default", "phase": "Running", "ready": "1/1",
        "restarts": 0, "node": "worker-1", "pod_ip": "10.1.2.3", "age": "3h", "containers": ["api"],
    }]
    monkeypatch.setattr(kube, "list_pods", lambda conn, namespace: pods)
    r = client.get(f"/api/kube/clusters/{cluster_id}/pods?namespace=default")
    assert r.status_code == 200
    assert r.json()[0]["ready"] == "1/1"


def test_pod_logs_route(client, cluster_id, monkeypatch):
    monkeypatch.setattr(kube, "pod_logs", lambda conn, ns, pod, container, tail, previous: {
        "container": container, "log": "line1\nline2", "tail": tail,
    })
    r = client.get(f"/api/kube/clusters/{cluster_id}/pods/default/api-abc/logs?container=api&tail=50")
    assert r.status_code == 200
    body = r.json()
    assert body["container"] == "api" and body["tail"] == 50 and "line1" in body["log"]


def test_deployments_route(client, cluster_id, monkeypatch):
    deps = [{
        "name": "web", "namespace": "default", "ready": "2/3", "replicas": 3,
        "available": 2, "updated": 3, "age": "10d",
    }]
    monkeypatch.setattr(kube, "list_deployments", lambda conn, namespace: deps)
    r = client.get(f"/api/kube/clusters/{cluster_id}/deployments")
    assert r.status_code == 200
    assert r.json()[0]["ready"] == "2/3"


def test_health_route(client, cluster_id, monkeypatch):
    canned = {
        "livez_ok": True, "readyz_ok": True,
        "readyz": [{"name": "etcd", "ok": True}],
        "component_statuses": [{"name": "scheduler", "healthy": True, "message": "ok"}],
        "control_plane_pods": [{"name": "kube-apiserver-x", "namespace": "kube-system", "phase": "Running", "ready": True, "restarts": 0}],
        "addons": [{"name": "coredns-1", "healthy": True, "detail": "Running"}],
    }
    monkeypatch.setattr(kube, "health", lambda conn: canned)
    r = client.get(f"/api/kube/clusters/{cluster_id}/health")
    assert r.status_code == 200
    assert r.json()["livez_ok"] is True and r.json()["readyz"][0]["name"] == "etcd"


def test_events_route(client, cluster_id, monkeypatch):
    events = [{
        "type": "Warning", "reason": "BackOff", "message": "Back-off restarting",
        "object": "Pod/api-abc", "namespace": "default", "count": 4, "last_seen": "2m",
    }]
    monkeypatch.setattr(kube, "list_events", lambda conn, namespace: events)
    r = client.get(f"/api/kube/clusters/{cluster_id}/events")
    assert r.status_code == 200
    assert r.json()[0]["reason"] == "BackOff"


def test_live_read_error_is_400(client, cluster_id, monkeypatch):
    def boom(conn):
        raise KubeError("cluster unreachable")

    monkeypatch.setattr(kube, "overview", boom)
    r = client.get(f"/api/kube/clusters/{cluster_id}/overview")
    assert r.status_code == 400
    assert "unreachable" in r.json()["detail"]


# --- actions ---------------------------------------------------------------------------------


def test_restart_pod_action(client, cluster_id, monkeypatch):
    monkeypatch.setattr(kube, "restart_pod", lambda conn, ns, pod: f"Pod {ns}/{pod} restarted.")
    r = client.post(f"/api/kube/clusters/{cluster_id}/pods/default/api-abc/restart")
    assert r.status_code == 200
    assert r.json()["ok"] is True and "restarted" in r.json()["message"]


def test_delete_pod_action(client, cluster_id, monkeypatch):
    monkeypatch.setattr(kube, "delete_pod", lambda conn, ns, pod: f"Pod {ns}/{pod} deleted.")
    r = client.delete(f"/api/kube/clusters/{cluster_id}/pods/default/api-abc")
    assert r.status_code == 200
    assert "deleted" in r.json()["message"]


def test_scale_deployment_action(client, cluster_id, monkeypatch):
    captured = {}

    def fake_scale(conn, ns, name, replicas):
        captured["replicas"] = replicas
        return f"scaled to {replicas}"

    monkeypatch.setattr(kube, "scale_deployment", fake_scale)
    r = client.post(f"/api/kube/clusters/{cluster_id}/deployments/default/web/scale", json={"replicas": 5})
    assert r.status_code == 200
    assert captured["replicas"] == 5


def test_restart_deployment_action(client, cluster_id, monkeypatch):
    monkeypatch.setattr(kube, "restart_deployment", lambda conn, ns, name: "rollout restart triggered")
    r = client.post(f"/api/kube/clusters/{cluster_id}/deployments/default/web/restart")
    assert r.status_code == 200
    assert "restart" in r.json()["message"]


def test_cordon_node_action(client, cluster_id, monkeypatch):
    captured = {}

    def fake_cordon(conn, name, cordon):
        captured["cordon"] = cordon
        return f"Node {name} {'cordoned' if cordon else 'uncordoned'}."

    monkeypatch.setattr(kube, "cordon_node", fake_cordon)
    r = client.post(f"/api/kube/clusters/{cluster_id}/nodes/worker-1/cordon", json={"cordon": True})
    assert r.status_code == 200
    assert captured["cordon"] is True and "cordoned" in r.json()["message"]


def test_cordon_forbidden_surfaces_clean_message(client, cluster_id, monkeypatch):
    def boom(conn, name, cordon):
        raise KubeError("Not permitted to cordon node worker-1: this needs elevated cluster RBAC")

    monkeypatch.setattr(kube, "cordon_node", boom)
    r = client.post(f"/api/kube/clusters/{cluster_id}/nodes/worker-1/cordon", json={"cordon": True})
    assert r.status_code == 400
    assert "elevated cluster RBAC" in r.json()["detail"]
