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

async function check(tileId: string, label: string, centerE: number, centerN: number) {
  console.log(`\n═══ ${label}  ${tileId} ═══`);
  const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
    region: REGION, modelVersionHash: MODEL_HASH, gridStepMeters: GRID, tileId,
  });
  if (atlases.length === 0) { console.log("  NO ATLAS"); return; }
  const a = atlases[0];
  console.log(`  res=${a.resolutionDegAz}° outdoor=${a.outdoorPointCount} buckets=${a.bucketCount}`);
  const center = lv95ToWgs84Precise(centerE, centerN);
  const minutes = ["07:30","09:00","10:30","12:00","14:00","16:00","18:00","20:00"];
  for (const m of minutes) {
    const utc = new Date(`2026-04-29T${m}:00+02:00`);
    const pos = SunCalc.getPosition(utc, center.lat, center.lon);
    const alt = pos.altitude * RAD_TO_DEG;
    let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
    if (az < 0) az += 360;
    if (alt <= 0) { console.log(`  ${m} night`); continue; }
    const bucket = lookupAtlasByAngle(atlases, az, alt);
    if (!bucket) { console.log(`  ${m} az=${az.toFixed(1)} alt=${alt.toFixed(1)}  ✗ NO BUCKET`); continue; }
    let sun=0, sunNoVeg=0, bBlk=0, vBlk=0, tBlk=0;
    for (let p = 0; p < a.outdoorPointCount; p++) {
      if ((bucket.sunMask[p >> 3] >> (p & 7)) & 1) sun++;
      if ((bucket.sunNoVegMask[p >> 3] >> (p & 7)) & 1) sunNoVeg++;
      if ((bucket.buildingsMask[p >> 3] >> (p & 7)) & 1) bBlk++;
      if ((bucket.vegetationMask[p >> 3] >> (p & 7)) & 1) vBlk++;
      if ((bucket.terrainMask[p >> 3] >> (p & 7)) & 1) tBlk++;
    }
    const od = a.outdoorPointCount;
    console.log(
      `  ${m} az=${az.toFixed(1).padStart(5)} alt=${alt.toFixed(1).padStart(4)}  ` +
      `sun=${((sun/od)*100).toFixed(1).padStart(5)}% noVeg=${((sunNoVeg/od)*100).toFixed(1).padStart(5)}% ` +
      `bBlk=${((bBlk/od)*100).toFixed(1).padStart(5)}% vBlk=${((vBlk/od)*100).toFixed(1).padStart(5)}% tBlk=${((tBlk/od)*100).toFixed(1).padStart(5)}%`,
    );
  }
}
async function main() {
  await check("e2537250_n1151500_s250", "Floréal (école)", 2537375, 1151625);
  await check("e2537500_n1151500_s250", "Voisin est", 2537625, 1151625);
  await check("e2537250_n1151750_s250", "Voisin nord", 2537375, 1151875);
}
main().catch((e) => { console.error(e); process.exit(1); });
