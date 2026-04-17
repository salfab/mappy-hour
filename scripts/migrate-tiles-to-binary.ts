// Convert existing .json.gz tile artifacts to the fast binary format.
//
// Run:
//   pnpm tsx scripts/migrate-tiles-to-binary.ts <tiles-dir>
//
// Reads every *.json.gz in the directory, writes the equivalent
// *.tile.bin.gz next to it (skips if already present). The JSON files are
// preserved untouched so the reader can still fall back.

import fs from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  encodeTileArtifactToBinary,
} from "../src/lib/precompute/sunlight-cache-binary";
import type { PrecomputedSunlightTileArtifact } from "../src/lib/precompute/sunlight-cache";

const gunzip = promisify(gunzipCb);
const gzip = promisify(gzipCb);

async function migrateOne(jsonGzPath: string): Promise<"skipped" | "converted" | "failed"> {
  const binGzPath = jsonGzPath.replace(/\.json\.gz$/, ".tile.bin.gz");
  try {
    await fs.access(binGzPath);
    return "skipped";
  } catch { /* not present, continue */ }
  try {
    const jsonGz = await fs.readFile(jsonGzPath);
    const jsonBuf = await gunzip(jsonGz);
    const artifact = JSON.parse(jsonBuf.toString("utf8")) as PrecomputedSunlightTileArtifact;
    const bin = encodeTileArtifactToBinary(artifact);
    const binGz = (await gzip(bin)) as Buffer;
    // Write atomically: write to .tmp then rename so a crash mid-write doesn't
    // leave a truncated binary file that the reader would accept as valid.
    const tmpPath = binGzPath + ".tmp";
    await fs.writeFile(tmpPath, binGz);
    await fs.rename(tmpPath, binGzPath);
    return "converted";
  } catch (err) {
    console.error(`  FAIL ${path.basename(jsonGzPath)}: ${(err as Error).message}`);
    return "failed";
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(p)));
    } else if (e.isFile() && e.name.endsWith(".json.gz") && !e.name.endsWith(".tile.bin.gz")) {
      out.push(p);
    }
  }
  return out;
}

async function main() {
  const root = process.argv[2];
  if (!root) {
    console.error("Usage: migrate-tiles-to-binary.ts <dir>");
    console.error("  Recursively converts all *.json.gz tile files under <dir>.");
    process.exit(1);
  }
  const t0 = performance.now();
  const files = await walk(root);
  console.log(`Found ${files.length} .json.gz tile files under ${root}`);

  let converted = 0, skipped = 0, failed = 0, totalJsonBytes = 0, totalBinBytes = 0;
  let lastLog = performance.now();
  for (let i = 0; i < files.length; i++) {
    const res = await migrateOne(files[i]);
    if (res === "converted") {
      converted += 1;
      try {
        const [jsonStat, binStat] = await Promise.all([
          fs.stat(files[i]),
          fs.stat(files[i].replace(/\.json\.gz$/, ".tile.bin.gz")),
        ]);
        totalJsonBytes += jsonStat.size;
        totalBinBytes += binStat.size;
      } catch { /* ignore */ }
    } else if (res === "skipped") {
      skipped += 1;
    } else {
      failed += 1;
    }
    if (performance.now() - lastLog > 2000) {
      const pct = ((i + 1) / files.length * 100).toFixed(1);
      console.log(`  [${i + 1}/${files.length} ${pct}%] converted=${converted} skipped=${skipped} failed=${failed}`);
      lastLog = performance.now();
    }
  }
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
  console.log(`  converted=${converted}  skipped=${skipped}  failed=${failed}`);
  if (converted > 0) {
    const jsonMB = (totalJsonBytes / 1024 / 1024).toFixed(1);
    const binMB = (totalBinBytes / 1024 / 1024).toFixed(1);
    const ratio = (totalBinBytes / totalJsonBytes).toFixed(2);
    console.log(`  disk: json=${jsonMB} MB  bin=${binMB} MB  ratio=${ratio}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
