"""Tests for the Redis engine (feature/redis-view).

No Redis server is required: redis_ops._client is patched to a fakeredis client
sharing one in-memory server, so keyspaces, scanning, per-type key reads and the
command console are all exercised end to end.
"""

import fakeredis
import pytest

from app.services import redis_ops

# dummy connection args -- the patched _client ignores them
ARGS = ("localhost", 6379, "", "", "0")


@pytest.fixture()
def server():
    return fakeredis.FakeServer()


@pytest.fixture(autouse=True)
def patch_client(monkeypatch, server):
    def fake_client(host, port, username, password, db_index):
        return fakeredis.FakeStrictRedis(server=server, db=db_index)
    monkeypatch.setattr(redis_ops, "_client", fake_client)


def _seed(db_index=0):
    r = fakeredis.FakeStrictRedis(server=_seed.server, db=db_index)
    r.set("greeting", "hello world")
    r.rpush("mylist", "a", "b", "c")
    r.sadd("myset", "x", "y")
    r.hset("myhash", mapping={"f1": "v1", "f2": "v2"})
    r.zadd("myzset", {"low": 1, "high": 9})
    r.expire("greeting", 600)
    return r


def test_test_connection_pings_and_reports(server):
    msg = redis_ops.test_connection(*ARGS)
    assert "Connected to Redis at localhost:6379" in msg


def test_keyspaces_lists_dbs_with_counts(server):
    _seed.server = server
    _seed(0)
    rows = redis_ops.keyspaces(*ARGS)
    by_db = {r["db"]: r for r in rows}
    assert len(rows) >= 16  # the full logical space is listed, empty dbs included
    assert by_db[0]["keys"] == 5  # DBSIZE fallback (fakeredis has no INFO; expires needs INFO)
    assert by_db[1]["keys"] == 0


def test_scan_returns_keys_with_type_and_ttl(server):
    _seed.server = server
    _seed(0)
    result = redis_ops.scan_keys(*ARGS, 0, "*", 0, 100)
    assert result["cursor"] == 0  # small keyspace, one page
    by_key = {k["key"]: k for k in result["keys"]}
    assert by_key["mylist"]["type"] == "list"
    assert by_key["myhash"]["type"] == "hash"
    assert by_key["greeting"]["type"] == "string"
    assert 0 < by_key["greeting"]["ttl"] <= 600
    assert by_key["mylist"]["ttl"] == -1  # no expiry


def test_scan_pattern_filters(server):
    _seed.server = server
    _seed(0)
    result = redis_ops.scan_keys(*ARGS, 0, "my*", 0, 100)
    assert {k["key"] for k in result["keys"]} == {"mylist", "myset", "myhash", "myzset"}


@pytest.mark.parametrize("key,expected_type,check", [
    ("greeting", "string", lambda v: v["value"] == "hello world" and v["length"] == 11),
    ("mylist", "list", lambda v: v["value"] == ["a", "b", "c"] and v["length"] == 3),
    ("myhash", "hash", lambda v: sorted(v["value"]) == [["f1", "v1"], ["f2", "v2"]]),
    ("myzset", "zset", lambda v: v["value"] == [["low", 1.0], ["high", 9.0]]),
])
def test_get_key_formats_each_type(server, key, expected_type, check):
    _seed.server = server
    _seed(0)
    detail = redis_ops.get_key(*ARGS, 0, key)
    assert detail["type"] == expected_type
    assert check(detail), detail


def test_get_key_set_is_read_fully(server):
    _seed.server = server
    _seed(0)
    detail = redis_ops.get_key(*ARGS, 0, "myset")
    assert detail["type"] == "set"
    assert sorted(detail["value"]) == ["x", "y"]
    assert detail["length"] == 2


def test_get_missing_key_is_a_clean_error(server):
    with pytest.raises(redis_ops.RedisOpError):
        redis_ops.get_key(*ARGS, 0, "does-not-exist")


def test_command_console_runs_reads_and_writes(server):
    set_reply = redis_ops.run_command(*ARGS, 0, "SET counter 41")
    assert set_reply["command"] == "SET"
    incr = redis_ops.run_command(*ARGS, 0, "INCR counter")
    assert incr["reply"] == 42
    got = redis_ops.run_command(*ARGS, 0, "GET counter")
    assert got["reply"] == "42"  # bytes decoded for display


def test_command_quotes_are_honoured(server):
    redis_ops.run_command(*ARGS, 0, 'SET phrase "a b c"')
    got = redis_ops.run_command(*ARGS, 0, "GET phrase")
    assert got["reply"] == "a b c"


def test_command_targets_the_selected_db(server):
    redis_ops.run_command(*ARGS, 3, "SET onlyin3 yes")
    assert redis_ops.run_command(*ARGS, 3, "GET onlyin3")["reply"] == "yes"
    # a different logical db does not see it
    assert redis_ops.run_command(*ARGS, 0, "GET onlyin3")["reply"] is None


def test_empty_command_is_rejected(server):
    with pytest.raises(redis_ops.RedisOpError):
        redis_ops.run_command(*ARGS, 0, "   ")


def test_db_index_parsing():
    assert redis_ops._db_index("") == 0
    assert redis_ops._db_index("5") == 5
    with pytest.raises(redis_ops.RedisOpError):
        redis_ops._db_index("notanumber")
