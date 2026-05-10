$ProgressPreference = "SilentlyContinue"
$nodeDir = "C:\tools\node-v20.18.0"
$env:PATH = "$nodeDir;$env:APPDATA\npm;" + $env:PATH
$env:MAPPY_DATA_ROOT = "C:\mappy-data"
Set-Location C:\srv\mappy-hour

Write-Host "=== Ingest lausanne places ==="
pnpm ingest:lausanne:places
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED"; exit 1 }

Write-Host "=== Ingest nyon places ==="
pnpm ingest:nyon:places
if ($LASTEXITCODE -ne 0) { Write-Host "FAILED"; exit 1 }

Write-Host "=== Done. Places ecrites dans C:\mappy-data\processed\places\ ==="
