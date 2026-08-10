# watchdog-scheduler.ps1 — Restart cron.js if it is not running; alert via Teams if tasks
# have stalled (heartbeat file not updated in > 2 hours). Registered as "JRB Scheduler Watchdog",
# running every 30 minutes (less critical than bot watchdog).

Add-Type -AssemblyName System.Security

function Get-Secret {
    param([string]$Name)
    $target = "JRBAgent:$Name"
    try {
        $source = @"
using System;
using System.Runtime.InteropServices;
public class CredManagerWD {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags; public uint Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob;
        public uint Persist; public uint AttributeCount; public IntPtr Attributes;
        public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr buffer);
    public static string GetPassword(string target) {
        IntPtr ptr = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out ptr)) return null;
        var cred = Marshal.PtrToStructure<CREDENTIAL>(ptr);
        var password = Marshal.PtrToStringUni(cred.CredentialBlob, (int)cred.CredentialBlobSize / 2);
        CredFree(ptr);
        return password;
    }
}
"@
        if (-not ([System.Management.Automation.PSTypeName]'CredManagerWD').Type) {
            Add-Type -TypeDefinition $source
        }
        return [CredManagerWD]::GetPassword($target)
    } catch {
        return $null
    }
}

function Send-TeamsAlert {
    param([string]$Message)
    try {
        $secret = Get-Secret "CLAUDE_EXECUTE_SECRET"
        if (-not $secret) { return }
        $bodyJson = @{ message = $Message } | ConvertTo-Json -Compress
        $bytes    = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)
        $wc       = New-Object System.Net.WebClient
        $wc.Headers.Add("Content-Type", "application/json")
        $wc.Headers.Add("X-Execute-Secret", $secret)
        $wc.UploadData("https://agent.jrboehlke.com/notify", "POST", $bytes) | Out-Null
    } catch {}
}

$PID_FILE        = Join-Path $env:TEMP "jrb-scheduler.pid"
$HEARTBEAT_FILE  = Join-Path $env:TEMP "jrb-scheduler-heartbeat.txt"
$LAUNCHER        = "C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1"
$LOG_FILE        = "C:\Users\Assistant\JRBAgent\agent\logs\watchdog.log"
$STALL_THRESHOLD = 2 * 60 * 60   # 2 hours in seconds
$ts              = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# ── 1. Is the scheduler process alive? ────────────────────────────────────────

$running   = $false
$storedPid = 0

if (Test-Path $PID_FILE) {
    try {
        $storedPid = [int](Get-Content $PID_FILE -Raw -ErrorAction Stop).Trim()
        if ($storedPid) {
            $proc = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.Name -like "node*") { $running = $true }
        }
    } catch {}
}

if (-not $running) {
    Add-Content -Path $LOG_FILE -Value "$ts  Scheduler not found -- restarting" -Encoding UTF8
    Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$LAUNCHER`" scheduler" -WindowStyle Hidden
    Send-TeamsAlert "Scheduler watchdog: cron.js was not running and has been restarted."
    exit 0
}

# ── 2. Heartbeat check — did any task actually run recently? ──────────────────

if (-not (Test-Path $HEARTBEAT_FILE)) { exit 0 }   # no baseline yet after first deploy

try {
    $rawTs    = (Get-Content $HEARTBEAT_FILE -Raw -ErrorAction Stop).Trim()
    $lastBeat = [long]$rawTs
    $nowMs    = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $ageSec   = [long](($nowMs - $lastBeat) / 1000)

    if ($ageSec -gt $STALL_THRESHOLD) {
        $ageMin = [long]($ageSec / 60)
        $msg    = "Scheduler watchdog: no task has completed in $ageMin min. Scheduler process is alive (PID $storedPid) but may be stalled. Check agent logs."
        Add-Content -Path $LOG_FILE -Value "$ts  $msg" -Encoding UTF8
        Send-TeamsAlert $msg
    }
} catch {
    Add-Content -Path $LOG_FILE -Value "$ts  Heartbeat check error: $_" -Encoding UTF8
}
