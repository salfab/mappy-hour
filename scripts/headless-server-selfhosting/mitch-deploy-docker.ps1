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

# Reclaim space — Mitch is space-constrained and each `pull` keeps the
# previous image as dangling layers, plus the build cache that the compose
# build profile accumulates. Without prune, the WSL2 vhdx grows monotonically
# until creation of new containers fails with E_FAIL (cf. incident 2026-05-12).
#
# `--until=2h` buffer keeps the previous image addressable for ~2 hours in
# case we need to revert quickly. `image prune -af` (not `-a`) wipes
# everything not currently referenced by a running container.
Write-Host "=== docker prune (reclaim space) ==="
wsl -d Ubuntu -u root -e bash -c "docker image prune -af --filter 'until=2h' 2>&1 | tail -5"
wsl -d Ubuntu -u root -e bash -c "docker builder prune -af --filter 'until=24h' 2>&1 | tail -5"
wsl -d Ubuntu -u root -e bash -c "docker system df 2>&1"

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
