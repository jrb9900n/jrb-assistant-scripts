# update-sa-proxy.ps1
# Run this in your own PowerShell window to update the SA_PROXY_URL secret
# after switching Webshare plans. Prompts interactively, never echoes the value.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\agent\launcher\update-sa-proxy.ps1"
#
# Enter the new proxy in the form: http://username:password@host:port

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class CredWriter2 {
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

$value = Read-Host "Enter new SA_PROXY_URL (http://user:pass@host:port)"
if ($value) {
    $ok = [CredWriter2]::Save("JRBAgent:SA_PROXY_URL", "JRBAgent", $value)
    if ($ok) { Write-Host "Saved SA_PROXY_URL" -ForegroundColor Green }
    else     { Write-Host "Failed to save SA_PROXY_URL" -ForegroundColor Red }
} else { Write-Host "Skipped - no value entered" -ForegroundColor Yellow }
