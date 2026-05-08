import fs from "node:fs/promises";
import path from "node:path";
import { gunzip as gunzipCb } from "node:zlib";
import { promisify } from "node:util";
import SunCalc from "suncalc";
import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import { decodeTileAtlasFromBinary, lookupAtlasByAngle } from "../../src/lib/precompute/sunlight-cache-atlas";
const gunzip = promisify(gunzipCb);
async function load(cacheRoot: string, tileId: string) {
  const p = path.join(cacheRoot, "sunlight/lausanne/d43fe24cbb9190af/g1/atlas/r0.75", `${tileId}.atlas.bin.gz`);
  const buf = await fs.readFile(p);
  return decodeTileAtlasFromBinary(new Uint8Array(await gunzip(buf)));
}
async function main() {
  const tileId = process.argv[2] ?? "e2534000_n1152000_s250";
  const m = /^e(\d+)_n(\d+)/.exec(tileId)!;
  const center = lv95ToWgs84Precise(parseInt(m[1])+125, parseInt(m[2])+125);
  const utc = new Date("2026-04-29T07:30:00+02:00");
  const pos = SunCalc.getPosition(utc, center.lat, center.lon);
  const alt = pos.altitude * 180 / Math.PI;
  let az = (pos.azimuth * 180 / Math.PI + 180) % 360; if (az<0) az+=360;

  for (const root of ["data/cache", "data/_cache-gpu-raster-golden-172239"]) {
    const a = await load(root, tileId);
    const b = lookupAtlasByAngle([a], az, alt)!;
    let bBlk=0, vBlk=0, tBlk=0;
    for (let i=0; i<a.outdoorPointCount; i++) {
      if ((b.buildingsMask[i>>3]>>(i&7))&1) bBlk++;
      if ((b.vegetationMask[i>>3]>>(i&7))&1) vBlk++;
      if ((b.terrainMask[i>>3]>>(i&7))&1) tBlk++;
    }
    const od = a.outdoorPointCount;
    console.log(`${root.padEnd(40)} outdoor=${od} bBlk=${(bBlk/od*100).toFixed(1).padStart(5)}% vBlk=${(vBlk/od*100).toFixed(1).padStart(5)}% tBlk=${(tBlk/od*100).toFixed(1).padStart(5)}%`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
