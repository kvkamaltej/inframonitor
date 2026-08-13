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

for pkg in ("cryptography", "paramiko", "bcrypt", "nacl", "cffi", "pydantic", "psycopg", "pymysql", "hvac", "requests"):
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

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="InfraMonitor",
    debug=False,
    strip=False,
    upx=False,
    # console=False -> no console window. Flip to True while debugging a build to see backend
    # tracebacks.
    console=False,
    disable_windowed_traceback=False,
    icon=os.path.join(ROOT, "desktop", "inframonitor.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="InfraMonitor",
)
