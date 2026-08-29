"""Local tests for the optional Keycloak / OIDC login (app.services.oidc + its routes).

No live Keycloak: these exercise only the pieces that need none -- that OIDC is OFF by default
(configured() False, /auth/oidc/status enabled:false), that make_pkce() produces a valid S256
challenge, and that extract_identity() maps realm client roles to app roles. Style mirrors
tests/test_users.py -- DATABASE_URL + JWT_SECRET are set before app.main imports app.core.database,
and OIDC env is deliberately left unset so the app stays on its local-login-only path.
"""

import base64
import hashlib
import os
import tempfile

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_oidctest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""
# leave OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET unset -> OIDC stays off

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture()
def client():
    from app.main import app

    with TestClient(app) as c:
        yield c


def test_oidc_unconfigured_by_default():
    from app.services import oidc

    assert oidc.configured() is False


def test_status_reports_disabled(client):
    r = client.get("/api/auth/oidc/status")
    assert r.status_code == 200
    # OIDC off => not enabled, and local login stays available (standalone/SQLite is the only way in).
    assert r.json() == {"enabled": False, "local_login": True}


def test_local_login_disabled_when_oidc_configured(client, monkeypatch):
    # With OIDC configured and no break-glass, web sign-in is Keycloak-only: status.local_login is
    # False and POST /auth/login is refused (can't be bypassed by hitting the API directly).
    from app.core.config import get_settings
    from app.services import oidc

    monkeypatch.setattr(oidc, "configured", lambda: True)
    monkeypatch.setattr(get_settings(), "allow_local_login", False)
    status = client.get("/api/auth/oidc/status").json()
    assert status == {"enabled": True, "local_login": False}
    r = client.post("/api/auth/login", json={"email": "admin@inframonitor.local", "password": "ChangeMe123!"})
    assert r.status_code == 403


def test_logout_route_redirects_when_unconfigured(client):
    # With OIDC off, /auth/oidc/logout is a harmless redirect (no Keycloak to end a session on).
    r = client.get("/api/auth/oidc/logout", follow_redirects=False)
    assert r.status_code == 302


def test_break_glass_reenables_local_login(client, monkeypatch):
    # ALLOW_LOCAL_LOGIN=true keeps local login available alongside Keycloak.
    from app.core.config import get_settings
    from app.services import oidc

    monkeypatch.setattr(oidc, "configured", lambda: True)
    monkeypatch.setattr(get_settings(), "allow_local_login", True)
    assert client.get("/api/auth/oidc/status").json()["local_login"] is True


def test_make_pkce_is_valid_s256():
    from app.services import oidc

    verifier, challenge = oidc.make_pkce()
    # verifier is url-safe and within the RFC 7636 length window
    assert 43 <= len(verifier) <= 128
    # challenge = base64url(sha256(verifier)) with no padding
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")
    assert challenge == expected
    assert "=" not in challenge


def _claims(roles, client_id="inframonitor", email="user@corp.local"):
    return {"email": email, "resource_access": {client_id: {"roles": roles}}}


@pytest.mark.parametrize(
    "roles,expected",
    [
        (["admin"], "admin"),
        (["administrator"], "admin"),
        (["developer"], "developer"),
        (["support"], "support"),
        (["developer", "admin"], "admin"),  # admin wins
    ],
)
def test_extract_identity_maps_roles(monkeypatch, roles, expected):
    from app.core.config import get_settings
    from app.services import oidc

    monkeypatch.setattr(get_settings(), "oidc_client_id", "inframonitor")
    email, role = oidc.extract_identity(_claims(roles))
    assert email == "user@corp.local"
    assert role == expected


def test_extract_identity_no_role_raises(monkeypatch):
    from app.core.config import get_settings
    from app.services import oidc

    monkeypatch.setattr(get_settings(), "oidc_client_id", "inframonitor")
    with pytest.raises(oidc.OidcError):
        oidc.extract_identity(_claims(["viewer"]))


def test_extract_identity_no_email_raises(monkeypatch):
    from app.core.config import get_settings
    from app.services import oidc

    monkeypatch.setattr(get_settings(), "oidc_client_id", "inframonitor")
    claims = {"resource_access": {"inframonitor": {"roles": ["admin"]}}}
    with pytest.raises(oidc.OidcError):
        oidc.extract_identity(claims)


def test_extract_identity_falls_back_to_preferred_username(monkeypatch):
    from app.core.config import get_settings
    from app.services import oidc

    monkeypatch.setattr(get_settings(), "oidc_client_id", "inframonitor")
    claims = {"preferred_username": "alice", "resource_access": {"inframonitor": {"roles": ["support"]}}}
    email, role = oidc.extract_identity(claims)
    assert email == "alice"
    assert role == "support"
