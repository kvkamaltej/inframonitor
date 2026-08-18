"""Ship Kubernetes pod logs into Loki by tailing the k8s API -- no agent in the cluster.

This mirrors ``app.services.log_shipper`` but sources its lines from the Kubernetes API
(``kube.pod_logs``) instead of over SSH. For a saved cluster connection it lists the pods in the
requested namespaces, tails each container's recent log window, and pushes the genuinely-new lines
to Loki's push API. There is no persistent agent and no long-lived client: like the rest of
``kube``, every read opens its own short-lived client. The async driver in app.main runs this via
``asyncio.to_thread`` so the sync kubernetes client and sync httpx push never block the event loop.

Cursor / de-duplication
-----------------------
State is deliberately light and lives only in the process: an in-memory cursor per
``(cluster_id, namespace, pod, container)`` holding the hash of the last line already shipped. Each
run tails the last ``TAIL_LINES`` lines, locates the remembered line in that window, and ships only
what follows it. When the remembered line has scrolled out of the window (a pod restarted, or it
produced more than the window between runs) the whole window is shipped -- best effort, favouring
"no gaps" over "never a duplicate". A restart re-ships at most one window per container.

The Loki push payload builder and pusher are reused verbatim from ``log_shipper``; only the cursor
(keyed on the k8s coordinates rather than a server) is re-implemented locally so the two shippers
never share dedup state.
"""

from __future__ import annotations

from app.services import kube
from app.services.log_shipper import _line_hash, _push_to_loki, build_push_payload

# How many trailing lines to pull per container per run. The cursor trims this to the new lines;
# the window just bounds how much a single run can catch up on.
TAIL_LINES = 500

JOB_LABEL = "k8s-logs"

# in-memory cursor: {(cluster_id, namespace, pod, container): last_shipped_line_hash}
_CURSORS: dict[tuple[str, str, str, str], str] = {}


def _new_lines_k8s(key: tuple[str, str, str, str], lines: list[str]) -> list[str]:
    """Return only the lines after this container's remembered cursor, and advance the cursor.

    A local twin of ``log_shipper._new_lines`` with its own ``_CURSORS`` keyed on the k8s
    coordinates. The cursor is the hash of the last line shipped last time; we find its last
    occurrence in the freshly-tailed window and return everything after it. When it is absent
    (first run, or scrolled out of the window) we ship the whole window.
    """
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
    # advance the cursor to the last line seen this run (shipped or not)
    _CURSORS[key] = _line_hash(lines[-1])
    return fresh


def _log_text(result) -> str:
    """Pull the raw log text out of whatever ``pod_logs`` returned.

    ``kube.pod_logs`` returns ``{"container", "log", "tail"}``; be defensive so a plain string or an
    alternative ``lines`` shape still works.
    """
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        if isinstance(result.get("log"), str):
            return result["log"]
        lines = result.get("lines")
        if isinstance(lines, list):
            return "\n".join(str(line) for line in lines)
    return ""


def _split_lines(text: str) -> list[str]:
    """Split a log blob into non-empty lines, dropping a single trailing newline's empty tail."""
    if not text:
        return []
    return [line for line in text.splitlines() if line != ""]


def _labels_for(cluster_name: str, cluster_id: str, namespace: str, pod: str, container: str) -> dict[str, str]:
    return {
        "cluster": cluster_name,
        "cluster_id": cluster_id,
        "namespace": namespace,
        "pod": pod,
        "container": container,
        "job": JOB_LABEL,
    }


def ship_cluster_once(
    conn: dict,
    cluster_id: str,
    cluster_name: str,
    namespaces: list[str],
    loki_url: str,
    *,
    client=None,
    list_fn=None,
    logs_fn=None,
) -> int:
    """Tail every pod/container in ``namespaces`` once and push new lines to Loki.

    ``namespaces`` empty (or ``[""]``) means all namespaces (``list_pods`` with ``namespace=""``).
    ``list_fn``/``logs_fn`` default to ``kube.list_pods``/``kube.pod_logs`` and are injectable for
    tests. Returns the total number of lines shipped. Never raises for a per-pod/per-container
    failure -- those are swallowed so one bad pod cannot stall the sweep. Returns 0 if ``loki_url``
    is empty.
    """
    loki_url = (loki_url or "").strip()
    if not loki_url:
        return 0
    lister = list_fn or kube.list_pods
    reader = logs_fn or kube.pod_logs

    # Normalise: empty list, or a list whose only entry is blank, means "all namespaces".
    targets = [ns for ns in (namespaces or []) if str(ns).strip()]
    if not targets:
        targets = [""]

    shipped = 0
    for ns in targets:
        try:
            pods = lister(conn, ns)
        except Exception:
            # unreachable cluster, forbidden namespace -- skip this namespace this run
            continue
        for pod in pods or []:
            pod_name = str(pod.get("name") or "") if isinstance(pod, dict) else ""
            if not pod_name:
                continue
            # a pod's own namespace (from list_pod_for_all_namespaces) beats the request namespace
            pod_ns = str(pod.get("namespace") or "") if isinstance(pod, dict) else ""
            effective_ns = pod_ns or ns
            containers = pod.get("containers") if isinstance(pod, dict) else None
            if not isinstance(containers, list) or not containers:
                containers = [""]
            for container in containers:
                container = str(container or "")
                try:
                    result = reader(conn, effective_ns, pod_name, container, TAIL_LINES)
                except Exception:
                    # missing pod, terminated container, forbidden -- skip this container this run
                    continue
                lines = _split_lines(_log_text(result))
                key = (cluster_id, effective_ns, pod_name, container)
                fresh = _new_lines_k8s(key, lines)
                if not fresh:
                    continue
                labels = _labels_for(cluster_name, cluster_id, effective_ns, pod_name, container)
                payload = build_push_payload(labels, fresh)
                try:
                    _push_to_loki(loki_url, payload, client=client)
                except Exception:
                    # Loki push failed; leave the cursor advanced (best effort) and move on.
                    continue
                shipped += len(fresh)
    return shipped
