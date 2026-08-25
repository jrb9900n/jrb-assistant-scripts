# save-acs-secrets.ps1
# Run this in your own PowerShell window to store Azure Communication
# Services credentials in Windows Credential Manager. Values are prompted
# interactively and never pass through Claude Code / chat.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\launcher\save-acs-secrets.ps1"

# Guard against Add-Type collision when both secrets scripts are run in the
# same PowerShell session (e.g. during testing). Each script uses a distinct
# class name so the guard is per-script, not shared.
if (-not ([System.Management.Automation.PSTypeName]'AcsCredWriter').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AcsCredWriter {
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
        bool ok = false;
        try {
            ok = CredWrite(ref c, 0);
        } finally {
            // Zero the secret bytes in unmanaged memory before freeing so the
            // plaintext credential does not linger on the heap.
            for (int i = 0; i < blob.Length; i++) {
                Marshal.WriteByte(ptr, i, 0);
            }
            Array.Clear(blob, 0, blob.Length);
            Marshal.FreeHGlobal(ptr);
        }
        return ok;
    }
}
"@
}

function Set-JRBSecret([string]$Name) {
    # -AsSecureString keeps the value out of a plain System.String in managed
    # memory. We marshal it to an unmanaged BSTR solely to pass it into the
    # C# Save() call; the BSTR is freed immediately after.
    $secure = Read-Host "Enter value for $Name" -AsSecureString
    if ($secure.Length -gt 0) {
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $value = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
            $ok = [AcsCredWriter]::Save("JRBAgent:$Name", "JRBAgent", $value)
        } finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
        if ($ok) { Write-Host "  Saved $Name" -ForegroundColor Green }
        else     { Write-Host "  Failed $Name" -ForegroundColor Red }
    } else { Write-Host "  Skipped $Name" -ForegroundColor Yellow }
}

Write-Host "`nAzure Communication Services - Credential Manager Setup" -ForegroundColor Cyan
Write-Host "=========================================================`n"

Write-Host "ACS_CONNECTION_STRING - from the ACS resource's Keys blade in the Azure Portal, used for Call Automation (answer/reject/hang up calls) in the live voice bridge"
Set-JRBSecret "ACS_CONNECTION_STRING"

Write-Host "`nACS_VOICE_PHONE_NUMBER - the E.164 phone number (e.g. +14145551234) provisioned on the ACS resource that Michael dials to reach the live voice bridge"
Set-JRBSecret "ACS_VOICE_PHONE_NUMBER"

Write-Host "`nDone. These are now readable as JRBAgent:ACS_CONNECTION_STRING and JRBAgent:ACS_VOICE_PHONE_NUMBER."
Write-Host "Tell Claude once this is saved - no need to share the actual values."
