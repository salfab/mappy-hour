import fs from "node:fs/promises";
import path from "node:path";
import { gunzip as gunzipCb } from "node:zlib";
import { promisify } from "node:util";
import SunCalc from "suncalc";
import { lv95ToWgs84 } from "../../src/lib/geo/projection";
import {
  decodeTileAtlasFromBinary,
  lookupAtlasByAngle,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const gunzip = promisify(gunzipCb);
const RAD_TO_DEG = 180 / Math.PI;
const MODEL_HASH = "d43fe24cbb9190af";

async function loadAtlas(cacheRoot: string, tileId: string) {
  const p = path.join(cacheRoot, "sunlight/lausanne", MODEL_HASH, "g1/atlas/r0.75", `${tileId}.atlas.bin.gz`);
  try {
    const buf = await fs.readFile(p);
    const data = await gunzip(buf);
    return decodeTileAtlasFromBinary(new Uint8Array(data));
  } catch { return null; }
}

async function main() {
  const tileIds = ["e2536750_n1152000_s250", "e2537250_n1151500_s250"];
  const caches = [
    { name: "cache (CURRENT with terrain fix)", root: "data/cache" },
    { name: "_cache-gpu-raster-pre-terrain-112726", root: "data/_cache-gpu-raster-pre-terrain-112726" },
  ];
  for (const tileId of tileIds) {
    console.log(`\n═══ ${tileId} ═══`);
    const e = parseInt(tileId.slice(1,8)); const n = parseInt(tileId.slice(10,17));
    const center = lv95ToWgs84(e+125, n+125);
    const utc = new Date("2026-04-29T07:30:00+02:00");
    const pos = SunCalc.getPosition(utc, center.lat, center.lon);
    const alt = pos.altitude * RAD_TO_DEG;
    let az = (pos.azimuth * RAD_TO_DEG + 180) % 360; if (az < 0) az += 360;
    for (const c of caches) {
      const a = await loadAtlas(c.root, tileId);
      if (!a) { console.log(`  ${c.name}: NO ATLAS`); continue; }
      const bucket = lookupAtlasByAngle([a], az, alt);
      if (!bucket) { console.log(`  ${c.name}: buckets=${a.bucketCount} NO BUCKET`); continue; }
      let bBlk = 0, vBlk = 0, tBlk = 0;
      for (let p = 0; p < a.outdoorPointCount; p++) {
        if ((bucket.buildingsMask[p >> 3] >> (p & 7)) & 1) bBlk++;
        if ((bucket.vegetationMask[p >> 3] >> (p & 7)) & 1) vBlk++;
        if ((bucket.terrainMask[p >> 3] >> (p & 7)) & 1) tBlk++;
      }
      const od = a.outdoorPointCount;
      console.log(`  ${c.name}: buckets=${a.bucketCount} outdoor=${od} bBlk=${(bBlk/od*100).toFixed(1)}% vBlk=${(vBlk/od*100).toFixed(1)}% tBlk=${(tBlk/od*100).toFixed(1)}%`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
