# Bench multi-session : compare N=1, N=2, N=3 sur 296 tuiles top-priority Lausanne, 3 jours.
# Voir docs/architecture/refactor-multi-session-plan.md.
# Output : bench-multisession-results-YYYYMMDD-HHmmss/

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repoRoot

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = Join-Path $repoRoot "bench-multisession-results-$timestamp"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$tileSelection = "data/processed/precompute/high-value-tile-selection.top-priority.json"
$warmupDate = "2027-05-15"
$warmupDays = 1
$benchStartDate = "2027-05-01"
$benchDays = 3

function Invoke-Run {
    param(
        [int]$N,
        [string]$Label,
        [string]$StartDate,
        [int]$Days
    )
    $logPath = Join-Path $outDir "$Label.log"
    $env:MAPPY_RUST_VULKAN_SESSIONS = "$N"
    $env:MAPPY_TILE_PIPELINE_DEPTH = "3"
    Write-Host "[$(Get-Date -Format HH:mm:ss)] >>> $Label (N=$N, $Days days from $StartDate) -> $logPath"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & pnpm precompute:all-regions:vulkan -- `
        --tile-selection-file=$tileSelection `
        --start-date=$StartDate `
        --days=$Days `
        --skip-existing=false `
        *> $logPath
    $sw.Stop()
    $sec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    $min = [math]::Round($sw.Elapsed.TotalMinutes, 2)
    Write-Host "[$(Get-Date -Format HH:mm:ss)] <<< $Label done in $sec sec ($min min)"
    return $sw.Elapsed.TotalSeconds
}

Write-Host "=== Bench multi-session ==="
Write-Host "Output : $outDir"
Write-Host "Tile selection : $tileSelection"
Write-Host "Bench dates    : $benchStartDate +$benchDays days"
Write-Host ""

$timings = [ordered]@{}

$timings["warmup"] = Invoke-Run -N 2 -Label "warmup" -StartDate $warmupDate -Days $warmupDays
$timings["n1"]     = Invoke-Run -N 1 -Label "bench-n1" -StartDate $benchStartDate -Days $benchDays
$timings["n2"]     = Invoke-Run -N 2 -Label "bench-n2" -StartDate $benchStartDate -Days $benchDays
$timings["n3"]     = Invoke-Run -N 3 -Label "bench-n3" -StartDate $benchStartDate -Days $benchDays

$totalTiles = 296 * $benchDays
$summary = @"
# Bench multi-session — $timestamp

**Setup** : 296 top-priority Lausanne, depth=3, $benchDays jours ($benchStartDate +).
**Warmup** (jeté) : N=2, $warmupDays jour, $([math]::Round($timings.warmup,1))s.

## Wall time

| N | Wall sec | Wall min | Tiles/min | Speedup vs N=1 |
|---|---|---|---|---|
| 1 | $([math]::Round($timings.n1,1)) | $([math]::Round($timings.n1/60,2)) | $([math]::Round($totalTiles/($timings.n1/60),1)) | 1.00× |
| 2 | $([math]::Round($timings.n2,1)) | $([math]::Round($timings.n2/60,2)) | $([math]::Round($totalTiles/($timings.n2/60),1)) | $([math]::Round($timings.n1/$timings.n2,2))× |
| 3 | $([math]::Round($timings.n3,1)) | $([math]::Round($timings.n3/60,2)) | $([math]::Round($totalTiles/($timings.n3/60),1)) | $([math]::Round($timings.n1/$timings.n3,2))× |

Total tiles processés par run : $totalTiles (296 × $benchDays jours).
"@

$summary | Tee-Object -FilePath (Join-Path $outDir "SUMMARY.md")

Write-Host ""
Write-Host "=== DONE ==="
Write-Host "Summary : $(Join-Path $outDir 'SUMMARY.md')"
