import fs from "node:fs/promises";
import path from "node:path";
import { gunzip as gunzipCb } from "node:zlib";
import { promisify } from "node:util";
const gunzip = promisify(gunzipCb);

const MODEL_HASH = "d43fe24cbb9190af";
const GRID = 1;

async function main() {
  for (const tileId of [
    "e2537250_n1151750_s250",
    "e2537250_n1152000_s250",
    "e2537500_n1151750_s250",
    "e2537500_n1152000_s250",
  ]) {
    const p = path.join(process.cwd(), "data/cache/tile-grid-metadata/lausanne", MODEL_HASH, `g${GRID}`, `${tileId}.json.gz`);
    try {
      const buf = await fs.readFile(p);
      const json = JSON.parse((await gunzip(buf)).toString("utf8"));
      const total = json.totalPoints ?? json.pointCount ?? 0;
      const indoor = json.indoorCount ?? 0;
      const pct = total > 0 ? (indoor / total) * 100 : 0;
      console.log(`${tileId}: total=${total} indoor=${indoor} pct=${pct.toFixed(1)}%`);
    } catch (e: any) {
      console.log(`${tileId}: ERROR ${e.message}`);
    }
  }
}
main();
