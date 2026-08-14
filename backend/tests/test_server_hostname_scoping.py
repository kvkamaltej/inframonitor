"""Hostname uniqueness is scoped to the GROUP (folder), not global.

The same hostname may live in different groups (BH and MH can each have a "dev" host), but two
servers with the same hostname in the SAME group is a 409. NULL/unassigned is its own bucket. IP
addresses stay globally unique. Covers the server create route and the CSV import path.

Style mirrors tests/test_db_connections.py: DATABASE_URL + JWT_SECRET are set before app.main
imports app.core.database (the engine is built at import time). NOTE: the app engine is a
process-level singleton, so test modules in one pytest run share one SQLite file -- names here are
uniquely prefixed to stay clear of folders/servers other modules create.
"""

import os
import tempfile

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_hostscopetest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


_ADMIN = {"sub": "admin@local", "role": "admin", "guest": False}


@pytest.fixture()
def client():
    from app.core.security import require_admin
    from app.main import app

    app.dependency_overrides[require_admin] = lambda: _ADMIN
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _make_folder(client, name):
    r = client.post("/api/folders", json={"name": name})
    if r.status_code == 201:
        return r.json()["id"]
    # already exists (shared engine across modules): look it up by name
    for folder in client.get("/api/folders").json():
        if folder["name"].lower() == name.lower():
            return folder["id"]
    raise AssertionError(f"could not create or find folder {name}")


def _make_server(client, hostname, ip, folder_id=None):
    payload = {"hostname": hostname, "ip_address": ip, "username": "ops"}
    if folder_id is not None:
        payload["folder_id"] = folder_id
    return client.post("/api/servers", json=payload)


# --- create route ----------------------------------------------------------------------------


def test_same_hostname_in_different_groups_succeeds(client):
    bh = _make_folder(client, "hscope-BH")
    mh = _make_folder(client, "hscope-MH")

    assert _make_server(client, "hscope-dev", "10.90.0.1", bh).status_code == 201
    # same hostname, DIFFERENT group -> allowed
    assert _make_server(client, "hscope-dev", "10.90.0.2", mh).status_code == 201


def test_same_hostname_in_same_group_is_rejected(client):
    grp = _make_folder(client, "hscope-GroupA")

    assert _make_server(client, "hscope-web", "10.90.1.1", grp).status_code == 201
    dup = _make_server(client, "hscope-web", "10.90.1.2", grp)
    assert dup.status_code == 409
    assert "already exists in this group" in dup.json()["detail"]


def test_unassigned_bucket_is_its_own_group(client):
    # two unassigned servers with the same hostname collide with each other...
    assert _make_server(client, "hscope-solo", "10.90.2.1").status_code == 201
    assert _make_server(client, "hscope-solo", "10.90.2.2").status_code == 409
    # ...but an unassigned hostname does not collide with the same hostname inside a folder
    grp = _make_folder(client, "hscope-GroupB")
    assert _make_server(client, "hscope-solo", "10.90.2.3", grp).status_code == 201


# --- CSV import --------------------------------------------------------------------------------


def test_csv_import_hostname_scoped_to_unassigned_bucket(client):
    grp = _make_folder(client, "hscope-CsvGroup")
    # a server named "hscope-shared" already lives inside a folder
    assert _make_server(client, "hscope-shared", "10.90.4.1", grp).status_code == 201

    # importing an UNASSIGNED "hscope-shared" must NOT be treated as a duplicate (different bucket)
    csv_text = "hostname,ip_address,username\nhscope-shared,10.90.4.2,ops\n"
    r = client.post("/api/servers/import", json={"csv_text": csv_text, "dry_run": False})
    assert r.status_code == 200
    body = r.json()
    assert body["created"] == 1 and body["skipped"] == 0

    # re-importing an UNASSIGNED "hscope-shared" (fresh IP, so only the hostname can collide) is now
    # a skip, because an unassigned "hscope-shared" already exists in the same (unassigned) bucket
    csv_again = "hostname,ip_address,username\nhscope-shared,10.90.4.9,ops\n"
    r2 = client.post("/api/servers/import", json={"csv_text": csv_again, "dry_run": False})
    assert r2.status_code == 200
    assert r2.json()["skipped"] == 1
