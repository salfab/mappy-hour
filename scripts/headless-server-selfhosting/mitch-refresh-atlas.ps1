param(
    [Parameter(Mandatory=$true)]
    [string]$AtlasArgs
)
$ProgressPreference = "SilentlyContinue"
$repoDir = "C:\srv\mappy-hour"

Set-Location $repoDir

Write-Host "=== git pull ==="
git pull --ff-only
if ($LASTEXITCODE -ne 0) { Write-Host "git pull failed"; exit 1 }

Write-Host "=== docker compose atlas-loader (args: $AtlasArgs) ==="
# Bash inside WSL handles the `cd && docker compose ...` chain — no PS parsing.
wsl -d Ubuntu -u root -e bash -c "cd /mnt/c/srv/mappy-hour && docker compose --profile loader run --rm atlas-loader $AtlasArgs"
if ($LASTEXITCODE -ne 0) { Write-Host "atlas-loader failed"; exit 1 }

Write-Host "=== docker compose restart mappy-hour ==="
# Force the runtime to re-scan the cache so newly installed regions are picked up.
wsl -d Ubuntu -u root -e bash -c "cd /mnt/c/srv/mappy-hour && docker compose restart mappy-hour"
if ($LASTEXITCODE -ne 0) { Write-Host "compose restart failed"; exit 1 }

Start-Sleep 15
Write-Host "=== Health check ==="
try {
    $r = Invoke-WebRequest "http://127.0.0.1:3000/api/datasets" -UseBasicParsing -TimeoutSec 10
    Write-Host "OK: HTTP $($r.StatusCode)"
} catch {
    Write-Host "FAIL: $($_.Exception.Message)"
    wsl -d Ubuntu -u root -e bash -c "docker logs mappy-hour --tail 30 2>&1"
    exit 1
}
