# save-fleetops-secrets.ps1
# Run this in your own PowerShell window to store your FleetOps login
# in Windows Credential Manager. Values are prompted interactively and
# never pass through Claude Code / chat.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\launcher\save-fleetops-secrets.ps1"

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

    // Accepts a SecureString so the plaintext never lives in a managed string.
    // The SecureString's unmanaged buffer is passed directly to CredWrite, then
    // zeroed and freed before this method returns.
    public static bool Save(string target, string user, System.Security.SecureString pass) {
        // Marshal the SecureString to unmanaged Unicode memory (already maintained
        // as Unicode internally by SecureString on Windows).
        IntPtr ptr = IntPtr.Zero;
        bool ok = false;
        try {
            ptr = Marshal.SecureStringToGlobalAllocUnicode(pass);
            int byteLen = pass.Length * 2; // UTF-16LE: 2 bytes per char
            CREDENTIAL c = new CREDENTIAL {
                Type=1, TargetName=target, UserName=user,
                CredentialBlob=ptr, CredentialBlobSize=(uint)byteLen, Persist=2
            };
            ok = CredWrite(ref c, 0);
        } finally {
            if (ptr != IntPtr.Zero) {
                // Zero the unmanaged buffer before releasing it so the
                // plaintext password does not linger in freed memory.
                Marshal.ZeroFreeGlobalAllocUnicode(ptr);
            }
        }
        return ok;
    }
}
"@

function Set-JRBSecret([string]$Name) {
    # -AsSecureString keeps the keystrokes out of a plain managed string.
    $secure = Read-Host "Enter value for $Name" -AsSecureString
    if ($secure -and $secure.Length -gt 0) {
        $ok = [CredWriter]::Save("JRBAgent:$Name", "JRBAgent", $secure)
        # Dispose the SecureString immediately after use.
        $secure.Dispose()
        if ($ok) { Write-Host "  Saved $Name" -ForegroundColor Green }
        else     { Write-Host "  Failed $Name" -ForegroundColor Red }
    } else { Write-Host "  Skipped $Name" -ForegroundColor Yellow }
}

Write-Host "`nFleetOps - Credential Manager Setup" -ForegroundColor Cyan
Write-Host "=====================================`n"

Write-Host "FLEETOPS_EMAIL - Your login email for https://fleetops.jrboehlke.com"
Set-JRBSecret "FLEETOPS_EMAIL"

Write-Host "`nFLEETOPS_PASSWORD - Your login password for FleetOps"
Set-JRBSecret "FLEETOPS_PASSWORD"

Write-Host "`nDone. These are now readable as JRBAgent:FLEETOPS_EMAIL / FLEETOPS_PASSWORD."
Write-Host "Tell Claude once this is saved - no need to share the actual values."
