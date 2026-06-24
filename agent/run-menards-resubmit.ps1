$AgentDir = "C:\Users\Assistant\JRBAgent\agent"

Add-Type -AssemblyName System.Security

$src = @"
using System;
using System.Runtime.InteropServices;
public class CredMgrRS {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags; public uint Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
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
Add-Type -TypeDefinition $src

function Get-S { param([string]$n); [CredMgrRS]::GetPassword("JRBAgent:$n") }

[System.Environment]::SetEnvironmentVariable("FLEETOPS_SUPABASE_URL",         "https://mzywmgesulyalevtzudw.supabase.co",  "Process")
[System.Environment]::SetEnvironmentVariable("FLEETOPS_SUPABASE_SERVICE_KEY",  (Get-S "FLEETOPS_SUPABASE_SERVICE_KEY"),      "Process")
[System.Environment]::SetEnvironmentVariable("M365_TENANT_ID",                 (Get-S "M365_TENANT_ID"),                    "Process")
[System.Environment]::SetEnvironmentVariable("M365_CLIENT_ID",                 (Get-S "M365_CLIENT_ID"),                    "Process")
[System.Environment]::SetEnvironmentVariable("M365_CLIENT_SECRET",             (Get-S "M365_CLIENT_SECRET"),                "Process")
[System.Environment]::SetEnvironmentVariable("M365_USER_EMAIL",                (Get-S "M365_USER_EMAIL"),                   "Process")
[System.Environment]::SetEnvironmentVariable("MENARDS_REBATE_FIRST_NAME",      (Get-S "MENARDS_REBATE_FIRST_NAME"),         "Process")
[System.Environment]::SetEnvironmentVariable("MENARDS_REBATE_LAST_NAME",       (Get-S "MENARDS_REBATE_LAST_NAME"),          "Process")
[System.Environment]::SetEnvironmentVariable("MENARDS_REBATE_ADDRESS1",        (Get-S "MENARDS_REBATE_ADDRESS1"),           "Process")
[System.Environment]::SetEnvironmentVariable("MENARDS_REBATE_CITY",            (Get-S "MENARDS_REBATE_CITY"),               "Process")
[System.Environment]::SetEnvironmentVariable("MENARDS_REBATE_STATE",           (Get-S "MENARDS_REBATE_STATE"),              "Process")
[System.Environment]::SetEnvironmentVariable("MENARDS_REBATE_ZIP",             (Get-S "MENARDS_REBATE_ZIP"),                "Process")
[System.Environment]::SetEnvironmentVariable("MENARDS_REBATE_EMAIL",           (Get-S "MENARDS_REBATE_EMAIL"),              "Process")
[System.Environment]::SetEnvironmentVariable("SA_PROXY_URL",                   (Get-S "SA_PROXY_URL"),                      "Process")

Set-Location $AgentDir
node test-menards-resubmit.mjs
