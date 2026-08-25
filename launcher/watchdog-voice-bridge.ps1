# watchdog-voice-bridge.ps1 - Restart the voice bridge if it's not listening on port 3979.
# Mirrors watchdog-bot.ps1's pattern exactly. Intended to be registered as a
# scheduled task running every 5 minutes (registration requires elevated
# PowerShell -- not done by this script, see the PR description for the
# manual Task Scheduler steps).
#
# DEPENDS ON: start-agent.ps1 having a "voice" mode arm (node voice/realtime-bridge.js).
# That change ships as its own isolated, separately-reviewed diff per this
# repo's autonomy rules (never edit start-agent.ps1 without explicit
# sign-off) -- do NOT register this watchdog as a scheduled task until that
# diff is merged, or every restart attempt below will silently no-op against
# start-agent.ps1's default arm instead of actually starting anything.

$listening = netstat -ano | Select-String ":3979 .*LISTENING"
if (-not $listening) {
    # Derive the script root dynamically so this works from any install location,
    # matching watchdog-bot.ps1's approach.
    $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    $logDir  = Join-Path $scriptRoot "..\logs"
    $log     = [System.IO.Path]::GetFullPath((Join-Path $logDir "watchdog-voice.log"))
    $ts      = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $log -Value "$ts  Voice bridge not found on :3979 - restarting"
    $startAgent = Join-Path $scriptRoot "start-agent.ps1"
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$startAgent`" voice" -WindowStyle Hidden
}
