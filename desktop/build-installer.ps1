# Build a SIGNED Windows installer for Infra Monitor.
#   powershell -ExecutionPolicy Bypass -File desktop\build-installer.ps1
#
# Prereqs: desktop\build.ps1 has produced dist\InfraMonitor.exe, and Inno Setup 6 is installed
# (winget install JRSoftware.InnoSetup).
#
# Signing certificate, in order of preference:
#   1. A real code-signing cert: set CODESIGN_PFX (path to .pfx) and CODESIGN_PFX_PASSWORD.
#      This is what actually clears the SmartScreen "unknown publisher" warning on other PCs.
#   2. Otherwise a self-signed cert is created/reused. It makes the binaries signed and is
#      trusted on THIS machine only; other machines still show SmartScreen (self-signed cannot
#      establish publisher trust). Status "UnknownError" from Get-AuthenticodeSignature just
#      means "signed but the chain is not trusted here", which is expected for self-signed.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$exe = Join-Path $root "dist\InfraMonitor.exe"
if (-not (Test-Path $exe)) { throw "dist\InfraMonitor.exe not found. Run desktop\build.ps1 first." }

# --- resolve the signing certificate --------------------------------------------------------
if ($env:CODESIGN_PFX -and (Test-Path $env:CODESIGN_PFX)) {
    Write-Host "Using code-signing cert from CODESIGN_PFX."
    $pw = ConvertTo-SecureString $env:CODESIGN_PFX_PASSWORD -AsPlainText -Force
    $cert = Get-PfxCertificate -FilePath $env:CODESIGN_PFX -Password $pw
} else {
    $subject = "CN=Infra Monitor (self-signed)"
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
    if (-not $cert) {
        Write-Host "No CODESIGN_PFX set: creating a SELF-SIGNED cert (will NOT clear SmartScreen elsewhere)."
        $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation Cert:\CurrentUser\My -KeyUsage DigitalSignature -NotAfter (Get-Date).AddYears(3)
    }
}

function Invoke-Sign($path) {
    try {
        $r = Set-AuthenticodeSignature -FilePath $path -Certificate $cert -HashAlgorithm SHA256 -TimestampServer "http://timestamp.digicert.com" -ErrorAction Stop
    } catch {
        $r = Set-AuthenticodeSignature -FilePath $path -Certificate $cert -HashAlgorithm SHA256
    }
    Write-Host ("  signed {0}: {1}" -f (Split-Path $path -Leaf), $r.Status)
}

Write-Host "Signing the app exe..."
Invoke-Sign $exe

# --- locate ISCC and build the installer ----------------------------------------------------
$isccCandidates = @(
    (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source,
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
)
$iscc = $isccCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup (ISCC.exe) not found. Install:  winget install JRSoftware.InnoSetup" }

Write-Host "Compiling installer with Inno Setup..."
& $iscc (Join-Path $root "desktop\installer.iss")

$setup = Join-Path $root "dist-installer\InfraMonitor-Setup.exe"
if (-not (Test-Path $setup)) { throw "Installer was not produced at $setup" }

Write-Host "Signing the installer..."
Invoke-Sign $setup

Write-Host ""
Write-Host "Done: $setup"
Write-Host 'Verify:  Get-AuthenticodeSignature dist-installer\InfraMonitor-Setup.exe | Format-List'
