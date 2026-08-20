# keepalive-supabase.ps1
# Pings both JRBAgent Supabase projects (a lightweight authenticated PostgREST
# request, not just a network reachability check) so free-tier auto-pause
# (triggered by ~1 week of zero API activity) never kicks in.
#
# Registered as "JRB-Supabase-Keepalive", running every 4 days.
#
# Rebuilt 2026-08-19: the task's Action always pointed at this exact root path,
# but the file itself did not exist anywhere in the repo (no git history under
# this name either) - so the task had been silently failing with a
# file-not-found LastTaskResult since it was created on 2026-07-31. This is a
# fresh implementation, not a recovered original.

Add-Type -AssemblyName System.Security

function Get-Secret {
    param([string]$Name)
    $target = "JRBAgent:$Name"
    try {
        $source = @"
using System;
using System.Runtime.InteropServices;
public class CredManagerKA {
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
        if (-not ([System.Management.Automation.PSTypeName]'CredManagerKA').Type) {
            Add-Type -TypeDefinition $source
        }
        return [CredManagerKA]::GetPassword($target)
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

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$LOG_FILE   = Join-Path $scriptRoot "logs\supabase-keepalive.log"
$ts         = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# Same two Supabase projects used elsewhere in this repo (see CLAUDE.md's
# Credentials section) - both free-tier, both at risk of auto-pause.
$projects = @(
    @{ Name = "jrb-assistant"; Url = "https://znpahinyplccdyoekfeo.supabase.co"; KeyName = "SUPABASE_SERVICE_KEY" },
    @{ Name = "fleetops";      Url = "https://mzywmgesulyalevtzudw.supabase.co"; KeyName = "FLEETOPS_SUPABASE_SERVICE_KEY" }
)

$failures = [System.Collections.Generic.List[string]]::new()

foreach ($p in $projects) {
    $key = Get-Secret $p.KeyName
    if (-not $key) {
        $msg = "$ts  SKIP $($p.Name): secret $($p.KeyName) not found in Credential Manager"
        Add-Content -Path $LOG_FILE -Value $msg -Encoding UTF8
        $failures.Add("$($p.Name): missing secret $($p.KeyName)")
        continue
    }
    try {
        # A real PostgREST call (not just a TCP/HTTP reachability check) - this is
        # what registers as project activity against Supabase's inactivity timer.
        $headers = @{ apikey = $key; Authorization = "Bearer $key" }
        Invoke-WebRequest -Uri "$($p.Url)/rest/v1/" -Headers $headers -UseBasicParsing -TimeoutSec 20 | Out-Null
        Add-Content -Path $LOG_FILE -Value "$ts  OK $($p.Name)" -Encoding UTF8
    } catch {
        $errMsg = $_.Exception.Message
        Add-Content -Path $LOG_FILE -Value "$ts  ERROR $($p.Name): $errMsg" -Encoding UTF8
        $failures.Add("$($p.Name): $errMsg")
    }
}

if ($failures.Count -gt 0) {
    Send-TeamsAlert "Supabase keepalive: $($failures.Count) project(s) failed to ping - $($failures -join '; ')"
}
