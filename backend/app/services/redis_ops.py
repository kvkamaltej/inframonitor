"""Redis engine for the database module (feature/redis-view).

The rest of the database module speaks SQL through SQLAlchemy; Redis is a
key/value store, so it gets its own thin service rather than being forced through
the SQL console. Every call opens a fresh, short-lived client with the operator's
credentials, does one thing, and closes it -- nothing is pooled or stored, the
same posture as db_console.

Two surfaces sit on top of this:
  * a read-only browser -- list the logical databases, SCAN keys under a pattern,
    and read one key's value/ttl/type (element counts capped so a giant collection
    cannot be pulled in full);
  * a command console -- run an arbitrary Redis command. That is a deliberate
    power tool (the operator opted into writes); the caller decides who may reach
    it, exactly as with the SQL console.
"""

from __future__ import annotations

import shlex
from typing import Any

# redis-py is imported lazily so importing this module never requires the driver,
# and a missing install surfaces as a clean message instead of at app boot.

CONNECT_TIMEOUT_SECONDS = 6
SOCKET_TIMEOUT_SECONDS = 15

DEFAULT_PORT = 6379
# How many elements of a collection (or bytes of a string) a single key read will
# pull back, so browsing a multi-million-entry set cannot exhaust memory. The read
# reports whether it hit the cap.
VALUE_ELEMENT_CAP = 1000
STRING_BYTE_CAP = 256 * 1024
# SCAN page size hint. SCAN's COUNT is advisory, not a hard limit, but it keeps a
# page bounded on a large keyspace.
SCAN_COUNT = 300


class RedisOpError(Exception):
    """A failure safe to show the operator (bad host, auth, timeout, command error)."""


def _clean(exc: Exception) -> str:
    text = str(exc).strip() or exc.__class__.__name__
    # redis-py prefixes some errors with the class; keep it short and readable.
    return text.splitlines()[0][:300]


def _decode(value: Any) -> Any:
    """Bytes -> str for display, leaving already-decoded values untouched. Binary
    that is not valid UTF-8 is shown with replacement characters rather than
    failing the whole read."""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, (list, tuple)):
        return [_decode(v) for v in value]
    if isinstance(value, dict):
        return {_decode(k): _decode(v) for k, v in value.items()}
    return value


def _db_index(database: str | None) -> int:
    """The Redis logical database number. The saved connection stores it in the
    `database` field as text; blank means db 0."""
    raw = (database or "").strip()
    if not raw:
        return 0
    try:
        n = int(raw)
    except ValueError as exc:
        raise RedisOpError(f"Redis database must be a number (0-15), not {raw!r}") from exc
    if n < 0:
        raise RedisOpError("Redis database number cannot be negative")
    return n


def _client(host: str, port: int, username: str, password: str, db_index: int):
    try:
        import redis  # noqa: PLC0415
    except ModuleNotFoundError as exc:  # pragma: no cover - the package is a hard dep
        raise RedisOpError("The redis driver is not installed on the server") from exc

    return redis.Redis(
        host=(host or "").strip() or "127.0.0.1",
        port=port or DEFAULT_PORT,
        db=db_index,
        username=(username or "").strip() or None,
        password=password or None,
        socket_connect_timeout=CONNECT_TIMEOUT_SECONDS,
        socket_timeout=SOCKET_TIMEOUT_SECONDS,
        decode_responses=False,  # decode ourselves so binary values never crash a read
        health_check_interval=0,
    )


def test_connection(host: str, port: int, username: str, password: str, database: str) -> str:
    """PING the server and return a human-readable success line. Raises RedisOpError."""
    client = None
    try:
        client = _client(host, port, username, password, _db_index(database))
        client.ping()
        # INFO is best-effort: a green result must mean the socket + auth work (PING), but some
        # managed Redis restrict INFO, so a missing version must not fail an otherwise-good test.
        version = None
        try:
            info = client.info("server")
            version = _decode(info.get("redis_version")) if isinstance(info, dict) else None
        except Exception:
            version = None
        where = f"{(host or '').strip() or '127.0.0.1'}:{port or DEFAULT_PORT}"
        return f"Connected to Redis at {where}" + (f" — v{version}" if version else "")
    except RedisOpError:
        raise
    except Exception as exc:  # connection refused, auth, timeout, DNS ...
        raise RedisOpError(_clean(exc)) from exc
    finally:
        _close(client)


def keyspaces(host: str, port: int, username: str, password: str, database: str) -> list[dict[str, Any]]:
    """One entry per logical database (0-15), with its key count and how many keys
    carry a TTL. Databases with no keys are still listed so the operator can see the
    full space and switch into an empty one."""
    client = None
    try:
        client = _client(host, port, username, password, 0)
        # INFO keyspace gives keys + expires per db in one shot. Where it is unavailable, fall back
        # to a DBSIZE on each db (no expire count then). {'db0': {'keys': N, 'expires': M}, ...}
        try:
            info = client.info("keyspace")
        except Exception:
            info = {}
        try:
            configured = int(_decode(client.config_get("databases").get("databases", 16)))
        except Exception:
            configured = 16
        out = []
        for i in range(max(configured, 16)):
            row = info.get(f"db{i}") if isinstance(info, dict) else None
            if isinstance(row, dict):
                out.append({"db": i, "keys": int(row.get("keys", 0)), "expires": int(row.get("expires", 0))})
            else:
                fb = None
                try:
                    fb = _client(host, port, username, password, i)
                    out.append({"db": i, "keys": int(fb.dbsize()), "expires": 0})
                except Exception:
                    out.append({"db": i, "keys": 0, "expires": 0})
                finally:
                    _close(fb)
        return out
    except RedisOpError:
        raise
    except Exception as exc:
        raise RedisOpError(_clean(exc)) from exc
    finally:
        _close(client)


