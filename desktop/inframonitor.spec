# PyInstaller spec for the Infra Monitor desktop app.
#
# Build from the REPO ROOT:
#     pyinstaller desktop/inframonitor.spec --noconfirm
#
# Paths are made absolute from SPECPATH (the directory of this spec) rather than left
# relative, because PyInstaller resolves relative spec paths against the spec's own directory
# (desktop/), not the invocation cwd — so "desktop/app.py" would wrongly become
# desktop/desktop/app.py. Deriving everything from the repo root avoids that entirely.
#
# Produces a onedir bundle at dist/InfraMonitor/ (InfraMonitor.exe + _internal/). onedir is
# deliberate: faster start, no per-launch temp extraction.

import os
import sys

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, os.pardir))
BACKEND = os.path.join(ROOT, "backend")

# collect_submodules("app") imports the package while this spec runs (before Analysis uses
# pathex), so the backend has to be importable now.
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

# The static UI is served by the backend from STATIC_DIR; bundle it at the same relative path
# the app expects under the bundle root.
datas = [(os.path.join(ROOT, "frontend", "out"), "frontend/out")]
binaries = []

# uvicorn selects its loop / http / websocket / lifespan implementations by *string* at
# runtime, so PyInstaller's static analysis never sees them. The websocket ones are
# load-bearing: the interactive shell is a WS upgrade.
hiddenimports = [
    "app.main",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan.on",
    "websockets",
    "websockets.legacy",
    "websockets.legacy.server",
    "passlib.handlers.bcrypt",
    "jose.backends.cryptography_backend",
]

hiddenimports += collect_submodules("app")

# The kubernetes client and its runtime deps are imported lazily inside app.services.kube (so
# boot never needs them), which means PyInstaller's static analysis won't see them -- collect
# them explicitly. yaml (kubeconfig parsing), google-auth (gcp auth-provider kubeconfigs),
# python-dateutil/six, oauthlib/requests-oauthlib, and websocket-client (exec/attach streams)
# are the kubernetes client's own transitive requirements.
for pkg in (
    "cryptography", "paramiko", "bcrypt", "nacl", "cffi", "pydantic", "psycopg", "pymysql", "hvac", "requests",
    "kubernetes", "yaml", "google", "dateutil", "six", "oauthlib", "requests_oauthlib", "websocket",
):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

a = Analysis(
    # NB: the entry script is launcher.py, NOT app.py — an entry script named app.py would be
    # frozen as a top-level module `app`, shadowing the backend's `app` package so that
    # `import app.main` resolves to the launcher and fails with "'app' is not a package".
    [os.path.join(ROOT, "desktop", "launcher.py")],
    pathex=[BACKEND],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # The app's own DB is SQLite, but the Database console can connect out to Postgres (psycopg)
    # and MySQL (pymysql), and the Vault integration uses hvac/requests — all collected above,
    # so they are NOT excluded. Only tkinter and the server-profile metrics stack are dropped.
    excludes=["tkinter", "prometheus_client"],
    noarchive=False,
)

# Icon format is platform-specific: Windows wants .ico, macOS wants .icns, and PyInstaller
# ignores the icon for a Linux ELF. Pass only a format the current OS understands (and only if
# the file exists) so the same spec builds unchanged on all three platforms.
if sys.platform == "win32":
    APP_ICON = os.path.join(ROOT, "desktop", "inframonitor.ico")
elif sys.platform == "darwin":
    _icns = os.path.join(ROOT, "desktop", "inframonitor.icns")
    APP_ICON = _icns if os.path.exists(_icns) else None
else:
    APP_ICON = None

pyz = PYZ(a.pure)

# ONEFILE build: everything (interpreter, libs, frontend/out, backend) is packed INTO the single
# InfraMonitor.exe — no `_internal` folder. There is no COLLECT for a onefile build; a.binaries
# and a.datas go straight into EXE. Trade-off vs the old onedir: the exe self-extracts to a temp
# dir on each launch (a second or two of startup, covered by the splash), but it is one portable
# file. sys._MEIPASS still points at the extraction dir, so launcher._base_dir() is unchanged.
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="InfraMonitor",
    debug=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    # console=False -> no console window. Flip to True while debugging a build to see backend
    # tracebacks.
    console=False,
    disable_windowed_traceback=False,
    icon=APP_ICON,
)

# macOS: wrap the executable in a proper .app bundle so it launches from Finder/Dock with the
# right name and icon (a bare Unix executable has neither). No-op on Windows/Linux.
if sys.platform == "darwin":
    app = BUNDLE(
        exe,
        name="Infra Monitor.app",
        icon=APP_ICON,
        bundle_identifier="com.inframonitor.desktop",
        info_plist={
            "CFBundleName": "Infra Monitor",
            "CFBundleDisplayName": "Infra Monitor",
            "NSHighResolutionCapable": True,
            # WKWebView content is loaded from the bundled backend over http://127.0.0.1; allow it.
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        },
    )
