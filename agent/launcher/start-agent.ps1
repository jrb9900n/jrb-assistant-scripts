# launcher/start-agent.ps1
$AgentDir = "C:\Users\Assistant\JRBAgent\agent"

Add-Type -AssemblyName System.Security

function Get-Secret {
    param([string]$Name)
    $target = "JRBAgent:$Name"
    try {
        # Read via Windows Credential Manager using native API
        $source = @"
using System;
using System.Runtime.InteropServices;
public class CredManager {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
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
        if (-not ([System.Management.Automation.PSTypeName]'CredManager').Type) {
            Add-Type -TypeDefinition $source
        }
        $result = [CredManager]::GetPassword($target)
        if ($null -eq $result) { Write-Warning "Secret not found: $Name" }
        return $result
    } catch {
        Write-Warning "Error reading secret $Name`: $_"
        return $null
    }
}

$secrets = @{
    "ANTHROPIC_API_KEY"    = Get-Secret "ANTHROPIC_API_KEY"
    "SUPABASE_URL"         = "https://znpahinyplccdyoekfeo.supabase.co"
    "SUPABASE_SERVICE_KEY" = Get-Secret "SUPABASE_SERVICE_KEY"
    "M365_TENANT_ID"       = Get-Secret "M365_TENANT_ID"
    "M365_CLIENT_ID"       = Get-Secret "M365_CLIENT_ID"
    "M365_CLIENT_SECRET"   = Get-Secret "M365_CLIENT_SECRET"
    "M365_USER_EMAIL"      = "assistant@jrboehlke.com"
    "QB_CLIENT_ID"         = Get-Secret "QB_CLIENT_ID"
    "QB_CLIENT_SECRET"     = Get-Secret "QB_CLIENT_SECRET"
    "QB_REFRESH_TOKEN"     = Get-Secret "QB_REFRESH_TOKEN"
    "QB_REALM_ID"          = "9130357265584656"
    "GITHUB_TOKEN"         = Get-Secret "GITHUB_TOKEN"
    "GITHUB_USERNAME" = "jrb9900n"
    "GITHUB_REPOS"    = "jrb-assistant-scripts,FleetOps,FieldOps,AuditMatchingEngine"
    "TEAMS_BOT_APP_ID"     = Get-Secret "M365_CLIENT_ID"
    "TEAMS_BOT_APP_SECRET" = Get-Secret "TEAMS_BOT_APP_SECRET"
    "TEAMS_PORT"           = "3978"
    "TEAMS_PUBLIC_URL"    = "https://agent.jrboehlke.com"
    "BRAVE_SEARCH_API_KEY" = Get-Secret "BRAVE_SEARCH_API_KEY"
    "SA_EMAIL"             = Get-Secret "SA_EMAIL"
    "SA_PASSWORD"          = Get-Secret "SA_PASSWORD"
    "SA_EMAIL_OLD"         = Get-Secret "SA_EMAIL_OLD"
    "SA_PASSWORD_OLD"      = Get-Secret "SA_PASSWORD_OLD"
    "SA_PROXY_URL"         = Get-Secret "SA_PROXY_URL"
    # Expense capture
    "FLEETOPS_SUPABASE_URL"          = "https://mzywmgesulyalevtzudw.supabase.co"
    "FLEETOPS_SUPABASE_SERVICE_KEY"  = Get-Secret "FLEETOPS_SUPABASE_SERVICE_KEY"
    "QB_WEBHOOK_VERIFIER_TOKEN"      = Get-Secret "QB_WEBHOOK_VERIFIER_TOKEN"
    "EXPENSE_PORTAL_BASE"            = "https://fieldops.jrboehlke.com/expense"
    # Menards rebate automation
    "EDGE_PATH"                      = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    "REBATE_URL"                     = Get-Secret "REBATE_URL"
    "MENARDS_REBATE_FIRST_NAME"      = Get-Secret "MENARDS_REBATE_FIRST_NAME"
    "MENARDS_REBATE_LAST_NAME"       = Get-Secret "MENARDS_REBATE_LAST_NAME"
    "MENARDS_REBATE_ADDRESS1"        = Get-Secret "MENARDS_REBATE_ADDRESS1"
    "MENARDS_REBATE_CITY"            = Get-Secret "MENARDS_REBATE_CITY"
    "MENARDS_REBATE_STATE"           = Get-Secret "MENARDS_REBATE_STATE"
    "MENARDS_REBATE_ZIP"             = Get-Secret "MENARDS_REBATE_ZIP"
    "MENARDS_REBATE_PHONE"           = Get-Secret "MENARDS_REBATE_PHONE"
    "MENARDS_REBATE_EMAIL"           = Get-Secret "MENARDS_REBATE_EMAIL"
    # BTA Reporting weekly syncs
    "GOOGLE_SHEET_ID"       = Get-Secret "GOOGLE_SHEET_ID"
    "CLAUDE_EXECUTE_SECRET" = Get-Secret "CLAUDE_EXECUTE_SECRET"
    "CLAUDE_MCP_TOKEN"      = Get-Secret "CLAUDE_EXECUTE_SECRET"
    "HAIKU_THRESHOLD"      = "500"
    "CACHE_TTL_SECONDS"    = "3600"
    "MAX_TOKENS_SONNET"    = "4096"
    "MAX_TOKENS_HAIKU"     = "1024"
    "LOG_LEVEL"            = "info"
}

foreach ($kv in $secrets.GetEnumerator()) {
    if ($kv.Value) {
        [System.Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
    }
}

$mode = $args[0]
switch ($mode) {
    "teams"     { Set-Location $AgentDir; node teams/bot.js }
    "scheduler" { Set-Location $AgentDir; node scheduler/cron.js }
    "cli"       { $task = $args[1..($args.Length-1)] -join " "; Set-Location $AgentDir; node cli.js $task }
    "pm2-teams" {
        Set-Location $AgentDir
        $envLines = @()
        foreach ($kv in $secrets.GetEnumerator()) {
            if ($kv.Value) { $envLines += "$($kv.Key)=$($kv.Value)" }
        }
        $envLines | Set-Content ".env"
        $nodeExe = "C:\Users\Assistant\scoop\apps\nodejs\current\node.exe"
        pm2 start teams/bot.js --name jrb-teams-bot --interpreter $nodeExe
        Start-Sleep 3
        Remove-Item ".env" -Force
    }
    "pm2-scheduler" {
        Set-Location $AgentDir
        $envLines = @()
        foreach ($kv in $secrets.GetEnumerator()) {
            if ($kv.Value) { $envLines += "$($kv.Key)=$($kv.Value)" }
        }
        $envLines | Set-Content ".env"
        $nodeExe = "C:\Users\Assistant\scoop\apps\nodejs\current\node.exe"
        pm2 start scheduler/cron.js --name jrb-scheduler --interpreter $nodeExe
        Start-Sleep 3
        Remove-Item ".env" -Force
    }
    default     { Write-Host "Usage: .\start-agent.ps1 [teams|scheduler|cli|pm2-teams]" }
}

