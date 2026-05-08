import SunCalc from "suncalc";

import {
  loadPrecomputedTileAtlasesInPrecisionOrder,
  lookupAtlasByAngle,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID = 1;
const RAD_TO_DEG = 180 / Math.PI;

const TILES = [
  { tileId: "e2536750_n1152000_s250", lat: 46.5173, lon: 6.6175, label: "Montriond W (école)" },
  { tileId: "e2537000_n1152000_s250", lat: 46.5178, lon: 6.6185, label: "Montriond E" },
  { tileId: "e2537000_n1151750_s250", lat: 46.5157, lon: 6.6185, label: "Milan centre (control)" },
];

const DATES = ["2026-04-27", "2026-04-28", "2026-04-29"];
const TIMES = ["07:30", "08:00", "09:00"];

async function check() {
  for (const t of TILES) {
    console.log(`\n══ ${t.label} (${t.tileId}) ══`);
    const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      gridStepMeters: GRID,
      tileId: t.tileId,
    });
    if (atlases.length === 0) {
      console.log("  MISSING atlas");
      continue;
    }
    const a = atlases[0];
    console.log(`  outdoor=${a.outdoorPointCount}  buckets=${a.bucketCount}`);

    for (const date of DATES) {
      for (const time of TIMES) {
        const utc = new Date(`${date}T${time}:00+02:00`);
        const pos = SunCalc.getPosition(utc, t.lat, t.lon);
        const alt = pos.altitude * RAD_TO_DEG;
        let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
        if (az < 0) az += 360;
        if (alt <= 0) continue;
        const bucket = lookupAtlasByAngle(atlases, az, alt);
        if (!bucket) {
          console.log(`  ${date} ${time} az=${az.toFixed(1)}° alt=${alt.toFixed(1)}°  ✗ NO BUCKET`);
          continue;
        }
        let sFull = 0, sNoVeg = 0, bBlk = 0, vBlk = 0, tBlk = 0;
        for (let i = 0; i < a.outdoorPointCount; i++) {
          if ((bucket.sunMask[i >> 3] >> (i & 7)) & 1) sFull++;
          if ((bucket.sunNoVegMask[i >> 3] >> (i & 7)) & 1) sNoVeg++;
          if ((bucket.buildingsMask[i >> 3] >> (i & 7)) & 1) bBlk++;
          if ((bucket.vegetationMask[i >> 3] >> (i & 7)) & 1) vBlk++;
          if ((bucket.terrainMask[i >> 3] >> (i & 7)) & 1) tBlk++;
        }
        const od = a.outdoorPointCount;
        console.log(
          `  ${date} ${time} az=${az.toFixed(1)}°/alt=${alt.toFixed(1)}°  full=${((sFull/od)*100).toFixed(1)}%  noVeg=${((sNoVeg/od)*100).toFixed(1)}%  bBlk=${((bBlk/od)*100).toFixed(1)}%  vBlk=${((vBlk/od)*100).toFixed(1)}%  tBlk=${((tBlk/od)*100).toFixed(1)}%`,
        );
      }
    }
  }
}
check().catch((e) => { console.error(e); process.exit(1); });
