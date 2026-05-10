param(
    [string]$Atlas = "",
    [string]$Root = "C:\mappy-data\cache\sunlight",
    [int]$BucketsPerShard = 16,
    [int]$ZstdLevel = 10,
    [int]$Limit = 0,
    [switch]$DryRun,
    [switch]$Overwrite,
    [switch]$DeleteSourceAfterConvert
)

$ErrorActionPreference = "Stop"
$nodeDir = "C:\tools\node-v20.18.0"
$repoDir = "C:\srv\mappy-hour"
$env:PATH = "$nodeDir;$env:APPDATA\npm;" + $env:PATH
$env:MAPPY_DATA_ROOT = "C:\mappy-data"

Set-Location $repoDir

$argsList = @(
    "exec",
    "tsx",
    "scripts/precompute/convert-atlas-to-shards.ts",
    "--root=$Root",
    "--buckets-per-shard=$BucketsPerShard",
    "--zstd-level=$ZstdLevel",
    "--limit=$Limit"
)

if ($Atlas -ne "") {
    $argsList += "--atlas=$Atlas"
}
if ($DryRun) {
    $argsList += "--dry-run"
}
if ($Overwrite) {
    $argsList += "--overwrite"
}
if ($DeleteSourceAfterConvert) {
    $argsList += "--delete-source-after-convert"
}

& pnpm @argsList
exit $LASTEXITCODE
