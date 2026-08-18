if (-not ([System.Management.Automation.PSTypeName]'TwilioCredWriter').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class TwilioCredWriter {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags; public uint Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredWrite([In] ref CREDENTIAL credential, uint flags);
    public static bool Write(string target, string password) {
        // Use Encoding.Unicode.GetBytes so that CredentialBlobSize is the true
        // byte length (handles surrogate pairs correctly; password.Length*2 would
        // undercount a string containing supplementary-plane characters).
        byte[] blob = Encoding.Unicode.GetBytes(password);
        IntPtr ptr = Marshal.AllocHGlobal(blob.Length);
        try {
            Marshal.Copy(blob, 0, ptr, blob.Length);
            var cred = new CREDENTIAL { Type=1, TargetName=target, UserName="JRBAgent",
                CredentialBlob=ptr, CredentialBlobSize=(uint)blob.Length, Persist=2 };
            return CredWrite(ref cred, 0);
        } finally {
            // Always free the unmanaged buffer, even if CredWrite throws.
            Marshal.FreeHGlobal(ptr);
        }
    }
}
"@
}

function Save-Secret {
    param([string]$Name, [string]$Prompt)
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $plain  = [System.Net.NetworkCredential]::new("", $secure).Password
    if ([string]::IsNullOrWhiteSpace($plain)) { Write-Warning "Skipped $Name (empty)"; return }
    $ok = [TwilioCredWriter]::Write("JRBAgent:$Name", $plain)
    if ($ok) { Write-Host "  Saved $Name" -ForegroundColor Green }
    else     { Write-Warning "Failed to save $Name (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
}

Write-Host "Twilio credential setup - values are masked as you type." -ForegroundColor Cyan
Write-Host ""
Save-Secret "TWILIO_ACCOUNT_SID" "Account SID (starts with AC)"
Save-Secret "TWILIO_AUTH_TOKEN"  "Auth Token"
Save-Secret "TWILIO_FROM_PHONE"  "From phone number (e.g. +14145551234)"
Write-Host ""
Write-Host "Done. Restart the agent after merging the PR for these to take effect." -ForegroundColor Cyan
