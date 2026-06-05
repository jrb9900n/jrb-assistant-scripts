# scripts/stale-daemon-monitor.ps1
# Detects and kills three classes of stale node daemons, then restarts any that
# should be running, and records every kill in the agent memory system.
#
# Kill classes:
#   pm2-daemon        — any node.exe running pm2/lib/Daemon.js (leftover from PM2 era)
#   orphan-scheduler  — node.exe running cron.js that isn't the PID on record in %TEMP%\jrb-scheduler.pid
#   orphan-bot        — node.exe running bot.js that isn't the process listening on :3978
#   stale-code        — entry-point script on disk is newer than the process start (code changed while process ran)
#
# After a stale-code kill the script restarts the process via start-agent.ps1
# so the fresh code is live within seconds.
#
# Runs every 5 min via the "JRB Stale Daemon Monitor" Task Scheduler task.
# NOTE: Must run in the user's logged-in session — Get-WmiObject is session-scoped.

$AGENT_DIR   = "C:\Users\Assistant\JRBAgent\agent"
$LAUNCHER    = "C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1"
$LOG_FILE    = "$AGENT_DIR\logs\stale-daemon-kills.log"
$MEMORY_FILE = "C:\Users\Assistant\.claude\projects\C--Users-Assistant\memory\project-stale-daemon-kills.md"
$PID_FILE    = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "jrb-scheduler.pid")
$ts          = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$killed      = [System.Collections.Generic.List[hashtable]]::new()

function Write-KillLog {
    param([string]$KillPid, [string]$Reason, [string]$Cmd)
    $shortCmd = if ($Cmd.Length -gt 120) { $Cmd.Substring(0, 120) + "..." } else { $Cmd }
    $msg = "$ts  KILL pid=$KillPid  reason=$Reason  cmd=$shortCmd"
    Add-Content -Path $LOG_FILE -Value $msg -Encoding UTF8
    $killed.Add(@{ pid = $KillPid; reason = $Reason; cmd = $Cmd; time = $ts })
}

# ── Determine the legitimate scheduler PID ─────────────────────────────────────
$legitimatePid = $null
if (Test-Path $PID_FILE) {
    try {
        $rawPid = [int](Get-Content $PID_FILE -Raw -ErrorAction Stop).Trim()
        # Only treat as legitimate if the process is actually alive
        if (Get-Process -Id $rawPid -ErrorAction SilentlyContinue) {
            $legitimatePid = $rawPid
        }
    } catch {}
}

# ── Determine the legitimate bot PID (listening on :3978) ─────────────────────
$legitimateBotPid = $null
try {
    $netLine = netstat -ano | Select-String ":3978 .*LISTENING" | Select-Object -First 1
    if ($netLine) {
        $legitimateBotPid = [int](($netLine.ToString().Trim() -split '\s+')[-1])
    }
} catch {}

# ── Enumerate node.exe processes ───────────────────────────────────────────────
$nodeProcs = Get-WmiObject Win32_Process -Filter "name='node.exe'" |
    Select-Object ProcessId, CommandLine, CreationDate

$restartsNeeded = [System.Collections.Generic.HashSet[string]]::new()

