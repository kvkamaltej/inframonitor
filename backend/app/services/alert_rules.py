"""Manager for user-defined Prometheus alert rules (full profile only).

The app lets an operator add and remove their own alert rules from the UI without
editing files on the box or restarting anything. Those rules live in a single
writable YAML file -- the ``custom_rules_path`` setting -- which Prometheus mounts
separately from the shipped ``alerts.yml`` and re-reads on demand via its
lifecycle reload API. Everything the app owns is kept in ONE Prometheus rule group
named ``inframonitor-custom``; the shipped rules are never touched by this module.

The file we write is ordinary Prometheus rules YAML::

    groups:
      - name: inframonitor-custom
        rules:
          - alert: <name>
            expr: <expr>
            for: <duration>
            labels:
              severity: <severity>
            annotations:
              summary: <summary>
              description: <description>

Reading then writing is round-trip safe: existing rules in the group are preserved.
After every mutation the file is written first and Prometheus is reloaded second, so
a reload failure leaves the new file on disk to be retried rather than losing the edit.
"""

import re
from dataclasses import dataclass
from pathlib import Path

import httpx
import yaml

from app.core.config import get_settings

# The single group this module owns inside the custom rules file. The shipped alerts.yml
# lives in a different file and different groups; we never read or write those.
GROUP_NAME = "inframonitor-custom"

# Default location when the setting is unset. The orchestrator adds a real custom_rules_path
# attribute to Settings; until then getattr keeps this module importable and testable.
DEFAULT_RULES_PATH = "/etc/prometheus/custom_rules.yml"

# A valid Prometheus alert name (also a valid label value the UI can key on).
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Prometheus duration as we accept it: an integer followed by a single unit.
_DURATION_RE = re.compile(r"^\d+[smhd]$")

# Interactive UI call, not a batch job: fail fast on an unreachable Prometheus.
RELOAD_TIMEOUT_SECONDS = 5.0


class AlertRuleError(Exception):
    """Raised for validation failures, duplicate/missing rules, IO problems, or a failed
    Prometheus reload. The message is safe to surface directly to the user."""


@dataclass
class AlertRule:
    """One user-defined alert rule. ``for_duration`` serialises to the YAML key ``for``
    (``for`` is a Python keyword, so it cannot be a field name)."""

    name: str
    expr: str
    for_duration: str = "5m"
    severity: str = "warning"
    summary: str = ""
    description: str = ""


# Ready-to-use rules the UI can prefill. Each is a plain dict so the frontend can render it
# without knowing about AlertRule. `requires` (optional) names an external exporter the rule
# depends on, so the UI can warn before the operator adds a rule that can never fire here.
TEMPLATES: list[dict] = [
    {
        "key": "test-alert",
        "name": "InfraMonitorTestAlert",
        "expr": "vector(1) > 0",
        "for": "1m",
        "severity": "info",
        "summary": "Test alert (always firing)",
        "description": (
            "Synthetic alert to verify Prometheus->Alertmanager->app delivery. "
            "Delete when done."
        ),
    },
    {
        "key": "nginx-upstream-timeout",
        "name": "NginxUpstreamTimeout",
        "expr": (
            "histogram_quantile(0.95, sum by (le) "
            "(rate(nginx_http_request_duration_seconds_bucket[5m]))) > 30"
        ),
        "for": "5m",
        "severity": "warning",
        "summary": "nginx upstream responses slower than 30s",
        "description": (
            "p95 nginx request duration exceeded 30s. Requires an nginx metrics exporter "
            "feeding nginx_http_request_duration_seconds_bucket."
        ),
        "requires": "nginx metrics exporter (nginx_http_request_duration_seconds_bucket)",
    },
]


def _rules_path() -> Path:
    settings = get_settings()
    configured = getattr(settings, "custom_rules_path", "") or DEFAULT_RULES_PATH
    return Path(configured)


def _load_document(path: Path) -> dict:
    """Parse the whole rules file into a dict. Returns an empty document when the file is
    missing or blank so the first add_rule can create it from nothing."""
    if not path.exists():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise AlertRuleError(f"Cannot read custom rules file: {exc}") from exc
    if not text.strip():
        return {}
    try:
        loaded = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise AlertRuleError(f"Custom rules file is not valid YAML: {exc}") from exc
    if loaded is None:
        return {}
    if not isinstance(loaded, dict):
        raise AlertRuleError("Custom rules file must be a YAML mapping with a 'groups' key")
    return loaded


