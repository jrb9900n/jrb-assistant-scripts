# Load secrets from Windows Credential Manager
function Get-Secret($name) {
    $cred = cmdkey /list:JRBAgent:$name 2>$null
    $result = cmdkey /list | Select-String "JRBAgent:$name"
    if ($result) {
        Add-Type -AssemblyName System.Security
        $cm = [System.Net.CredentialCache]::DefaultCredentials
    }
    # Use credential manager via PowerShell
    $wincred = Get-StoredCredential -Target "JRBAgent:$name" -ErrorAction SilentlyContinue
    return $wincred?.Password
}

# Load all secrets into environment
$secrets = @(
    "ANTHROPIC_API_KEY","SUPABASE_URL","SUPABASE_SERVICE_KEY",
    "M365_TENANT_ID","M365_CLIENT_ID","M365_CLIENT_SECRET",
    "TEAMS_BOT_APP_SECRET","QB_CLIENT_ID","QB_CLIENT_SECRET",
    "QB_REFRESH_TOKEN","GITHUB_TOKEN","BRAVE_SEARCH_API_KEY",
    "SA_EMAIL","SA_PASSWORD","SA_EMAIL_OLD","SA_PASSWORD_OLD"
)

foreach ($key in $secrets) {
    $val = (cmdkey /list:JRBAgent:$key 2>&1)
}
