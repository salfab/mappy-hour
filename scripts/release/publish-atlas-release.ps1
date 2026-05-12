# publish-atlas-release.ps1 — Orchestre packaging + publication GitHub Release
#
# Usage:
#   pnpm atlas:publish -- --regions=lausanne,nyon --tag=atlas-v9-2026-05-08
#   pnpm atlas:publish -- --regions=lausanne,nyon  # tag auto-généré
#
# Prérequis : gh CLI authentifié (gh auth login)

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RawArgs
)

# pnpm passes a literal "--" separator before the script args, and the standard
# param() binding treats "--" as an ambiguous parameter prefix. Use
# ValueFromRemainingArguments + manual --key=value parsing to avoid that.
$Regions = "lausanne,nyon,morges,vevey,vevey_city,neuchatel,la_chaux_de_fonds,geneve"
$Tag = ""
$OutDir = "dist\releases"

foreach ($arg in $RawArgs) {
    if ($arg -eq "--") { continue }
    if ($arg -match '^--regions=(.+)$')  { $Regions = $Matches[1]; continue }
    if ($arg -match '^--tag=(.+)$')      { $Tag     = $Matches[1]; continue }
    if ($arg -match '^--out-dir=(.+)$')  { $OutDir  = $Matches[1]; continue }
}

# NOTE: pas de $ErrorActionPreference = "Stop" — npx/tsx/gh écrivent des logs
# de progression sur stderr, ce que Stop traiterait comme une erreur fatale.
# On vérifie $LASTEXITCODE manuellement après chaque commande externe.

# ── Auto-tag ──────────────────────────────────────────────────────────────────
# Convention : v{ALGO_MAJOR}.{FORMAT_MINOR}.{YYYYMMDD}{NNN}
#   - major = SUNLIGHT_CACHE_ALGORITHM_VERSION (sunlight-cache-vN → N)
#   - minor = SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION
#   - patch = YYYYMMDD * 1000 + counter (000-999) auto-incrémenté pour le jour
# Exemples : v9.2.20260509000, v9.2.20260509001, v9.2.20260510000
# Source de vérité : src/lib/precompute/model-version.ts
# (bumper le major/minor ici quand le source bump — c'est le seul couplage manuel)
if (-not $Tag) {
    $AlgoMajor = "9"
    $FormatMinor = "2"
    $Today = (Get-Date -Format "yyyyMMdd")
    $TagPrefix = "v$AlgoMajor.$FormatMinor.$Today"

    # Auto-increment NNN en scrutant les tags existants pour aujourd'hui
    $ExistingTags = ((gh release list --limit 100 --json tagName --jq '.[].tagName' 2>$null) -split "`r?`n") | Where-Object { $_ }
    $MaxCounter = -1
    foreach ($t in $ExistingTags) {
        if ($t -match "^v$AlgoMajor\.$FormatMinor\.$Today(\d{3})$") {
            $n = [int]$Matches[1]
            if ($n -gt $MaxCounter) { $MaxCounter = $n }
        }
    }
    $Counter = $MaxCounter + 1
    $Tag = "$TagPrefix" + $Counter.ToString("000")
    Write-Host "[publish] Tag auto-généré : $Tag"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ── Ingest places ─────────────────────────────────────────────────────────────
# Map of region → pnpm script (only regions that have a places ingest script)
$PlacesIngestMap = @{
    "lausanne" = "ingest:lausanne:places"
    "nyon"     = "ingest:nyon:places"
}
$PlacesTmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "mappy-places-$([datetime]::Now.ToString('yyyyMMddHHmmss'))"
$env:MAPPY_DATA_ROOT = $PlacesTmpRoot
Write-Host "`n[publish] ▶ Ingest places OSM..."
$RegionList = $Regions -split "," | ForEach-Object { $_.Trim() }
foreach ($region in $RegionList) {
    if ($PlacesIngestMap.ContainsKey($region)) {
        Write-Host "[publish]   · ingest places $region..."
        pnpm run $PlacesIngestMap[$region]
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[publish]   ! Warning: ingest:$region:places failed (places skipped for this region)"
        }
    }
}
# Copy generated places JSON to $OutDir.
# Note: Join-Path in Windows PowerShell 5.1 only accepts 2 positional args, so
# we chain calls explicitly. The 3-arg form silently throws and aborts the
# block on older shells (PositionalParameterNotFound + downstream Test-Path $null).
$PlacesProcessedDir = Join-Path (Join-Path $PlacesTmpRoot "processed") "places"
if (Test-Path $PlacesProcessedDir) {
    foreach ($f in (Get-ChildItem $PlacesProcessedDir -Filter "*-places.json")) {
        Copy-Item $f.FullName (Join-Path $OutDir $f.Name) -Force
        Write-Host "[publish]   · copied $($f.Name) → $OutDir"
    }
}
Remove-Item $PlacesTmpRoot -Recurse -Force -ErrorAction SilentlyContinue
$env:MAPPY_DATA_ROOT = $null

