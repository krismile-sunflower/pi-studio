param(
  [Parameter(Mandatory=$true)][string]$CertificatePath,
  [Parameter(Mandatory=$true)][string]$CertificatePassword,
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$artifacts = @(
  Join-Path $root "src-tauri\target\release\bundle\nsis\pi-studio_0.1.0_x64-setup.exe",
  Join-Path $root "src-tauri\target\release\bundle\msi\pi-studio_0.1.0_x64_en-US.msi",
  Join-Path $root "src-tauri\target\debug\bundle\nsis\pi-studio_0.1.0_x64-setup.exe",
  Join-Path $root "src-tauri\target\debug\bundle\msi\pi-studio_0.1.0_x64_en-US.msi"
) | Where-Object { Test-Path $_ }

if (-not $artifacts) {
  throw "No pi-studio installers found. Run pnpm exec tauri build first."
}

$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $signtool) {
  $kits = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $kits) {
    throw "signtool.exe not found. Install Windows SDK."
  }
  $signtool = $kits
}

foreach ($artifact in $artifacts) {
  & $signtool.Source sign /f $CertificatePath /p $CertificatePassword /fd SHA256 /tr $TimestampUrl /td SHA256 $artifact
  Write-Host "Signed $artifact"
}
