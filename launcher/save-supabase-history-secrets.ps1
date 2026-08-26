# save-supabase-history-secrets.ps1
# Run this in your own PowerShell window to store the "Old SA" history
# Supabase project's URL and service key in Windows Credential Manager. Values
# are prompted interactively and never pass through Claude Code / chat.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\launcher\save-supabase-history-secrets.ps1"

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class CredWriter {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags; public uint Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
    public static bool Save(string target, string user, string pass) {
        byte[] blob = Encoding.Unicode.GetBytes(pass);
        IntPtr ptr = Marshal.AllocHGlobal(blob.Length);
        Marshal.Copy(blob, 0, ptr, blob.Length);
        CREDENTIAL c = new CREDENTIAL { Type=1, TargetName=target, UserName=user,
            CredentialBlob=ptr, CredentialBlobSize=(uint)blob.Length, Persist=2 };
        bool ok = CredWrite(ref c, 0);
        Marshal.FreeHGlobal(ptr);
        return ok;
    }
}
"@

function Set-JRBSecret([string]$Name) {
    $value = Read-Host "Enter value for $Name"
    if ($value) {
        $ok = [CredWriter]::Save("JRBAgent:$Name", "JRBAgent", $value)
        if ($ok) { Write-Host "  Saved $Name" -ForegroundColor Green }
        else     { Write-Host "  Failed $Name" -ForegroundColor Red }
    } else { Write-Host "  Skipped $Name" -ForegroundColor Yellow }
}

Write-Host "`nSupabase History (Old SA) - Credential Manager Setup" -ForegroundColor Cyan
Write-Host "=========================================================`n"

Write-Host "SUPABASE_HISTORY_URL - project URL for the Old SA (2015-Aug 2023) archive Supabase project, e.g. https://<ref>.supabase.co"
Set-JRBSecret "SUPABASE_HISTORY_URL"

Write-Host "`nSUPABASE_HISTORY_KEY - service role key for that same project"
Set-JRBSecret "SUPABASE_HISTORY_KEY"

Write-Host "`nDone. These are now readable as JRBAgent:SUPABASE_HISTORY_URL / JRBAgent:SUPABASE_HISTORY_KEY."
Write-Host "The keepalive-supabase.ps1 task will pick them up automatically on its next scheduled run (every 4 days) - no restart needed."
Write-Host "Tell Claude once this is saved - no need to share the actual values."
