# Build InfraMonitor.exe (Windows). Run from the repo root:
#     powershell -ExecutionPolicy Bypass -File desktop\build.ps1
#
# Produces dist\InfraMonitor\InfraMonitor.exe (onedir). Requires Python 3.12 (`py -3.12`) and
# Node (for the one-time UI build). Docker is NOT involved.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "== Infra Monitor desktop build ==" -ForegroundColor Cyan

# 1. Build the static UI (only needs redoing when the frontend changes).
if (-not (Test-Path "frontend\out\index.html")) {
    Write-Host "Building static UI..." -ForegroundColor Yellow
    Push-Location frontend
    npm ci
    npm run build
    Pop-Location
} else {
    Write-Host "frontend\out already built (delete it to force a rebuild)."
}

# 2. Isolated build venv with backend + desktop deps.
$venv = ".venv-desktop"
if (-not (Test-Path $venv)) {
    Write-Host "Creating build venv ($venv) with Python 3.12..." -ForegroundColor Yellow
    py -3.12 -m venv $venv
}
$py = ".\$venv\Scripts\python.exe"
& $py -m pip install --upgrade pip
& $py -m pip install -r backend\requirements.txt -r desktop\requirements.txt

# 3. Freeze.
Write-Host "Freezing with PyInstaller..." -ForegroundColor Yellow
& $py -m PyInstaller desktop\inframonitor.spec --noconfirm

$exe = Join-Path $root "dist\InfraMonitor\InfraMonitor.exe"
if (Test-Path $exe) {
    Write-Host "`nBuilt: $exe" -ForegroundColor Green
    Write-Host "Data (DB + secret) will live in %APPDATA%\InfraMonitor on first run."
} else {
    Write-Error "Build finished but $exe was not produced."
}