def scan_keys(
    host: str, port: int, username: str, password: str, database: str,
    db_index: int, pattern: str, cursor: int, count: int = SCAN_COUNT,
) -> dict[str, Any]:
    """One SCAN page: the matched keys (each with its type and TTL) and the cursor
    to pass back for the next page (0 when the sweep is complete). Pattern defaults
    to '*'. TYPE/TTL are pipelined so a page is a couple of round trips, not two per
    key."""
    client = None
    try:
        client = _client(host, port, username, password, db_index)
        match = (pattern or "*").strip() or "*"
        next_cursor, raw_keys = client.scan(cursor=cursor, match=match, count=count or SCAN_COUNT)
        keys = [_decode(k) for k in raw_keys]
        types: list[Any] = []
        ttls: list[Any] = []
        if raw_keys:
            pipe = client.pipeline(transaction=False)
            for k in raw_keys:
                pipe.type(k)
            types = pipe.execute()
            pipe = client.pipeline(transaction=False)
            for k in raw_keys:
                pipe.ttl(k)
            ttls = pipe.execute()
        rows = [
            {"key": keys[i], "type": _decode(types[i]) if types else "unknown",
             "ttl": int(ttls[i]) if ttls else -1}
            for i in range(len(keys))
        ]
        return {"keys": rows, "cursor": int(next_cursor)}
    except RedisOpError:
        raise
    except Exception as exc:
        raise RedisOpError(_clean(exc)) from exc
    finally:
        _close(client)


def get_key(
    host: str, port: int, username: str, password: str, database: str,
    db_index: int, key: str,
) -> dict[str, Any]:
    """One key's type, TTL, size, length and value, formatted by type. Collections
    are capped at VALUE_ELEMENT_CAP elements and strings at STRING_BYTE_CAP bytes;
    `truncated` says whether the cap was hit."""
    client = None
    try:
        client = _client(host, port, username, password, db_index)
        kb = key.encode() if isinstance(key, str) else key
        ktype = _decode(client.type(kb))
        if ktype == "none":
            raise RedisOpError(f"Key {key!r} does not exist in db{db_index}")
        ttl = int(client.ttl(kb))
        try:
            size = client.memory_usage(kb)
        except Exception:
            size = None

        truncated = False
        length: int | None = None
        value: Any

        if ktype == "string":
            raw = client.get(kb) or b""
            length = len(raw)
            if len(raw) > STRING_BYTE_CAP:
                raw = raw[:STRING_BYTE_CAP]
                truncated = True
            value = _decode(raw)
        elif ktype == "list":
            length = int(client.llen(kb))
            raw = client.lrange(kb, 0, VALUE_ELEMENT_CAP - 1)
            truncated = length > VALUE_ELEMENT_CAP
            value = [_decode(v) for v in raw]
        elif ktype == "set":
            length = int(client.scard(kb))
            raw = []
            for i, member in enumerate(client.sscan_iter(kb, count=SCAN_COUNT)):
                if i >= VALUE_ELEMENT_CAP:
                    truncated = True
                    break
                raw.append(_decode(member))
            value = raw
        elif ktype == "zset":
            length = int(client.zcard(kb))
            raw = client.zrange(kb, 0, VALUE_ELEMENT_CAP - 1, withscores=True)
            truncated = length > VALUE_ELEMENT_CAP
            value = [[_decode(m), s] for m, s in raw]
        elif ktype == "hash":
            length = int(client.hlen(kb))
            pairs = []
            for i, (f, v) in enumerate(client.hscan_iter(kb, count=SCAN_COUNT)):
                if i >= VALUE_ELEMENT_CAP:
                    truncated = True
                    break
                pairs.append([_decode(f), _decode(v)])
            value = pairs
        elif ktype == "stream":
            length = int(client.xlen(kb))
            entries = client.xrange(kb, count=VALUE_ELEMENT_CAP)
            truncated = length > VALUE_ELEMENT_CAP
            value = [[_decode(eid), _decode(fields)] for eid, fields in entries]
        else:
            value = f"(unsupported type: {ktype})"

        return {
            "key": key, "type": ktype, "ttl": ttl, "size_bytes": size,
            "length": length, "value": value, "truncated": truncated,
        }
    except RedisOpError:
        raise
    except Exception as exc:
        raise RedisOpError(_clean(exc)) from exc
    finally:
        _close(client)


def run_command(
    host: str, port: int, username: str, password: str, database: str,
    db_index: int, command: str,
) -> dict[str, Any]:
    """Execute one raw Redis command and return its reply, decoded for display.
    The command console -- arbitrary commands including writes -- so the route that
    exposes it gates who may call it."""
    client = None
    try:
        parts = _split_command(command)
        if not parts:
            raise RedisOpError("Enter a command, e.g. GET mykey")
        client = _client(host, port, username, password, db_index)
        reply = client.execute_command(*parts)
        return {"command": parts[0].upper(), "reply": _decode(reply)}
    except RedisOpError:
        raise
    except Exception as exc:
        raise RedisOpError(_clean(exc)) from exc
    finally:
        _close(client)


def _split_command(command: str) -> list[str]:
    text = (command or "").strip()
    if not text:
        return []
    try:
        # shlex handles quoted arguments ("SET k \"a b\"") the way a redis-cli user expects.
        return shlex.split(text)
    except ValueError:
        # An unbalanced quote: fall back to a plain split rather than erroring on it.
        return text.split()


def _close(client) -> None:
    if client is None:
        return
    try:
        client.close()
    except Exception:
        pass
