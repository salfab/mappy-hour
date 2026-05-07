import fs from "node:fs/promises";
import path from "node:path";
import { loadPrecomputedSunlightTileBinary } from "../../src/lib/precompute/sunlight-cache-binary";

async function main() {
  const baseDir = "data/cache/sunlight/lausanne/d43fe24cbb9190af/g1/m15";
  const dates = (await fs.readdir(baseDir)).sort();

  let corrupt = 0, valid = 0;
  for (const date of dates) {
    const dateDir = path.join(baseDir, date);
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
        region: "lausanne", modelVersionHash: "d43fe24cbb9190af",
        date, gridStepMeters: 1, sampleEveryMinutes: 15,
        startLocalTime: `${twM[1]}:${twM[2]}`, endLocalTime: `${twM[3]}:${twM[4]}`,
        tileId,
      });
      if (!tile) continue;
      const total = tile.meta.framesMeta.reduce((a, f) => a + f.sunnyCount, 0);
      if (total === 0) { corrupt++; console.log(`CORRUPT ${date}/${tw}`); }
      else { valid++; console.log(`VALID   ${date}/${tw}  totalSunny=${total}`); }
    }
  }
  console.log(`\nCorrupt: ${corrupt}  Valid: ${valid}`);
}
main().catch(e => { console.error(e); process.exit(1); });
