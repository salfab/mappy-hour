$ProgressPreference = "SilentlyContinue"
$nodeDir = "C:\tools\node-v20.18.0"
$env:PATH = "$nodeDir;$env:APPDATA\npm;" + $env:PATH
$repoDir = "C:\srv\mappy-hour"

Set-Location $repoDir

Write-Host "=== git pull ==="
git pull
if ($LASTEXITCODE -ne 0) { Write-Host "git pull failed"; exit 1 }

Write-Host "=== pnpm install ==="
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Write-Host "pnpm install failed"; exit 1 }

Write-Host "=== pnpm build ==="
$env:NEXT_PUBLIC_FORCE_CACHE_ONLY = "true"
pnpm build
if ($LASTEXITCODE -ne 0) { Write-Host "pnpm build failed"; exit 1 }

Write-Host "=== Arret ancien serveur ==="
$pids = netstat -ano | Select-String ":3000 " | ForEach-Object {
    ($_ -split '\s+')[-1]
} | Sort-Object -Unique
foreach ($p in $pids) {
    if ($p -match '^\d+$' -and [int]$p -gt 0) {
        Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue
        Write-Host "Killed PID $p"
    }
}
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

Write-Host "=== Demarrage via WMI ==="
Set-Content "$repoDir\server.log" ""
Set-Content "$repoDir\server.err" ""
$cmd = "powershell.exe -NoProfile -File C:\temp\mitch-start.ps1"
$result = (Get-WmiObject -List Win32_Process).Create($cmd)
if ($result.ReturnValue -eq 0) {
    Set-Content "$repoDir\server.pid" $result.ProcessId
    Write-Host "Demarre via WMI, PID $($result.ProcessId). Attente 20s..."
} else {
    Write-Host "WMI launch failed: ReturnValue=$($result.ReturnValue)"
    exit 1
}
Start-Sleep 20

Write-Host "=== Verification ==="
try {
    $r = Invoke-WebRequest "http://127.0.0.1:3000" -UseBasicParsing -TimeoutSec 10
    Write-Host "OK: HTTP $($r.StatusCode) - serveur operationnel"
} catch {
    Write-Host "FAIL: $($_.Exception.Message)"
    Get-Content "$repoDir\server.log" -Tail 20 -ErrorAction SilentlyContinue
    Get-Content "$repoDir\server.err" -Tail 10 -ErrorAction SilentlyContinue
}
