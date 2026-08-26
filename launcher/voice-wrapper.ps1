# launcher/voice-wrapper.ps1
# Kills any orphaned voice bridge process before starting fresh.
# Task Scheduler runs this instead of start-agent.ps1 directly.
# Mirrors bot-wrapper.ps1's pattern exactly (port 3978 -> 3979, teams/bot.js -> voice/realtime-bridge.js).

# Kill by port 3979
$portLine = netstat -ano | Select-String ":3979 .*LISTENING" | Select-Object -First 1
if ($portLine) {
    $orphanPidStr = ($portLine -split '\s+')[-1].Trim()
    # Validate that the extracted token is a pure integer before passing it to
    # taskkill -- netstat output format can vary across Windows versions, so
    # the regex guard plus an explicit [int] cast protects against an
    # unintended shell injection or a non-PID token reaching taskkill.
    if ($orphanPidStr -match '^\d+$') {
        $orphanPid = [int]$orphanPidStr
        if ($orphanPid -gt 0) {
            Write-Output "voice-wrapper: killing PID $orphanPid on port 3979"
            $killResult = taskkill /f /pid $orphanPid 2>&1
            Write-Output "voice-wrapper: taskkill result: $killResult"
        } else {
            Write-Output "voice-wrapper: skipping invalid PID 0 from netstat output"
        }
    } else {
        Write-Output "voice-wrapper: could not parse a valid PID from netstat line: $portLine"
    }
}

# Kill by command line using CimInstance (preferred over WMI)
try {
    Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
        $_.CommandLine -like '*voice/realtime-bridge.js*' -or $_.CommandLine -like '*voice\realtime-bridge.js*'
    } | ForEach-Object {
        Write-Output "voice-wrapper: stopping node.exe PID $($_.ProcessId) by command line"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {
    Write-Output "voice-wrapper: CimInstance query failed: $_"
}

# Wait for OS to release the port before the new process starts
Start-Sleep -Seconds 4

# Derive the script root dynamically (matches bot-wrapper.ps1's approach) so
# this works from whichever directory it's actually deployed in.
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$scriptRoot\start-agent.ps1" voice
