"""PostgreSQL backup / restore via the pg client binaries (feature/db-connect follow-on).

A thin, safety-first wrapper around pg_dump / pg_restore / psql:

  * commands are built as argv LISTS and handed to subprocess.run -- never assembled into a shell
    string -- so a host, database, or user value can never break out into shell metacharacters;
  * the password is passed to the child through the PGPASSWORD environment variable, never on the
    command line (where it would be visible in the process list);
  * the binaries are resolved on PATH, or via the PG_BIN_DIR / PG_DUMP_PATH-style env overrides,
    and a clean DbConsoleError is raised when they are missing rather than a raw OSError.

Only PostgreSQL is supported here; the routes gate other engines out with a 400 before calling in.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone

from app.services.db_console import DbConsoleError

# Generous but bounded: a dump/restore of a real database can take a while, but must not hang the
# worker forever on an unreachable host or a wedged child.
BACKUP_TIMEOUT_SECONDS = 3600
RESTORE_TIMEOUT_SECONDS = 3600

# per-binary env override -> a full path to that executable, honored before PG_BIN_DIR and PATH.
_BIN_ENV = {"pg_dump": "PG_DUMP_PATH", "pg_restore": "PG_RESTORE_PATH", "psql": "PSQL_PATH"}

# custom-format dumps (pg_dump -Fc) begin with this magic; a plain-SQL dump does not, so restore
# can pick pg_restore vs psql -f from the file's own first bytes.
_PGDMP_MAGIC = b"PGDMP"


def _resolve_binary(name: str) -> str:
    """Return an absolute path to a pg client binary, or raise DbConsoleError if it is not found.

    Resolution order: the per-binary env override (e.g. PG_DUMP_PATH), then PG_BIN_DIR/<name>
    (with a .exe fallback on Windows), then the binary as found on PATH.
    """
    override = os.environ.get(_BIN_ENV.get(name, ""))
    if override and os.path.isfile(override):
        return override
    bin_dir = os.environ.get("PG_BIN_DIR")
    if bin_dir:
        candidate = os.path.join(bin_dir, name)
        if os.path.isfile(candidate):
            return candidate
        if os.path.isfile(candidate + ".exe"):
            return candidate + ".exe"
    found = shutil.which(name)
    if found:
        return found
    raise DbConsoleError(f"{name} not found on the server; install postgresql-client")


def _safe_name(value: str) -> str:
    """A filesystem-safe token from a database name for use in a download filename."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", (value or "").strip())
    cleaned = cleaned.strip("._-")
    return cleaned or "database"


def _child_env(password: str) -> dict:
    env = dict(os.environ)
    if password:
        env["PGPASSWORD"] = password
    else:
        env.pop("PGPASSWORD", None)
    return env


def _clean_stderr(stderr) -> str:
    """Collapse pg client stderr into a single, safe-to-show line."""
    if isinstance(stderr, (bytes, bytearray)):
        text = bytes(stderr).decode("utf-8", "replace")
    else:
        text = str(stderr or "")
    first = next((line.strip() for line in text.splitlines() if line.strip()), text.strip())
    return first[:500]


def _base_args(binary: str, fields: dict, database: str) -> list[str]:
    return [
        binary,
        "-h", str(fields.get("host") or ""),
        "-p", str(fields.get("port") or 5432),
        "-U", str(fields.get("username") or ""),
        "-d", database,
    ]


def backup(fields: dict, database: str) -> tuple[str, str]:
    """Dump `database` to a temp file in pg custom format and return (temp_path, download_filename).

    `fields` carries host/port/username/password. The caller is responsible for deleting the
    returned temp file once it has been streamed. Raises DbConsoleError on any failure.
    """
    db_name = (database or "").strip()
    if not db_name:
        raise DbConsoleError("A database name is required for backup")
    binary = _resolve_binary("pg_dump")

    fd, path = tempfile.mkstemp(prefix="pgbackup_", suffix=".dump")
    os.close(fd)
    # -Fc = custom format (compressed, restorable with pg_restore). -f writes straight to the file.
    args = _base_args(binary, fields, db_name) + ["-Fc", "-f", path]
    try:
        proc = subprocess.run(
            args,
            env=_child_env(fields.get("password") or ""),
            capture_output=True,
            timeout=BACKUP_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        _safe_remove(path)
        raise DbConsoleError("pg_dump timed out") from exc
    except OSError as exc:
        _safe_remove(path)
        raise DbConsoleError(f"pg_dump could not be run: {exc}") from exc
    if proc.returncode != 0:
        _safe_remove(path)
        raise DbConsoleError(_clean_stderr(proc.stderr) or "pg_dump failed")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"{_safe_name(db_name)}-{stamp}.dump"
    return path, filename


def restore(fields: dict, database: str, upload_path: str) -> str:
    """Restore `upload_path` into `database` and return a short success message.

    A custom-format dump (pg_dump -Fc, magic "PGDMP") is loaded with pg_restore --clean --if-exists;
    anything else is treated as plain SQL and piped through psql -f. Raises DbConsoleError on failure.
    """
    db_name = (database or "").strip()
    if not db_name:
        raise DbConsoleError("A database name is required for restore")
    if not os.path.isfile(upload_path):
        raise DbConsoleError("Uploaded file not found")

    with open(upload_path, "rb") as handle:
        head = handle.read(len(_PGDMP_MAGIC))
    is_custom = head == _PGDMP_MAGIC

    if is_custom:
        binary = _resolve_binary("pg_restore")
        # --clean --if-exists drops existing objects first so a restore over a populated database
        # replaces rather than collides; the dump file is the trailing positional argument.
        args = _base_args(binary, fields, db_name) + ["--clean", "--if-exists", upload_path]
        label = "pg_restore"
    else:
        binary = _resolve_binary("psql")
        # -v ON_ERROR_STOP=1 turns the first SQL error into a non-zero exit instead of plowing on.
        args = _base_args(binary, fields, db_name) + ["-v", "ON_ERROR_STOP=1", "-f", upload_path]
        label = "psql"

    try:
        proc = subprocess.run(
            args,
            env=_child_env(fields.get("password") or ""),
            capture_output=True,
            timeout=RESTORE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise DbConsoleError(f"{label} timed out") from exc
    except OSError as exc:
        raise DbConsoleError(f"{label} could not be run: {exc}") from exc
    if proc.returncode != 0:
        raise DbConsoleError(_clean_stderr(proc.stderr) or f"{label} failed")
    return f"Restored {database} with {label}"


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
