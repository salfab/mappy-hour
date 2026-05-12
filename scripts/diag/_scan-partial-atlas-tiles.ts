/**
 * Scanne toutes les tuiles atlas pour identifier celles avec bucketCount anormalement bas
 * (signature d'un atlas généré par batch partiel : 57 buckets = ~1 journée, vs ~1500 pour
 * une année complète). Écrit une liste des tuiles à régénérer.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  loadPrecomputedTileAtlasesInPrecisionOrder,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const REGION = (process.env.REGION ?? "lausanne") as
  | "lausanne" | "nyon" | "morges" | "geneve" | "vevey" | "vevey_city" | "neuchatel";
const MODEL_HASH = "d43fe24cbb9190af";
const GRID = 1;
const SUSPECT_BUCKET_THRESHOLD = 500;

function parseTile(name: string): string | null {
  const m = /^(e\d+_n\d+_s\d+)$/.exec(name);
  return m ? m[1] : null;
}

async function main() {
  const atlasDir = path.join(
    process.cwd(),
    "data/cache/sunlight",
    REGION, MODEL_HASH, `g${GRID}`, "atlas", "r0.75",
  );
  const files = await fs.readdir(atlasDir);
  const tiles = files
    .filter((f) => f.endsWith(".atlas.bin.gz"))
    .map((f) => parseTile(f.replace(".atlas.bin.gz", "")))
    .filter((t): t is string => t !== null);

  console.log(`[${REGION}] scanning ${tiles.length} atlas tiles, threshold=${SUSPECT_BUCKET_THRESHOLD} buckets...`);

  const bucketHistogram = new Map<number, number>();
  const partial: Array<{ tileId: string; buckets: number; outdoor: number }> = [];
  let scanned = 0;
  for (const tileId of tiles) {
    scanned++;
    if (scanned % 50 === 0) process.stdout.write(`  ${scanned}/${tiles.length}\r`);
    const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
      region: REGION, modelVersionHash: MODEL_HASH, gridStepMeters: GRID, tileId,
    });
    if (atlases.length === 0) continue;
    const a = atlases[0];
    bucketHistogram.set(a.bucketCount, (bucketHistogram.get(a.bucketCount) ?? 0) + 1);
    if (a.bucketCount < SUSPECT_BUCKET_THRESHOLD) {
      partial.push({ tileId, buckets: a.bucketCount, outdoor: a.outdoorPointCount });
    }
  }
  process.stdout.write(`  ${scanned}/${tiles.length} ✓\n\n`);

  console.log(`Histogramme bucketCount :`);
  const sorted = [...bucketHistogram.entries()].sort((a, b) => a[0] - b[0]);
  for (const [buckets, count] of sorted) {
    console.log(`  buckets=${buckets.toString().padStart(5)} : ${count} tuile(s)`);
  }

  console.log(`\n⚠ ${partial.length} tuile(s) avec < ${SUSPECT_BUCKET_THRESHOLD} buckets (partiel)`);
  if (partial.length > 0) {
    partial.sort((a, b) => a.buckets - b.buckets);
    for (const p of partial.slice(0, 20)) {
      console.log(`  ${p.tileId}  buckets=${p.buckets}  outdoor=${p.outdoor}`);
    }
    if (partial.length > 20) console.log(`  ... and ${partial.length - 20} more`);

    const outPath = path.join(
      process.cwd(),
      "data/processed/precompute",
      `partial-atlas-${REGION}.json`,
    );
    await fs.writeFile(outPath, JSON.stringify({
      tileSizeMeters: 250,
      generatedAt: new Date().toISOString(),
      tiles: partial.map((p) => ({ region: REGION, tileId: p.tileId })),
    }, null, 2), "utf8");
    console.log(`\nSélection de régénération écrite : ${outPath}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
