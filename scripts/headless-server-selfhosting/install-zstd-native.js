#!/usr/bin/env node
// install-zstd-native.js
// Downloads the @mongodb-js/zstd prebuilt NAPI binary for the current platform.
// Run via: node scripts/headless-server-selfhosting/install-zstd-native.js
// Called from mitch-deploy.ps1 and mitch-install-zstd-native.ps1.

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const repoRoot = path.resolve(__dirname, "../..");
const zstdDir = path.join(repoRoot, "node_modules", "@mongodb-js", "zstd");
const prebuildBin = path.join(zstdDir, "node_modules", ".bin", "prebuild-install.CMD");

console.log("[zstd-install] Node:", process.version, "platform:", process.platform, "arch:", process.arch);

if (!fs.existsSync(zstdDir)) {
  console.error("[zstd-install] @mongodb-js/zstd not found in node_modules — run pnpm install first");
  process.exit(1);
}

if (!fs.existsSync(prebuildBin)) {
  console.error("[zstd-install] prebuild-install not found at", prebuildBin);
  process.exit(1);
}

console.log("[zstd-install] Running prebuild-install --runtime napi --verbose ...");
const result = spawnSync(
  process.execPath,
  [prebuildBin, "--runtime", "napi", "--verbose", "--directory", zstdDir],
  { stdio: "inherit", cwd: repoRoot }
);
console.log("[zstd-install] prebuild-install exit:", result.status);

// Verify
console.log("[zstd-install] Testing require...");
try {
  require("@mongodb-js/zstd");
  console.log("[zstd-install] OK — @mongodb-js/zstd loaded successfully");
  process.exit(0);
} catch (e) {
  console.error("[zstd-install] FAIL:", e.message);
  console.error("[zstd-install] Prebuilds directory contents:");
  const prebuildsDir = path.join(zstdDir, "prebuilds");
  if (fs.existsSync(prebuildsDir)) {
    fs.readdirSync(prebuildsDir, { recursive: true }).forEach((f) => console.error("  ", f));
  } else {
    console.error("  (empty)");
  }
  process.exit(1);
}
