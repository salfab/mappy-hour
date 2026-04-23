import fs from "node:fs/promises";
import path from "node:path";
import SunCalc from "suncalc";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";
import { loadPrecomputedTileAtlasesInPrecisionOrder, lookupAtlasByAngle } from "../../src/lib/precompute/sunlight-cache-atlas";
const MODEL_HASH = "d43fe24cbb9190af", GRID = 1, RAD_TO_DEG = 180 / Math.PI;
async function main() {
  const atlasDir = path.join(process.cwd(), "data/cache/sunlight/lausanne", MODEL_HASH, `g${GRID}`, "atlas/r0.75");
  const files = (await fs.readdir(atlasDir)).filter(f => f.endsWith(".atlas.bin.gz"));
  const tiles = files.map(f => { const m = /^e(\d+)_n(\d+)_s\d+/.exec(f); return m ? { id: f.replace(".atlas.bin.gz",""), e: +m[1], n: +m[2] } : null; }).filter(x => x !== null);
  const utc = new Date("2026-04-29T07:30:00+02:00");
  let zero=0, nonZero=0;
  const zeroTiles: string[] = [];
  for (const t of tiles) {
    const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({ region:"lausanne", modelVersionHash:MODEL_HASH, gridStepMeters:GRID, tileId:t.id });
    if (atlases.length === 0) continue;
    const a = atlases[0];
    if (a.outdoorPointCount < 100) continue;
    const c = lv95ToWgs84(t.e+125, t.n+125);
    const pos = SunCalc.getPosition(utc, c.lat, c.lon);
    const alt = pos.altitude * RAD_TO_DEG;
    let az = (pos.azimuth * RAD_TO_DEG + 180) % 360; if (az<0) az+=360;
    if (alt <= 0) continue;
    const b = lookupAtlasByAngle(atlases, az, alt);
    if (!b) continue;
    let bBlk = 0;
    for (let i=0; i<a.outdoorPointCount; i++) if ((b.buildingsMask[i>>3]>>(i&7))&1) bBlk++;
    const pct = bBlk/a.outdoorPointCount*100;
    if (pct < 0.5) { zero++; zeroTiles.push(t.id); } else nonZero++;
  }
  console.log(`Total: ${zero+nonZero}  zero=${zero}  nonZero=${nonZero}  (${(zero/(zero+nonZero)*100).toFixed(1)}% KO)`);
  console.log(`KO tiles:\n${zeroTiles.map(id => `    { "region": "lausanne", "tileId": "${id}" }`).join(",\n")}`);
}
main().catch(e => { console.error(e); process.exit(1); });