# ── Packaging ─────────────────────────────────────────────────────────────────
# Each region produces TWO archives: <region>-atlas.tar + <region>-grid-metadata.tar.
# A single shared archive `buildings-shared.tar` is also generated. All sha256
# sidecars + release-manifest.json land in $OutDir alongside the tars.
Write-Host "`n[publish] ▶ Packaging des régions : $Regions"
$RegionList = $Regions -split "," | ForEach-Object { $_.Trim() }
$TileSelectionFile = "data/processed/precompute/high-value-tile-selection.top-priority.json"

$Summaries = @()
foreach ($Region in $RegionList) {
    Write-Host "[publish]   · packaging $Region (atlas + grid-metadata)..."
    $tmpOut = [System.IO.Path]::GetTempFileName()
    & npx tsx scripts/release/package-atlas-region.ts `
        "--region=$Region" `
        "--out-dir=$OutDir" `
        "--tile-selection-file=$TileSelectionFile" 1> $tmpOut
    $packExit = $LASTEXITCODE
    $Output = Get-Content $tmpOut -Raw
    Remove-Item $tmpOut -ErrorAction SilentlyContinue

    if ($packExit -ne 0) {
        Write-Host "[publish] ✗ package-atlas-region échoué pour $Region (exit $packExit)"
        exit 1
    }

    $Lines = $Output -split "`r?`n"
    $JsonLine = ($Lines | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1)
    if (-not $JsonLine) {
        Write-Host "[publish] ✗ Aucun JSON summary pour $Region. Stdout:`n$Output"
        exit 1
    }
    $Summaries += $JsonLine
}

Write-Host "[publish]   · packaging buildings-shared..."
$tmpOut = [System.IO.Path]::GetTempFileName()
& npx tsx scripts/release/package-buildings-shared.ts "--out-dir=$OutDir" 1> $tmpOut
$buildingsExit = $LASTEXITCODE
$BuildingsOutput = Get-Content $tmpOut -Raw
Remove-Item $tmpOut -ErrorAction SilentlyContinue

if ($buildingsExit -ne 0) {
    Write-Host "[publish] ✗ package-buildings-shared échoué (exit $buildingsExit)"
    exit 1
}
$BuildingsJsonLine = (($BuildingsOutput -split "`r?`n") | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1)
if ($BuildingsJsonLine) {
    $Summaries += $BuildingsJsonLine
}

# ── Manifest ─────────────────────────────────────────────────────────────────
Write-Host "`n[publish] ▶ Construction du release-manifest.json..."
$SummaryInput = $Summaries -join "`n"
$SummaryInput | npx tsx scripts/release/build-release-manifest.ts `
    "--tag=$Tag" `
    "--out-dir=$OutDir" `
    "--from-stdin=true" `
    "--places-dir=$OutDir"

if ($LASTEXITCODE -ne 0) {
    Write-Error "[publish] ✗ build-release-manifest échoué."
    exit 1
}

# ── Vérifier gh CLI ───────────────────────────────────────────────────────────
$GhVersion = gh --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "[publish] gh CLI introuvable. Installez-le et lancez 'gh auth login'."
    exit 1
}

# ── Génération de la description de release ──────────────────────────────────
$ManifestPath = Join-Path $OutDir "release-manifest.json"
$Manifest = Get-Content $ManifestPath | ConvertFrom-Json

$RegionLines = ""
foreach ($R in $Manifest.regions.PSObject.Properties) {
    $RName = $R.Name
    $RData = $R.Value
    $Hash = $RData.modelVersionHash.Substring(0, 8)
    $GHash = if ($RData.gridMetadataHash) { $RData.gridMetadataHash.Substring(0, 8) } else { "—" }
    $Tiles = $RData.tileCount
    $GTiles = if ($RData.gridMetadataTileCount) { $RData.gridMetadataTileCount } else { 0 }
    $RegionLines += "- **$RName** : $Tiles atlas tuiles (hash $Hash) + $GTiles grid-meta (hash $GHash)`n"
}

