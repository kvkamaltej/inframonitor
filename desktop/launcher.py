"""Standalone desktop entrypoint for Infra Monitor.

Runs the existing FastAPI backend on a private 127.0.0.1 port and shows it in a native OS
webview window. No Docker, no separate browser, no server to operate: one double-clickable
app. Its database and secret live under the per-user application-data directory, so
reinstalling or upgrading the app never touches them — the desktop analogue of the
container's named data volume.

The whole app is intentionally the *same* backend the server deployment runs. The static UI
already talks to a relative `/api`, so pointing a webview at http://127.0.0.1:<port> "just
works" with no rebuild.

Run modes:
  * normal:   python desktop/launcher.py       -> starts the backend and opens the window
  * headless: INFRAMONITOR_DESKTOP_HEADLESS=1  -> starts the backend, prints the URL, exits
              (used to smoke-test the bootstrap without a display or pywebview installed)

The entry script is named launcher.py, NOT app.py, on purpose: PyInstaller would freeze an
`app.py` entry script as a top-level `app` module, shadowing the backend's `app` package.
"""

from __future__ import annotations

import os
import secrets
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path


# Shown the instant the window can render, while the backend finishes booting and WebView2
# warms up. Self-contained (no network, no external assets) and dark by default so there is no
# white flash before the app — matches the app's "Comfortable Dark" palette.
_SPLASH_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#1a1b26;color:#c0caf5;
    font-family:'Segoe UI',system-ui,-apple-system,sans-serif;}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;}
  .spinner{width:40px;height:40px;border:4px solid #2f3549;border-top-color:#2dd4bf;
    border-radius:50%;animation:spin .9s linear infinite;}
  @keyframes spin{to{transform:rotate(360deg);}}
  .logo{font-size:22px;font-weight:600;letter-spacing:.3px;}
  .logo b{color:#2dd4bf;font-weight:600;}
  .sub{font-size:13px;color:#8b95bd;}
</style></head>
<body><div class="wrap">
  <div class="spinner"></div>
  <div class="logo">Infra <b>Monitor</b></div>
  <div class="sub">Starting up…</div>
</div></body></html>"""

# Shown only if the backend never becomes healthy — points at the log the launcher now writes.
_ERROR_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#1a1b26;color:#c0caf5;
    font-family:'Segoe UI',system-ui,-apple-system,sans-serif;}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:14px;text-align:center;padding:0 40px;}
  .title{font-size:18px;font-weight:600;color:#f7768e;}
  .sub{font-size:13px;color:#8b95bd;max-width:560px;line-height:1.5;}
  code{background:#24283b;padding:2px 6px;border-radius:6px;color:#c0caf5;}
</style></head>
<body><div class="wrap">
  <div class="title">Infra Monitor could not start</div>
  <div class="sub">The backend did not become ready. See
    <code>%APPDATA%\\InfraMonitor\\runtime.log</code> and
    <code>startup-error.log</code> for details, then reopen the app.</div>
</div></body></html>"""


def _is_frozen() -> bool:
    # PyInstaller sets both of these on the frozen executable.
    return getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS")


def _base_dir() -> Path:
    """Directory the bundled resources (backend package, frontend/out) sit under.

    Frozen: PyInstaller unpacks datas to sys._MEIPASS. In a dev checkout: the repo root.
    """
    if _is_frozen():
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent


def _data_dir() -> Path:
    """Per-user, writable directory for the DB + secret. Created if missing.

    Survives app upgrades because it lives outside the install/bundle. Override with
    INFRAMONITOR_DATA_DIR (used by tests so they don't touch the real profile).
    """
    override = os.environ.get("INFRAMONITOR_DATA_DIR")
    if override:
        target = Path(override)
    elif sys.platform.startswith("win"):
        root = Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming"))
        target = root / "InfraMonitor"
    elif sys.platform == "darwin":
        target = Path.home() / "Library" / "Application Support" / "InfraMonitor"
    else:
        root = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
        target = root / "InfraMonitor"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _load_or_create_secret(data_dir: Path) -> str:
    """The one secret the app must keep forever.

    JWT_SECRET signs logins AND is the Fernet key encrypting stored SSH credentials, so it is
    generated once and persisted (0600) in the data dir. Losing it makes every stored
    credential undecryptable — same rule as the server deployment, enforced here automatically.
    """
    key_file = data_dir / "secret.key"
    if key_file.exists():
        existing = key_file.read_text(encoding="utf-8").strip()
        if len(existing) >= 32:
            return existing
    secret = secrets.token_urlsafe(48)
    key_file.write_text(secret, encoding="utf-8")
    try:
        os.chmod(key_file, 0o600)
    except OSError:
        # best-effort on filesystems without POSIX perms (e.g. some Windows setups)
        pass
    return secret


def _free_port() -> int:
    # Bind to port 0 and let the OS pick a free ephemeral port on loopback only.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _configure_env(data_dir: Path, base_dir: Path) -> None:
    os.environ.setdefault("JWT_SECRET", _load_or_create_secret(data_dir))
    os.environ["DATABASE_URL"] = f"sqlite:///{(data_dir / 'inframonitor.db').as_posix()}"
    os.environ["STATIC_DIR"] = str(base_dir / "frontend" / "out")
    # A single-machine desktop app has nothing to scrape it and nothing to link to.
    os.environ.setdefault("METRICS_ENABLED", "false")
    # In a dev checkout the backend package is not on sys.path; add it. When frozen it is
    # baked into the executable (pathex in the .spec) and this is a no-op.
    backend = base_dir / "backend"
    if backend.is_dir() and str(backend) not in sys.path:
        sys.path.insert(0, str(backend))


def _redirect_std_streams(data_dir: Path) -> None:
    """Give stdout/stderr a real destination when frozen with no console.

    A PyInstaller windowed build (console=False), launched by double-click, has
    `sys.stdout is None` and `sys.stderr is None`. Anything that writes to them — uvicorn's
    logging, the backend's startup banner, a stray print — then raises AttributeError during
    startup, which is exactly why the backend died before creating its DB and no window opened.
    Point both at a rolling log file so those writes succeed and we also get diagnostics.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        log = open(data_dir / "runtime.log", "a", buffering=1, encoding="utf-8", errors="replace")
    except OSError:
        return
    if sys.stdout is None:
        sys.stdout = log
    if sys.stderr is None:
        sys.stderr = log


def _run_server(port: int) -> None:
    try:
        import uvicorn
        from app.main import app

        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
        server = uvicorn.Server(config)
        # Signal handlers can only be installed on the main thread, and this runs on a worker
        # thread so the webview owns the main thread. No-op them rather than crash on startup.
        server.install_signal_handlers = lambda: None  # type: ignore[assignment]
        server.run()
    except BaseException:
        # This runs on a worker thread; an unhandled exception here would otherwise vanish
        # (its stderr may be None) and only show up as "backend never became healthy". Record it.
        import traceback

        try:
            (_data_dir() / "startup-error.log").write_text(traceback.format_exc(), encoding="utf-8")
        except OSError:
            pass
        raise


def _wait_healthy(port: int, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/health"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def main() -> int:
    base_dir = _base_dir()
    data_dir = _data_dir()
    # Must happen before the server thread starts (and before any print/logging), or a windowed
    # frozen build crashes writing to a None stream.
    _redirect_std_streams(data_dir)
    _configure_env(data_dir, base_dir)

    port = int(os.environ.get("INFRAMONITOR_DESKTOP_PORT") or _free_port())
    threading.Thread(target=_run_server, args=(port,), daemon=True).start()
    url = f"http://127.0.0.1:{port}/"

    # Headless: prove the backend boots (CI / smoke test) without a display or pywebview.
    if os.environ.get("INFRAMONITOR_DESKTOP_HEADLESS") == "1":
        if not _wait_healthy(port):
            print("Infra Monitor backend did not become healthy in time.", file=sys.stderr)
            return 1
        message = f"HEADLESS OK: serving {url}  (data dir: {data_dir})"
        print(message)
        # A windowed (console=False) frozen build has no visible stdout, so also drop a
        # sentinel file when asked, letting a build check confirm the packaged backend booted.
        marker = os.environ.get("INFRAMONITOR_DESKTOP_HEALTHFILE")
        if marker:
            try:
                Path(marker).write_text(message, encoding="utf-8")
            except OSError:
                pass
        return 0

    # Imported here, not at module top, so the headless path needs neither pywebview nor a
    # webview runtime installed.
    import webview

    # Show the splash straight away (inline HTML, no wait), THEN swap to the app once the
    # backend is healthy. Previously the window was created only after health passed, so the
    # user stared at nothing during the backend boot + WebView2 cold-start.
    window = webview.create_window(
        "Infra Monitor",
        html=_SPLASH_HTML,
        width=1400,
        height=900,
        min_size=(940, 600),
    )

    def _load_app_when_ready() -> None:
        # Runs on a pywebview worker thread once the GUI loop is up; its load_* calls are
        # marshalled back onto the UI thread by pywebview.
        if _wait_healthy(port):
            window.load_url(url)
        else:
            window.load_html(_ERROR_HTML)

    # Blocks on the main thread until the window is closed; the daemon server thread then dies
    # with the process.
    webview.start(_load_app_when_ready)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
