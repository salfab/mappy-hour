import { loadPrecomputedTileAtlasesInPrecisionOrder } from "../../src/lib/precompute/sunlight-cache-atlas";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID = 1;

async function main() {
  for (const tileId of [
    "e2537250_n1151750_s250",
    "e2537250_n1152000_s250",
    "e2537500_n1151750_s250",
    "e2537500_n1152000_s250",
  ]) {
    console.log(`\n═══ ${tileId} ═══`);
    const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
      region: REGION, modelVersionHash: MODEL_HASH, gridStepMeters: GRID, tileId,
    });
    for (const a of atlases) {
      const m: any = a.meta;
      console.log(`  res=${a.resolutionDegAz}° outdoor=${a.outdoorPointCount} buckets=${a.bucketCount}`);
      console.log(`  generatedAt=${m.generatedAt}`);
      console.log(`  sourceFramesTotal=${m.stats?.sourceFramesTotal}`);
      // Dump all buckets az/alt
      const azs: number[] = [];
      const alts: number[] = [];
      for (let i = 0; i < a.bucketCount; i++) {
        azs.push(a.bucketAz[i]);
        alts.push(a.bucketAlt[i]);
      }
      const azMin = Math.min(...azs) * a.resolutionDegAz;
      const azMax = (Math.max(...azs) + 1) * a.resolutionDegAz;
      const altMin = Math.min(...alts) * a.resolutionDegAlt;
      const altMax = (Math.max(...alts) + 1) * a.resolutionDegAlt;
      console.log(`  az range: ${azMin.toFixed(1)}°..${azMax.toFixed(1)}°  alt range: ${altMin.toFixed(1)}°..${altMax.toFixed(1)}°`);
      // Distinct alts
      const uniqAlts = [...new Set(alts)].sort((a, b) => a - b);
      console.log(`  distinct alt buckets: ${uniqAlts.length} (${uniqAlts.slice(0, 10).map(x => (x * a.resolutionDegAlt).toFixed(1)).join(",")}..)`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
