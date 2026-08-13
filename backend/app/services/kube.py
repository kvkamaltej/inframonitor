"""Kubernetes cluster access (feature/kubernetes).

Builds a short-lived client from a saved cluster's credentials (a full kubeconfig YAML, or an
api-server URL + bearer token + optional CA), runs a single read or action, and tears the client
down. Nothing here is long-lived: every call opens its own client with an 8-second per-request
timeout so an unreachable or misbehaving cluster can never hang the API.

Style mirrors app.services.db_console: the heavy driver (the `kubernetes` client) and PyYAML are
imported LAZILY inside functions so importing this module never requires them, a single KubeError
carries a message safe to show the operator, and `_clean` collapses the client's noisy exceptions
(especially kubernetes.client.rest.ApiException) to one meaningful line.
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
from datetime import datetime, timezone
from typing import Any, Iterator

REQUEST_TIMEOUT_SECONDS = 8

# Control-plane / addon components reported by /health, matched by name prefix against the pods in
# kube-system. control-plane vs addon is a display split only.
_CONTROL_PLANE_PREFIXES = ("kube-apiserver", "etcd", "kube-scheduler", "kube-controller-manager")
_ADDON_PREFIXES = ("coredns", "kube-proxy", "metrics-server")


class KubeError(Exception):
    """A connection or API failure with a message safe to show the operator."""


def _clean(exc: Exception) -> str:
    """Collapse a client exception to a single short, safe line.

    For an ApiException, prefer the JSON `message` from the response body, then the HTTP reason;
    for everything else, the first non-empty line of str(exc). Capped so a giant body cannot flood
    the response.
    """
    text = ""
    # Import lazily: this module must import even when the kubernetes client is absent.
    try:
        from kubernetes.client.rest import ApiException  # type: ignore
    except Exception:
        ApiException = ()  # type: ignore

    if ApiException and isinstance(exc, ApiException):  # type: ignore[arg-type]
        body = getattr(exc, "body", None)
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8", "replace")
        if body:
            try:
                parsed = json.loads(body)
                if isinstance(parsed, dict):
                    text = str(parsed.get("message") or "")
            except Exception:
                text = ""
        if not text:
            text = str(getattr(exc, "reason", "") or "")
        status = getattr(exc, "status", None)
        if not text and status:
            text = f"HTTP {status}"
    if not text:
        text = str(exc).strip()
    if not text:
        text = exc.__class__.__name__
    first = next((line.strip() for line in text.splitlines() if line.strip()), text)
    return first[:500]


def _is_forbidden(exc: Exception) -> bool:
    try:
        from kubernetes.client.rest import ApiException  # type: ignore
    except Exception:
        return False
    return isinstance(exc, ApiException) and getattr(exc, "status", None) in (401, 403)


# --- client construction -------------------------------------------------------------------


@contextlib.contextmanager
def _api_client(conn: dict) -> Iterator[Any]:
    """Yield a configured kubernetes ApiClient for `conn`, cleaning it (and any temp CA file) up.

    conn keys: auth_method ("kubeconfig"|"token"), api_server_url, kubeconfig, token, ca_cert,
    verify_tls.
    """
    try:
        from kubernetes import client, config  # type: ignore
        import yaml  # type: ignore
    except Exception as exc:  # kubernetes client not installed
        raise KubeError(f"Kubernetes client is not available: {_clean(exc)}") from exc

    ca_path: str | None = None
    api_client = None
    try:
        cfg = client.Configuration()
        auth_method = (conn.get("auth_method") or "kubeconfig").strip().lower()
        if auth_method == "kubeconfig":
            raw = conn.get("kubeconfig") or ""
            if not raw.strip():
                raise KubeError("No kubeconfig is stored for this cluster.")
            try:
                loaded = yaml.safe_load(raw)
            except Exception as exc:
                raise KubeError(f"Could not parse kubeconfig YAML: {_clean(exc)}") from exc
            if not isinstance(loaded, dict):
                raise KubeError("kubeconfig is not a valid YAML document.")
            try:
                config.load_kube_config_from_dict(loaded, client_configuration=cfg)
            except Exception as exc:
                raise KubeError(f"Invalid kubeconfig: {_clean(exc)}") from exc
        else:  # token
            host = (conn.get("api_server_url") or "").strip()
            token = conn.get("token") or ""
            if not host:
                raise KubeError("API server URL is required for token authentication.")
            if not token.strip():
                raise KubeError("A bearer token is required for token authentication.")
            cfg.host = host
            cfg.api_key = {"authorization": "Bearer " + token}
            cfg.verify_ssl = bool(conn.get("verify_tls", True))
            ca_cert = conn.get("ca_cert") or ""
            if ca_cert.strip():
                # The client reads the CA from a file path, so materialise the PEM to a temp file
                # kept for the client's lifetime and removed in the finally below.
                fd, ca_path = tempfile.mkstemp(prefix="kube_ca_", suffix=".pem")
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(ca_cert)
                cfg.ssl_ca_cert = ca_path
            elif not cfg.verify_ssl:
                # No CA and verification off: silence the client's per-request InsecureRequestWarning.
                with contextlib.suppress(Exception):
                    import urllib3  # type: ignore

                    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

        api_client = client.ApiClient(cfg)
        yield api_client
    finally:
        if api_client is not None:
            with contextlib.suppress(Exception):
                api_client.close()
        if ca_path:
            with contextlib.suppress(Exception):
                os.remove(ca_path)


# --- helpers ---------------------------------------------------------------------------------


def _age(created: datetime | None) -> str:
    """Compact age string ("5d" / "3h" / "12m" / "8s") from a creation timestamp to now."""
    if not created:
        return ""
    now = datetime.now(timezone.utc)
    ts = created
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    seconds = int((now - ts).total_seconds())
    if seconds < 0:
        seconds = 0
    if seconds >= 86400:
        return f"{seconds // 86400}d"
    if seconds >= 3600:
        return f"{seconds // 3600}h"
    if seconds >= 60:
        return f"{seconds // 60}m"
    return f"{seconds}s"


_MEM_UNITS = (
    ("Ki", 1024), ("Mi", 1024 ** 2), ("Gi", 1024 ** 3), ("Ti", 1024 ** 4), ("Pi", 1024 ** 5),
    ("K", 1000), ("M", 1000 ** 2), ("G", 1000 ** 3), ("T", 1000 ** 4),
)


def _parse_cpu_cores(quantity: Any) -> float:
    q = str(quantity or "").strip()
    if not q:
        return 0.0
    try:
        if q.endswith("m"):
            return float(q[:-1]) / 1000.0
        if q.endswith("n"):
            return float(q[:-1]) / 1e9
        if q.endswith("u"):
            return float(q[:-1]) / 1e6
        return float(q)
    except (TypeError, ValueError):
        return 0.0


def _parse_mem_bytes(quantity: Any) -> int:
    q = str(quantity or "").strip()
    if not q:
        return 0
    for unit, mult in _MEM_UNITS:
        if q.endswith(unit):
            try:
                return int(float(q[: -len(unit)]) * mult)
            except (TypeError, ValueError):
                return 0
    try:
        return int(float(q))
    except (TypeError, ValueError):
        return 0


def _fmt_mem(nbytes: int) -> str:
    if nbytes <= 0:
        return ""
    gi = nbytes / (1024 ** 3)
    if gi >= 1:
        return f"{gi:.1f} Gi"
    mi = nbytes / (1024 ** 2)
    return f"{mi:.0f} Mi"


def _node_ready(node: Any) -> tuple[str, list[dict]]:
    conditions: list[dict] = []
    ready = "NotReady"
    for cond in (getattr(node.status, "conditions", None) or []):
        conditions.append({"type": str(cond.type), "status": str(cond.status)})
        if cond.type == "Ready":
            ready = "Ready" if str(cond.status) == "True" else "NotReady"
    return ready, conditions


def _node_roles(node: Any) -> list[str]:
    roles: list[str] = []
    labels = (getattr(node.metadata, "labels", None) or {})
    for key, value in labels.items():
        if key.startswith("node-role.kubernetes.io/"):
            role = key.split("/", 1)[1]
            if role and role not in roles:
                roles.append(role)
        elif key == "kubernetes.io/role" and value and value not in roles:
            roles.append(value)
    return roles


def _node_internal_ip(node: Any) -> str:
    for addr in (getattr(node.status, "addresses", None) or []):
        if addr.type == "InternalIP":
            return str(addr.address or "")
    return ""


def _node_dict(node: Any) -> dict:
    status, conditions = _node_ready(node)
    capacity = getattr(node.status, "capacity", None) or {}
    allocatable = getattr(node.status, "allocatable", None) or {}
    info = getattr(node.status, "node_info", None)
    return {
        "name": str(node.metadata.name),
        "status": status,
        "roles": _node_roles(node),
        "kubelet_version": str(getattr(info, "kubelet_version", "") or ""),
        "os_image": str(getattr(info, "os_image", "") or ""),
        "internal_ip": _node_internal_ip(node),
        "cpu_capacity": str(capacity.get("cpu", "") or ""),
        "memory_capacity": _fmt_mem(_parse_mem_bytes(capacity.get("memory"))),
        "cpu_allocatable": str(allocatable.get("cpu", "") or ""),
        "memory_allocatable": _fmt_mem(_parse_mem_bytes(allocatable.get("memory"))),
        "age": _age(getattr(node.metadata, "creation_timestamp", None)),
        "schedulable": not bool(getattr(node.spec, "unschedulable", False)),
        "conditions": conditions,
        "linked_server_id": None,
        "linked_server_alias": None,
    }


def _pod_dict(pod: Any) -> dict:
    statuses = getattr(pod.status, "container_statuses", None) or []
    ready_count = sum(1 for cs in statuses if getattr(cs, "ready", False))
    restarts = sum(int(getattr(cs, "restart_count", 0) or 0) for cs in statuses)
    total = len(getattr(pod.spec, "containers", None) or []) or len(statuses)
    return {
        "name": str(pod.metadata.name),
        "namespace": str(getattr(pod.metadata, "namespace", "") or ""),
        "phase": str(getattr(pod.status, "phase", "") or ""),
        "ready": f"{ready_count}/{total}",
        "restarts": restarts,
        "node": str(getattr(pod.spec, "node_name", "") or ""),
        "pod_ip": str(getattr(pod.status, "pod_ip", "") or ""),
        "age": _age(getattr(pod.metadata, "creation_timestamp", None)),
        "containers": [str(c.name) for c in (getattr(pod.spec, "containers", None) or [])],
    }


def _deployment_dict(dep: Any) -> dict:
    spec = getattr(dep, "spec", None)
    dstatus = getattr(dep, "status", None)
    desired = int(getattr(spec, "replicas", 0) or 0)
    ready = int(getattr(dstatus, "ready_replicas", 0) or 0)
    available = int(getattr(dstatus, "available_replicas", 0) or 0)
    updated = int(getattr(dstatus, "updated_replicas", 0) or 0)
    return {
        "name": str(dep.metadata.name),
        "namespace": str(getattr(dep.metadata, "namespace", "") or ""),
        "ready": f"{ready}/{desired}",
        "replicas": desired,
        "available": available,
        "updated": updated,
        "age": _age(getattr(dep.metadata, "creation_timestamp", None)),
    }


def _event_dict(ev: Any) -> dict:
    obj = getattr(ev, "involved_object", None)
    obj_name = ""
    if obj is not None:
        kind = str(getattr(obj, "kind", "") or "")
        name = str(getattr(obj, "name", "") or "")
        obj_name = f"{kind}/{name}".strip("/")
    last = getattr(ev, "last_timestamp", None) or getattr(ev, "event_time", None)
    return {
        "type": str(getattr(ev, "type", "") or ""),
        "reason": str(getattr(ev, "reason", "") or ""),
        "message": str(getattr(ev, "message", "") or ""),
        "object": obj_name,
        "namespace": str(getattr(ev.metadata, "namespace", "") or ""),
        "count": int(getattr(ev, "count", 0) or 0),
        "last_seen": _age(last),
    }


def _probe(api_client: Any, path: str, query_params: list | None = None) -> tuple[int, str]:
    """Raw GET against an endpoint that returns plain text (livez/readyz). Returns (status, text)."""
    from kubernetes.client.rest import ApiException  # type: ignore

    try:
        resp = api_client.call_api(
            path,
            "GET",
            query_params=query_params or [],
            response_type=None,
            auth_settings=["BearerToken"],
            _preload_content=False,
            _return_http_data_only=True,
            _request_timeout=REQUEST_TIMEOUT_SECONDS,
        )
        data = getattr(resp, "data", b"")
        text = data.decode("utf-8", "replace") if isinstance(data, (bytes, bytearray)) else str(data)
        status = int(getattr(resp, "status", 200) or 200)
        with contextlib.suppress(Exception):
            resp.release_conn()
        return status, text
    except ApiException as exc:
        body = getattr(exc, "body", "") or ""
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8", "replace")
        return int(getattr(exc, "status", 0) or 0), str(body)


# --- public API ------------------------------------------------------------------------------


def test_connection(conn: dict) -> str:
    """Confirm the credentials reach a live API server. Returns the server version string.

    Raises KubeError with a safe message on any failure.
    """
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            info = client.VersionApi(api_client).get_code(_request_timeout=REQUEST_TIMEOUT_SECONDS)
            return str(getattr(info, "git_version", "") or "")
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


def list_nodes(conn: dict) -> list[dict]:
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            nodes = client.CoreV1Api(api_client).list_node(_request_timeout=REQUEST_TIMEOUT_SECONDS)
            return [_node_dict(node) for node in nodes.items]
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


def list_namespaces(conn: dict) -> list[str]:
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            result = client.CoreV1Api(api_client).list_namespace(_request_timeout=REQUEST_TIMEOUT_SECONDS)
            return [str(ns.metadata.name) for ns in result.items]
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


def list_pods(conn: dict, namespace: str = "") -> list[dict]:
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            core = client.CoreV1Api(api_client)
            if namespace:
                result = core.list_namespaced_pod(namespace, _request_timeout=REQUEST_TIMEOUT_SECONDS)
            else:
                result = core.list_pod_for_all_namespaces(_request_timeout=REQUEST_TIMEOUT_SECONDS)
            return [_pod_dict(pod) for pod in result.items]
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


def pod_logs(conn: dict, namespace: str, pod: str, container: str = "", tail: int = 200, previous: bool = False) -> dict:
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            kwargs: dict = {
                "name": pod,
                "namespace": namespace,
                "tail_lines": max(1, int(tail)),
                "previous": bool(previous),
                "_request_timeout": REQUEST_TIMEOUT_SECONDS,
            }
            if container:
                kwargs["container"] = container
            log = client.CoreV1Api(api_client).read_namespaced_pod_log(**kwargs)
            return {"container": container, "log": str(log or ""), "tail": int(tail)}
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


def list_deployments(conn: dict, namespace: str = "") -> list[dict]:
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            apps = client.AppsV1Api(api_client)
            if namespace:
                result = apps.list_namespaced_deployment(namespace, _request_timeout=REQUEST_TIMEOUT_SECONDS)
            else:
                result = apps.list_deployment_for_all_namespaces(_request_timeout=REQUEST_TIMEOUT_SECONDS)
            return [_deployment_dict(dep) for dep in result.items]
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


def list_events(conn: dict, namespace: str = "") -> list[dict]:
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            core = client.CoreV1Api(api_client)
            if namespace:
                result = core.list_namespaced_event(namespace, _request_timeout=REQUEST_TIMEOUT_SECONDS)
            else:
                result = core.list_event_for_all_namespaces(_request_timeout=REQUEST_TIMEOUT_SECONDS)
            return [_event_dict(ev) for ev in result.items]
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


def health(conn: dict) -> dict:
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            livez_status, _ = _probe(api_client, "/livez")
            readyz_status, readyz_text = _probe(api_client, "/readyz", query_params=[("verbose", "true")])

            readyz: list[dict] = []
            for line in readyz_text.splitlines():
                line = line.strip()
                if line.startswith("[+]") or line.startswith("[-]"):
                    ok = line.startswith("[+]")
                    rest = line[3:].strip()
                    name = rest.split(" ", 1)[0]
                    if name:
                        readyz.append({"name": name, "ok": ok})

            component_statuses: list[dict] = []
            # list_component_status 404s / is forbidden on many managed clusters -- treat as absent.
            with contextlib.suppress(Exception):
                cs_result = client.CoreV1Api(api_client).list_component_status(_request_timeout=REQUEST_TIMEOUT_SECONDS)
                for comp in cs_result.items:
                    healthy = False
                    message = ""
                    for cond in (getattr(comp, "conditions", None) or []):
                        if cond.type == "Healthy":
                            healthy = str(cond.status) == "True"
                            message = str(getattr(cond, "message", "") or "")
                    component_statuses.append({"name": str(comp.metadata.name), "healthy": healthy, "message": message})

            control_plane_pods: list[dict] = []
            addons: list[dict] = []
            with contextlib.suppress(Exception):
                pods = client.CoreV1Api(api_client).list_namespaced_pod("kube-system", _request_timeout=REQUEST_TIMEOUT_SECONDS)
                for pod in pods.items:
                    name = str(pod.metadata.name)
                    phase = str(getattr(pod.status, "phase", "") or "")
                    statuses = getattr(pod.status, "container_statuses", None) or []
                    ready = bool(statuses) and all(getattr(cs, "ready", False) for cs in statuses)
                    restarts = sum(int(getattr(cs, "restart_count", 0) or 0) for cs in statuses)
                    if name.startswith(_CONTROL_PLANE_PREFIXES):
                        control_plane_pods.append({
                            "name": name, "namespace": "kube-system", "phase": phase,
                            "ready": ready, "restarts": restarts,
                        })
                    elif name.startswith(_ADDON_PREFIXES):
                        addon = name.split("-")[0] if not name.startswith("metrics-server") else "metrics-server"
                        addons.append({"name": name, "healthy": ready and phase == "Running", "detail": phase})

            return {
                "livez_ok": livez_status == 200,
                "readyz_ok": readyz_status == 200,
                "readyz": readyz,
                "component_statuses": component_statuses,
                "control_plane_pods": control_plane_pods,
                "addons": addons,
            }
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


def overview(conn: dict) -> dict:
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            core = client.CoreV1Api(api_client)
            version = ""
            platform = ""
            with contextlib.suppress(Exception):
                info = client.VersionApi(api_client).get_code(_request_timeout=REQUEST_TIMEOUT_SECONDS)
                version = str(getattr(info, "git_version", "") or "")
                platform = str(getattr(info, "platform", "") or "")

            nodes = core.list_node(_request_timeout=REQUEST_TIMEOUT_SECONDS).items
            nodes_ready = 0
            cpu_cores = 0.0
            mem_bytes = 0
            for node in nodes:
                ready, _ = _node_ready(node)
                if ready == "Ready":
                    nodes_ready += 1
                capacity = getattr(node.status, "capacity", None) or {}
                cpu_cores += _parse_cpu_cores(capacity.get("cpu"))
                mem_bytes += _parse_mem_bytes(capacity.get("memory"))

            namespace_count = len(core.list_namespace(_request_timeout=REQUEST_TIMEOUT_SECONDS).items)

            pods = core.list_pod_for_all_namespaces(_request_timeout=REQUEST_TIMEOUT_SECONDS).items
            by_phase = {"Running": 0, "Pending": 0, "Failed": 0, "Succeeded": 0, "Unknown": 0}
            for pod in pods:
                phase = str(getattr(pod.status, "phase", "") or "Unknown")
                if phase not in by_phase:
                    phase = "Unknown"
                by_phase[phase] += 1

            livez_status, _ = _probe(api_client, "/livez")

            warnings: list[dict] = []
            with contextlib.suppress(Exception):
                events = core.list_event_for_all_namespaces(_request_timeout=REQUEST_TIMEOUT_SECONDS).items
                warnings = [_event_dict(ev) for ev in events if str(getattr(ev, "type", "")) == "Warning"][:20]

            cpu_display = str(int(cpu_cores)) if cpu_cores == int(cpu_cores) else f"{cpu_cores:.1f}"
            return {
                "version": version,
                "platform": platform,
                "node_count": len(nodes),
                "nodes_ready": nodes_ready,
                "namespace_count": namespace_count,
                "pod_count": len(pods),
                "pods_by_phase": by_phase,
                "cpu_capacity": cpu_display if nodes else "",
                "memory_capacity": _fmt_mem(mem_bytes),
                "health_ok": livez_status == 200,
                "warnings": warnings,
            }
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


# --- actions ---------------------------------------------------------------------------------


def restart_pod(conn: dict, namespace: str, pod: str) -> str:
    """Delete a pod so its controller recreates it."""
    return delete_pod(conn, namespace, pod, _verb="restarted")


def delete_pod(conn: dict, namespace: str, pod: str, _verb: str = "deleted") -> str:
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            client.CoreV1Api(api_client).delete_namespaced_pod(pod, namespace, _request_timeout=REQUEST_TIMEOUT_SECONDS)
            return f"Pod {namespace}/{pod} {_verb}."
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


def scale_deployment(conn: dict, namespace: str, name: str, replicas: int) -> str:
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            body = {"spec": {"replicas": int(replicas)}}
            client.AppsV1Api(api_client).patch_namespaced_deployment_scale(
                name, namespace, body, _request_timeout=REQUEST_TIMEOUT_SECONDS
            )
            return f"Deployment {namespace}/{name} scaled to {int(replicas)} replica(s)."
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


def restart_deployment(conn: dict, namespace: str, name: str) -> str:
    """Rollout restart: stamp the pod template's restartedAt annotation, as `kubectl rollout restart`."""
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            now = datetime.now(timezone.utc).isoformat()
            body = {"spec": {"template": {"metadata": {"annotations": {"kubectl.kubernetes.io/restartedAt": now}}}}}
            client.AppsV1Api(api_client).patch_namespaced_deployment(
                name, namespace, body, _request_timeout=REQUEST_TIMEOUT_SECONDS
            )
            return f"Deployment {namespace}/{name} rollout restart triggered."
    except KubeError:
        raise
    except Exception as exc:
        raise KubeError(_clean(exc)) from exc


def cordon_node(conn: dict, name: str, cordon: bool) -> str:
    try:
        with _api_client(conn) as api_client:
            from kubernetes import client  # type: ignore

            body = {"spec": {"unschedulable": bool(cordon)}}
            client.CoreV1Api(api_client).patch_node(name, body, _request_timeout=REQUEST_TIMEOUT_SECONDS)
            return f"Node {name} {'cordoned' if cordon else 'uncordoned'}."
    except KubeError:
        raise
    except Exception as exc:
        if _is_forbidden(exc):
            raise KubeError(
                f"Not permitted to {'cordon' if cordon else 'uncordon'} node {name}: this needs elevated "
                f"cluster RBAC (patch on nodes). {_clean(exc)}"
            ) from exc
        raise KubeError(_clean(exc)) from exc
