# publish-atlas-release.ps1 — Orchestre packaging + publication GitHub Release
#
# Usage:
#   pnpm atlas:publish -- --regions=lausanne,nyon --tag=atlas-v9-2026-05-08
#   pnpm atlas:publish -- --regions=lausanne,nyon  # tag auto-généré
#
# Prérequis : gh CLI authentifié (gh auth login)

param(
    [string]$Regions = "lausanne,nyon,morges,vevey,geneve",
    [string]$Tag = "",
    [string]$OutDir = "dist\releases"
)

# Absorber args --key=value passés par pnpm (format CLI uniforme)
foreach ($arg in $args) {
    if ($arg -match '^--regions=(.+)$')  { $Regions = $Matches[1] }
    if ($arg -match '^--tag=(.+)$')      { $Tag     = $Matches[1] }
    if ($arg -match '^--out-dir=(.+)$')  { $OutDir  = $Matches[1] }
}

$ErrorActionPreference = "Stop"

# ── Auto-tag ──────────────────────────────────────────────────────────────────
if (-not $Tag) {
    $AlgoVersion = "v9"  # extrait de sunlight-cache-v9
    $Date = (Get-Date -Format "yyyy-MM-dd")
    $Tag = "atlas-$AlgoVersion-$Date"
    Write-Host "[publish] Tag auto-généré : $Tag"
}

# ── Packaging ─────────────────────────────────────────────────────────────────
Write-Host "`n[publish] ▶ Packaging des régions : $Regions"
$RegionList = $Regions -split "," | ForEach-Object { $_.Trim() }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$Summaries = @()
foreach ($Region in $RegionList) {
    Write-Host "[publish]   · packaging $Region..."
    $Output = npx tsx scripts/release/package-atlas-region.ts `
        "--region=$Region" `
        "--out-dir=$OutDir" 2>&1

    # stderr va à la console via 2>&1, stdout contient le JSON summary
    $Lines = ($Output | Where-Object { $_ -is [string] }) -split "`n"
    $JsonLine = ($Lines | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1)
    if (-not $JsonLine) {
        Write-Error "[publish] ✗ Aucun JSON summary pour $Region. Output:`n$Output"
        exit 1
    }
    $Summaries += $JsonLine
}

# ── Manifest ─────────────────────────────────────────────────────────────────
Write-Host "`n[publish] ▶ Construction du release-manifest.json..."
$SummaryInput = $Summaries -join "`n"
$SummaryInput | npx tsx scripts/release/build-release-manifest.ts `
    "--tag=$Tag" `
    "--out-dir=$OutDir" `
    "--from-stdin=true"

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
    $Tiles = $RData.tileCount
    $RegionLines += "- **$RName** : $Tiles tuiles (hash $Hash...)`n"
}

$Description = @"
## Atlas sunlight — $Tag

Algorithme : ``$($Manifest.algorithmVersion)`` — Format : v$($Manifest.artifactFormatVersion)

### Régions packagées
$RegionLines
### Installation

\`\`\`bash
pnpm atlas:download -- --repo=OWNER/REPO --regions=lausanne,nyon --release=$Tag
\`\`\`

> Vérifie automatiquement la compatibilité algorithmVersion/artifactFormatVersion.
"@

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
Write-Host "[publish]   Vérifiez sur GitHub puis utilisez 'gh release edit $Tag --draft=false' pour la publier."
