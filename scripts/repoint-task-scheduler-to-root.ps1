# scripts/repoint-task-scheduler-to-root.ps1
# One-time migration: repoints the "JRB Teams Bot", "JRB Scheduler", and
# "JRB Cloudflare Watchdog" scheduled tasks from agent\ paths to the root
# repo paths. Must be run from an elevated (Run as Administrator) PowerShell -
# Claude Code cannot modify these task definitions itself (Set-ScheduledTask
# returns "Access is denied" from a non-elevated session).
#
# Usage (elevated PowerShell):
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\scripts\repoint-task-scheduler-to-root.ps1"
#
# Safe to run more than once - it just overwrites each task's Action with the
# same target. Does not touch "JRB Cloudflare Tunnel" (already root-independent,
# calls cloudflared.exe directly with no agent\ path involved).

$ErrorActionPreference = 'Stop'

function Repoint-Task {
    param([string]$TaskName, [string]$Arguments)
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Arguments
    Set-ScheduledTask -TaskName $TaskName -Action $action
    $current = (Get-ScheduledTask -TaskName $TaskName).Actions.Arguments
    Write-Output "$TaskName -> $current"
}

Repoint-Task -TaskName "JRB Teams Bot" `
    -Arguments '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Assistant\JRBAgent\launcher\bot-wrapper.ps1"'

Repoint-Task -TaskName "JRB Scheduler" `
    -Arguments '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Assistant\JRBAgent\launcher\scheduler-wrapper.ps1"'

Repoint-Task -TaskName "JRB Cloudflare Watchdog" `
    -Arguments '-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\scripts\cloudflared-watchdog.ps1"'

Write-Output ""
Write-Output "All three tasks repointed to root. Restart them to verify:"
Write-Output '  Start-ScheduledTask -TaskName "JRB Teams Bot"'
Write-Output '  Start-ScheduledTask -TaskName "JRB Scheduler"'
Write-Output "Check port 3978 is listening and the scheduler log shows 'All schedules registered.'"
Write-Output "Once both are confirmed healthy running from root, the agent\ subtree is safe to delete."
