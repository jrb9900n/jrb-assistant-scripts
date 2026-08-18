# watchdog-bot.ps1 - Restart the Teams bot if it's not listening on port 3978.
# Registered as a scheduled task running every 5 minutes.

$listening = netstat -ano | Select-String ":3978 .*LISTENING"
if (-not $listening) {
    # Derive the script root dynamically so this works from any install location,
    # matching bot-wrapper.ps1's approach (finding #5 - hardcoded path removed).
    $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    $logDir  = Join-Path $scriptRoot "..\logs"
    $log     = [System.IO.Path]::GetFullPath((Join-Path $logDir "watchdog.log"))
    $ts      = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $log -Value "$ts  Bot not found on :3978 - restarting"
    $startAgent = Join-Path $scriptRoot "start-agent.ps1"
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$startAgent`" teams" -WindowStyle Hidden
}
