# launcher/bot-wrapper.ps1
# Kills any orphaned Teams bot process before starting fresh.
# Task Scheduler runs this instead of start-agent.ps1 directly.

# Kill by port 3978
$portLine = netstat -ano | Select-String ":3978 .*LISTENING" | Select-Object -First 1
if ($portLine) {
    $orphanPid = ($portLine -split '\s+')[-1].Trim()
    if ($orphanPid -match '^\d+$') {
        Write-Output "bot-wrapper: killing PID $orphanPid on port 3978"
        $killResult = taskkill /f /pid $orphanPid 2>&1
        Write-Output "bot-wrapper: taskkill result: $killResult"
    }
}

# Kill by command line using CimInstance (preferred over WMI)
try {
    Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
        $_.CommandLine -like '*teams/bot.js*' -or $_.CommandLine -like '*teams\bot.js*'
    } | ForEach-Object {
        Write-Output "bot-wrapper: stopping node.exe PID $($_.ProcessId) by command line"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {
    Write-Output "bot-wrapper: CimInstance query failed: $_"
}

# Wait for OS to release the port before the new process starts
Start-Sleep -Seconds 4

& "C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1" teams