def _find_group(document: dict) -> dict | None:
    for group in document.get("groups") or []:
        if isinstance(group, dict) and group.get("name") == GROUP_NAME:
            return group
    return None


def _write_document(path: Path, document: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            yaml.safe_dump(document, sort_keys=False, default_flow_style=False),
            encoding="utf-8",
        )
    except OSError as exc:
        raise AlertRuleError(f"Cannot write custom rules file: {exc}") from exc


def _rule_to_yaml(rule: AlertRule) -> dict:
    """Serialise an AlertRule to the Prometheus rule mapping written to disk."""
    return {
        "alert": rule.name,
        "expr": rule.expr,
        "for": rule.for_duration,
        "labels": {"severity": rule.severity},
        "annotations": {"summary": rule.summary, "description": rule.description},
    }


def _rule_to_dict(entry: dict) -> dict:
    """Flatten a stored Prometheus rule mapping into the flat shape the UI consumes."""
    labels = entry.get("labels") or {}
    annotations = entry.get("annotations") or {}
    return {
        "name": entry.get("alert", ""),
        "expr": entry.get("expr", ""),
        "for": entry.get("for", ""),
        "severity": labels.get("severity", ""),
        "summary": annotations.get("summary", ""),
        "description": annotations.get("description", ""),
    }


def list_rules() -> list[dict]:
    """Return the custom rules as flat dicts (name/expr/for/severity/summary/description).
    Empty list when the file is missing, empty, or has no inframonitor-custom group."""
    document = _load_document(_rules_path())
    group = _find_group(document)
    if group is None:
        return []
    return [_rule_to_dict(entry) for entry in group.get("rules") or [] if isinstance(entry, dict)]


def _validate(rule: AlertRule) -> None:
    if not _NAME_RE.match(rule.name or ""):
        raise AlertRuleError(
            f"Invalid alert name {rule.name!r}: must match ^[A-Za-z_][A-Za-z0-9_]*$"
        )
    if not (rule.expr or "").strip():
        raise AlertRuleError("Alert expression (expr) must not be empty")
    if not _DURATION_RE.match(rule.for_duration or ""):
        raise AlertRuleError(
            f"Invalid 'for' duration {rule.for_duration!r}: must match ^\\d+[smhd]$ (e.g. 5m)"
        )


def add_rule(rule: AlertRule) -> None:
    """Validate and append a rule to the inframonitor-custom group, write the file (creating
    the parent directory and group if needed), then reload Prometheus. Raises AlertRuleError
    on a validation failure or a duplicate name; existing rules are preserved."""
    _validate(rule)
    path = _rules_path()
    document = _load_document(path)
    document.setdefault("groups", [])
    group = _find_group(document)
    if group is None:
        group = {"name": GROUP_NAME, "rules": []}
        document["groups"].append(group)
    group.setdefault("rules", [])
    if any(
        isinstance(entry, dict) and entry.get("alert") == rule.name for entry in group["rules"]
    ):
        raise AlertRuleError(f"A custom rule named {rule.name!r} already exists")
    group["rules"].append(_rule_to_yaml(rule))
    _write_document(path, document)
    reload_prometheus()


def delete_rule(name: str) -> None:
    """Remove the named rule from the group, write the file, then reload Prometheus.
    Raises AlertRuleError when no rule with that name exists."""
    path = _rules_path()
    document = _load_document(path)
    group = _find_group(document)
    rules = (group.get("rules") if group else None) or []
    remaining = [
        entry for entry in rules if not (isinstance(entry, dict) and entry.get("alert") == name)
    ]
    if len(remaining) == len(rules):
        raise AlertRuleError(f"No custom rule named {name!r}")
    group["rules"] = remaining
    _write_document(path, document)
    reload_prometheus()


def reload_prometheus() -> None:
    """Ask Prometheus to re-read its rule files via the lifecycle reload API. No-op when
    prometheus_url is unset (lite profile). Raises AlertRuleError on any failure -- the file
    on disk is kept, so the reload can be retried without re-adding the rule."""
    base = (get_settings().prometheus_url or "").strip().rstrip("/")
    if not base:
        return
    try:
        with httpx.Client(timeout=RELOAD_TIMEOUT_SECONDS) as client:
            response = client.post(f"{base}/-/reload")
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise AlertRuleError(
            f"Prometheus reload returned HTTP {exc.response.status_code}. "
            "The rule was saved; check that --web.enable-lifecycle is set, then retry."
        ) from exc
    except httpx.HTTPError as exc:
        raise AlertRuleError(
            "Prometheus is unreachable for reload. The rule was saved; retry the reload."
        ) from exc
