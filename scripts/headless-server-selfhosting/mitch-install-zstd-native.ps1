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

node scripts\headless-server-selfhosting\install-zstd-native.js
exit $LASTEXITCODE
