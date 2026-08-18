"""Unit tests for app.services.k8s_log_shipper.

No real cluster is required: ``list_fn`` and ``logs_fn`` are injected as fakes, and the Loki push
(``_push_to_loki``) is monkeypatched to capture payloads. We assert that new lines are pushed with
the expected labels (namespace/pod/container + job=k8s-logs) and that a second run over the same
canned logs ships nothing thanks to the in-memory cursor dedup.

Style mirrors the log_shipper unit tests in tests/test_server_monitoring.py.
"""

import os
import tempfile

# must be set before importing k8s_log_shipper -> log_shipper -> app.core.database (engine built at
# import time, and get_settings() requires a JWT secret)
_TMP = tempfile.mkdtemp(prefix="inframonitor_k8slogtest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

from app.services import k8s_log_shipper  # noqa: E402


def _fake_list_fn(conn, namespace):
    # two pods, each with two containers
    return [
        {"name": "api-0", "namespace": namespace or "prod", "containers": ["app", "sidecar"]},
        {"name": "worker-0", "namespace": namespace or "prod", "containers": ["worker", "sidecar"]},
    ]


def _fake_logs_fn(conn, namespace, pod, container, tail):
    # canned multi-line text; kube.pod_logs returns {"container", "log", "tail"}
    return {"container": container, "log": f"{pod}/{container} line 1\n{pod}/{container} line 2\n", "tail": tail}


def _capture_pushes(monkeypatch):
    pushes = []

    def fake_push(loki_url, payload, *, client=None):
        pushes.append((loki_url, payload))

    monkeypatch.setattr(k8s_log_shipper, "_push_to_loki", fake_push)
    return pushes


def test_ship_cluster_once_pushes_new_lines_with_expected_labels(monkeypatch):
    k8s_log_shipper._CURSORS.clear()
    pushes = _capture_pushes(monkeypatch)

    shipped = k8s_log_shipper.ship_cluster_once(
        conn={"auth_method": "kubeconfig"},
        cluster_id="clstr-123",
        cluster_name="prod-cluster",
        namespaces=["prod"],
        loki_url="http://loki:3100",
        list_fn=_fake_list_fn,
        logs_fn=_fake_logs_fn,
    )

    # 2 pods * 2 containers * 2 lines each
    assert shipped == 8
    # one push per pod/container stream
    assert len(pushes) == 4

    for loki_url, payload in pushes:
        assert loki_url == "http://loki:3100"
        stream = payload["streams"][0]["stream"]
        assert stream["cluster"] == "prod-cluster"
        assert stream["cluster_id"] == "clstr-123"
        assert stream["namespace"] == "prod"
        assert stream["pod"] in {"api-0", "worker-0"}
        assert stream["container"] in {"app", "sidecar", "worker"}
        assert stream["job"] == "k8s-logs"
        # two values, correctly split from the canned blob
        values = payload["streams"][0]["values"]
        assert len(values) == 2
        assert values[0][1].endswith("line 1")
        assert values[1][1].endswith("line 2")


def test_second_run_dedups_via_cursor(monkeypatch):
    k8s_log_shipper._CURSORS.clear()
    pushes = _capture_pushes(monkeypatch)

    common = dict(
        conn={},
        cluster_id="clstr-123",
        cluster_name="prod-cluster",
        namespaces=["prod"],
        loki_url="http://loki:3100",
        list_fn=_fake_list_fn,
        logs_fn=_fake_logs_fn,
    )

    first = k8s_log_shipper.ship_cluster_once(**common)
    assert first == 8

    # identical canned logs -> nothing new to ship
    second = k8s_log_shipper.ship_cluster_once(**common)
    assert second == 0
    # only the first run's four pushes were made
    assert len(pushes) == 4


def test_empty_loki_url_returns_zero(monkeypatch):
    k8s_log_shipper._CURSORS.clear()
    pushes = _capture_pushes(monkeypatch)

    shipped = k8s_log_shipper.ship_cluster_once(
        conn={},
        cluster_id="c",
        cluster_name="c",
        namespaces=["prod"],
        loki_url="",
        list_fn=_fake_list_fn,
        logs_fn=_fake_logs_fn,
    )
    assert shipped == 0
    assert pushes == []


def test_pod_without_containers_falls_back_to_empty_container(monkeypatch):
    k8s_log_shipper._CURSORS.clear()
    pushes = _capture_pushes(monkeypatch)

    def list_no_containers(conn, namespace):
        return [{"name": "lonely-0", "namespace": "prod", "containers": []}]

    calls = []

    def logs_fn(conn, namespace, pod, container, tail):
        calls.append((pod, container))
        return {"container": container, "log": "only line\n", "tail": tail}

    shipped = k8s_log_shipper.ship_cluster_once(
        conn={},
        cluster_id="c",
        cluster_name="c",
        namespaces=["prod"],
        loki_url="http://loki:3100",
        list_fn=list_no_containers,
        logs_fn=logs_fn,
    )

    assert shipped == 1
    # fell back to a single container="" call
    assert calls == [("lonely-0", "")]
    assert pushes[0][1]["streams"][0]["stream"]["container"] == ""


def test_all_namespaces_when_empty_list(monkeypatch):
    k8s_log_shipper._CURSORS.clear()
    _capture_pushes(monkeypatch)

    seen_ns = []

    def list_fn(conn, namespace):
        seen_ns.append(namespace)
        return [{"name": "p-0", "namespace": "kube-system", "containers": ["c"]}]

    k8s_log_shipper.ship_cluster_once(
        conn={},
        cluster_id="c",
        cluster_name="c",
        namespaces=[],
        loki_url="http://loki:3100",
        list_fn=list_fn,
        logs_fn=_fake_logs_fn,
    )
    # empty namespaces -> all-namespaces call with ""
    assert seen_ns == [""]


def test_bad_pod_does_not_stop_sweep(monkeypatch):
    k8s_log_shipper._CURSORS.clear()
    pushes = _capture_pushes(monkeypatch)

    def logs_fn(conn, namespace, pod, container, tail):
        if pod == "api-0":
            raise RuntimeError("pod terminated")
        return {"container": container, "log": "line 1\n", "tail": tail}

    shipped = k8s_log_shipper.ship_cluster_once(
        conn={},
        cluster_id="c",
        cluster_name="c",
        namespaces=["prod"],
        loki_url="http://loki:3100",
        list_fn=_fake_list_fn,
        logs_fn=logs_fn,
    )

    # api-0's two containers raised; worker-0's two containers each shipped one line
    assert shipped == 2
    assert len(pushes) == 2
