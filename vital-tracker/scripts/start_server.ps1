# Start the Vital Tracker server with Influx environment variables.
# This script is intended to be run at user logon by a Scheduled Task.

param()

function Write-Info($s){ Write-Host $s -ForegroundColor Cyan }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir

Write-Info "Starting Vital Tracker server from $repoRoot"

# Load environment variables used by the server (defaults provided)
$env:INFLUX_URL = 'http://localhost:8086'
$env:INFLUX_TOKEN = 'my-token'
$env:INFLUX_ORG = 'myorg'
$env:INFLUX_BUCKET = 'default'

# Path to release exe
$exePath = Join-Path $repoRoot 'target\release\vital-tracker.exe'

# Prepare logging so scheduled task runs are recorded
$logDir = Join-Path $repoRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logPath = Join-Path $logDir ("vital-server-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")

"=== Vital Tracker start: $(Get-Date -Format o) ===" | Out-File -FilePath $logPath -Encoding UTF8
"Repo root: $repoRoot" | Out-File -FilePath $logPath -Append -Encoding UTF8

"Environment: INFLUX_URL=$env:INFLUX_URL INFLUX_ORG=$env:INFLUX_ORG INFLUX_BUCKET=$env:INFLUX_BUCKET" | Out-File -FilePath $logPath -Append -Encoding UTF8

if (-not (Test-Path $exePath)) {
    Write-Info "Release executable not found at $exePath - building release..."
    "Release executable not found - building release..." | Out-File -FilePath $logPath -Append -Encoding UTF8
    Push-Location $repoRoot
    # Capture cargo build output to the log so scheduled runs are debuggable
    & cargo build --release 2>&1 | Out-File -FilePath $logPath -Append -Encoding UTF8
    Pop-Location
}

if (Test-Path $exePath) {
    Write-Info "Launching $exePath (logging to $logPath)"
    "Launching $exePath" | Out-File -FilePath $logPath -Append -Encoding UTF8

    # Start via cmd.exe so we can redirect stdout/stderr to the log file on PowerShell 5.1
    $exeQuoted = '"' + $exePath + '"'
    $logQuoted = '"' + $logPath + '"'
    $cmd = "$exeQuoted >> $logQuoted 2>&1"
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru

    if ($proc) {
        "Launched process Id: $($proc.Id)" | Out-File -FilePath $logPath -Append -Encoding UTF8
        Write-Info "Server started (process launched, PID $($proc.Id))."
    } else {
        "Failed to launch process via cmd.exe" | Out-File -FilePath $logPath -Append -Encoding UTF8
        Write-Host "Could not launch server executable." -ForegroundColor Red
    }
} else {
    "Could not find or build the server executable at: $exePath" | Out-File -FilePath $logPath -Append -Encoding UTF8
    Write-Host "Could not find or build the server executable at: $exePath" -ForegroundColor Red
}

"=== End start attempt: $(Get-Date -Format o) ===" | Out-File -FilePath $logPath -Append -Encoding UTF8
