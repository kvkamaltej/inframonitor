"""Tests for the gateway traffic feature (feature/gateway-traffic).

No gateway is required: Kong's http-log payload is a plain JSON document, so the
ingest path is exercised by posting the real shape Kong sends and then reading
the two screens back through their own routes.

Style mirrors tests/test_db_connections.py: DATABASE_URL + JWT_SECRET are set
before app.main imports app.core.database (the engine is built at import time).
"""

import os
import tempfile
from datetime import datetime, timezone

# must be set before app.main imports app.core.database (engine built at import time)
_TMP = tempfile.mkdtemp(prefix="inframonitor_gwtest_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP, "test.db").replace("\\", "/")
os.environ.setdefault("JWT_SECRET", "test_secret_that_is_long_enough_to_pass_validation")
os.environ["CORS_ORIGINS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


_ADMIN = {"sub": "tester@local", "role": "admin", "guest": False}


@pytest.fixture()
def client():
    from app.core.security import require_admin, require_admin_not_guest, require_user
    from app.main import app

    app.dependency_overrides[require_user] = lambda: _ADMIN
    app.dependency_overrides[require_admin] = lambda: _ADMIN
    app.dependency_overrides[require_admin_not_guest] = lambda: _ADMIN
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture()
def token(client, request):
    """Register a gateway and return the token Kong would present.

    Named per test: the SQLite file lives for the whole module, so a fixed name
    would collide with its own uniqueness check on the second test.
    """
    name = f"kong-{request.node.name}"[:120]
    res = client.post("/api/gateway/gateways", json={"name": name, "environment": "test"})
    assert res.status_code == 200, res.text
    return res.json()["token"]


def _kong(path, status, ip="10.0.0.9", method="POST", ms=3):
    """One entry shaped exactly as Kong's http-log plugin emits it."""
    return {
        "client_ip": ip,
        "started_at": int(datetime.now(timezone.utc).timestamp() * 1000),
        "request": {"method": method, "uri": path, "headers": {"user-agent": "sqlmap/1.7"}},
        "response": {"status": status},
        "latencies": {"request": ms},
        "route": {"name": path.strip("/").replace("/", "_")},
    }


# --- ingest ----------------------------------------------------------------------------------


def test_ingest_requires_a_known_token(client):
    res = client.post("/api/gateway/ingest", json=[_kong("/captcha/getCaptcha", 200)])
    assert res.status_code == 401

    res = client.post(
        "/api/gateway/ingest",
        json=[_kong("/captcha/getCaptcha", 200)],
        headers={"X-Gateway-Token": "not-a-real-token"},
    )
    assert res.status_code == 401


def test_ingest_accepts_kongs_native_batch(client, token):
    batch = [
        _kong("/captcha/getCaptcha", 200),
        _kong("/captcha/getCaptcha", 429),
        _kong("/captcha/getCaptcha", 429),
    ]
    res = client.post("/api/gateway/ingest", json=batch, headers={"X-Gateway-Token": token})
    assert res.status_code == 200, res.text
    assert res.json()["accepted"] == 3


def test_ingest_accepts_a_single_object_not_only_a_list(client, token):
    res = client.post(
        "/api/gateway/ingest",
        json=_kong("/user/UserLogout", 200),
        headers={"X-Gateway-Token": token},
    )
    assert res.status_code == 200
    assert res.json()["accepted"] == 1


def test_malformed_entries_are_skipped_not_fatal(client, token):
    # A batch is all-or-nothing at the HTTP level; one bad entry must not cost
    # the good ones, or a single odd request would blind the whole view.
    batch = [_kong("/captcha/getCaptcha", 200), {"nonsense": True}, "not-a-dict"]
    res = client.post("/api/gateway/ingest", json=batch, headers={"X-Gateway-Token": token})
    assert res.status_code == 200
    assert res.json()["accepted"] == 1


# --- the address screen -----------------------------------------------------------------------


def test_sources_counts_and_derived_columns(client, token):
    batch = (
        [_kong("/captcha/getCaptcha", 429, ip="1.1.1.1") for _ in range(8)]
        + [_kong("/captcha/getCaptcha", 200, ip="1.1.1.1") for _ in range(2)]
        + [_kong("/user/UserLogout", 200, ip="2.2.2.2")]
    )
    client.post("/api/gateway/ingest", json=batch, headers={"X-Gateway-Token": token})

    rows = client.get("/api/gateway/sources", params={"range": "5m"}).json()
    by_ip = {r["client_ip"]: r for r in rows}

    noisy = by_ip["1.1.1.1"]
    assert noisy["requests"] == 10
    assert noisy["throttled"] == 8
    assert noisy["allowed"] == 2
    assert noisy["throttled_share"] == 0.8
    assert noisy["endpoints"] == 1

    assert by_ip["2.2.2.2"]["throttled"] == 0


def test_sources_sort_is_whitelisted(client, token):
    client.post(
        "/api/gateway/ingest",
        json=[_kong("/captcha/getCaptcha", 429)],
        headers={"X-Gateway-Token": token},
    )
    assert client.get("/api/gateway/sources", params={"sort": "throttled"}).status_code == 200
    # A column name must never reach the query builder unchecked.
    bad = client.get("/api/gateway/sources", params={"sort": "client_ip; DROP TABLE users"})
    assert bad.status_code == 400


def test_range_is_whitelisted(client):
    assert client.get("/api/gateway/sources", params={"range": "5m"}).status_code == 200
    assert client.get("/api/gateway/sources", params={"range": "7 years"}).status_code == 400


# --- the drill-down ---------------------------------------------------------------------------


def test_endpoints_for_one_address_are_grouped_and_sorted(client, token):
    batch = (
        [_kong("/captcha/getCaptcha", 429, ip="9.9.9.9") for _ in range(5)]
        + [_kong("/captcha/verifyCaptcha", 200, ip="9.9.9.9") for _ in range(2)]
        + [_kong("/captcha/getCaptcha", 200, ip="8.8.8.8")]
    )
    client.post("/api/gateway/ingest", json=batch, headers={"X-Gateway-Token": token})

    rows = client.get(
        "/api/gateway/sources/9.9.9.9/endpoints", params={"range": "5m", "sort": "hits"}
    ).json()

    assert [r["path"] for r in rows] == ["/captcha/getCaptcha", "/captcha/verifyCaptcha"]
    assert rows[0]["hits"] == 5
    assert rows[0]["throttled"] == 5
    assert rows[1]["hits"] == 2
    assert rows[1]["throttled"] == 0
    # the other address's traffic must not leak into this view
    assert sum(r["hits"] for r in rows) == 7


def test_endpoint_sort_direction_is_honoured(client, token):
    batch = [_kong("/a/one", 200, ip="7.7.7.7") for _ in range(3)] + [
        _kong("/b/two", 200, ip="7.7.7.7")
    ]
    client.post("/api/gateway/ingest", json=batch, headers={"X-Gateway-Token": token})

    desc = client.get(
        "/api/gateway/sources/7.7.7.7/endpoints", params={"sort": "hits", "dir": "desc"}
    ).json()
    asc = client.get(
        "/api/gateway/sources/7.7.7.7/endpoints", params={"sort": "hits", "dir": "asc"}
    ).json()
    assert [r["hits"] for r in desc] == [3, 1]
    assert [r["hits"] for r in asc] == [1, 3]


def test_tier_and_limit_are_resolved_by_longest_prefix(client, token):
    # /user/GenerateOTPRequest is auth 5/min even though /user/ has no rule and
    # /captcha/ would match a shorter prefix on other paths.
    batch = [
        _kong("/user/GenerateOTPRequest", 429, ip="5.5.5.5"),
        _kong("/captcha/getCaptcha", 429, ip="5.5.5.5"),
        _kong("/reports/unit/summary", 429, ip="5.5.5.5"),
    ]
    client.post("/api/gateway/ingest", json=batch, headers={"X-Gateway-Token": token})

    rows = client.get("/api/gateway/sources/5.5.5.5/endpoints").json()
    tiers = {r["path"]: (r["tier"], r["limit_rule"]) for r in rows}
    assert tiers["/user/GenerateOTPRequest"] == ("auth", "5/min")
    assert tiers["/captcha/getCaptcha"] == ("captcha", "30/min")
    assert tiers["/reports/unit/summary"] == ("report", "10/min")


# --- the raw stream ---------------------------------------------------------------------------


def test_events_filter_by_status_and_path(client, token):
    batch = [
        _kong("/captcha/getCaptcha", 429, ip="4.4.4.4"),
        _kong("/captcha/getCaptcha", 200, ip="4.4.4.4"),
        _kong("/user/UserLogout", 200, ip="4.4.4.4"),
    ]
    client.post("/api/gateway/ingest", json=batch, headers={"X-Gateway-Token": token})

    throttled = client.get(
        "/api/gateway/sources/4.4.4.4/events", params={"status": 429}
    ).json()
    assert len(throttled) == 1
    assert throttled[0]["path"] == "/captcha/getCaptcha"

    one_path = client.get(
        "/api/gateway/sources/4.4.4.4/events", params={"path": "/user/UserLogout"}
    ).json()
    assert len(one_path) == 1
    assert one_path[0]["status"] == 200


def test_query_string_is_stripped_from_the_path(client, token):
    # The scanner sends payloads in the query string. They must not each become a
    # distinct endpoint, or the drill-down turns into thousands of one-hit rows.
    batch = [
        _kong("/captcha/getCaptcha?1'%20or%201=1--", 429, ip="3.3.3.3"),
        _kong("/captcha/getCaptcha?sleep(20)", 429, ip="3.3.3.3"),
        _kong("/captcha/getCaptcha", 429, ip="3.3.3.3"),
    ]
    client.post("/api/gateway/ingest", json=batch, headers={"X-Gateway-Token": token})

    rows = client.get("/api/gateway/sources/3.3.3.3/endpoints").json()
    assert len(rows) == 1
    assert rows[0]["path"] == "/captcha/getCaptcha"
    assert rows[0]["hits"] == 3

# --- regressions found running it against a live feed ------------------------------------------


def test_a_second_batch_folds_into_the_existing_rollup_row(client, token):
    """Kong posts continuously, so the second batch hits a rollup row that is
    already there. That path was never exercised: every other test posts one
    batch, and within a single request the row just inserted is still the
    aware Python object in the session's identity map. Read back in a later
    request SQLite hands it over naive -- `DateTime(timezone=True)` is a
    Postgres-only guarantee -- and comparing it to the aware timestamp just
    parsed from Kong raised TypeError, so ingest answered 500 and Kong dropped
    the batch. Pin one `started_at` so both batches share a minute bucket.
    """
    started = int(datetime.now(timezone.utc).timestamp() * 1000)

    def batch(n, status):
        out = []
        for _ in range(n):
            e = _kong("/captcha/getCaptcha", status, ip="14.139.93.243")
            e["started_at"] = started
            out.append(e)
        return out

    first = client.post("/api/gateway/ingest", json=batch(3, 200),
                        headers={"X-Gateway-Token": token})
    assert first.status_code == 200, first.text

    second = client.post("/api/gateway/ingest", json=batch(2, 429),
                         headers={"X-Gateway-Token": token})
    assert second.status_code == 200, second.text

    rows = client.get("/api/gateway/sources?range=5m").json()
    row = next(r for r in rows if r["client_ip"] == "14.139.93.243")
    assert row["requests"] == 5
    assert row["allowed"] == 3
    assert row["throttled"] == 2
    # One rollup row, not two: the second batch folded into the first.
    assert row["endpoints"] == 1


def test_timestamps_come_back_as_utc(client, token):
    """Every timestamp must carry its offset.

    SQLite returns these naive, and a naive ISO string has no offset, which
    `new Date()` reads as *local* time. On a UTC+5:30 host that ages every row
    by five and a half hours, so the page reported a request from a second ago
    as "5h ago" -- on the one column an operator watches during a scan.
    """
    client.post("/api/gateway/ingest",
                json=[_kong("/captcha/getCaptcha", 429, ip="203.0.113.7")],
                headers={"X-Gateway-Token": token})

    def aware(value):
        assert value is not None
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None

    source = next(r for r in client.get("/api/gateway/sources?range=5m").json()
                  if r["client_ip"] == "203.0.113.7")
    assert aware(source["last_seen"]), source["last_seen"]

    endpoint = client.get("/api/gateway/sources/203.0.113.7/endpoints?range=5m").json()[0]
    assert aware(endpoint["last_hit"]), endpoint["last_hit"]

    event = client.get("/api/gateway/sources/203.0.113.7/events?range=5m").json()[0]
    assert aware(event["ts"]), event["ts"]

    gateway = next(g for g in client.get("/api/gateway/gateways").json()
                   if g["last_event_at"] is not None)
    assert aware(gateway["last_event_at"]), gateway["last_event_at"]
