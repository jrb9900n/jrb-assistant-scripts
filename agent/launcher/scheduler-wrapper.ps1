# launcher/scheduler-wrapper.ps1
# Kills any orphaned scheduler process before starting fresh.
# Task Scheduler runs this instead of start-agent.ps1 directly.
#
# RECONSTRUCTED 2026-08-03: this file was never tracked in git (unlike its
# sibling bot-wrapper.ps1, which is) and was found missing from disk,
# leaving the "JRB Scheduler" Task Scheduler task with no target script to
# run — every scheduled task (ads_health_check, self_heal_watcher,
# sa_connectivity_check, qb_health_check, etc.) had silently stopped firing.
# Modeled directly on bot-wrapper.ps1's pattern, adapted for a process with
# no fixed port to check (cron.js already self-dedups via a PID file on
# startup — see scheduler/cron.js's top-of-file comment — so the kill below
# is belt-and-suspenders, same as bot-wrapper.ps1's own redundant checks).

Get-WmiObject Win32_Process -Filter "name='node.exe'" | Where-Object {
    $_.CommandLine -like '*scheduler/cron.js*' -or $_.CommandLine -like '*scheduler\cron.js*'
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

& "C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1" scheduler
