import fs from "node:fs/promises";
import path from "node:path";
import SunCalc from "suncalc";

import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import {
  loadPrecomputedTileAtlasesInPrecisionOrder,
  lookupAtlasByAngle,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID = 1;
const RAD_TO_DEG = 180 / Math.PI;
const FOCUS_KEY_TARGET = "2537,1152";

async function main() {
  const atlasDir = path.join(
    process.cwd(), "data/cache/sunlight", REGION, MODEL_HASH, `g${GRID}`, "atlas", "r0.75",
  );
  const files = await fs.readdir(atlasDir);
  const tiles = files
    .filter((f) => f.endsWith(".atlas.bin.gz"))
    .map((f) => f.replace(".atlas.bin.gz", ""))
    .map((name) => {
      const m = /^e(\d+)_n(\d+)_s\d+$/.exec(name);
      return m ? { tileId: name, tileE: +m[1], tileN: +m[2] } : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const targetTiles = tiles.filter((t) => {
    const cx = Math.round((t.tileE + 125) / 1000);
    const cy = Math.round((t.tileN + 125) / 1000);
    return `${cx},${cy}` === FOCUS_KEY_TARGET;
  });
  console.log(`Focus ${FOCUS_KEY_TARGET}: ${targetTiles.length} tuiles\n`);
  targetTiles.sort((a, b) => (a.tileN - b.tileN) || (a.tileE - b.tileE));

  const utc = new Date("2026-04-29T07:30:00+02:00");
  const grid: Record<string, string> = {};

  for (const t of targetTiles) {
    const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
      region: REGION, modelVersionHash: MODEL_HASH, gridStepMeters: GRID, tileId: t.tileId,
    });
    const a = atlases[0];
    if (!a) continue;
    const center = lv95ToWgs84Precise(t.tileE + 125, t.tileN + 125);
    const pos = SunCalc.getPosition(utc, center.lat, center.lon);
    const alt = pos.altitude * RAD_TO_DEG;
    let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
    if (az < 0) az += 360;
    const bucket = lookupAtlasByAngle(atlases, az, alt);
    if (!bucket) continue;
    let bBlk = 0, vBlk = 0;
    for (let i = 0; i < a.outdoorPointCount; i++) {
      if ((bucket.buildingsMask[i >> 3] >> (i & 7)) & 1) bBlk++;
      if ((bucket.vegetationMask[i >> 3] >> (i & 7)) & 1) vBlk++;
    }
    const od = a.outdoorPointCount;
    const bPct = (bBlk / od) * 100;
    const vPct = (vBlk / od) * 100;
    const tag = bPct < 0.5 ? "✗" : "✓";
    console.log(
      `  ${tag} ${t.tileId}  buckets=${a.bucketCount.toString().padStart(4)}  outdoor=${od}  bBlk=${bPct.toFixed(1).padStart(5)}%  vBlk=${vPct.toFixed(1).padStart(5)}%`,
    );
    grid[`${t.tileE}_${t.tileN}`] = bPct < 0.5 ? "✗" : "✓";
  }

  console.log(`\nGrid spatial (focus ${FOCUS_KEY_TARGET}):`);
  const tileNs = [...new Set(targetTiles.map((t) => t.tileN))].sort((a, b) => b - a);
  const tileEs = [...new Set(targetTiles.map((t) => t.tileE))].sort((a, b) => a - b);
  console.log(`       ${tileEs.map((e) => e.toString().slice(-4)).join(" ")}`);
  for (const n of tileNs) {
    let row = `${n}: `;
    for (const e of tileEs) {
      row += ` ${grid[`${e}_${n}`] ?? "·"}   `;
    }
    console.log(row);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
