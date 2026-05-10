param(
    [string]$Atlas = "",
    [string]$Date = "2026-05-10",
    [string]$Start = "08:00",
    [string]$End = "12:00",
    [int]$Sample = 15,
    [int]$Iterations = 3,
    [string]$Shards = "8,16,32,64",
    [string]$ZstdLevels = "3,10"
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
    "scripts/diag/bench-atlas-sharding.ts",
    "--date=$Date",
    "--start=$Start",
    "--end=$End",
    "--sample=$Sample",
    "--iterations=$Iterations",
    "--shards=$Shards",
    "--zstd-levels=$ZstdLevels"
)

if ($Atlas -ne "") {
    $argsList += "--atlas=$Atlas"
}

& pnpm @argsList
exit $LASTEXITCODE
