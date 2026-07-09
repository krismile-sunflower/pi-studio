param(
  [string]$NodeHome = "",
  [string]$OutDir = "src-tauri\binaries\windows-x64"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($OutDir)) {
  $OutDir = Join-Path $root $OutDir
}

if (-not $NodeHome) {
  $piCmd = Get-Command pi.cmd -ErrorAction SilentlyContinue
  if ($piCmd) {
    $NodeHome = Split-Path -Parent $piCmd.Source
  } else {
    $pi = Get-Command pi -ErrorAction SilentlyContinue
    if (-not $pi) {
      throw "Could not find pi on PATH. Install @earendil-works/pi-coding-agent or pass -NodeHome."
    }
    $NodeHome = Split-Path -Parent $pi.Source
  }
}

$nodeExe = Join-Path $NodeHome "node.exe"
$piPackage = Join-Path $NodeHome "node_modules\@earendil-works\pi-coding-agent"

if (-not (Test-Path $nodeExe)) {
  throw "node.exe not found at $nodeExe"
}

if (-not (Test-Path $piPackage)) {
  throw "Pi npm package not found at $piPackage"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Copy-Item -Force (Join-Path $NodeHome "node.exe") (Join-Path $OutDir "node.exe")

function Clear-DirectoryIfExists {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    return
  }
  $emptyDir = Join-Path $env:TEMP ("tau-empty-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $emptyDir | Out-Null
  robocopy $emptyDir $Path /MIR /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed while clearing $Path with exit code $LASTEXITCODE"
  }
  $global:LASTEXITCODE = 0
  Remove-Item -LiteralPath $emptyDir -Recurse -Force
  Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
}

$targetPackage = Join-Path $OutDir "pi-package"
Clear-DirectoryIfExists $targetPackage
Clear-DirectoryIfExists (Join-Path $OutDir "node_modules")

robocopy $piPackage $targetPackage /MIR /NFL /NDL /NJH /NJS /NC /NS /XF *.map *.d.ts *.tsbuildinfo /XD src | Out-Null
if ($LASTEXITCODE -gt 7) {
  throw "robocopy failed while copying Pi package with exit code $LASTEXITCODE"
}
$global:LASTEXITCODE = 0

Set-Content -Path (Join-Path $OutDir "pi.cmd") -Encoding ASCII -Value @"
@ECHO off
SETLOCAL
SET "DIR=%~dp0"
"%DIR%node.exe" "%DIR%pi-package\dist\cli.js" %*
"@

Set-Content -Path (Join-Path $OutDir "pi.ps1") -Encoding ASCII -Value @'
$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent
& (Join-Path $basedir "node.exe") (Join-Path $basedir "pi-package\dist\cli.js") @args
exit $LASTEXITCODE
'@

Set-Content -Path (Join-Path $OutDir "pi") -Encoding ASCII -Value @'
#!/usr/bin/env sh
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$DIR/node.exe" "$DIR/pi-package/dist/cli.js" "$@"
'@

$prunePatterns = @("*.map", "*.d.ts", "*.tsbuildinfo")
foreach ($pattern in $prunePatterns) {
  Get-ChildItem -Path $targetPackage -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}
$srcDirs = Get-ChildItem -Path $targetPackage -Recurse -Directory -Filter "src" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -like "*\node_modules\*" }
foreach ($srcDir in $srcDirs) {
  Remove-Item -LiteralPath $srcDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Vendored Pi sidecar to $OutDir"
Write-Host "Node: $((Get-Item (Join-Path $OutDir 'node.exe')).Length) bytes"
Write-Host "Pi package: $targetPackage"
