# save-adp-secrets.ps1
# Run this in your own PowerShell window to store ADP (RUN Powered by ADP)
# API credentials in Windows Credential Manager. Values are read from local
# files you provide and never pass through Claude Code / chat.
#
# BEFORE RUNNING THIS: you must have already completed ADP API Central
# developer registration (see tools/impl/adp.js header for the full
# checklist) and have in hand:
#   - a Client ID and Client Secret for your registered app
#   - a client certificate + private key (PEM format) issued/associated by ADP
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\launcher\save-adp-secrets.ps1"

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class CredWriterADP {
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

function Set-JRBSecret([string]$Name, [string]$Value) {
    if ($Value) {
        $ok = [CredWriterADP]::Save("JRBAgent:$Name", "JRBAgent", $Value)
        if ($ok) { Write-Host "  Saved $Name" -ForegroundColor Green }
        else     { Write-Host "  Failed $Name" -ForegroundColor Red }
    } else { Write-Host "  Skipped $Name" -ForegroundColor Yellow }
}

function Set-JRBSecretPrompt([string]$Name) {
    $value = Read-Host "Enter value for $Name"
    Set-JRBSecret $Name $value
}

function Set-JRBSecretFromFile([string]$Name, [string]$Prompt) {
    $path = Read-Host $Prompt
    if ($path -and (Test-Path $path)) {
        $content = Get-Content -Raw -Path $path
        Set-JRBSecret $Name $content
    } else {
        Write-Host "  Skipped $Name (no file found at that path)" -ForegroundColor Yellow
    }
}

Write-Host "`nADP (RUN Powered by ADP) - Credential Manager Setup" -ForegroundColor Cyan
Write-Host "=======================================================`n"

Write-Host "ADP_CLIENT_ID - OAuth2 client ID from your registered ADP API Central app"
Set-JRBSecretPrompt "ADP_CLIENT_ID"

Write-Host "`nADP_CLIENT_SECRET - OAuth2 client secret from your registered ADP API Central app"
Set-JRBSecretPrompt "ADP_CLIENT_SECRET"

Write-Host "`nADP_CLIENT_CERT - path to your client certificate PEM file (full chain, not just the leaf, if ADP issued one)"
Set-JRBSecretFromFile "ADP_CLIENT_CERT" "Enter file path to the certificate PEM"

Write-Host "`nADP_CLIENT_KEY - path to your client private key PEM file"
Set-JRBSecretFromFile "ADP_CLIENT_KEY" "Enter file path to the private key PEM"

Write-Host "`nDone. These are now readable as JRBAgent:ADP_CLIENT_ID / ADP_CLIENT_SECRET / ADP_CLIENT_CERT / ADP_CLIENT_KEY."
Write-Host "These also need to be added to launcher/start-agent.ps1's \$secrets injection (a separate PR - editing"
Write-Host "start-agent.ps1 always requires Michael's explicit go-ahead per CLAUDE.md's Autonomy Rules) and the"
Write-Host "agent restarted before tools/impl/adp.js will see them."
Write-Host "Tell Claude once this is saved - no need to share the actual values."
