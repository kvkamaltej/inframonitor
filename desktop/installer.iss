; Inno Setup script for the Infra Monitor desktop app.
; Build with:  ISCC.exe desktop\installer.iss   (or via desktop\build-installer.ps1)
;
; Packages the single-file dist\InfraMonitor.exe into a per-user installer (no admin / no UAC)
; with Start-Menu + optional desktop shortcuts and a clean uninstaller. Paths are relative to
; THIS .iss file's directory (desktop\).

#define AppName "Infra Monitor"
#define AppVersion "0.1.0"
#define AppPublisher "Infra Monitor"
#define AppExe "InfraMonitor.exe"

[Setup]
AppId={{8B1E2F4A-6C2D-4E7A-9F3B-INFRAMONITOR01}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
; Per-user install: lands in %LOCALAPPDATA%\Programs\InfraMonitor, needs no administrator.
PrivilegesRequired=lowest
DefaultDirName={autopf}\InfraMonitor
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
SetupIconFile=inframonitor.ico
OutputDir=..\dist-installer
OutputBaseFilename=InfraMonitor-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; The app's data (DB + secret.key) lives in %APPDATA%\InfraMonitor and is intentionally NOT
; removed on uninstall, so reinstalling keeps the inventory and credentials.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "..\dist\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
