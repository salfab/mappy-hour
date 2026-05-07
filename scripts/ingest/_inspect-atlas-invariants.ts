/**
 * Deep inspection of atlas invariants:
 *   - outdoorPointCount == max(pointOutdoorIndex) + 1
 *   - outdoorPointCount == count(pointOutdoorIndex != -1)
 *   - maskBytesPerBucket matches ceil(outdoorPointCount / 8)
 *
 * If any of these fail, the mask bits don't align with the outdoor index
 * used to look them up → every comparison is broken.
 *
 * Run:
 *   pnpm tsx scripts/ingest/_inspect-atlas-invariants.ts
 */

import { loadPrecomputedTileAtlas } from "../../src/lib/precompute/sunlight-cache-atlas";
import { loadPrecomputedSunlightTileBinary } from "../../src/lib/precompute/sunlight-cache-binary";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const DATE = "2026-04-18";

const TEST_TILES = [
  "e2538000_n1152500_s250",
  "e2538250_n1152250_s250",
  "e2538500_n1152250_s250",
];

const RESOLUTIONS = [1, 0.5, 0.25];

async function inspectAtlas(tileId: string, resolutionDeg: number): Promise<void> {
  const atlas = await loadPrecomputedTileAtlas({
    region: REGION,
    modelVersionHash: MODEL_HASH,
    gridStepMeters: GRID_STEP,
    tileId,
    resolutionDeg,
  });
  if (!atlas) {
    console.log(`  ${resolutionDeg}° atlas: MISSING`);
    return;
  }

  let maxOi = -1;
  let countNonNeg = 0;
  let negCount = 0;
  for (let i = 0; i < atlas.pointCount; i++) {
    const oi = atlas.pointOutdoorIndex[i];
    if (oi >= 0) {
      countNonNeg++;
      if (oi > maxOi) maxOi = oi;
    } else {
      negCount++;
    }
  }

  const expectedMaskBytes = Math.ceil(atlas.outdoorPointCount / 8);
  const impliedMaskBytes = Math.ceil((maxOi + 1) / 8);

  console.log(
    `  ${resolutionDeg}° atlas: pointCount=${atlas.pointCount}, outdoorPointCount=${atlas.outdoorPointCount}, buckets=${atlas.bucketCount}`,
  );
  console.log(
    `    pointOutdoorIndex: max=${maxOi}, impliedOutdoor=${maxOi + 1}, count(!=-1)=${countNonNeg}, count(=-1)=${negCount}`,
  );
  console.log(
    `    invariant outdoorPointCount==max+1: ${atlas.outdoorPointCount === maxOi + 1 ? "OK" : "FAIL"}`,
  );
  console.log(
    `    invariant outdoorPointCount==count(!=-1): ${atlas.outdoorPointCount === countNonNeg ? "OK" : "FAIL"}`,
  );
  console.log(
    `    maskBytesPerBucket expected=${expectedMaskBytes} (from outdoor), impliedFromMaxOi=${impliedMaskBytes}`,
  );

}

async function main(): Promise<void> {
  for (const tileId of TEST_TILES) {
    console.log(`\n=== ${tileId} ===`);
    const tile = await loadPrecomputedSunlightTileBinary({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      date: DATE,
      gridStepMeters: GRID_STEP,
      sampleEveryMinutes: SAMPLE_MINUTES,
      startLocalTime: "17:00",
      endLocalTime: "17:45",
      tileId,
    });
    if (tile) {
      let maxOi = -1;
      let countNonNeg = 0;
      for (let i = 0; i < tile.pointCount; i++) {
        const oi = tile.pointOutdoorIndex[i];
        if (oi >= 0) { countNonNeg++; if (oi > maxOi) maxOi = oi; }
      }
      console.log(
        `  tile cache: outdoorPointCount=${tile.outdoorPointCount}, max(pointOutdoorIndex)=${maxOi}, count(!=-1)=${countNonNeg}`,
      );
    } else {
      console.log(`  tile cache: MISSING`);
    }
    for (const r of RESOLUTIONS) {
      await inspectAtlas(tileId, r);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
