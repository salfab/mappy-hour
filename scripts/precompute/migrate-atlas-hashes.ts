import fs from "node:fs";
import path from "node:path";

try {
  const envLocal = fs.readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of envLocal.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_]\w*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1");
    }
  }
} catch {}

const _envDataRoot = process.env.MAPPY_DATA_ROOT?.trim();
const DATA_ROOT =
  _envDataRoot && _envDataRoot.length > 0
    ? path.isAbsolute(_envDataRoot)
      ? _envDataRoot
      : path.resolve(process.cwd(), _envDataRoot)
    : path.join(process.cwd(), "data");

const _envCacheSunlightDir = process.env.MAPPY_CACHE_SUNLIGHT_DIR?.trim();
const ATLAS_DIR =
  _envCacheSunlightDir && _envCacheSunlightDir.length > 0
    ? path.isAbsolute(_envCacheSunlightDir)
      ? _envCacheSunlightDir
      : path.resolve(process.cwd(), _envCacheSunlightDir)
    : path.join(DATA_ROOT, "cache", "sunlight");

const OLD_HASHES: Record<string, string> = {
  lausanne: "fe6c20d7778483c0",
  geneve: "491a4540dbcc89d2",
  morges: "027226a77cf99719",
  nyon: "84d199f86a70eb94",
  vevey: "6bd6acab505414cd",
  vevey_city: "9749f3b55dc49405",
};

const REGIONS = Object.keys(OLD_HASHES) as (keyof typeof OLD_HASHES)[];

const execute = process.argv.includes("--execute");

async function main() {
  const { getSunlightModelVersion } = await import("../../src/lib/precompute/model-version.js");

  console.log(`ATLAS_DIR: ${ATLAS_DIR}`);
  console.log(`Mode: ${execute ? "EXECUTE" : "dry-run (pass --execute to rename)"}\n`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const region of REGIONS) {
    const oldHash = OLD_HASHES[region];
    let newHash: string;
    try {
      const mv = await getSunlightModelVersion(region as Parameters<typeof getSunlightModelVersion>[0], {
        buildingHeightBiasMeters: 0,
      });
      newHash = mv.modelVersionHash;
    } catch (err) {
      console.error(`  [ERROR] ${region}: could not compute new hash — ${(err as Error).message}`);
      errors++;
      continue;
    }

    console.log(`${region}: ${oldHash} → ${newHash}`);

    if (oldHash === newHash) {
      console.log(`  [SKIP] hashes are identical, nothing to do`);
      skipped++;
      continue;
    }

    const srcDir = path.join(ATLAS_DIR, region, oldHash);
    const dstDir = path.join(ATLAS_DIR, region, newHash);

    if (!fs.existsSync(srcDir)) {
      console.warn(`  [WARN] source does not exist: ${srcDir}`);
      skipped++;
      continue;
    }

    if (fs.existsSync(dstDir)) {
      console.warn(`  [WARN] target already exists, skipping to avoid overwrite: ${dstDir}`);
      skipped++;
      continue;
    }

    if (!execute) {
      console.log(`  [dry-run] would rename:\n    ${srcDir}\n    → ${dstDir}`);
      migrated++;
      continue;
    }

    try {
      fs.renameSync(srcDir, dstDir);
      console.log(`  [OK] renamed`);
      migrated++;
    } catch (err) {
      console.error(`  [ERROR] rename failed — ${(err as Error).message}`);
      errors++;
    }
  }

  console.log(`\nSummary: ${migrated} ${execute ? "migrated" : "would migrate"}, ${skipped} skipped, ${errors} errors`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
