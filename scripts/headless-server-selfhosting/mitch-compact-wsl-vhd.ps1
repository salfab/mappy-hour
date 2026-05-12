# Compact the WSL2 ext4.vhdx after `docker prune` has freed space inside.
#
# Why this is needed even with the prune step in mitch-deploy-docker.ps1:
# `docker image prune` deletes layers INSIDE the WSL2 distro's filesystem,
# but the underlying .vhdx file on the Windows host does NOT auto-shrink.
# It only grows. After enough deploys, the vhdx hits the disk limit even
# though `du -sh /var/lib/docker` inside WSL reports a small footprint.
#
# This script:
#   1. Stops the running mappy-hour container (gracefully)
#   2. `wsl --shutdown` to release locks on the vhdx
#   3. Compacts the vhdx with `Optimize-VHD` (Hyper-V module)
#   4. Restarts the container via mitch-deploy-docker.ps1
#
# Cost: ~30-60s downtime (container restart).
#
# Usage (manual): pwsh -File C:\srv\mappy-hour\scripts\headless-server-selfhosting\mitch-compact-wsl-vhd.ps1
# Scheduled task: register weekly via Windows Task Scheduler (suggested:
#   Sunday 03:00 local, after Mitch's overnight idle window).

$ProgressPreference = "SilentlyContinue"
$ErrorActionPreference = "Stop"

# ── Discover the vhdx ─────────────────────────────────────────────────────────
# Default Ubuntu distro from the Microsoft Store lives under
# C:\Users\<user>\AppData\Local\Packages\CanonicalGroupLimited.Ubuntu*\LocalState\ext4.vhdx
# Find it dynamically to survive store version bumps.
$candidates = @(
  "$env:LOCALAPPDATA\Packages\CanonicalGroupLimited.Ubuntu*\LocalState\ext4.vhdx",
  "$env:LOCALAPPDATA\Packages\CanonicalGroupLimited.UbuntuonWindows*\LocalState\ext4.vhdx",
  "C:\Users\kiosque\AppData\Local\Packages\CanonicalGroupLimited.Ubuntu*\LocalState\ext4.vhdx"
)
$vhdPath = $null
foreach ($pattern in $candidates) {
  $found = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $vhdPath = $found.FullName; break }
}
if (-not $vhdPath) {
  Write-Host "FATAL: ext4.vhdx not found in any expected location." -ForegroundColor Red
  Write-Host "Patterns tried:" -ForegroundColor Yellow
  $candidates | ForEach-Object { Write-Host "  $_" }
  exit 1
}
Write-Host "vhdx found: $vhdPath"
$sizeBefore = (Get-Item $vhdPath).Length
Write-Host ("size before: {0:N1} GB" -f ($sizeBefore / 1GB))

# ── Stop container + shut down WSL ────────────────────────────────────────────
Write-Host "=== stopping mappy-hour container ==="
wsl -d Ubuntu -u root -e bash -c "cd /mnt/c/srv/mappy-hour && docker compose down --remove-orphans" 2>&1 | Out-Host

Write-Host "=== wsl --shutdown ==="
wsl --shutdown
Start-Sleep 8

# ── Compact ──────────────────────────────────────────────────────────────────
# Optimize-VHD requires the Hyper-V module (comes with WSL2 on Win10/11 Pro).
# `-Mode Full` walks the entire vhdx and rewrites it without unused blocks.
# Takes 1-5 min depending on size.
try {
  Import-Module Hyper-V -ErrorAction Stop
} catch {
  Write-Host "Hyper-V module unavailable. Falling back to diskpart." -ForegroundColor Yellow
  # diskpart fallback — works on Home editions too. The compact command needs
  # the vhd attached read-only.
  $diskpartScript = @"
select vdisk file="$vhdPath"
attach vdisk readonly
compact vdisk
detach vdisk
exit
"@
  $tmp = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $tmp -Value $diskpartScript -Encoding ASCII
  diskpart /s $tmp | Out-Host
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
if (Get-Command Optimize-VHD -ErrorAction SilentlyContinue) {
  Write-Host "=== Optimize-VHD -Mode Full ==="
  Optimize-VHD -Path $vhdPath -Mode Full
}

$sizeAfter = (Get-Item $vhdPath).Length
$reclaimed = $sizeBefore - $sizeAfter
Write-Host ("size after:  {0:N1} GB" -f ($sizeAfter / 1GB))
Write-Host ("reclaimed:   {0:N1} GB" -f ($reclaimed / 1GB)) -ForegroundColor Green

# ── Restart the stack ─────────────────────────────────────────────────────────
$deployScript = Join-Path $PSScriptRoot "mitch-deploy-docker.ps1"
Write-Host "=== restarting via $deployScript ==="
& $deployScript
exit $LASTEXITCODE
