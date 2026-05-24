# watchdog-bot.ps1 — Restart the Teams bot if it's not listening on port 3978.
# Registered as a scheduled task running every 5 minutes.

$listening = netstat -ano | Select-String ":3978 .*LISTENING"
if (-not $listening) {
    $log = "C:\Users\Assistant\JRBAgent\agent\logs\watchdog.log"
    $ts  = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $log -Value "$ts  Bot not found on :3978 — restarting"
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1`" teams" -WindowStyle Hidden
}
