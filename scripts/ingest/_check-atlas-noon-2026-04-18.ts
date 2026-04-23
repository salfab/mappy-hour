/**
 * Verifies that the bucket covering 2026-04-18 noon at Lausanne has sunCount>0
 * on every Lausanne atlas tile. If any tile reports sunCount=0, the atlas is
 * incomplete or incorrect for this bucket.
 *
 * Run:
 *   pnpm tsx scripts/ingest/_check-atlas-noon-2026-04-18.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import SunCalc from "suncalc";

import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
import {
  loadPrecomputedTileAtlas,
  lookupAtlasBucket,
} from "../../src/lib/precompute/sunlight-cache-atlas";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";

const RAD_TO_DEG = 180 / Math.PI;
const RES = 1;

function countBits(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    let x = mask[i];
    while (x) {
      x &= x - 1;
      n++;
    }
  }
  return n;
}

function parseTileId(id: string): { minE: number; minN: number; size: number } | null {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id);
  if (!m) return null;
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

async function main() {
  const region = "lausanne" as const;
  const gridStep = 1;
  // 2026-04-18 12:00 local Europe/Zurich (CEST = UTC+2)
  const utc = new Date("2026-04-18T10:00:00Z");

  const regionRoot = path.join(CACHE_SUNLIGHT_DIR, region);
  const hashes = await fs.readdir(regionRoot);
  let missing = 0;
  let zero = 0;
  let ok = 0;
  let missingAtlas = 0;
  const zeroSamples: string[] = [];
  const missingSamples: string[] = [];
  const okProbeTiles: string[] = [];
  const probeTileIds = new Set([
    "e2537750_n1152500_s250",
    "e2538000_n1152500_s250",
    "e2537750_n1152750_s250",
  ]);

  for (const hash of hashes) {
    const atlasDir = path.join(regionRoot, hash, `g${gridStep}`, "atlas", "r1");
    let files: string[];
    try {
      files = await fs.readdir(atlasDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".atlas.bin.gz")) continue;
      const tileId = f.slice(0, -".atlas.bin.gz".length);
      const parsed = parseTileId(tileId);
      if (!parsed) continue;
      const centerE = parsed.minE + parsed.size / 2;
      const centerN = parsed.minN + parsed.size / 2;
      const { lat, lon } = lv95ToWgs84(centerE, centerN);
      const pos = SunCalc.getPosition(utc, lat, lon);
      const altDeg = pos.altitude * RAD_TO_DEG;
      if (altDeg <= 0) continue;
      let azDeg = (pos.azimuth * RAD_TO_DEG + 180) % 360;
      if (azDeg < 0) azDeg += 360;
      const azB = Math.floor(azDeg / RES);
      const altB = Math.floor(altDeg / RES);

      const atlas = await loadPrecomputedTileAtlas({
        region,
        modelVersionHash: hash,
        gridStepMeters: gridStep,
        tileId,
        resolutionDeg: RES,
      });
      if (!atlas) {
        missingAtlas++;
        continue;
      }
      const bucket = lookupAtlasBucket(atlas, azB, altB);
      if (!bucket) {
        missing++;
        if (missingSamples.length < 5) {
          missingSamples.push(`${tileId} az=${azDeg.toFixed(1)} alt=${altDeg.toFixed(1)} azB=${azB} altB=${altB}`);
        }
        continue;
      }
      const sunCount = countBits(bucket.sunMask);
      if (sunCount === 0) {
        zero++;
        if (zeroSamples.length < 5) {
          zeroSamples.push(`${tileId} az=${azDeg.toFixed(1)} alt=${altDeg.toFixed(1)}`);
        }
      } else {
        ok++;
        if (probeTileIds.has(tileId)) okProbeTiles.push(`${tileId} sunCount=${sunCount}`);
      }
    }
  }

  console.log(`\n=== 2026-04-18 noon (10:00 UTC) — Lausanne atlas check ===`);
  console.log(`OK (sunCount>0):        ${ok}`);
  console.log(`ZERO (sunCount=0):      ${zero}`);
  console.log(`MISSING bucket:         ${missing}`);
  console.log(`MISSING atlas file:     ${missingAtlas}`);
  if (zeroSamples.length) {
    console.log(`\nZero samples:`);
    for (const s of zeroSamples) console.log(`  ${s}`);
  }
  if (missingSamples.length) {
    console.log(`\nMissing-bucket samples:`);
    for (const s of missingSamples) console.log(`  ${s}`);
  }
  if (okProbeTiles.length) {
    console.log(`\nProbe tiles with OK bucket:`);
    for (const s of okProbeTiles) console.log(`  ${s}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
