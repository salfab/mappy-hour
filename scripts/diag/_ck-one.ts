import SunCalc from "suncalc";
import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import { loadPrecomputedTileAtlasesInPrecisionOrder, lookupAtlasByAngle } from "../../src/lib/precompute/sunlight-cache-atlas";
const MODEL_HASH = "d43fe24cbb9190af", GRID = 1, RAD_TO_DEG = 180 / Math.PI;
async function main() {
  const tileId = "e2534000_n1152000_s250";
  const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({ region:"lausanne", modelVersionHash:MODEL_HASH, gridStepMeters:GRID, tileId });
  const a = atlases[0];
  const c = lv95ToWgs84Precise(2534125, 1152125);
  const utc = new Date("2026-04-29T07:30:00+02:00");
  const pos = SunCalc.getPosition(utc, c.lat, c.lon);
  const alt = pos.altitude * RAD_TO_DEG;
  let az = (pos.azimuth * RAD_TO_DEG + 180) % 360; if (az<0) az+=360;
  const b = lookupAtlasByAngle(atlases, az, alt)!;
  let bBlk=0;
  for (let i=0; i<a.outdoorPointCount; i++) if ((b.buildingsMask[i>>3]>>(i&7))&1) bBlk++;
  console.log(`${tileId}  outdoor=${a.outdoorPointCount}  bBlk=${(bBlk/a.outdoorPointCount*100).toFixed(1)}%`);
}
main().catch(e => { console.error(e); process.exit(1); });
