$ProgressPreference = "SilentlyContinue"
$repoDir = "C:\srv\mappy-hour"

Set-Location $repoDir

# git pull so the compose file is always up to date
Write-Host "=== git pull ==="
git pull
if ($LASTEXITCODE -ne 0) { Write-Host "git pull failed"; exit 1 }

# Compose the runtime .env from two sources:
#   - .env.ci  : secrets pushed by the deploy workflow (UMAMI_APP_SECRET,
#                UMAMI_DB_PASSWORD, …). Owned by GitHub Actions.
#   - host-stable variables (atlas + buildings paths) - hardcoded here
#     because they're a property of this specific Mitch box, not of
#     the application.
# Anything previously edited by hand in .env is overwritten on every
# deploy by design (CI is the single source of truth).
Write-Host "=== sync .env from CI secrets ==="
$envCi = Join-Path $repoDir ".env.ci"
$envOut = Join-Path $repoDir ".env"
$hostStable = @(
  "MAPPY_ATLAS_PATH=/mnt/c/mappy-data/cache/sunlight",
  "MAPPY_BUILDINGS_PATH=/mnt/c/mappy-data/processed/buildings",
  "MAPPY_FORCE_CACHE_ONLY=true"
)
if (-not (Test-Path $envCi)) {
  Write-Host "  WARNING: .env.ci not found. CI may have failed to scp secrets. Reusing existing .env."
} else {
  $ciContent = Get-Content $envCi -Raw
  $merged = ($hostStable -join "`n") + "`n" + $ciContent
  Set-Content -Path $envOut -Value $merged -Encoding UTF8
  Remove-Item $envCi -ErrorAction SilentlyContinue
  Write-Host "  .env regenerated"
}

Write-Host "=== docker compose pull ==="
wsl -d Ubuntu -u root -e bash -lc 'cd /mnt/c/srv/mappy-hour && docker compose pull'
if ($LASTEXITCODE -ne 0) { Write-Host "docker compose pull failed"; exit 1 }

Write-Host "=== docker compose up -d ==="
wsl -d Ubuntu -u root -e bash -lc 'cd /mnt/c/srv/mappy-hour && docker compose up -d --remove-orphans'
if ($LASTEXITCODE -ne 0) { Write-Host "docker compose up failed"; exit 1 }

# Reclaim space - Mitch is space-constrained and each `pull` keeps the
# previous image as dangling layers, plus the build cache that the compose
# build profile accumulates. Without prune, the WSL2 vhdx grows monotonically
# until creation of new containers fails with E_FAIL (cf. incident 2026-05-12).
#
# `--until=2h` buffer keeps the previous image addressable for ~2 hours in
# case we need to revert quickly. `image prune -af` (not `-a`) wipes
# everything not currently referenced by a running container.
Write-Host "=== docker prune (reclaim space) ==="
wsl -d Ubuntu -u root -e bash -lc "docker image prune -af --filter 'until=2h' 2>&1 | tail -5"
wsl -d Ubuntu -u root -e bash -lc "docker builder prune -af --filter 'until=24h' 2>&1 | tail -5"
wsl -d Ubuntu -u root -e bash -lc "docker system df 2>&1"

Write-Host "=== Waiting 25s for container to start ==="
Start-Sleep 25

Write-Host "=== Health check ==="
try {
    $r = Invoke-WebRequest "http://127.0.0.1:3000/api/datasets" -UseBasicParsing -TimeoutSec 10
    Write-Host "OK: HTTP $($r.StatusCode) - container operational"
} catch {
    Write-Host "FAIL: $($_.Exception.Message)"
    wsl -d Ubuntu -u root -e bash -lc "docker logs mappy-hour --tail 30"
    exit 1
}
