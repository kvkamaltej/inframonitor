"""Local tests for (1) server-scoped shell command favorites and (2) the relaxed on-demand log-target
validation. Both run end to end against a temp SQLite database; no live SSH is required (the log tests
only exercise _validated_log_target, not a real fetch).

Style mirrors tests/test_db_connections.py: DATABASE_URL + JWT_SECRET are set before app.main imports
app.core.database (the engine is built at import time). The seeded admin user is reused as the caller
so favorites' _current_user lookup resolves to a real row.
"""

import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="inframonitor_favtest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# the seeded admin, created by _seed_defaults at startup, so _current_user resolves.
_USER = {"sub": "admin@inframonitor.local", "role": "admin", "guest": False}


@pytest.fixture()
def client():
    from app.core.security import require_user
    from app.core.database import SessionLocal
    from app.main import app
    from app.models.entities import ShellFavorite

    app.dependency_overrides[require_user] = lambda: _USER
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    # These modules share one engine (the first import wins the DATABASE_URL), so clear the
    # favorites this test created — they hold a FK to users, which would otherwise block an unrelated
    # test's `DROP TABLE users` (FK enforcement is on for SQLite here).
    with SessionLocal() as session:
        session.query(ShellFavorite).delete()
        session.commit()


# --- favorites scope ------------------------------------------------------------------------


def test_global_and_server_favorites_filter_by_server(client):
    g = client.post("/api/shell/favorites", json={"name": "tail-catalina", "command": "tail -f x", "scope": "global"})
    assert g.status_code == 201, g.text
    assert g.json()["scope"] == "global"
    assert g.json()["server_public_id"] == ""

    s = client.post("/api/shell/favorites", json={
        "name": "restart-app", "command": "systemctl restart app", "scope": "server", "server_public_id": "srv-AAA"})
    assert s.status_code == 201, s.text
    assert s.json()["scope"] == "server"
    assert s.json()["server_public_id"] == "srv-AAA"

    # listing for server AAA sees the global one + AAA's own
    names_aaa = {f["name"] for f in client.get("/api/shell/favorites?server=srv-AAA").json()}
    assert names_aaa == {"tail-catalina", "restart-app"}

    # listing for a different server sees only the global one
    names_bbb = {f["name"] for f in client.get("/api/shell/favorites?server=srv-BBB").json()}
    assert names_bbb == {"tail-catalina"}


def test_server_scope_requires_a_server(client):
    r = client.post("/api/shell/favorites", json={"name": "x", "command": "y", "scope": "server"})
    assert r.status_code == 400


def test_same_name_allowed_across_buckets(client):
    a = client.post("/api/shell/favorites", json={"name": "logs", "command": "a", "scope": "global"})
    assert a.status_code == 201
    # same name, but scoped to a server -> different bucket, allowed
    b = client.post("/api/shell/favorites", json={
        "name": "logs", "command": "b", "scope": "server", "server_public_id": "srv-Z"})
    assert b.status_code == 201, b.text
    # but a second GLOBAL "logs" clashes
    c = client.post("/api/shell/favorites", json={"name": "logs", "command": "c", "scope": "global"})
    assert c.status_code == 409


# --- log target validation ------------------------------------------------------------------


def test_log_target_validation():
    from app.api.routes import _validated_log_target

    class _S:
        database_logs_json = "[]"
        tomcat_json = "[]"

    s = _S()
    # arbitrary absolute file paths are now allowed (syslog, an app log on a particular VM)
    assert _validated_log_target(s, "file", "/var/log/syslog") == "/var/log/syslog"
    assert _validated_log_target(s, "file", "/opt/app/logs/app.log") == "/opt/app/logs/app.log"
    # a blank journal target means the whole systemd journal
    assert _validated_log_target(s, "journal", "") == ""
    # a named unit still works
    assert _validated_log_target(s, "journal", "nginx.service") == "nginx.service"


def test_log_target_rejects_relative_path():
    import pytest as _pytest
    from fastapi import HTTPException
    from app.api.routes import _validated_log_target

    class _S:
        database_logs_json = "[]"
        tomcat_json = "[]"

    with _pytest.raises(HTTPException):
        _validated_log_target(_S(), "file", "var/log/syslog")  # not absolute
    with _pytest.raises(HTTPException):
        _validated_log_target(_S(), "file", "")  # empty
