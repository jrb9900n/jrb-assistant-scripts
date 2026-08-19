# save-fleetsharp-secrets.ps1
# Run this in your own PowerShell window to store FleetSharp credentials
# in Windows Credential Manager. Values are prompted interactively and
# never pass through Claude Code / chat.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\agent\launcher\save-fleetsharp-secrets.ps1"

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

Write-Host "`nFleetSharp - Credential Manager Setup" -ForegroundColor Cyan
Write-Host "=======================================`n"

Write-Host "FLEETSHARP_URL - Base portal URL, e.g. https://yourcompany.fleetsharp.com"
Set-JRBSecret "FLEETSHARP_URL"

Write-Host "`nFLEETSHARP_EMAIL - Login username/email for the FleetSharp portal"
Set-JRBSecret "FLEETSHARP_EMAIL"

Write-Host "`nFLEETSHARP_PASSWORD - Login password for the FleetSharp portal"
Set-JRBSecret "FLEETSHARP_PASSWORD"

Write-Host "`nDone. These are now readable as JRBAgent:FLEETSHARP_URL / FLEETSHARP_EMAIL / FLEETSHARP_PASSWORD."
Write-Host "Tell Claude once this is saved - no need to share the actual values."
