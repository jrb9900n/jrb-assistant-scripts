# save-other-org-supabase-secrets.ps1
# Run this in your own PowerShell window to store the URL + service key for
# each Supabase project that lives under the other (non-J.R. Boehlke) org -
# "JRB SA History" (Old SA, 2015-Aug 2023 archive) and "JRB Database" - in
# Windows Credential Manager. Values are prompted interactively and never
# pass through Claude Code / chat.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\launcher\save-other-org-supabase-secrets.ps1"

$credWriterSource = @"
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
# Guarded like keepalive-supabase.ps1's Get-Secret: running this in the same
# PowerShell session as any sibling save-*-secrets.ps1 (all of which define
# an identical CredWriter the same way) would otherwise throw "type already
# exists" and abort before saving anything - already hit once before, which
# is why update-sa-proxy.ps1 had to rename its own copy to CredWriter2.
if (-not ([System.Management.Automation.PSTypeName]'CredWriter').Type) {
    Add-Type -TypeDefinition $credWriterSource
}

function Set-JRBSecret([string]$Name) {
    $value = (Read-Host "Enter value for $Name").Trim()
    if ($Name -like "*_URL") { $value = $value.TrimEnd('/') }
    if ($value) {
        $ok = [CredWriter]::Save("JRBAgent:$Name", "JRBAgent", $value)
        if ($ok) { Write-Host "  Saved $Name" -ForegroundColor Green }
        else     { Write-Host "  Failed $Name" -ForegroundColor Red }
    } else { Write-Host "  Skipped $Name" -ForegroundColor Yellow }
}

Write-Host "`nOther-Org Supabase Projects - Credential Manager Setup" -ForegroundColor Cyan
Write-Host "============================================================`n"
Write-Host "These credentials are ONLY used to ping each project's root REST endpoint"
Write-Host "to keep it from auto-pausing - never to read or write any table/row data.`n"

Write-Host "--- JRB SA History (Old SA, 2015-Aug 2023 archive) ---"
Write-Host "SUPABASE_HISTORY_URL - project URL, e.g. https://<ref>.supabase.co"
Set-JRBSecret "SUPABASE_HISTORY_URL"
Write-Host "SUPABASE_HISTORY_KEY - service role key for that same project"
Set-JRBSecret "SUPABASE_HISTORY_KEY"

Write-Host "`n--- JRB Database ---"
Write-Host "SUPABASE_JRBDB_URL - project URL, e.g. https://<ref>.supabase.co"
Set-JRBSecret "SUPABASE_JRBDB_URL"
Write-Host "SUPABASE_JRBDB_KEY - service role key for that same project"
Set-JRBSecret "SUPABASE_JRBDB_KEY"

Write-Host "`nDone. These are now readable as JRBAgent:SUPABASE_HISTORY_URL / JRBAgent:SUPABASE_HISTORY_KEY"
Write-Host "and JRBAgent:SUPABASE_JRBDB_URL / JRBAgent:SUPABASE_JRBDB_KEY."
Write-Host "The keepalive-supabase.ps1 task will pick up whichever pairs are saved automatically on its"
Write-Host "next scheduled run (every 4 days) - no restart needed."
Write-Host "Tell Claude once this is saved - no need to share the actual values."
