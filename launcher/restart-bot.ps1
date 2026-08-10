# One-shot bot restart — kills the process on 3978 and relaunches via launcher
$pids = @(netstat -ano | Select-String ":3978\s+.*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] })
foreach ($procId in $pids) {
    if ($procId -match '^\d+$') { taskkill /f /pid $procId 2>$null }
}
Start-Sleep 2
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1`" teams" -WindowStyle Hidden
