# PyInstaller spec for the Infra Monitor desktop app.
#
# Build from the REPO ROOT (so the relative paths below resolve):
#     pyinstaller desktop/inframonitor.spec --noconfirm
#
# Produces a onedir bundle at dist/InfraMonitor/ with InfraMonitor.exe inside. onedir (not
# onefile) is deliberate: it starts faster and avoids the onefile temp-extract on every
# launch. Switch EXE(exclude_binaries=...) / add a onefile EXE if a single file is required.

from PyInstaller.utils.hooks import collect_all, collect_submodules

# The static UI is served by the backend from STATIC_DIR; bundle it as data at the same
# relative path the app expects under sys._MEIPASS.
datas = [("frontend/out", "frontend/out")]
binaries = []

# uvicorn selects its loop / http / websocket / lifespan implementations by *string* at
# runtime, so PyInstaller's static analysis never sees them. Name them explicitly. The
# websocket ones are load-bearing here: the interactive shell is a WS upgrade.
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
    # passlib picks its bcrypt backend dynamically; python-jose picks its crypto backend too.
    "passlib.handlers.bcrypt",
    "jose.backends.cryptography_backend",
]

# Freeze the whole backend package (its modules are imported lazily inside app.py).
hiddenimports += collect_submodules("app")

# Native-extension packages whose data/binaries PyInstaller's default hooks miss parts of.
for pkg in ("cryptography", "paramiko", "bcrypt", "nacl", "cffi", "pydantic"):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

a = Analysis(
    ["desktop/app.py"],
    # Make the backend package importable at freeze time so its dependency tree is pulled in.
    pathex=["backend"],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Desktop is SQLite-only; the Postgres driver and the monitoring stack are server-profile
    # only, and tkinter is never used. Dropping them slims the bundle. (If a build errors on a
    # missing psycopg symbol, remove it from here — SQLAlchemy only imports it for a pg URL.)
    excludes=["tkinter", "psycopg", "prometheus_client"],
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
    # console=False -> no console window. Flip to True while debugging a build so backend
    # tracebacks are visible.
    console=False,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="InfraMonitor",
)
