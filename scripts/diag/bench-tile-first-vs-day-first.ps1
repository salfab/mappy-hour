# Bench tile-first vs day-first orchestrator (proto MAPPY_PRECOMPUTE_ORDER=tile-first).
# Cold-cache A/B sur tile-selection top-priority (toutes regions), backend Vulkan.
# Output : bench-tile-first-results-YYYYMMDD-HHmmss/
#
# Usage:
#   pwsh scripts/diag/bench-tile-first-vs-day-first.ps1
#   pwsh scripts/diag/bench-tile-first-vs-day-first.ps1 -Days 7

param(
    [int]$Days = 3,
    [string]$StartDate = "2027-05-01"
)

$ErrorActionPreference = "Stop"
# Resolve repo root: this script lives in scripts/diag/, repo root is two levels up.
$scriptPath = $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $scriptPath))
Set-Location $repoRoot

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = Join-Path $repoRoot "bench-tile-first-results-$timestamp"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$tileSelection = "data/processed/precompute/high-value-tile-selection.top-priority.json"
$pipelineDepth = 3
$sessions = 1

# Caches isoles : chaque run cold-start, comparable.
$cacheDayFirst  = Join-Path $outDir "cache-day-first"
$cacheTileFirst = Join-Path $outDir "cache-tile-first"
New-Item -ItemType Directory -Path $cacheDayFirst -Force | Out-Null
New-Item -ItemType Directory -Path $cacheTileFirst -Force | Out-Null

