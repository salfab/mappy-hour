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
import type {
  PrecomputedSunlightFrame,
  PrecomputedSunlightTileArtifact,
} from "../src/lib/precompute/sunlight-cache";

const gunzip = promisify(gunzipCb);
const gzip = promisify(gzipCb);

// On-disk legacy JSON has base64-encoded mask fields. The in-memory type now
// uses Uint8Array masks, so we decode on load to obtain a valid artifact.
type LegacyJsonFrame = Omit<
  PrecomputedSunlightFrame,
  | "sunMask"
  | "sunMaskNoVegetation"
  | "terrainBlockedMask"
  | "buildingsBlockedMask"
  | "vegetationBlockedMask"
> & {
  sunMaskBase64: string;
  sunMaskNoVegetationBase64: string;
  terrainBlockedMaskBase64: string;
  buildingsBlockedMaskBase64: string;
  vegetationBlockedMaskBase64: string;
};

type LegacyJsonArtifact = Omit<PrecomputedSunlightTileArtifact, "frames"> & {
  frames: LegacyJsonFrame[];
};

function decodeLegacyJsonArtifact(legacy: LegacyJsonArtifact): PrecomputedSunlightTileArtifact {
  return {
    ...legacy,
    frames: legacy.frames.map((f) => ({
      ...f,
      sunMask: new Uint8Array(Buffer.from(f.sunMaskBase64, "base64")),
      sunMaskNoVegetation: new Uint8Array(Buffer.from(f.sunMaskNoVegetationBase64, "base64")),
      terrainBlockedMask: new Uint8Array(Buffer.from(f.terrainBlockedMaskBase64, "base64")),
      buildingsBlockedMask: new Uint8Array(Buffer.from(f.buildingsBlockedMaskBase64, "base64")),
      vegetationBlockedMask: new Uint8Array(Buffer.from(f.vegetationBlockedMaskBase64, "base64")),
    })),
  };
}

async function migrateOne(jsonGzPath: string): Promise<"skipped" | "converted" | "failed"> {
  const binGzPath = jsonGzPath.replace(/\.json\.gz$/, ".tile.bin.gz");
  try {
    await fs.access(binGzPath);
    return "skipped";
  } catch { /* not present, continue */ }
  try {
    const jsonGz = await fs.readFile(jsonGzPath);
    const jsonBuf = await gunzip(jsonGz);
    const legacy = JSON.parse(jsonBuf.toString("utf8")) as LegacyJsonArtifact;
    const artifact = decodeLegacyJsonArtifact(legacy);
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
  const concurrency = Number.parseInt(process.argv[3] ?? "4", 10);
  if (!root) {
    console.error("Usage: migrate-tiles-to-binary.ts <dir> [concurrency=4]");
    console.error("  Recursively converts all *.json.gz tile files under <dir>.");
    process.exit(1);
  }
  const t0 = performance.now();
  const files = await walk(root);
  console.log(`Found ${files.length} .json.gz tile files under ${root} (concurrency=${concurrency})`);

  let converted = 0, skipped = 0, failed = 0, totalJsonBytes = 0, totalBinBytes = 0;
  let lastLog = performance.now();
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= files.length) return;
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
        const done = converted + skipped + failed;
        const pct = (done / files.length * 100).toFixed(1);
        console.log(`  [${done}/${files.length} ${pct}%] converted=${converted} skipped=${skipped} failed=${failed}`);
        lastLog = performance.now();
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

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
