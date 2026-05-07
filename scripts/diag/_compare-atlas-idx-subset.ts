/**
 * Compare two atlas .idx files: check if NEW bucket keys are a subset of BASELINE.
 *
 * Used for proj4 → Precise migration validation. Sub-µm precision in WGS coords
 * cannot move atlas bucket keys (resolution 0.75°), so we expect strict subset.
 *
 * Usage: npx tsx scripts/diag/_compare-atlas-idx-subset.ts <baseline.idx> <new.idx>
 */
import fs from "node:fs/promises";
import { decodeTileAtlasIndex } from "../../src/lib/precompute/sunlight-cache-atlas";

async function main() {
  const [baselinePath, newPath] = process.argv.slice(2);
  if (!baselinePath || !newPath) {
    console.error("Usage: npx tsx _compare-atlas-idx-subset.ts <baseline.idx> <new.idx>");
    process.exit(2);
  }

  const baseline = decodeTileAtlasIndex(await fs.readFile(baselinePath));
  const fresh = decodeTileAtlasIndex(await fs.readFile(newPath));

  console.log(`Baseline: ${baseline.bucketCount} buckets, ${baseline.outdoorPointCount} outdoor pts, res ${baseline.resolutionDegAz}°/${baseline.resolutionDegAlt}°`);
  console.log(`New:      ${fresh.bucketCount} buckets, ${fresh.outdoorPointCount} outdoor pts, res ${fresh.resolutionDegAz}°/${fresh.resolutionDegAlt}°`);

  if (baseline.outdoorPointCount !== fresh.outdoorPointCount) {
    console.warn(`⚠️  outdoorPointCount differs: baseline=${baseline.outdoorPointCount} vs new=${fresh.outdoorPointCount}`);
  }

  const packKey = (az: number, alt: number) => (az << 16) | alt;
  const baseKeys = new Set<number>();
  for (let i = 0; i < baseline.bucketCount; i++) {
    baseKeys.add(packKey(baseline.bucketAz[i], baseline.bucketAlt[i]));
  }

  const newKeys = new Set<number>();
  for (let i = 0; i < fresh.bucketCount; i++) {
    newKeys.add(packKey(fresh.bucketAz[i], fresh.bucketAlt[i]));
  }

  const inBoth = [...newKeys].filter((k) => baseKeys.has(k)).length;
  const inNewNotBase = [...newKeys].filter((k) => !baseKeys.has(k));
  const inBaseNotNew = [...baseKeys].filter((k) => !newKeys.has(k));

  console.log(`\nIntersection: ${inBoth} buckets`);
  console.log(`In NEW but not BASELINE: ${inNewNotBase.length}`);
  console.log(`In BASELINE but not NEW: ${inBaseNotNew.length} (expected — baseline is multi-day cumulative)`);

  if (inNewNotBase.length === 0) {
    console.log(`\n✅ STRICT SUBSET: every new bucket exists in baseline. Bit-parity at bucket-key level confirmed.`);
    process.exit(0);
  } else {
    console.log(`\n❌ NEW contains ${inNewNotBase.length} bucket keys absent from baseline:`);
    for (const k of inNewNotBase.slice(0, 10)) {
      const az = (k >>> 16) & 0xffff;
      const alt = k & 0xffff;
      console.log(`   az=${az * baseline.resolutionDegAz}° alt=${alt * baseline.resolutionDegAlt}°`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
