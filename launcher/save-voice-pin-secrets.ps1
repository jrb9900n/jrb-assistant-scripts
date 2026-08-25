# save-voice-pin-secrets.ps1
# Run this in your own PowerShell window to store the live voice bridge's
# caller-authorization settings in Windows Credential Manager. Values are
# prompted interactively and never pass through Claude Code / chat.
#
# Kept separate from save-acs-secrets.ps1 on purpose: the PIN is a distinct
# trust boundary from the ACS connection string (Michael may want to rotate
# the PIN -- e.g. after any suspicion it leaked -- far more often than he'd
# ever touch ACS provisioning), matching this repo's convention of one
# secrets script per logical credential group.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\launcher\save-voice-pin-secrets.ps1"

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

Write-Host "`nVoice Bridge Caller Authorization - Credential Manager Setup" -ForegroundColor Cyan
Write-Host "================================================================`n"

Write-Host "VOICE_CALL_PIN - digits only, spoken by the caller to unlock calendar/email tool access on a live call. This is the real security gate, not the caller-ID check below (Caller ID is spoofable)."
Set-JRBSecret "VOICE_CALL_PIN"

Write-Host "`nVOICE_ALLOWED_CALLER_IDS - comma-separated E.164 numbers (e.g. +14145551234,+14145555678), Michael's own cell first. Advisory only -- cuts off obvious misdials/robocalls before the PIN challenge, not a real security boundary on its own."
Set-JRBSecret "VOICE_ALLOWED_CALLER_IDS"

Write-Host "`nDone. These are now readable as JRBAgent:VOICE_CALL_PIN and JRBAgent:VOICE_ALLOWED_CALLER_IDS."
Write-Host "Tell Claude once this is saved - no need to share the actual values."
