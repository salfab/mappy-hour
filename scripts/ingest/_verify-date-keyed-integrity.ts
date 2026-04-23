/**
 * Integrity check on the date-keyed tile cache.
 *
 * For each tile in the cache:
 *   - check outdoorPointCount > 0
 *   - check frame count > 0
 *   - for each frame where sun is above horizon:
 *       * popcount(sunMask) must equal frame.sunnyCount (metadata)
 *       * popcount(sunMaskNoVeg) must equal frame.sunnyCountNoVegetation
 *       * if sun alt > 15° at tile center: sunnyCount should be > 0
 *         (100% blocked tile would be pathological)
 *   - check sunnyCount monotonic sanity: noVeg >= sun (removing veg only opens bits)
 *
 * Run:
 *   pnpm tsx scripts/ingest/_verify-date-keyed-integrity.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import SunCalc from "suncalc";

import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
} from "../../src/lib/precompute/sunlight-cache-binary";

const RAD_TO_DEG = 180 / Math.PI;

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const DATE = "2026-04-18";
const WINDOW = "t0000-2359";
const START_LOCAL = "00:00";
const END_LOCAL = "23:59";

function popcountBytes(buf: Uint8Array, bits: number): number {
  const fullBytes = Math.floor(bits / 8);
  const tailBits = bits - fullBytes * 8;
  let count = 0;
  for (let i = 0; i < fullBytes; i++) {
    let x = buf[i];
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    count += (x + (x >> 4)) & 0x0f;
  }
  if (tailBits > 0) {
    const mask = (1 << tailBits) - 1;
    let x = buf[fullBytes] & mask;
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    count += (x + (x >> 4)) & 0x0f;
  }
  return count;
}

function parseTileId(id: string): { minE: number; minN: number; size: number } | null {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id);
  if (!m) return null;
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

async function main(): Promise<void> {
  const dir = path.join(
    CACHE_SUNLIGHT_DIR,
    REGION,
    MODEL_HASH,
    `g${GRID_STEP}`,
    `m${SAMPLE_MINUTES}`,
    DATE,
    WINDOW,
    "tiles",
  );
  const files = await fs.readdir(dir);
  const tileIds = files
    .filter((f) => f.endsWith(".tile.bin.gz"))
    .map((f) => f.slice(0, -".tile.bin.gz".length));

  console.log(`Checking ${tileIds.length} tile(s) in ${dir}\n`);

  const issues: Array<{ tileId: string; reason: string }> = [];
  let ok = 0;
  let withZeroOutdoor = 0;
  let withAllDarkFramesWhenSunUp: { tileId: string; frame: string; altDeg: number }[] = [];
  let metaMismatches: { tileId: string; frame: string; declared: number; actual: number; kind: string }[] = [];
  let invariantViolations: { tileId: string; frame: string; sunnyCount: number; sunnyCountNoVeg: number }[] = [];

  const dayTotals = {
    sunBits: 0,
    noVegBits: 0,
    totalFramesAboveHorizon: 0,
  };

  for (const tileId of tileIds) {
    const tile = await loadPrecomputedSunlightTileBinary({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      date: DATE,
      gridStepMeters: GRID_STEP,
      sampleEveryMinutes: SAMPLE_MINUTES,
      startLocalTime: START_LOCAL,
      endLocalTime: END_LOCAL,
      tileId,
    });
    if (!tile) { issues.push({ tileId, reason: "load failed" }); continue; }

    if (tile.outdoorPointCount === 0) {
      withZeroOutdoor++;
      issues.push({ tileId, reason: "outdoorPointCount=0" });
      continue;
    }

    const parsed = parseTileId(tileId)!;
    const centerE = parsed.minE + parsed.size / 2;
    const centerN = parsed.minN + parsed.size / 2;
    const { lat, lon } = lv95ToWgs84(centerE, centerN);

    let framesOK = 0;
    for (const fm of tile.meta.framesMeta) {
      const utc = new Date(fm.utcTime);
      const pos = SunCalc.getPosition(utc, lat, lon);
      const altDeg = pos.altitude * RAD_TO_DEG;

      const sunMask = getFrameMask(tile, fm.index, MASK_KIND_SUN);
      const noVegMask = getFrameMask(tile, fm.index, MASK_KIND_SUN_NO_VEG);

      const actualSun = popcountBytes(sunMask, tile.outdoorPointCount);
      const actualNoVeg = popcountBytes(noVegMask, tile.outdoorPointCount);

      // Metadata vs actual popcount
      if (actualSun !== fm.sunnyCount) {
        metaMismatches.push({ tileId, frame: fm.localTime, declared: fm.sunnyCount, actual: actualSun, kind: "sun" });
      }
      if (actualNoVeg !== fm.sunnyCountNoVegetation) {
        metaMismatches.push({ tileId, frame: fm.localTime, declared: fm.sunnyCountNoVegetation, actual: actualNoVeg, kind: "noVeg" });
      }

      // Invariant: noVeg >= sun (removing veg only opens bits, never closes)
      if (actualNoVeg < actualSun) {
        invariantViolations.push({ tileId, frame: fm.localTime, sunnyCount: actualSun, sunnyCountNoVeg: actualNoVeg });
      }

      // Check: sun alt > 15° and yet NO sunny points? Suspicious.
      if (altDeg > 15) {
        dayTotals.totalFramesAboveHorizon++;
        dayTotals.sunBits += actualSun;
        dayTotals.noVegBits += actualNoVeg;
        if (actualNoVeg === 0) {
          withAllDarkFramesWhenSunUp.push({ tileId, frame: fm.localTime, altDeg });
        }
      }
      framesOK++;
    }

    if (framesOK > 0) ok++;
  }

  console.log(`=== Summary ===`);
  console.log(`  tiles loaded OK:                     ${ok}/${tileIds.length}`);
  console.log(`  tiles with outdoorPointCount=0:      ${withZeroOutdoor}`);
  console.log(`  tiles that failed to load:           ${issues.filter((x) => x.reason === "load failed").length}`);
  console.log(`  framesMeta vs actual mask mismatches: ${metaMismatches.length}`);
  console.log(`  noVeg < sun (invariant violations):   ${invariantViolations.length}`);
  console.log(`  frames "sun alt > 15° but 0 sunnyNoVeg": ${withAllDarkFramesWhenSunUp.length}`);
  console.log(`  day total sun bits (alt > 15°):      ${dayTotals.sunBits}`);
  console.log(`  day total noVeg bits (alt > 15°):    ${dayTotals.noVegBits}`);
  console.log(`  frames aggregated:                   ${dayTotals.totalFramesAboveHorizon}`);

  if (issues.length > 0) {
    console.log(`\n=== Issues (${issues.length}) ===`);
    for (const i of issues.slice(0, 20)) {
      console.log(`  ${i.tileId}: ${i.reason}`);
    }
    if (issues.length > 20) console.log(`  ... +${issues.length - 20} more`);
  }

  if (metaMismatches.length > 0) {
    console.log(`\n=== Metadata/mask mismatches (first 20) ===`);
    for (const m of metaMismatches.slice(0, 20)) {
      console.log(`  ${m.tileId}@${m.frame} [${m.kind}]: declared=${m.declared}, actual=${m.actual}, diff=${m.declared - m.actual}`);
    }
    if (metaMismatches.length > 20) console.log(`  ... +${metaMismatches.length - 20} more`);
  }

  if (invariantViolations.length > 0) {
    console.log(`\n=== Invariant violations (noVeg < sun) ===`);
    for (const v of invariantViolations.slice(0, 20)) {
      console.log(`  ${v.tileId}@${v.frame}: sun=${v.sunnyCount}, noVeg=${v.sunnyCountNoVeg}`);
    }
    if (invariantViolations.length > 20) console.log(`  ... +${invariantViolations.length - 20} more`);
  }

  if (withAllDarkFramesWhenSunUp.length > 0) {
    console.log(`\n=== Fully-dark frames when sun > 15° (${withAllDarkFramesWhenSunUp.length}) ===`);
    for (const d of withAllDarkFramesWhenSunUp.slice(0, 20)) {
      console.log(`  ${d.tileId}@${d.frame}: altDeg=${d.altDeg.toFixed(1)}`);
    }
    if (withAllDarkFramesWhenSunUp.length > 20) console.log(`  ... +${withAllDarkFramesWhenSunUp.length - 20} more`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
