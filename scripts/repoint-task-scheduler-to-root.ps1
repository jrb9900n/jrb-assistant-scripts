# scripts/repoint-task-scheduler-to-root.ps1
# One-time migration: repoints scheduled tasks from agent\ paths to the root
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
#
# 2026-08-19 update: the original repoint (PRs #260/#261) covered "JRB Teams
# Bot", "JRB Scheduler", and "JRB Cloudflare Watchdog", but missed two more
# tasks that were ALSO still pointing at the deleted agent\ subtree: "JRB Bot
# Watchdog" and "JRB Scheduler Watchdog". Both have been silently failing
# every 5 minutes since agent\ was deleted on 2026-08-17 (LastTaskResult
# 0xFFFD0000, file-not-found) - meaning neither the Teams bot nor the
# scheduler process has had ANY working auto-heal for 2+ days. Discovered
# when the Teams bot was found completely down with no auto-restart. Also
# disables "JRBBotAutoRestart", a dead legacy duplicate of "JRB Bot Watchdog"
# (unconditional kill+restart every cycle rather than only-if-down, itself
# also pointing at the dead agent\ path, and already not scheduled to run
# again per its own expired trigger) - left disabled rather than deleted so
# it's recoverable if this call turns out to be wrong.

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

Repoint-Task -TaskName "JRB Bot Watchdog" `
    -Arguments '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Assistant\JRBAgent\launcher\watchdog-bot.ps1"'

Repoint-Task -TaskName "JRB Scheduler Watchdog" `
    -Arguments '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Assistant\JRBAgent\launcher\watchdog-scheduler.ps1"'

Write-Output ""
Write-Output "Disabling JRBBotAutoRestart (dead legacy duplicate, see comment above)..."
Disable-ScheduledTask -TaskName "JRBBotAutoRestart" | Out-Null
Write-Output "JRBBotAutoRestart -> Disabled"

Write-Output ""
Write-Output "All five tasks repointed to root. Restart the two long-running services to verify:"
Write-Output '  Start-ScheduledTask -TaskName "JRB Teams Bot"'
Write-Output '  Start-ScheduledTask -TaskName "JRB Scheduler"'
Write-Output "Check port 3978 is listening and the scheduler log shows 'All schedules registered.'"
Write-Output ""
Write-Output "To verify the two watchdogs themselves are now actually working, wait for their next"
Write-Output "5-min cycle and check LastTaskResult is 0 (not 0xFFFD0000):"
Write-Output '  Get-ScheduledTaskInfo -TaskName "JRB Bot Watchdog" | Select LastRunTime,LastTaskResult'
Write-Output '  Get-ScheduledTaskInfo -TaskName "JRB Scheduler Watchdog" | Select LastRunTime,LastTaskResult'
Write-Output "Once all are confirmed healthy running from root, the agent\ subtree is safe to delete."
