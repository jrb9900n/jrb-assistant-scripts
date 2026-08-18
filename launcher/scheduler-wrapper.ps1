# launcher/scheduler-wrapper.ps1
# Kills any orphaned scheduler process before starting fresh.
# Task Scheduler runs this instead of start-agent.ps1 directly.
#
# RECONSTRUCTED 2026-08-03: this file was never tracked in git (unlike its
# sibling bot-wrapper.ps1, which is) and was found missing from disk,
# leaving the "JRB Scheduler" Task Scheduler task with no target script to
# run - every scheduled task (ads_health_check, self_heal_watcher,
# sa_connectivity_check, qb_health_check, etc.) had silently stopped firing.
# Modeled directly on bot-wrapper.ps1's pattern, adapted for a process with
# no fixed port to check (cron.js already self-dedups via a PID file on
# startup - see scheduler/cron.js's top-of-file comment - so the kill below
# is belt-and-suspenders, same as bot-wrapper.ps1's own redundant checks).

$ErrorActionPreference = 'Stop'

# Derive the script root dynamically so this works under any user account or
# machine, rather than relying on a hardcoded path that silently breaks when
# the username, drive letter, or install location differs (finding #1).
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# Use Get-CimInstance instead of the deprecated (and PS7-removed) Get-WmiObject
# so the kill step does not silently produce no output in modern environments
# (finding #2).
# Wrapped in try/catch so that a WMI failure (service unavailable, access
# denied, etc.) does not abort the entire script under ErrorActionPreference=Stop
# and prevent start-agent.ps1 from ever being reached.
try {
    Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
        $_.CommandLine -like '*scheduler/cron.js*' -or $_.CommandLine -like '*scheduler\cron.js*'
    } | ForEach-Object {
        # Obtain a .NET Process handle by PID so we can call WaitForExit() and
        # confirm the OS has fully released file locks and port handles before
        # proceeding - a fixed-duration sleep is not reliable (finding #3).
        $proc = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($proc) {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            # Always wait for the process to exit after sending the kill signal.
            # The 5000 ms timeout prevents indefinite blocking if Stop-Process
            # failed silently or the OS is slow to reap the handle.
            # Note: the .NET Process object holds an OS handle opened before
            # Stop-Process was called, so WaitForExit tracks the original
            # process - not a PID that may have been reused.
            $proc.WaitForExit(5000) | Out-Null
        }
    }
} catch {
    Write-Output "scheduler-wrapper: CimInstance query failed (non-fatal): $_"
}

# Wrap the launch in try/catch so that a missing or broken start-agent.ps1
# produces a non-zero exit code that Task Scheduler can report as a failure,
# rather than silently succeeding with exit code 0 (finding #4).
try {
    & "$scriptRoot\start-agent.ps1" scheduler
} catch {
    Write-Error "Failed to launch scheduler via start-agent.ps1: $_"
    exit 1
}
