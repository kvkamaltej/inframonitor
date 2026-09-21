"""Tests for the DB SSH tunnel manager (app.services.db_ssh).

The forwarder itself (sshtunnel) is not exercised against a live bastion here; `_forwarder` is
patched to a fake so the manager's own logic -- direct pass-through, lazy open, reuse, signature
invalidation on edit, and close -- is covered deterministically.
"""

import types

import pytest

from app.services import db_ssh


class _FakeForwarder:
    _next_port = 40000

    def __init__(self):
        self.is_active = True
        _FakeForwarder._next_port += 1
        self.local_bind_port = _FakeForwarder._next_port
        self.stopped = False

    def stop(self):
        self.stopped = True
        self.is_active = False


def _conn(**over):
    base = dict(
        public_id="c1", host="db.internal", port=5432,
        ssh_host="", ssh_port=22, ssh_username="",
        encrypted_ssh_password="", encrypted_ssh_private_key="",
    )
    base.update(over)
    return types.SimpleNamespace(**base)


@pytest.fixture(autouse=True)
def fake_forwarder(monkeypatch):
    made: list[_FakeForwarder] = []

    def fake(*args, **kwargs):
        f = _FakeForwarder()
        made.append(f)
        return f

    monkeypatch.setattr(db_ssh, "_forwarder", fake)
    # start from a clean registry every test
    db_ssh._tunnels.clear()
    yield made
    db_ssh._tunnels.clear()


def test_no_ssh_host_is_a_direct_passthrough(fake_forwarder):
    host, port = db_ssh.target(_conn())
    assert (host, port) == ("db.internal", 5432)
    assert fake_forwarder == []  # no tunnel opened


def test_ssh_host_opens_a_tunnel_and_returns_local_port(fake_forwarder):
    host, port = db_ssh.target(_conn(ssh_host="bastion.example"))
    assert host == "127.0.0.1"
    assert port == fake_forwarder[0].local_bind_port
    assert len(fake_forwarder) == 1


def test_tunnel_is_reused_across_calls(fake_forwarder):
    conn = _conn(ssh_host="bastion.example")
    a = db_ssh.target(conn)
    b = db_ssh.target(conn)
    assert a == b
    assert len(fake_forwarder) == 1  # opened once, reused


def test_changed_target_reopens_the_tunnel(fake_forwarder):
    first = db_ssh.target(_conn(ssh_host="bastion.example", host="db1"))
    # same public_id, but the DB host changed -> the cached forwarder is stale and must be replaced
    second = db_ssh.target(_conn(ssh_host="bastion.example", host="db2"))
    assert len(fake_forwarder) == 2
    assert fake_forwarder[0].stopped is True
    assert first != second


def test_close_stops_and_forgets_the_tunnel(fake_forwarder):
    conn = _conn(ssh_host="bastion.example")
    db_ssh.target(conn)
    db_ssh.close(conn.public_id)
    assert fake_forwarder[0].stopped is True
    # a subsequent call opens a fresh one
    db_ssh.target(conn)
    assert len(fake_forwarder) == 2


def test_temp_target_direct_when_no_ssh(fake_forwarder):
    host, port, fwd = db_ssh.temp_target("", 22, "", "", "", "db.internal", 3306)
    assert (host, port) == ("db.internal", 3306)
    assert fwd is None


def test_temp_target_opens_a_one_shot_tunnel(fake_forwarder):
    host, port, fwd = db_ssh.temp_target("bastion.example", 22, "ubuntu", "pw", "", "db.internal", 3306)
    assert host == "127.0.0.1"
    assert fwd is fake_forwarder[0]
    db_ssh.stop(fwd)
    assert fwd.stopped is True
