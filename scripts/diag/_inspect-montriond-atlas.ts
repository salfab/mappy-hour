import {
  loadPrecomputedTileAtlasesInPrecisionOrder,
  getAtlasBucketMasks,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID = 1;
const RES = 0.75;

async function main() {
  for (const tileId of [
    "e2536750_n1152000_s250",
    "e2537000_n1152000_s250",
    "e2537000_n1151750_s250", // Milan centre control
  ]) {
    console.log(`\n═══ ${tileId} ═══`);
    const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
      region: REGION, modelVersionHash: MODEL_HASH, gridStepMeters: GRID, tileId,
    });
    if (atlases.length === 0) { console.log("  no atlas"); continue; }
    for (const a of atlases) {
      console.log(`  res=${a.resolutionDegAz}°  outdoor=${a.outdoorPointCount}  buckets=${a.bucketCount}  generatedAt=${a.meta.generatedAt ?? "?"}`);
      for (let i = 0; i < Math.min(a.bucketCount, 15); i++) {
        const masks = getAtlasBucketMasks(a, i);
        if (!masks) continue;
        const azB = masks.azBucket, altB = masks.altBucket;
        const azMin = azB * a.resolutionDegAz, azMax = (azB + 1) * a.resolutionDegAz;
        const altMin = altB * a.resolutionDegAlt, altMax = (altB + 1) * a.resolutionDegAlt;
        let sun = 0, sunNoVeg = 0, bBlk = 0, vBlk = 0, tBlk = 0;
        for (let p = 0; p < a.outdoorPointCount; p++) {
          if ((masks.sunMask[p >> 3] >> (p & 7)) & 1) sun++;
          if ((masks.sunNoVegMask[p >> 3] >> (p & 7)) & 1) sunNoVeg++;
          if ((masks.buildingsMask[p >> 3] >> (p & 7)) & 1) bBlk++;
          if ((masks.vegetationMask[p >> 3] >> (p & 7)) & 1) vBlk++;
          if ((masks.terrainMask[p >> 3] >> (p & 7)) & 1) tBlk++;
        }
        const od = a.outdoorPointCount;
        console.log(
          `    [${i}] azB=${azB} (${azMin.toFixed(1)}-${azMax.toFixed(1)}°) altB=${altB} (${altMin.toFixed(1)}-${altMax.toFixed(1)}°) ` +
          `sun=${((sun/od)*100).toFixed(1)}% noVeg=${((sunNoVeg/od)*100).toFixed(1)}% ` +
          `bBlk=${((bBlk/od)*100).toFixed(1)}% vBlk=${((vBlk/od)*100).toFixed(1)}% tBlk=${((tBlk/od)*100).toFixed(1)}%`,
        );
      }
      if (a.bucketCount > 15) console.log(`    ... and ${a.bucketCount - 15} more`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
