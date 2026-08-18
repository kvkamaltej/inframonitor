"""Unit tests for the user-defined Prometheus alert-rule manager.

The module reads get_settings() for custom_rules_path and prometheus_url. We monkeypatch
app.services.alert_rules.get_settings to return a throwaway object pointed at a tmp_path file
with prometheus_url="" so reload_prometheus() is a no-op and no network call is made.
"""

from dataclasses import dataclass

import pytest
import yaml

from app.services import alert_rules
from app.services.alert_rules import AlertRule, AlertRuleError


@dataclass
class _FakeSettings:
    custom_rules_path: str
    prometheus_url: str = ""


@pytest.fixture
def rules_file(tmp_path, monkeypatch):
    path = tmp_path / "custom_rules.yml"
    monkeypatch.setattr(
        alert_rules, "get_settings", lambda: _FakeSettings(custom_rules_path=str(path))
    )
    return path


def test_add_then_list_returns_rule(rules_file):
    assert alert_rules.list_rules() == []  # missing file -> empty
    alert_rules.add_rule(
        AlertRule(name="MyAlert", expr="up == 0", for_duration="2m", severity="critical",
                  summary="s", description="d")
    )
    rules = alert_rules.list_rules()
    assert rules == [
        {"name": "MyAlert", "expr": "up == 0", "for": "2m", "severity": "critical",
         "summary": "s", "description": "d"}
    ]


def test_written_file_is_valid_prometheus_yaml(rules_file):
    alert_rules.add_rule(AlertRule(name="MyAlert", expr="up == 0"))
    document = yaml.safe_load(rules_file.read_text(encoding="utf-8"))
    assert [g["name"] for g in document["groups"]] == ["inframonitor-custom"]
    rule = document["groups"][0]["rules"][0]
    assert rule["alert"] == "MyAlert"
    assert rule["expr"] == "up == 0"
    assert rule["for"] == "5m"
    assert rule["labels"]["severity"] == "warning"
    assert set(rule["annotations"]) == {"summary", "description"}


def test_duplicate_add_raises_and_preserves(rules_file):
    alert_rules.add_rule(AlertRule(name="Dup", expr="up == 0"))
    with pytest.raises(AlertRuleError, match="already exists"):
        alert_rules.add_rule(AlertRule(name="Dup", expr="vector(1)"))
    assert [r["name"] for r in alert_rules.list_rules()] == ["Dup"]


def test_add_preserves_existing_rules(rules_file):
    alert_rules.add_rule(AlertRule(name="First", expr="up == 0"))
    alert_rules.add_rule(AlertRule(name="Second", expr="vector(1) > 0"))
    assert [r["name"] for r in alert_rules.list_rules()] == ["First", "Second"]


def test_delete_removes_rule(rules_file):
    alert_rules.add_rule(AlertRule(name="First", expr="up == 0"))
    alert_rules.add_rule(AlertRule(name="Second", expr="vector(1) > 0"))
    alert_rules.delete_rule("First")
    assert [r["name"] for r in alert_rules.list_rules()] == ["Second"]


def test_delete_missing_raises(rules_file):
    with pytest.raises(AlertRuleError, match="No custom rule"):
        alert_rules.delete_rule("Nope")


def test_invalid_name_raises(rules_file):
    with pytest.raises(AlertRuleError, match="Invalid alert name"):
        alert_rules.add_rule(AlertRule(name="1bad-name", expr="up == 0"))


def test_empty_expr_raises(rules_file):
    with pytest.raises(AlertRuleError, match="expr"):
        alert_rules.add_rule(AlertRule(name="Good", expr="  "))


def test_invalid_for_duration_raises(rules_file):
    with pytest.raises(AlertRuleError, match="for"):
        alert_rules.add_rule(AlertRule(name="Good", expr="up == 0", for_duration="5x"))


def test_reload_noop_when_prometheus_url_empty(rules_file):
    # prometheus_url defaults to "" in _FakeSettings, so this must not attempt any HTTP call.
    alert_rules.reload_prometheus()


def test_templates_shape():
    keys = {t["key"] for t in alert_rules.TEMPLATES}
    assert {"test-alert", "nginx-upstream-timeout"} <= keys
    for tpl in alert_rules.TEMPLATES:
        assert {"key", "name", "expr", "for", "severity", "summary", "description"} <= set(tpl)
    nginx = next(t for t in alert_rules.TEMPLATES if t["key"] == "nginx-upstream-timeout")
    assert "requires" in nginx
