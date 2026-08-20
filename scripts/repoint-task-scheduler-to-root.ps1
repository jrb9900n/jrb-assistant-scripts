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
    param(
        [string]$TaskName,
        [string]$Arguments,
        # The filesystem path embedded in $Arguments, used to pre-validate
        # that the target file exists before committing the Set-ScheduledTask
        # change. Avoids silently repointing a task to another missing path.
        [string]$TargetFilePath
    )

    # Validate the target script exists before touching the task definition.
    # A missing file here means the launcher directory wasn't part of the
    # migration, the user profile differs, or the path is wrong - all cases
    # where repointing would recreate the silent file-not-found failure being
    # fixed. Fail loudly before any change is made so the operator can
    # correct the path and re-run.
    if ($TargetFilePath -and -not (Test-Path -LiteralPath $TargetFilePath)) {
        throw "Repoint-Task: target file not found for '$TaskName': $TargetFilePath`n" +
              "Verify the path is correct for this machine before re-running. No tasks were modified."
    }

    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Arguments
    Set-ScheduledTask -TaskName $TaskName -Action $action
    $current = (Get-ScheduledTask -TaskName $TaskName).Actions.Arguments
    Write-Output "$TaskName -> $current"
}

# Pre-validate all target paths up front so the script aborts before making
# ANY changes if any file is missing, rather than failing partway through.
$pathsToValidate = @(
    'C:\Users\Assistant\JRBAgent\launcher\bot-wrapper.ps1',
    'C:\Users\Assistant\JRBAgent\launcher\scheduler-wrapper.ps1',
    'C:\Users\Assistant\JRBAgent\scripts\cloudflared-watchdog.ps1',
    'C:\Users\Assistant\JRBAgent\launcher\watchdog-bot.ps1',
    'C:\Users\Assistant\JRBAgent\launcher\watchdog-scheduler.ps1'
)
$missingPaths = $pathsToValidate | Where-Object { -not (Test-Path -LiteralPath $_) }
if ($missingPaths) {
    throw "The following target script(s) were not found on this machine. Correct the paths and re-run.`n" +
          "No tasks have been modified.`n`n" +
          ($missingPaths -join "`n")
}

Repoint-Task -TaskName "JRB Teams Bot" `
    -TargetFilePath 'C:\Users\Assistant\JRBAgent\launcher\bot-wrapper.ps1' `
    -Arguments '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Assistant\JRBAgent\launcher\bot-wrapper.ps1"'

Repoint-Task -TaskName "JRB Scheduler" `
    -TargetFilePath 'C:\Users\Assistant\JRBAgent\launcher\scheduler-wrapper.ps1' `
    -Arguments '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Assistant\JRBAgent\launcher\scheduler-wrapper.ps1"'

Repoint-Task -TaskName "JRB Cloudflare Watchdog" `
    -TargetFilePath 'C:\Users\Assistant\JRBAgent\scripts\cloudflared-watchdog.ps1' `
    -Arguments '-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\scripts\cloudflared-watchdog.ps1"'

Repoint-Task -TaskName "JRB Bot Watchdog" `
    -TargetFilePath 'C:\Users\Assistant\JRBAgent\launcher\watchdog-bot.ps1' `
    -Arguments '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Assistant\JRBAgent\launcher\watchdog-bot.ps1"'

Repoint-Task -TaskName "JRB Scheduler Watchdog" `
    -TargetFilePath 'C:\Users\Assistant\JRBAgent\launcher\watchdog-scheduler.ps1' `
    -Arguments '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Assistant\JRBAgent\launcher\watchdog-scheduler.ps1"'

Write-Output ""
Write-Output "Disabling JRBBotAutoRestart (dead legacy duplicate, see comment above)..."
# Guard against the task being absent (already deleted, renamed, or environment
# differs) so a missing legacy task does not abort the script and obscure that
# all five critical repoints above succeeded.
$legacyTask = Get-ScheduledTask -TaskName "JRBBotAutoRestart" -ErrorAction SilentlyContinue
if ($legacyTask) {
    Disable-ScheduledTask -TaskName "JRBBotAutoRestart" | Out-Null
    Write-Output "JRBBotAutoRestart -> Disabled"
} else {
    Write-Output "JRBBotAutoRestart -> not found (already deleted or renamed); skipped"
}

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
