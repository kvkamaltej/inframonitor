# Infra Monitor — desktop app

Packages the exact same FastAPI backend + static UI as a **standalone native desktop app**:
one window, no Docker, no browser, no server to operate. The backend runs on a private
`127.0.0.1` port inside the app; a native OS webview shows the UI — **WebView2 on Windows,
WKWebView on macOS, WebKit2GTK/Qt on Linux**. Runs on all three; the binary for each is built
on that OS (they are not cross-compilable — see [Building](#building)).

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

## Building

One PyInstaller spec (`desktop/inframonitor.spec`, **onefile**) builds on all three OSes. Each
script builds the static UI once, makes an isolated `.venv-desktop`, and freezes.

| OS | Command | Output |
|----|---------|--------|
| Windows | `powershell -ExecutionPolicy Bypass -File desktop\build.ps1` | `dist\InfraMonitor.exe` |
| Linux | `bash desktop/build.sh` | `dist/InfraMonitor` (executable) |
| macOS | `bash desktop/build.sh` | `dist/Infra Monitor.app` |

A PyInstaller build **only runs on the OS it targets** — you cannot cross-compile the Mac/Linux
binaries from Windows. To produce all three from one trigger, use the GitHub Actions workflow
`.github/workflows/desktop-build.yml`: run it from the **Actions** tab (workflow_dispatch) or
push a `v*` tag, and it builds + smoke-tests Windows, Linux and macOS and uploads each as an
artifact (and attaches them to the Release on a tag).

### Signed Windows installer
```
powershell -ExecutionPolicy Bypass -File desktop\build-installer.ps1
```
Wraps `dist\InfraMonitor.exe` in an Inno Setup installer at `dist-installer\InfraMonitor-Setup.exe`
and signs both. Set `CODESIGN_PFX` + `CODESIGN_PFX_PASSWORD` to a real code-signing cert to clear
SmartScreen elsewhere; otherwise a self-signed cert is used (trusted on this machine only).

### App icon (the asset baked into the build)
The window / taskbar / installer icon is **`desktop/inframonitor.ico`** — a teal server-stack with a
green status LED. It is embedded into the exe by `inframonitor.spec` (`icon=`) and into the installer
by `installer.iss`, so it shows on the built desktop app automatically. Preview it at
`desktop/inframonitor-preview.png`. To change it, edit `desktop/gen_icon.py` and run
`python desktop/gen_icon.py` (needs Pillow) to regenerate the `.ico` + preview PNG, then rebuild.
(macOS uses `.icns` if present; Linux ELF binaries carry no icon — see the spec's platform-aware
`APP_ICON`.)

### Platform notes / gotchas
- **Windows — WebView2 runtime** ships with Windows 11 and updated Windows 10; if a target lacks
  it, bundle Microsoft's Evergreen bootstrapper with the installer.
- **Linux — webview backend.** `desktop/requirements.txt` pins the pip-only **Qt** path (PySide6,
  Qt libs bundled in the wheel). At runtime Qt needs a few system `.so`s present (`libegl1`,
  `libxkbcommon0`, `libnss3`, …; the CI workflow apt-installs them). For the lighter native
  **GTK/WebKit2GTK** path instead, install system packages and use the GTK extra:
  ```
  sudo apt install gir1.2-webkit2-4.1 python3-gi python3-gi-cairo libgirepository1.0-dev   # Debian/Ubuntu
  pip install 'pywebview[gtk]'
  ```
- **macOS** uses the native Cocoa/WKWebView backend (pyobjc, pulled in automatically). The spec's
  `BUNDLE` step produces `Infra Monitor.app` so it launches from Finder/Dock with icon + name.
  Unsigned/unnotarized apps trigger Gatekeeper on other Macs; sign & notarize with an Apple
  Developer ID to distribute.
- If a built app closes instantly, flip `console=False` → `True` in `inframonitor.spec` to see the
  backend traceback, and check PyInstaller warnings for a missing hidden import (paramiko/
  cryptography/bcrypt — the spec already collects them).