$BuildingsLine = ""
if ($Manifest.buildingsShared) {
    $bs = $Manifest.buildingsShared
    $obstacleCount = if ($bs.uniqueObstaclesCount) { $bs.uniqueObstaclesCount } else { "?" }
    $bsBytes = [math]::Round($bs.bytes / 1MB, 1)
    $BuildingsLine = "`n### Buildings shared`n- ``buildings-shared.tar`` : $bsBytes MB, $obstacleCount obstacles (indexVersion=$($bs.indexVersion))`n"
}

$PlacesLines = ""
$PlacesFiles = Get-ChildItem $OutDir -Filter "*-places.json" -ErrorAction SilentlyContinue
if ($PlacesFiles) {
    foreach ($pf in $PlacesFiles) {
        $PlacesLines += "- $($pf.Name) ($([math]::Round($pf.Length / 1KB, 1)) KB)`n"
    }
}

# Detect the GitHub repo from gh CLI to inject the right --repo value in the
# install command. Falls back to OWNER/REPO if gh can't resolve it.
$RepoFromGh = (gh repo view --json nameWithOwner -q .nameWithOwner 2>$null)
if (-not $RepoFromGh) { $RepoFromGh = "OWNER/REPO" }

# Build the description by parts: a double-quoted here-string for variable
# interpolation, then a single-quoted block for the fenced code (which
# bypasses PowerShell's backtick escape entirely — backticks would otherwise
# need to be doubled to survive the @"..."@ here-string).
$PlacesSectionHead = if ($PlacesLines) { "`n### Places OSM`n$PlacesLines" } else { "" }

$DescHead = @"
## Atlas sunlight — $Tag

Algorithme : ``$($Manifest.algorithmVersion)`` — Format : v$($Manifest.artifactFormatVersion)

### Régions packagées
$RegionLines$BuildingsLine$PlacesSectionHead
### Installation

"@

$DescCode = @'
```bash
# Cache-only deploy (atlas + places only — Mitch use case)
pnpm atlas:download -- --repo={REPO} --regions=lausanne,nyon --release={TAG}

# Re-precompute-capable host (also pulls grid-metadata + global buildings index)
pnpm atlas:download -- --repo={REPO} --regions=lausanne,nyon --release={TAG} \
    --with-grid-metadata --with-buildings
```
'@ -replace '\{REPO\}', $RepoFromGh -replace '\{TAG\}', $Tag

$DescTail = @"

> Vérifie automatiquement la compatibilité algorithmVersion/artifactFormatVersion.
"@

$Description = "$DescHead`n$DescCode`n$DescTail"

# ── Création de la release GitHub ─────────────────────────────────────────────
Write-Host "`n[publish] ▶ Création de la release GitHub : $Tag"
gh release create $Tag `
    --title "Atlas sunlight $Tag" `
    --notes $Description `
    --draft

if ($LASTEXITCODE -ne 0) {
    Write-Error "[publish] ✗ gh release create échoué."
    exit 1
}

# ── Upload des assets ─────────────────────────────────────────────────────────
$Assets = Get-ChildItem $OutDir -File | Where-Object {
    $_.Name -match "\.(tar|tar\.part\d+|sha256|json)$"
}

Write-Host "[publish] ▶ Upload de $($Assets.Count) assets..."
foreach ($Asset in $Assets) {
    Write-Host "[publish]   · $($Asset.Name) ($([math]::Round($Asset.Length / 1MB, 1)) MB)"
}

$AssetPaths = $Assets | ForEach-Object { $_.FullName }
gh release upload $Tag @AssetPaths

if ($LASTEXITCODE -ne 0) {
    Write-Error "[publish] ✗ gh release upload échoué."
    exit 1
}

Write-Host "`n[publish] ✓ Release $Tag publiée (draft)."
Write-Host "[publish]   Vérifiez sur GitHub, puis pour la publier comme 'latest' :"
Write-Host "[publish]     gh release edit $Tag --draft=false --latest=true"
Write-Host ""
Write-Host "[publish]   Une fois publiée, les clients pourront télécharger sans préciser le tag :"
Write-Host "[publish]     pnpm atlas:download -- --repo=$RepoFromGh --regions=lausanne"
