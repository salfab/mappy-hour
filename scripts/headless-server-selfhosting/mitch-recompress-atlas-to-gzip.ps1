# mitch-recompress-atlas-to-gzip.ps1
# One-time migration: recompress atlas files from zstd to gzip in-place.
# Required when atlas files were generated with MAPPY_ATLAS_COMPRESSION=zstd
# (default) on a machine with @mongodb-js/zstd, then deployed to a machine
# without a working native zstd module.
#
# Prerequisites: zstd.exe at C:\tools\zstd.exe (see mitch-deploy notes)
# Usage: powershell -File scripts/headless-server-selfhosting/mitch-recompress-atlas-to-gzip.ps1

$zstdExe = "C:\tools\zstd.exe"
$dataRoot = if ($env:MAPPY_DATA_ROOT) { $env:MAPPY_DATA_ROOT } else { "C:\mappy-data" }
$atlasRoot = Join-Path $dataRoot "cache\sunlight"

if (-not (Test-Path $zstdExe)) {
    Write-Error "zstd.exe not found at $zstdExe. Download from https://github.com/facebook/zstd/releases"
    exit 1
}

$files = Get-ChildItem $atlasRoot -Recurse -Filter "*.atlas.bin.gz"
$total = $files.Count
Write-Host "[recompress] Found $total atlas files under $atlasRoot"

$converted = 0
$skipped = 0

foreach ($f in $files) {
    # Read first 4 bytes to detect compression format
    $stream = [System.IO.File]::OpenRead($f.FullName)
    $header = New-Object byte[] 4
    $null = $stream.Read($header, 0, 4)
    $stream.Close()

    $isGzip = $header[0] -eq 0x1F -and $header[1] -eq 0x8B
    $isZstd = $header[0] -eq 0x28 -and $header[1] -eq 0xB5 -and $header[2] -eq 0x2F -and $header[3] -eq 0xFD

    if ($isGzip) {
        $skipped++
        continue
    }

    if (-not $isZstd) {
        Write-Warning "[recompress] Unknown format for $($f.Name): $($header | ForEach-Object { $_.ToString('x2') })"
        continue
    }

    # Decompress zstd to temp file
    $tmpRaw = [System.IO.Path]::GetTempFileName()
    & $zstdExe -d $f.FullName -o $tmpRaw -f -q
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "[recompress] zstd decompress failed for $($f.Name)"
        Remove-Item $tmpRaw -ErrorAction SilentlyContinue
        continue
    }

    # Recompress with gzip (level 1 = fast, same as the app's gzip path)
    $tmpGz = [System.IO.Path]::GetTempFileName()
    $rawBytes = [System.IO.File]::ReadAllBytes($tmpRaw)
    $outStream = [System.IO.File]::Create($tmpGz)
    $gz = New-Object System.IO.Compression.GZipStream($outStream, [System.IO.Compression.CompressionLevel]::Fastest)
    $gz.Write($rawBytes, 0, $rawBytes.Length)
    $gz.Dispose()
    $outStream.Dispose()

    # Replace original
    Move-Item $tmpGz $f.FullName -Force
    Remove-Item $tmpRaw -ErrorAction SilentlyContinue
    $converted++
    Write-Host "[recompress] $($f.Name) ($([math]::Round($f.Length / 1KB, 0)) KB zstd → gzip)"
}

Write-Host ""
Write-Host "[recompress] Done: $converted converted, $skipped already gzip, $($total - $converted - $skipped) skipped/error"
