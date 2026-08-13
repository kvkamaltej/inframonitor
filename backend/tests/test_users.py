"""Local tests for editing user details (PATCH /api/users/{id}).

No live services required: the route runs end to end against a temp SQLite database. Style mirrors
tests/test_kube.py -- DATABASE_URL + JWT_SECRET are set before app.main imports app.core.database.
"""

import os
import tempfile

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_userstest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


_ADMIN = {"sub": "admin@local", "role": "admin", "guest": False}


@pytest.fixture()
def client():
    from app.core.security import require_admin_not_guest
    from app.main import app

    app.dependency_overrides[require_admin_not_guest] = lambda: _ADMIN
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _make_user(email="dev@local", role="developer", full_name="Dev One"):
    # find-or-create by email: the module shares one SQLite DB across tests, so re-using the same
    # email (e.g. the admin's own row in two self-edit tests) must not collide on the unique index.
    from app.core.database import SessionLocal
    from app.core.security import hash_password
    from app.models.entities import Role, User
    from sqlalchemy import select

    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == email))
        if user is None:
            user = User(email=email, full_name=full_name, password_hash=hash_password("initialpw"), role=Role(role))
            db.add(user)
        else:
            user.full_name = full_name
            user.role = Role(role)
        db.commit()
        db.refresh(user)
        return user.id


def test_patch_updates_full_name_and_role(client):
    uid = _make_user()
    r = client.patch(f"/api/users/{uid}", json={"full_name": "Renamed Dev", "role": "support"})
    assert r.status_code == 200
    body = r.json()
    assert body["full_name"] == "Renamed Dev"
    assert body["role"] == "support"


def test_patch_promotes_to_admin(client):
    uid = _make_user(email="promote@local")
    r = client.patch(f"/api/users/{uid}", json={"role": "admin"})
    assert r.status_code == 200
    assert r.json()["role"] == "admin"  # administrator surfaced as "admin"


def test_patch_password_reset(client):
    uid = _make_user(email="pw@local")
    r = client.patch(f"/api/users/{uid}", json={"password": "brand-new-secret"})
    assert r.status_code == 200

    from app.core.database import SessionLocal
    from app.core.security import verify_password
    from app.models.entities import User

    with SessionLocal() as db:
        user = db.get(User, uid)
        assert verify_password("brand-new-secret", user.password_hash)


def test_patch_password_too_short_is_400(client):
    uid = _make_user(email="short@local")
    r = client.patch(f"/api/users/{uid}", json={"password": "short"})
    assert r.status_code == 400
    assert "8 characters" in r.json()["detail"]


def test_patch_self_role_change_blocked(client):
    # the admin editing their own row cannot change their own role
    uid = _make_user(email=_ADMIN["sub"], role="admin")
    r = client.patch(f"/api/users/{uid}", json={"role": "developer"})
    assert r.status_code == 400
    assert "your own role" in r.json()["detail"]


def test_patch_self_same_role_allowed(client):
    # sending the same role as a no-op must not be rejected
    uid = _make_user(email=_ADMIN["sub"], role="admin", full_name="Self")
    r = client.patch(f"/api/users/{uid}", json={"role": "admin", "full_name": "Self Updated"})
    assert r.status_code == 200
    assert r.json()["full_name"] == "Self Updated"


def test_patch_missing_user_is_404(client):
    assert client.patch("/api/users/999999", json={"full_name": "x"}).status_code == 404


def test_patch_email_is_immutable(client):
    uid = _make_user(email="keep@local")
    # any email field is ignored (not part of the schema); the stored email is unchanged
    r = client.patch(f"/api/users/{uid}", json={"full_name": "Kept", "email": "new@local"})
    assert r.status_code == 200
    assert r.json()["email"] == "keep@local"
