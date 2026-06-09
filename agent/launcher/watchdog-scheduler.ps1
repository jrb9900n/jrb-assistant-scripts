# watchdog-scheduler.ps1 — Restart cron.js if it's not running.
# Mirrors watchdog-bot.ps1. Registered as "JRB Scheduler Watchdog" task,
# running every 5 minutes.

# Use $env:TEMP to match Node.js os.tmpdir() on this machine
$PID_FILE  = Join-Path $env:TEMP "jrb-scheduler.pid"
$LAUNCHER  = "C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1"
$LOG_FILE  = "C:\Users\Assistant\JRBAgent\agent\logs\watchdog.log"
$ts        = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

$running = $false

if (Test-Path $PID_FILE) {
    try {
        $storedPid = [int](Get-Content $PID_FILE -Raw -ErrorAction Stop).Trim()
        if ($storedPid) {
            $proc = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
            # Verify PID belongs to a node.exe process, not a recycled PID
            if ($proc -and $proc.Name -like "node*") {
                $running = $true
            }
        }
    } catch {}
}

if (-not $running) {
    Add-Content -Path $LOG_FILE -Value "$ts  Scheduler not found — restarting" -Encoding UTF8
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$LAUNCHER`" scheduler" -WindowStyle Hidden
}
