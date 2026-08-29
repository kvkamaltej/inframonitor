"""CSV import's `group` column, and the Excel inventory export.

Two features that arrived together for the fleet onboarding: a CSV may name the group each
server belongs to (creating it if it does not exist), and the whole visible inventory can be
downloaded as an .xlsx.

Style mirrors tests/test_server_hostname_scoping.py: DATABASE_URL + JWT_SECRET are set before
app.main imports app.core.database (the engine is built at import time). The app engine is a
process-level singleton shared by every test module in a run, so names here are uniquely
prefixed to stay clear of rows other modules create.
"""

import io
import os
import tempfile

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_impexptest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


_ADMIN = {"sub": "admin@local", "role": "admin", "guest": False}
_HEADER = "hostname,ip_address,username,group,server_type\n"


@pytest.fixture()
def client():
    from app.core.security import require_admin, require_user
    from app.main import app

    app.dependency_overrides[require_admin] = lambda: _ADMIN
    app.dependency_overrides[require_user] = lambda: _ADMIN
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _import(client, csv_text, dry_run=False):
    response = client.post("/api/servers/import", json={"csv_text": csv_text, "dry_run": dry_run})
    assert response.status_code == 200, response.text
    return response.json()


def _folder_named(client, name):
    for folder in client.get("/api/folders").json():
        if folder["name"] == name:
            return folder
    return None


def test_group_column_creates_the_folder_and_assigns_members(client):
    result = _import(client, _HEADER + (
        "impexp-a,10.90.1.1,root,ImpExp Alpha,application\n"
        "impexp-b,10.90.1.2,root,ImpExp Alpha,database\n"
        "impexp-c,10.90.1.3,root,ImpExp Beta,application\n"
    ))
    assert (result["created"], result["failed"]) == (3, 0)
    # one folder per distinct name, created by the import itself -- not one per row
    assert _folder_named(client, "ImpExp Alpha")["server_count"] == 2
    assert _folder_named(client, "ImpExp Beta")["server_count"] == 1


def test_group_column_reuses_an_existing_folder_case_insensitively(client):
    client.post("/api/folders", json={"name": "ImpExp Gamma"})
    _import(client, _HEADER + "impexp-d,10.90.1.4,root,impexp gamma,application\n")
    # matched the existing "ImpExp Gamma" rather than creating a second, differently-cased one
    assert [f["name"] for f in client.get("/api/folders").json()].count("ImpExp Gamma") == 1
    assert _folder_named(client, "ImpExp Gamma")["server_count"] == 1


def test_same_hostname_in_two_groups_is_not_a_duplicate(client):
    result = _import(client, _HEADER + (
        "impexp-dev,10.90.2.1,root,ImpExp BH,application\n"
        "impexp-dev,10.90.2.2,root,ImpExp MH,application\n"
    ))
    # hostname uniqueness is per-group, so both rows land; the IPs differ, which stays global
    assert (result["created"], result["skipped"]) == (2, 0)


def test_reimporting_the_same_rows_skips_instead_of_duplicating(client):
    csv_text = _HEADER + "impexp-idem,10.90.3.1,root,ImpExp Idem,application\n"
    assert _import(client, csv_text)["created"] == 1
    repeat = _import(client, csv_text)
    assert (repeat["created"], repeat["skipped"]) == (0, 1)


def test_excel_quoted_headers_are_still_matched(client):
    # a CSV saved out of Excel can arrive with doubled quotes around header names
    result = _import(client, '"""hostname""","""ip_address""",username,"""group"""\n' + "impexp-q,10.90.4.1,root,ImpExp Quoted\n")
    assert (result["created"], result["failed"]) == (1, 0)
    assert _folder_named(client, "ImpExp Quoted")["server_count"] == 1


def test_export_returns_a_readable_workbook_with_the_group_column(client):
    openpyxl = pytest.importorskip("openpyxl")
    _import(client, _HEADER + "impexp-x,10.90.5.1,root,ImpExp Export,application\n")

    response = client.get("/api/servers/export.xlsx")
    assert response.status_code == 200, response.text
    assert "spreadsheetml" in response.headers["content-type"]
    assert ".xlsx" in response.headers["content-disposition"]

    sheet = openpyxl.load_workbook(io.BytesIO(response.content)).active
    headers = [cell.value for cell in sheet[1]]
    assert headers[:6] == ["Hostname", "Alias", "IP Address", "SSH Port", "Username", "Group"]
    rows = {row[0]: row for row in sheet.iter_rows(min_row=2, values_only=True)}
    assert rows["impexp-x"][5] == "ImpExp Export"
    # the header row is frozen and filterable, so the sheet opens usable
    assert sheet.freeze_panes == "A2"


def test_export_never_leaks_credentials(client):
    pytest.importorskip("openpyxl")
    secret = "impexp-plaintext-password"
    _import(client, "hostname,ip_address,username,password\n" + f"impexp-secret,10.90.6.1,root,{secret}\n")

    response = client.get("/api/servers/export.xlsx")
    assert response.status_code == 200
    # the workbook is a zip of XML; the password must not appear anywhere in those bytes
    assert secret.encode() not in response.content
    sheet = pytest.importorskip("openpyxl").load_workbook(io.BytesIO(response.content)).active
    headers = [cell.value for cell in sheet[1]]
    assert "Password" not in headers and "Private Key" not in headers
    row = {r[0]: r for r in sheet.iter_rows(min_row=2, values_only=True)}["impexp-secret"]
    assert row[headers.index("Credentials")] == "Yes"
