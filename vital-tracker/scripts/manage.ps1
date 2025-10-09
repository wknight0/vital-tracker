<#
Usage: .\scripts\manage.ps1 <action>
Actions:
  start  - start docker compose stack (InfluxDB + Grafana)
  stop   - stop the stack
  logs   - tail compose logs
  run    - start stack, wait for Influx, then launch backend in new window
  help   - show this help
#>

param(
    [string]$Action = 'help'
)

function Write-Info($s){ Write-Host $s -ForegroundColor Cyan }
function Write-Err($s){ Write-Host $s -ForegroundColor Red }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir

function Start-Stack {
    Write-Info "Starting docker compose stack"
    Push-Location $repoRoot
    docker compose up -d --build
    $rc = $LASTEXITCODE
    Pop-Location
    return $rc
}

function Stop-Stack {
    Write-Info "Stopping docker compose stack"
    Push-Location $repoRoot
    docker compose down
    $rc = $LASTEXITCODE
    Pop-Location
    return $rc
}

function Logs-Stack {
    Write-Info "Tailing docker compose logs"
    $influxUrl = 'http://localhost:8086'
    $influxToken = 'my-token'
    $influxOrg = 'myorg'
    $influxBucket = 'default'
    $cmd = "cd `"$repoRoot`"; `$env:INFLUX_URL='$influxUrl'; `$env:INFLUX_TOKEN='$influxToken'; `$env:INFLUX_ORG='$influxOrg'; `$env:INFLUX_BUCKET='$influxBucket'; cargo run"
            $line = $_.Trim()
            if ($line -eq '' -or $line.StartsWith('#')) { return }
            $parts = $line -split('=',2)
            if ($parts.Length -lt 2) { return }
            $k = $parts[0].Trim()
            $v = $parts[1].Trim()
            if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1,$v.Length-2) }
            if ($v.StartsWith("'") -and $v.EndsWith("'")) { $v = $v.Substring(1,$v.Length-2) }
            Set-Item -Path "Env:\$k" -Value $v -Force
        }
    }

    $influxUrl = $env:INFLUX_URL
    $influxToken = $env:INFLUX_TOKEN
    $influxOrg = $env:INFLUX_ORG
    $influxBucket = $env:INFLUX_BUCKET
    if (-not $influxUrl) { $influxUrl = 'http://localhost:8086' }
    if (-not $influxToken) { $influxToken = 'my-token' }
    if (-not $influxOrg) { $influxOrg = 'myorg' }
    if (-not $influxBucket) { $influxBucket = 'default' }
    $cmd = "cd `"$repoRoot`"; `$env:INFLUX_URL='$influxUrl'; `$env:INFLUX_TOKEN='$influxToken'; `$env:INFLUX_ORG='$influxOrg'; `$env:INFLUX_BUCKET='$influxBucket'; cargo run"
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit","-Command",$cmd -WorkingDirectory $repoRoot
}

switch ($Action.ToLower()) {
    'start' { Start-Stack | Out-Null }
    'stop' { Stop-Stack | Out-Null }
    'logs' { Logs-Stack }
    'run' {
        $rc = Start-Stack
        if ($rc -ne 0) { Write-Err "docker compose reported exit code $rc" }
        $ready = Wait-Influx 60
        if (-not $ready) { Write-Err "Influx did not become healthy, backend will still be started" }
        Start-Backend
    }
    'help' { Get-Content -Path $MyInvocation.MyCommand.Path | Select-String -Pattern 'Usage' -Context 0,10 }
    Default {
        Write-Err "Unknown action: $Action"; Write-Host "Available actions: start, stop, logs, run, help"
    }
}
