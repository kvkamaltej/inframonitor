#!/usr/bin/env bash
# Build the Infra Monitor desktop app on Linux or macOS. Run from anywhere:
#     bash desktop/build.sh
#
# Produces (onefile, from desktop/inframonitor.spec):
#   Linux:  dist/InfraMonitor            (a single executable — chmod +x, double-click or run)
#   macOS:  dist/Infra Monitor.app       (a Finder/Dock app bundle)  + dist/InfraMonitor
#
# The Windows equivalent is desktop/build.ps1. Docker is NOT involved. Data (the SQLite DB and
# the secret key) lives outside the bundle, per-user, created on first run:
#   Linux:  ~/.local/share/InfraMonitor/      (or $XDG_DATA_HOME/InfraMonitor)
#   macOS:  ~/Library/Application Support/InfraMonitor/
#
# Prereqs:
#   * Python 3.12  (python3.12; 3.11+ works too)
#   * Node + npm   (one-time static-UI build)
#   * Linux only: a Qt/WebEngine or GTK/WebKit2GTK backend for pywebview. desktop/requirements.txt
#     pins the pip-only Qt path (PySide6). For the lighter native GTK path instead, install the
#     system packages listed in desktop/README.md and `pip install pywebview[gtk]`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
echo "== Infra Monitor desktop build ($(uname -s)) =="

# 1. Build the static UI (only needs redoing when the frontend changes).
if [ ! -f "frontend/out/index.html" ]; then
    echo "Building static UI..."
    ( cd frontend && npm ci && npm run build )
else
    echo "frontend/out already built (delete it to force a rebuild)."
fi

# 2. Isolated build venv with backend + desktop deps.
PYTHON="${PYTHON:-python3.12}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON="python3"
VENV=".venv-desktop"
if [ ! -d "$VENV" ]; then
    echo "Creating build venv ($VENV) with $PYTHON..."
    "$PYTHON" -m venv "$VENV"
fi
PY="$VENV/bin/python"
"$PY" -m pip install --upgrade pip
"$PY" -m pip install -r backend/requirements.txt -r desktop/requirements.txt

# 3. Freeze.
echo "Freezing with PyInstaller..."
"$PY" -m PyInstaller desktop/inframonitor.spec --noconfirm

# 4. Report the produced artifact per-platform.
if [ "$(uname -s)" = "Darwin" ]; then
    APP="dist/Infra Monitor.app"
    if [ -d "$APP" ]; then
        echo ""
        echo "Built: $APP"
        echo "Data (DB + secret) will live in ~/Library/Application Support/InfraMonitor on first run."
    else
        echo "Build finished but $APP was not produced." >&2
        exit 1
    fi
else
    BIN="dist/InfraMonitor"
    if [ -f "$BIN" ]; then
        chmod +x "$BIN"
        echo ""
        echo "Built: $BIN"
        echo "Data (DB + secret) will live in ~/.local/share/InfraMonitor on first run."
    else
        echo "Build finished but $BIN was not produced." >&2
        exit 1
    fi
fi