function Invoke-Run {
    param(
        [string]$Order,        # "day-first" | "tile-first"
        [string]$Label,
        [string]$CacheDir
    )
    $logPath = Join-Path $outDir "$Label.log"
    $env:MAPPY_RUST_VULKAN_SESSIONS = "$sessions"
    $env:MAPPY_TILE_PIPELINE_DEPTH = "$pipelineDepth"
    $env:MAPPY_CACHE_SUNLIGHT_DIR = $CacheDir
    # Tile-first is now the default in cache-admin since 2026-05-08; force
    # day-first explicitly when needed.
    $env:MAPPY_PRECOMPUTE_ORDER = $Order

    Write-Host "[$(Get-Date -Format HH:mm:ss)] >>> $Label (order=$Order, days=$Days from $StartDate, cache=$CacheDir)"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & pnpm precompute:all-regions:vulkan -- `
        --tile-selection-file=$tileSelection `
        --start-date=$StartDate `
        --days=$Days `
        --skip-existing=false `
        *> $logPath
    $exitCode = $LASTEXITCODE
    $sw.Stop()
    $sec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    $min = [math]::Round($sw.Elapsed.TotalMinutes, 2)
    if ($exitCode -ne 0) {
        Write-Host "[$(Get-Date -Format HH:mm:ss)] <<< $Label FAILED (exit=$exitCode) after $sec sec — voir $logPath"
    } else {
        Write-Host "[$(Get-Date -Format HH:mm:ss)] <<< $Label done in $sec sec ($min min)"
    }
    return @{ Seconds = $sw.Elapsed.TotalSeconds; ExitCode = $exitCode }
}

function Get-LogMetric {
    param([string]$LogPath, [string]$Pattern)
    $matches = Select-String -Path $LogPath -Pattern $Pattern -AllMatches -ErrorAction SilentlyContinue
    if (-not $matches) { return 0 }
    return ($matches | Measure-Object).Count
}

function Get-AtlasMergeNewBucketsSum {
    param([string]$LogPath, [string]$Tag)  # "atlas-merge" | "atlas-merge-multi"
    $sum = 0
    $entries = Select-String -Path $LogPath -Pattern "\[$Tag\].*newBuckets=(\d+)" -AllMatches -ErrorAction SilentlyContinue
    if ($entries) {
        foreach ($entry in $entries) {
            foreach ($m in $entry.Matches) {
                $sum += [int]$m.Groups[1].Value
            }
        }
    }
    return $sum
}

Write-Host "=== Bench tile-first vs day-first ==="
Write-Host "Repo root : $repoRoot"
Write-Host "Output    : $outDir"
Write-Host "Tiles     : $tileSelection"
Write-Host "Window    : $StartDate +$Days days, depth=$pipelineDepth, sessions=$sessions"
Write-Host ""

$timings = [ordered]@{}
$timings["day-first"]  = Invoke-Run -Order "day-first"  -Label "bench-day-first"  -CacheDir $cacheDayFirst
$timings["tile-first"] = Invoke-Run -Order "tile-first" -Label "bench-tile-first" -CacheDir $cacheTileFirst

# Métriques diagnostiques.
$dfLog  = Join-Path $outDir "bench-day-first.log"
$tfLog  = Join-Path $outDir "bench-tile-first.log"

$dfAtlasMerges  = Get-LogMetric -LogPath $dfLog -Pattern "\[atlas-merge\]"
$dfAtlasWrites  = Get-LogMetric -LogPath $dfLog -Pattern "\[atlas-write\]"
$dfNewBuckets   = Get-AtlasMergeNewBucketsSum -LogPath $dfLog -Tag "atlas-merge"

$tfAtlasMerges  = Get-LogMetric -LogPath $tfLog -Pattern "\[atlas-merge-multi\]"
$tfAtlasWrites  = Get-LogMetric -LogPath $tfLog -Pattern "\[atlas-write\]"
$tfNewBuckets   = Get-AtlasMergeNewBucketsSum -LogPath $tfLog -Tag "atlas-merge-multi"
$tfTileCompletions = Get-LogMetric -LogPath $tfLog -Pattern "\[tile-first\] .* state="

# Compte total tiles*days approximatif depuis logs (un manifest par region, plusieurs regions possible).
$tilesProcessed = Get-LogMetric -LogPath $dfLog -Pattern "\[atlas-merge\]"
$dfSec = $timings["day-first"].Seconds
$tfSec = $timings["tile-first"].Seconds
$dfExit = $timings["day-first"].ExitCode
$tfExit = $timings["tile-first"].ExitCode

$dfThroughput = if ($dfSec -gt 0 -and $dfAtlasMerges -gt 0) { [math]::Round($dfAtlasMerges / ($dfSec / 60), 1) } else { 0 }
$tfThroughput = if ($tfSec -gt 0 -and $tfTileCompletions -gt 0) { [math]::Round($tfTileCompletions / ($tfSec / 60), 1) } else { 0 }
$speedup = if ($tfSec -gt 0) { [math]::Round($dfSec / $tfSec, 2) } else { 0 }

$summary = @"
# Bench tile-first vs day-first — $timestamp

**Setup** : tile-selection=top-priority (multi-region), $Days jours ($StartDate +), depth=$pipelineDepth, sessions=$sessions, backend=rust-wgpu-vulkan, skip-existing=false (cold-cache).

## Wall time

| Order | Wall sec | Wall min | Speedup vs day-first | Exit code |
|---|---|---|---|---|
| day-first  | $([math]::Round($dfSec,1))  | $([math]::Round($dfSec/60,2))  | 1.00× | $dfExit |
| tile-first | $([math]::Round($tfSec,1)) | $([math]::Round($tfSec/60,2)) | $($speedup)× | $tfExit |

## Métriques I/O atlas

| Métrique | day-first | tile-first | Ratio (df/tf) |
|---|---|---|---|
| atlas merges        | $dfAtlasMerges | $tfAtlasMerges | $(if ($tfAtlasMerges -gt 0) { [math]::Round($dfAtlasMerges / $tfAtlasMerges, 2) } else { "n/a" }) |
| atlas writes (async)| $dfAtlasWrites | $tfAtlasWrites | $(if ($tfAtlasWrites -gt 0) { [math]::Round($dfAtlasWrites / $tfAtlasWrites, 2) } else { "n/a" }) |
| total newBuckets    | $dfNewBuckets  | $tfNewBuckets  | $(if ($tfNewBuckets -gt 0) { [math]::Round([double]$dfNewBuckets / $tfNewBuckets, 2) } else { "n/a" }) |

Throughput indicatif :
- day-first  : ~$dfThroughput tile×date computed/min
- tile-first : ~$tfThroughput tiles/min

Tile-first tile completions logged : $tfTileCompletions

## Lecture des ratios

- **merges/writes ratio ≈ $Days×** → tile-first économise bien le facteur N_dates d'I/O atlas (gain principal attendu)
- **newBuckets ratio ≈ 1×** → pas de déduplication cross-day (chaque jour avait ses buckets uniques) — gain perf ≈ overhead I/O économisé seulement
- **newBuckets ratio > 1×** → forte mutualisation cross-day, bonus GPU compute non négligeable
"@

$summary | Tee-Object -FilePath (Join-Path $outDir "SUMMARY.md")

Write-Host ""
Write-Host "=== DONE ==="
Write-Host "Summary : $(Join-Path $outDir 'SUMMARY.md')"
Write-Host "Logs    : $outDir\bench-*.log"
if ($dfExit -ne 0 -or $tfExit -ne 0) {
    Write-Host ""
    Write-Host "WARN : au moins un run a échoué — vérifier les logs avant d'interpréter le summary."
}
