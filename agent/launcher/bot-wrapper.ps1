# launcher/bot-wrapper.ps1
# Kills any orphaned Teams bot process before starting fresh.
# Task Scheduler runs this instead of start-agent.ps1 directly.

# Kill by port 3978
$portLine = netstat -ano | Select-String ":3978 .*LISTENING" | Select-Object -First 1
if ($portLine) {
    $orphanPid = ($portLine -split '\s+')[-1].Trim()
    if ($orphanPid -match '^\d+$') {
        taskkill /f /pid $orphanPid 2>$null
    }
}

# Kill by command line (belt and suspenders)
Get-WmiObject Win32_Process -Filter "name='node.exe'" | Where-Object {
    $_.CommandLine -like '*teams/bot.js*' -or $_.CommandLine -like '*teams\bot.js*'
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

& "C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1" teams
