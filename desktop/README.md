# Infra Monitor — desktop app (experimental)

Packages the exact same FastAPI backend + static UI as a **standalone native desktop app**:
one window, no Docker, no browser, no server to operate. The backend runs on a private
`127.0.0.1` port inside the app; a native OS webview (WebView2 on Windows) shows the UI.

This is a **personal, per-machine** tool: each install has its **own** local database and
`JWT_SECRET`, independent of the shared server deployment. It does not replace the server —
it sits beside it.

## Where data lives

On first launch the app creates, and thereafter reuses:

| OS | Location |
|----|----------|
| Windows | `%APPDATA%\InfraMonitor\` |
| macOS | `~/Library/Application Support/InfraMonitor/` |
| Linux | `~/.local/share/InfraMonitor/` |

It holds `inframonitor.db` (SQLite) and `secret.key`. This dir is **outside** the app bundle,
so reinstalling/upgrading never wipes it — the desktop analogue of the container's named
volume. **Back up `secret.key` with the DB**: it is the Fernet key for the stored SSH
credentials, so losing it makes them undecryptable.

## Run from source (no build)

```
INFRAMONITOR_DESKTOP_HEADLESS=1 python desktop/launcher.py   # smoke test: boots backend, prints URL, exits
python desktop/launcher.py                                    # opens the real window (needs pywebview)
```

`pip install -r desktop/requirements.txt` first for the windowed run. Python **3.12** — the
default 3.9 cannot run the backend.

## Build a Windows .exe

```
powershell -ExecutionPolicy Bypass -File desktop\build.ps1
```

Output: `dist\InfraMonitor\InfraMonitor.exe` (onedir bundle). The script builds the static UI
once, creates an isolated `.venv-desktop`, and freezes with PyInstaller via
`desktop/inframonitor.spec`.

### Notes / gotchas
- **WebView2 runtime** is required on Windows. It ships with Windows 11 and updated Windows
  10; if a target lacks it, bundle Microsoft's Evergreen bootstrapper with the installer.
- If the built exe closes instantly, flip `console=False` → `True` in `inframonitor.spec` to
  see the backend traceback, and check the PyInstaller warnings for a missing hidden import
  (paramiko/cryptography/bcrypt are the usual suspects — the spec already collects them).
- **Not yet done** (incremental follow-ons): a code-signed MSI/NSIS installer, auto-update,
  an app icon, and macOS/Linux builds (the entrypoint is already cross-platform; only the
  packaging step is Windows-first here).
