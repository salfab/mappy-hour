# mitch-install-zstd-native.ps1
# Downloads the prebuilt @mongodb-js/zstd NAPI binary for the current Node/platform.
# Run once after pnpm install when the prebuilt wasn't downloaded automatically.
#
# Usage:
#   powershell -File C:\srv\mappy-hour\scripts\headless-server-selfhosting\mitch-install-zstd-native.ps1

$nodeDir = "C:\tools\node-v20.18.0"
$env:PATH = "$nodeDir;$env:APPDATA\npm;" + $env:PATH
Set-Location "C:\srv\mappy-hour"

Write-Host "=== Node version ==="
node --version

Write-Host "=== Running prebuild-install for @mongodb-js/zstd ==="
$prebuildBin = "node_modules\@mongodb-js\zstd\node_modules\.bin\prebuild-install.CMD"
if (-not (Test-Path $prebuildBin)) {
    $prebuildBin = "node_modules\.bin\prebuild-install.CMD"
}

node $prebuildBin --runtime napi --verbose --directory "node_modules\@mongodb-js\zstd"
$prebuildExit = $LASTEXITCODE
Write-Host "prebuild-install exit: $prebuildExit"

if ($prebuildExit -ne 0) {
    Write-Host "prebuild-install failed — checking if a prebuilt exists in node_modules..."
    # List what's in the prebuilds dir after the attempt
    $prebuildsDir = "node_modules\@mongodb-js\zstd\prebuilds"
    if (Test-Path $prebuildsDir) {
        Get-ChildItem $prebuildsDir -Recurse | Select-Object FullName
    } else {
        Write-Host "(prebuilds dir absent)"
    }
}

Write-Host "=== Testing require('@mongodb-js/zstd') ==="
$testJs = @'
try { require('@mongodb-js/zstd'); console.log('OK - zstd loaded'); }
catch(e) { console.log('FAIL: ' + e.message); process.exitCode = 1; }
'@
$testJs | node
Write-Host "zstd test exit: $LASTEXITCODE"
