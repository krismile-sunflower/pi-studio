param(
  [string]$ProjectPath = (Get-Location).Path,
  [int]$Port = 3991,
  [int]$TimeoutSeconds = 20,
  [switch]$UseSystemPi,
  [switch]$Mirror
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "src-tauri\target\smoke"
$sessionDir = Join-Path $logDir "sessions"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path $sessionDir | Out-Null
$stdout = Join-Path $logDir "pi-smoke.out.log"
$stderr = Join-Path $logDir "pi-smoke.err.log"

function Quote-ProcessArgument {
  param([string]$Value)
  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Resolve-PiSmokeCommand {
  $args = @("--mode", "rpc", "--session-dir", $sessionDir, "--no-approve")

  if ($Mirror) {
    $extension = Join-Path $root "src-tauri\extensions\mirror-server.ts"
    $staticDir = Join-Path $root "src"
    if (-not (Test-Path $extension)) {
      throw "Tau extension not found: $extension"
    }
    $env:TAU_MIRROR_PORT = "$Port"
    $env:TAU_HOST = "127.0.0.1"
    $env:TAU_STATIC_DIR = $staticDir
    $args += @("--extension", $extension)
  }

  if ($env:PI_DESKTOP_CLI) {
    return @{
      File = $env:PI_DESKTOP_CLI
      Args = $args
    }
  }

  $bundledDir = Join-Path $root "src-tauri\binaries\windows-x64"
  $bundledNode = Join-Path $bundledDir "node.exe"
  $bundledCli = Join-Path $bundledDir "pi-package\dist\cli.js"
  if (-not $UseSystemPi -and (Test-Path $bundledNode) -and (Test-Path $bundledCli)) {
    return @{
      File = $bundledNode
      Args = @($bundledCli) + $args
    }
  }

  $pi = Get-Command pi.cmd -ErrorAction SilentlyContinue
  if (-not $pi) {
    $pi = Get-Command pi -ErrorAction Stop
  }

  if ($pi.Source.EndsWith(".ps1")) {
    return @{
      File = "powershell.exe"
      Args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $pi.Source) + $args
    }
  }

  if ($pi.Source.EndsWith(".cmd") -or $pi.Source.EndsWith(".bat")) {
    return @{
      File = "cmd.exe"
      Args = @("/c", $pi.Source) + $args
    }
  }

  return @{
    File = $pi.Source
    Args = $args
  }
}

function Wait-RpcResponse {
  param(
    [string]$Id,
    [datetime]$Deadline
  )

  while ((Get-Date) -lt $Deadline -and -not $proc.HasExited) {
    $remaining = [int][Math]::Max(1, ($Deadline - (Get-Date)).TotalMilliseconds)
    $readTask = $proc.StandardOutput.ReadLineAsync()
    if (-not $readTask.Wait($remaining)) {
      break
    }
    $line = $readTask.Result
    if ($null -eq $line) {
      break
    }
    [void]$stdoutBuffer.AppendLine($line)
    try {
      $value = $line | ConvertFrom-Json -ErrorAction Stop
      if ($value.type -eq "response" -and $value.id -eq $Id) {
        return $value
      }
    } catch {}
  }

  throw "Timed out waiting for RPC response $Id"
}

$piCommand = Resolve-PiSmokeCommand
$file = $piCommand.File
$argList = $piCommand.Args

if (-not $UseSystemPi -and $file -notlike "*\windows-x64\node.exe" -and -not $env:PI_DESKTOP_CLI) {
  Write-Warning "Bundled Pi runtime not found; smoke test is falling back to system pi. Run scripts\vendor-pi-sidecar-windows.ps1 to test the packaged runtime."
}

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $file
$psi.Arguments = ($argList | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
$psi.WorkingDirectory = $ProjectPath
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::new()
$proc.StartInfo = $psi
[void]$proc.Start()

$stdoutBuffer = [System.Text.StringBuilder]::new()
$stderrBuffer = [System.Text.StringBuilder]::new()
$stderrHandler = [System.Diagnostics.DataReceivedEventHandler]{
  param($sender, $eventArgs)
  if ($null -ne $eventArgs.Data) {
    [void]$stderrBuffer.AppendLine($eventArgs.Data)
  }
}
$proc.add_ErrorDataReceived($stderrHandler)
$proc.BeginErrorReadLine()

function Send-RpcLine {
  param([string]$Json)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Json + "`n")
  $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $proc.StandardInput.BaseStream.Flush()
}

# Windows PowerShell's redirected stdin may emit a UTF-8 BOM on the first write.
# Send a harmless warm-up line so subsequent JSONL commands parse cleanly.
Send-RpcLine ""

$script:SmokePassed = $false
try {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  Send-RpcLine '{"id":"pi-smoke-state","type":"get_state"}'
  $state = Wait-RpcResponse -Id "pi-smoke-state" -Deadline $deadline
  if (-not $state.success) {
    throw "get_state failed: $($state.error)"
  }

  Send-RpcLine '{"id":"pi-smoke-models","type":"get_available_models"}'
  $models = Wait-RpcResponse -Id "pi-smoke-models" -Deadline $deadline
  if (-not $models.success) {
    throw "get_available_models failed: $($models.error)"
  }
  if ($null -eq $models.data -or $null -eq $models.data.models) {
    throw "get_available_models returned an unexpected payload"
  }

  Send-RpcLine '{"id":"pi-smoke-entries","type":"get_entries"}'
  $entries = Wait-RpcResponse -Id "pi-smoke-entries" -Deadline $deadline
  if (-not $entries.success) {
    throw "get_entries failed: $($entries.error)"
  }

  if ($Mirror) {
    $health = "http://127.0.0.1:$Port/api/health"
    $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $health
    if ($res.StatusCode -ne 200) {
      throw "Mirror health check failed with HTTP $($res.StatusCode)"
    }
    Write-Host "Mirror health check passed at $health"
  }

  $script:SmokePassed = $true
  Write-Host "Pi native RPC smoke test passed"
}
finally {
  if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
  }
  try {
    [void]$proc.WaitForExit(5000)
  } catch {}
  Set-Content -Path $stdout -Value $stdoutBuffer.ToString() -Encoding UTF8
  Set-Content -Path $stderr -Value $stderrBuffer.ToString() -Encoding UTF8
}

if ($script:SmokePassed) {
  $global:LASTEXITCODE = 0
  [Environment]::Exit(0)
}
