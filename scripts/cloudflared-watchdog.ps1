$cf = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
    # IMPORTANT: do not Start-Process cloudflared.exe directly from this script.
    # This watchdog task has a 2-minute ExecutionTimeLimit; any child process it
    # spawns lives inside its job object and gets killed when the task instance
    # completes/is torn down, even though Start-Process itself returns immediately.
    # (Confirmed 2026-08-06: cloudflared was spawned but reaped within ~1-3s, before
    # it could even flush its startup log lines.)
    # Fix: hand the restart off to the dedicated "JRB Cloudflare Tunnel" task, which
    # has its own 72-hour execution limit and runs as its own independent job --
    # unaffected by this watchdog task's lifecycle.
    Start-ScheduledTask -TaskName "JRB Cloudflare Tunnel"
}
