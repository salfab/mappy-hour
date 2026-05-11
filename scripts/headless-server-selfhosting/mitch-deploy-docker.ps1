$ProgressPreference = "SilentlyContinue"
$repoDir = "C:\srv\mappy-hour"

Set-Location $repoDir

# git pull so the compose file is always up to date
Write-Host "=== git pull ==="
git pull
if ($LASTEXITCODE -ne 0) { Write-Host "git pull failed"; exit 1 }

Write-Host "=== docker compose pull ==="
wsl -d Ubuntu -u root -e bash -c "cd /mnt/c/srv/mappy-hour && docker compose pull"
if ($LASTEXITCODE -ne 0) { Write-Host "docker compose pull failed"; exit 1 }

Write-Host "=== docker compose up -d ==="
wsl -d Ubuntu -u root -e bash -c "cd /mnt/c/srv/mappy-hour && docker compose up -d --remove-orphans"
if ($LASTEXITCODE -ne 0) { Write-Host "docker compose up failed"; exit 1 }

Write-Host "=== Waiting 25s for container to start ==="
Start-Sleep 25

Write-Host "=== Health check ==="
try {
    $r = Invoke-WebRequest "http://127.0.0.1:3000/api/datasets" -UseBasicParsing -TimeoutSec 10
    Write-Host "OK: HTTP $($r.StatusCode) - container operational"
} catch {
    Write-Host "FAIL: $($_.Exception.Message)"
    wsl -d Ubuntu -u root -e bash -c "docker logs mappy-hour --tail 30"
    exit 1
}
