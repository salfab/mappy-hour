/**
 * Purges date-keyed cache entries where all frames have sunnyCount=0.
 * These are corrupted precompute runs (typically t0000-2359 batch).
 * Valid entries (sunnyCount>0 for at least one frame) are kept.
 *
 * Usage (dry-run):
 *   pnpm tsx scripts/ingest/purge-corrupt-cache.ts --region=lausanne
 * Usage (live):
 *   pnpm tsx scripts/ingest/purge-corrupt-cache.ts --region=lausanne --delete
 */

import fs from "node:fs/promises";
import path from "node:path";
import { loadPrecomputedSunlightTileBinary } from "../../src/lib/precompute/sunlight-cache-binary";
import { CACHE_SUNLIGHT_DIR } from "../../src/lib/storage/data-paths";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";

async function main() {
  const region = (process.argv.find(a => a.startsWith("--region="))?.split("=")[1] ?? "lausanne") as PrecomputedRegionName;
  const doDelete = process.argv.includes("--delete");

  console.log(`Scanning ${region} cache for corrupt entries (sunnyCount=0 on all frames)`);
  console.log(doDelete ? "Mode: DELETE" : "Mode: DRY-RUN (pass --delete to actually remove)");
  console.log();

  const regionRoot = path.join(CACHE_SUNLIGHT_DIR, region);
  const hashes = await fs.readdir(regionRoot);

  let corrupt = 0, valid = 0, deleted = 0;

  for (const hash of hashes) {
    const gridDir = path.join(regionRoot, hash, "g1", "m15");
    let dates: string[];
    try { dates = await fs.readdir(gridDir); } catch { continue; }

    for (const date of dates.sort()) {
      const dateDir = path.join(gridDir, date);
      let tws: string[];
      try { tws = await fs.readdir(dateDir); } catch { continue; }

      for (const tw of tws) {
        const tilesDir = path.join(dateDir, tw, "tiles");
        let files: string[];
        try { files = await fs.readdir(tilesDir); } catch { continue; }

        const bin = files.find(f => f.endsWith(".tile.bin.gz"));
        if (!bin) continue;
        const tileId = bin.replace(".tile.bin.gz", "");
        const twM = /^t(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(tw);
        if (!twM) continue;

        const tile = await loadPrecomputedSunlightTileBinary({
          region, modelVersionHash: hash,
          date, gridStepMeters: 1, sampleEveryMinutes: 15,
          startLocalTime: `${twM[1]}:${twM[2]}`, endLocalTime: `${twM[3]}:${twM[4]}`,
          tileId,
        });
        if (!tile) continue;

        const totalSunny = tile.meta.framesMeta.reduce((a, f) => a + f.sunnyCount, 0);
        if (totalSunny === 0) {
          corrupt++;
          const twDir = path.join(dateDir, tw);
          console.log(`${doDelete ? "DELETE" : "WOULD DELETE"} ${date}/${tw}  (${files.length} files)`);
          if (doDelete) {
            await fs.rm(twDir, { recursive: true, force: true });
            deleted++;
            // Remove date dir if now empty
            const remaining = await fs.readdir(dateDir).catch(() => ["x"]);
            if (remaining.length === 0) await fs.rmdir(dateDir).catch(() => {});
          }
        } else {
          valid++;
        }
      }
    }
  }

  console.log();
  console.log(`Corrupt entries: ${corrupt}  Valid: ${valid}`);
  if (doDelete) console.log(`Deleted: ${deleted} time-window directories`);
  else console.log(`Re-run with --delete to remove corrupt entries.`);
}

main().catch(e => { console.error(e); process.exit(1); });
