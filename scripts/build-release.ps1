param(
  [switch]$VendorPi,
  [switch]$SkipVendorPi,
  [switch]$Debug,
  [switch]$Smoke
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $SkipVendorPi -or $VendorPi) {
  & "$PSScriptRoot\vendor-pi-sidecar-windows.ps1"
}

pnpm install --frozen-lockfile
npm install --omit=dev --prefix "$root\src-tauri\extensions"

if ($Smoke) {
  & "$PSScriptRoot\smoke-pi-tau.ps1" -ProjectPath $root
}

if ($Debug) {
  pnpm exec tauri build --debug
} else {
  pnpm exec tauri build
}
