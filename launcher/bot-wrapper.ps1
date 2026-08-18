# launcher/bot-wrapper.ps1
# Kills any orphaned Teams bot process before starting fresh.
# Task Scheduler runs this instead of start-agent.ps1 directly.

# Kill by port 3978
$portLine = netstat -ano | Select-String ":3978 .*LISTENING" | Select-Object -First 1
if ($portLine) {
    $orphanPidStr = ($portLine -split '\s+')[-1].Trim()
    # Validate that the extracted token is a pure integer before passing it to
    # taskkill. netstat output format can vary across Windows versions (e.g.
    # trailing whitespace, extra columns, or IPv6 formatting differences) so
    # the regex guard plus an explicit [int] cast protects against an
    # unintended shell injection or a non-PID token reaching taskkill.
    if ($orphanPidStr -match '^\d+$') {
        $orphanPid = [int]$orphanPidStr
        if ($orphanPid -gt 0) {
            Write-Output "bot-wrapper: killing PID $orphanPid on port 3978"
            $killResult = taskkill /f /pid $orphanPid 2>&1
            Write-Output "bot-wrapper: taskkill result: $killResult"
        } else {
            Write-Output "bot-wrapper: skipping invalid PID 0 from netstat output"
        }
    } else {
        Write-Output "bot-wrapper: could not parse a valid PID from netstat line: $portLine"
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

# Derive the script root dynamically (matches scheduler-wrapper.ps1's approach) so
# this works from whichever directory it's actually deployed in, rather than a
# hardcoded path that silently breaks if the launcher is ever moved again - which
# is exactly what happened to this repo's agent\/root dual-tree before.
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$scriptRoot\start-agent.ps1" teams