foreach ($proc in $nodeProcs) {
    $pid = $proc.ProcessId
    $cmd = if ($proc.CommandLine) { $proc.CommandLine } else { "" }

    # 1. PM2 daemon — should never be running; the PM2 era is over
    if ($cmd -like "*pm2*Daemon*" -or $cmd -like "*pm2/lib/Daemon*" -or $cmd -like "*pm2\lib\Daemon*") {
        & taskkill /f /pid $pid | Out-Null
        Write-KillLog $pid "pm2-daemon" $cmd
        continue
    }

    # 2. Orphan scheduler — a cron.js that lost the PID-file race
    if ($cmd -like "*cron.js*") {
        if ($legitimatePid -and ($pid -ne $legitimatePid)) {
            & taskkill /f /pid $pid | Out-Null
            Write-KillLog $pid "orphan-scheduler" $cmd
            continue
        }
    }

    # 3. Orphan bot — a bot.js not on port 3978
    if ($cmd -like "*bot.js*") {
        if ($legitimateBotPid -and ($pid -ne $legitimateBotPid)) {
            & taskkill /f /pid $pid | Out-Null
            Write-KillLog $pid "orphan-bot" $cmd
            continue
        }
    }

    # 4. Stale code — entry-point script modified after the process started
    $scriptPath = $null
    if ($cmd -match "node(?:\.exe)?\s+(\S+\.(?:js|cjs|mjs))") {
        $rawPath = $Matches[1]
        $scriptPath = if ([System.IO.Path]::IsPathRooted($rawPath)) {
            $rawPath
        } else {
            [System.IO.Path]::Combine($AGENT_DIR, $rawPath)
        }
    }

    if ($scriptPath -and (Test-Path $scriptPath)) {
        $procStarted = [Management.ManagementDateTimeConverter]::ToDateTime($proc.CreationDate)
        $ageSec      = ((Get-Date) - $procStarted).TotalSeconds
        if ($ageSec -lt 90) { continue }  # Grace period — don't touch freshly-started processes

        $scriptMtime = (Get-Item $scriptPath).LastWriteTime
        if ($scriptMtime -gt $procStarted) {
            $scriptName = [System.IO.Path]::GetFileName($scriptPath)
            & taskkill /f /pid $pid | Out-Null
            Write-KillLog $pid "stale-code:$scriptName" $cmd

            # Queue a restart for continuously-running processes
            if ($cmd -like "*cron.js*") { $null = $restartsNeeded.Add("scheduler") }
            if ($cmd -like "*bot.js*")  { $null = $restartsNeeded.Add("teams") }
        }
    }
}



# ── Restart stale-killed processes ─────────────────────────────────────────────
foreach ($mode in $restartsNeeded) {
    $restartTs = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LOG_FILE -Value "$restartTs  RESTART mode=$mode after stale-code kill" -Encoding UTF8
    Start-Process powershell `
        -ArgumentList "-ExecutionPolicy Bypass -File `"$LAUNCHER`" $mode" `
        -WindowStyle Hidden
    Start-Sleep -Seconds 2
}

# ── Update memory file ──────────────────────────────────────────────────────────
if ($killed.Count -gt 0) {
    $newLines = ($killed | ForEach-Object {
        "- $($_.time)  pid=$($_.pid)  reason=$($_.reason)"
    }) -join "`n"

    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

    if (Test-Path $MEMORY_FILE) {
        $existing = [System.IO.File]::ReadAllText($MEMORY_FILE, $utf8NoBom)
        if ($existing -match "(?m)^## Kill Log") {
            # Prepend new entries right after the "## Kill Log" header
            $updated = $existing -replace "(?m)(^## Kill Log\s*$)", "`$1`n$newLines"
            [System.IO.File]::WriteAllText($MEMORY_FILE, $updated, $utf8NoBom)
        } else {
            [System.IO.File]::AppendAllText($MEMORY_FILE, "`n$newLines`n", $utf8NoBom)
        }
    } else {
        $body = @"
---
name: project-stale-daemon-kills
description: Rolling history of daemon kills by the stale-daemon-monitor watchdog — pm2 ghosts, orphans, and stale-code processes
metadata:
  type: project
---

Automated kill log written by ``agent/scripts/stale-daemon-monitor.ps1`` (runs every 5 min via Task Scheduler).
Each entry: timestamp, PID, reason (pm2-daemon / orphan-scheduler / orphan-bot / stale-code:filename).
Read this to understand how often stale daemons appear and which scripts are repeat offenders.

**Why:** PM2-era ghost processes silently ran old code (2026-06-05 incident). This monitor ensures only current code runs.
**How to apply:** If kills are frequent, the upstream cause is likely a restart flow that doesn't kill before relaunching.

## Kill Log
$newLines
"@
        [System.IO.File]::WriteAllText($MEMORY_FILE, $body, $utf8NoBom)
    }
}
