$cf = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
    $logFile = "C:\Users\Assistant\.cloudflared\tunnel.log"
    # Rotate if over 5 MB
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 5MB) {
        Move-Item $logFile "$logFile.bak" -Force
    }
    Start-Process `
        -FilePath "C:\Users\Assistant\scoop\shims\cloudflared.exe" `
        -ArgumentList "tunnel --logfile `"$logFile`" run jrb-agent" `
        -WindowStyle Hidden
}
