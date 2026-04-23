/**
 * Reproduce the curl request — enumerate tiles for this bbox and analyse the
 * atlas + binary tile state for each, to find where the 0-shadows come from.
 */
import SunCalc from "suncalc";

import { wgs84ToLv95, lv95ToWgs84 } from "../../src/lib/geo/projection";
import {
  loadPrecomputedTileAtlasesInPrecisionOrder,
  lookupAtlasByAngle,
} from "../../src/lib/precompute/sunlight-cache-atlas";
import { loadPrecomputedSunlightTileBinary } from "../../src/lib/precompute/sunlight-cache-binary";

const BBOX = {
  minLon: 6.622406, minLat: 46.514623, maxLon: 6.625818, maxLat: 46.516683,
};
const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID = 1;
const DATE = "2026-04-29";
const RAD_TO_DEG = 180 / Math.PI;

function tilesIn(bbox: typeof BBOX): string[] {
  const sw = wgs84ToLv95(bbox.minLon, bbox.minLat);
  const ne = wgs84ToLv95(bbox.maxLon, bbox.maxLat);
  const tiles = new Set<string>();
  const TS = 250;
  for (let te = Math.floor(sw.easting / TS) * TS; te <= ne.easting; te += TS) {
    for (let tn = Math.floor(sw.northing / TS) * TS; tn <= ne.northing; tn += TS) {
      tiles.add(`e${te}_n${tn}_s250`);
    }
  }
  return [...tiles];
}

async function main() {
  const tiles = tilesIn(BBOX);
  console.log(`Tiles in bbox: ${tiles.join(", ")}`);

  // Compute az/alt for each sample 07:30 → 21:00 every 15min (same as curl)
  const centerE = (wgs84ToLv95(BBOX.minLon, BBOX.minLat).easting + wgs84ToLv95(BBOX.maxLon, BBOX.maxLat).easting) / 2;
  const centerN = (wgs84ToLv95(BBOX.minLon, BBOX.minLat).northing + wgs84ToLv95(BBOX.maxLon, BBOX.maxLat).northing) / 2;
  const center = lv95ToWgs84(centerE, centerN);

  const samples: Array<{ local: string; utc: Date; az: number; alt: number }> = [];
  const minutes = [
    "07:30","07:45","08:00","08:15","08:30","08:45","09:00","09:15","09:30","09:45","10:00",
    "12:00","15:00","18:00",
  ];
  for (const m of minutes) {
    const utc = new Date(`${DATE}T${m}:00+02:00`);
    const pos = SunCalc.getPosition(utc, center.lat, center.lon);
    const alt = pos.altitude * RAD_TO_DEG;
    if (alt <= 0) continue;
    let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
    if (az < 0) az += 360;
    samples.push({ local: m, utc, az, alt });
  }

  for (const tileId of tiles) {
    console.log(`\n══ ${tileId} ══`);
    const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
      region: REGION, modelVersionHash: MODEL_HASH, gridStepMeters: GRID, tileId,
    });
    console.log(`  atlas: ${atlases.length} resolutions, buckets=${atlases.map((a) => a.bucketCount).join("/")}`);

    // For the 07:30-21:00 requested samples, check which have an atlas bucket
    let nBucket = 0, nNoBucket = 0;
    for (const s of samples) {
      const bucket = atlases.length > 0 ? lookupAtlasByAngle(atlases, s.az, s.alt) : null;
      if (bucket) nBucket++; else nNoBucket++;
    }
    console.log(`  coverage: ${nBucket}/${samples.length} samples have bucket`);

    // Analyse each sample
    for (const s of samples.slice(0, 6)) {
      const bucket = atlases.length > 0 ? lookupAtlasByAngle(atlases, s.az, s.alt) : null;
      const a = atlases[0];
      if (!bucket) {
        console.log(`  ${s.local} az=${s.az.toFixed(1)} alt=${s.alt.toFixed(1)}  ✗ NO BUCKET`);
        continue;
      }
      let sun = 0, sunNoVeg = 0, bBlk = 0, vBlk = 0, tBlk = 0;
      for (let p = 0; p < a.outdoorPointCount; p++) {
        if ((bucket.sunMask[p >> 3] >> (p & 7)) & 1) sun++;
        if ((bucket.sunNoVegMask[p >> 3] >> (p & 7)) & 1) sunNoVeg++;
        if ((bucket.buildingsMask[p >> 3] >> (p & 7)) & 1) bBlk++;
        if ((bucket.vegetationMask[p >> 3] >> (p & 7)) & 1) vBlk++;
        if ((bucket.terrainMask[p >> 3] >> (p & 7)) & 1) tBlk++;
      }
      const od = a.outdoorPointCount;
      console.log(
        `  ${s.local} az=${s.az.toFixed(1)} alt=${s.alt.toFixed(1)}  ` +
        `sun=${((sun/od)*100).toFixed(1)}% noVeg=${((sunNoVeg/od)*100).toFixed(1)}% ` +
        `bBlk=${((bBlk/od)*100).toFixed(1)}% vBlk=${((vBlk/od)*100).toFixed(1)}% tBlk=${((tBlk/od)*100).toFixed(1)}%`,
      );
    }

    // Check for binary tile (per-date fallback)
    for (const window of ["t0000-2359", "t0730-2100"]) {
      const [startLocalTime, endLocalTime] = [window.slice(1, 5), window.slice(6)];
      const start = `${startLocalTime.slice(0, 2)}:${startLocalTime.slice(2)}`;
      const end = `${endLocalTime.slice(0, 2)}:${endLocalTime.slice(2)}`;
      const bin = await loadPrecomputedSunlightTileBinary({
        region: REGION, modelVersionHash: MODEL_HASH, date: DATE,
        gridStepMeters: GRID, sampleEveryMinutes: 15,
        startLocalTime: start, endLocalTime: end,
        tileId,
      }).catch(() => null);
      console.log(`  binary ${window}: ${bin ? `EXISTS (frames=${bin.frameCount} pts=${bin.pointCount})` : "not found"}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
