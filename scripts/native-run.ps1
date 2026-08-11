<#
  Infra Monitor -- run natively on this machine. No Docker.

  Reads .env, then starts uvicorn with the repo root as the working directory so that
  ./data/inframonitor.db and ./.env resolve the way .env describes them.

  Written for Windows PowerShell 5.1, so no &&, no ternary, no null-coalescing.
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$BindHost = "127.0.0.1",
    [switch]$Reload
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Fail([string]$text) { Write-Host "FAIL  $text" -ForegroundColor Red; exit 1 }

$venvPython = Join-Path $repo ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) { Fail "No .venv found. Run scripts\native-setup.ps1 first." }
if (-not (Test-Path (Join-Path $repo "frontend\out\index.html"))) { Fail "frontend/out is missing. Run scripts\native-setup.ps1 (it builds the UI)." }

$envFile = Join-Path $repo ".env"
if (-not (Test-Path $envFile)) { Fail "No .env found. Run scripts\native-setup.ps1 first." }

# Load .env into the process environment. pydantic-settings would read the file itself,
# but only relative to the working directory, and being explicit here means the values
# are also visible to anything else this script starts.
$settings = @{}
foreach ($line in Get-Content $envFile) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0) { continue }
    if ($trimmed.StartsWith("#")) { continue }
    $split = $trimmed.IndexOf("=")
    if ($split -lt 1) { continue }
    $key = $trimmed.Substring(0, $split).Trim()
    $value = $trimmed.Substring($split + 1).Trim()
    $settings[$key] = $value
    Set-Item -Path "Env:$key" -Value $value
}

$secret = $settings["JWT_SECRET"]
if ([string]::IsNullOrWhiteSpace($secret)) { Fail "JWT_SECRET is not set in .env." }
if ($secret -eq "change_this_secret_before_production" -or $secret.Length -lt 32) {
    Fail "JWT_SECRET is a placeholder or too short. Generate one with: .venv\Scripts\python.exe -c `"import secrets;print(secrets.token_urlsafe(48))`""
}

if ($Port -eq 0) {
    if ($settings.ContainsKey("APP_PORT")) { $Port = [int]$settings["APP_PORT"] } else { $Port = 8088 }
}

# The app package lives under backend/, but the working directory is the repo root so the
# relative sqlite path in .env lands in ./data.
$env:PYTHONPATH = Join-Path $repo "backend"
if ([string]::IsNullOrWhiteSpace($env:STATIC_DIR)) { $env:STATIC_DIR = Join-Path $repo "frontend\out" }
if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) { $env:DATABASE_URL = "sqlite:///./data/inframonitor.db" }
if ([string]::IsNullOrWhiteSpace($env:PUBLIC_URL)) { $env:PUBLIC_URL = "http://localhost:$Port" }

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    $owner = Get-Process -Id $existing[0].OwningProcess -ErrorAction SilentlyContinue
    $name = "unknown"
    if ($null -ne $owner) { $name = "$($owner.ProcessName) (PID $($owner.Id))" }
    Fail "Port $Port is already in use by $name. Stop it, or pass -Port with a different value."
}

Write-Host ""
Write-Host "Infra Monitor (native)" -ForegroundColor Cyan
Write-Host "  url      http://localhost:$Port"
Write-Host "  database $env:DATABASE_URL  (relative to $repo)"
Write-Host "  ui       $env:STATIC_DIR"
Write-Host "  stop     Ctrl+C"
Write-Host ""

$uvicornArgs = @("-m", "uvicorn", "app.main:app", "--host", $BindHost, "--port", "$Port")
if ($Reload) { $uvicornArgs += @("--reload", "--reload-dir", (Join-Path $repo "backend")) }

& $venvPython $uvicornArgs
