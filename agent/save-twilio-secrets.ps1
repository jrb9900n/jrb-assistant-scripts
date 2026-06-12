Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredWriter2 {
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
        var blob = Marshal.StringToCoTaskMemUni(password);
        var cred = new CREDENTIAL { Type=1, TargetName=target, UserName="JRBAgent",
            CredentialBlob=blob, CredentialBlobSize=(uint)(password.Length*2), Persist=2 };
        bool r = CredWrite(ref cred, 0);
        Marshal.FreeCoTaskMem(blob);
        return r;
    }
}
"@

function Save-Secret {
    param([string]$Name, [string]$Prompt)
    $val = Read-Host -Prompt $Prompt -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($val))
    if ([string]::IsNullOrWhiteSpace($plain)) { Write-Warning "Skipped $Name (empty)"; return }
    $ok = [CredWriter2]::Write("JRBAgent:$Name", $plain)
    if ($ok) { Write-Host "Saved $Name" } else { Write-Warning "Failed to save $Name" }
}

Write-Host "Twilio credential setup — values are masked as you type."
Write-Host ""
Save-Secret "TWILIO_ACCOUNT_SID" "Account SID (starts with AC)"
Save-Secret "TWILIO_AUTH_TOKEN"  "Auth Token"
Save-Secret "TWILIO_FROM_PHONE"  "From phone number (E.164, e.g. +12622001234)"
Write-Host ""
Write-Host "Done. Restart the agent after merging the PR for these to take effect."
