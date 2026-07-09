param(
  [string]$ProjectPath = (Get-Location).Path,
  [int]$Port = 3991,
  [int]$TimeoutSeconds = 20,
  [switch]$UseSystemPi
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $root "src-tauri\extensions\mirror-server.ts"
$staticDir = Join-Path $root "src"

if (-not (Test-Path $extension)) {
  throw "Tau extension not found: $extension"
}

$env:TAU_MIRROR_PORT = "$Port"
$env:TAU_HOST = "127.0.0.1"
$env:TAU_STATIC_DIR = $staticDir
$logDir = Join-Path $root "src-tauri\target\smoke"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
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
  $args = @("--mode", "rpc", "--extension", $extension, "--no-approve")

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
$stdoutHandler = [System.Diagnostics.DataReceivedEventHandler]{
  param($sender, $eventArgs)
  if ($null -ne $eventArgs.Data) {
    [void]$stdoutBuffer.AppendLine($eventArgs.Data)
  }
}
$stderrHandler = [System.Diagnostics.DataReceivedEventHandler]{
  param($sender, $eventArgs)
  if ($null -ne $eventArgs.Data) {
    [void]$stderrBuffer.AppendLine($eventArgs.Data)
  }
}
$proc.add_OutputDataReceived($stdoutHandler)
$proc.add_ErrorDataReceived($stderrHandler)
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()
$proc.StandardInput.WriteLine('{"id":"pi-smoke-start","type":"new_session"}')
$proc.StandardInput.Flush()

$script:SmokePassed = $false
try {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $health = "http://127.0.0.1:$Port/api/health"

  $passed = $false
  do {
    Start-Sleep -Milliseconds 500
    try {
      $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $health
      if ($res.StatusCode -eq 200) {
        $passed = $true
        break
      }
    } catch {}
  } while ((Get-Date) -lt $deadline -and -not $proc.HasExited)

  if ($passed) {
    $script:SmokePassed = $true
    Write-Host "Tau health check passed at $health"
  } else {
    throw "Tau health check did not pass within $TimeoutSeconds seconds.`nSTDOUT:`n$($stdoutBuffer.ToString())`nSTDERR:`n$($stderrBuffer.ToString())"
  }
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
