/**
 * Diagnostic: vérifier que l'atlas de la tuile contenant Place de la Riponne
 * contient bien des masques soleil non vides le 2026-04-22.
 *
 * Usage: pnpm tsx scripts/diag/check-riponne-atlas.ts
 */
import SunCalc from "suncalc";

import { wgs84ToLv95 } from "../../src/lib/geo/projection";
import {
  loadPrecomputedTileAtlas,
  loadPrecomputedTileAtlasesInPrecisionOrder,
  lookupAtlasBucket,
  lookupAtlasByAngle,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const REGION = "lausanne";
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;

// Place de la Riponne
const RIPONNE_LAT = 46.5231;
const RIPONNE_LON = 6.6323;
const DATE = "2026-04-22";

function popcount8(x: number): number {
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}
function popcount(buf: Uint8Array, bits: number): number {
  const fb = Math.floor(bits / 8);
  const tb = bits - fb * 8;
  let n = 0;
  for (let i = 0; i < fb; i++) n += popcount8(buf[i]);
  if (tb > 0) n += popcount8(buf[fb] & ((1 << tb) - 1));
  return n;
}

function tileIdFor(easting: number, northing: number, size = 250): string {
  const e = Math.floor(easting / size) * size;
  const n = Math.floor(northing / size) * size;
  return `e${e}_n${n}_s${size}`;
}

async function main() {
  const { easting, northing } = wgs84ToLv95(RIPONNE_LON, RIPONNE_LAT);
  const tileId = tileIdFor(easting, northing);
  console.log(`Riponne WGS84=(${RIPONNE_LAT}, ${RIPONNE_LON})`);
  console.log(`Riponne LV95=(${easting.toFixed(1)}, ${northing.toFixed(1)})`);
  console.log(`tileId=${tileId}`);

  const targetRes = Number(process.env.RES ?? "0") || undefined;
  const atlases = targetRes
    ? await (async () => {
        const a = await loadPrecomputedTileAtlas({
          region: REGION as never,
          modelVersionHash: MODEL_HASH,
          gridStepMeters: GRID_STEP,
          tileId,
          resolutionDeg: targetRes,
        });
        return a ? [a] : [];
      })()
    : await loadPrecomputedTileAtlasesInPrecisionOrder({
        region: REGION as never,
        modelVersionHash: MODEL_HASH,
        gridStepMeters: GRID_STEP,
        tileId,
      });
  if (atlases.length === 0) {
    console.error(`ATLAS NOT FOUND for tile ${tileId} at res=${targetRes ?? "fallback"}`);
    return;
  }
  const atlas = atlases[0];
  console.log(`loaded ${atlases.length} atlas(es) at res=${targetRes ?? "cascade"}; primary=${atlas.resolutionDegAz}°`);

  console.log(
    `\natlas: pointCount=${atlas.pointCount}  outdoor=${atlas.outdoorPointCount}  buckets=${atlas.bucketCount}  resAz=${atlas.resolutionDegAz}° resAlt=${atlas.resolutionDegAlt}°`,
  );
  console.log(
    `atlas meta: ${JSON.stringify(atlas.meta, null, 2).slice(0, 800)}`,
  );

  // Global stats: how many buckets have any sun bits?
  const bits = atlas.outdoorPointCount;
  let bucketsWithSun = 0;
  let totalSunBits = 0;
  for (let i = 0; i < atlas.bucketCount; i++) {
    const di = atlas.bucketDataIndex[i];
    const maskStart =
      di * 5 * atlas.maskBytesPerBucket; // 5 masks per bucket, sun=0
    const sunMask = atlas.maskBuffer.subarray(
      maskStart,
      maskStart + atlas.maskBytesPerBucket,
    );
    const c = popcount(sunMask, bits);
    if (c > 0) bucketsWithSun++;
    totalSunBits += c;
  }
  console.log(
    `\nGlobal: bucketsWithSun=${bucketsWithSun}/${atlas.bucketCount}  totalSunBits=${totalSunBits} (of ${atlas.bucketCount * bits} possible)`,
  );

  // Min/max alt buckets present
  let minAlt = Number.POSITIVE_INFINITY;
  let maxAlt = -1;
  for (let i = 0; i < atlas.bucketCount; i++) {
    const a = atlas.bucketAlt[i];
    if (a < minAlt) minAlt = a;
    if (a > maxAlt) maxAlt = a;
  }
  console.log(`alt bucket range present: [${minAlt}..${maxAlt}]°`);

  // Dump first 20 bucket keys to understand the indexing convention
  console.log("\nFirst 20 bucket (az,alt) keys in the atlas index:");
  for (let i = 0; i < Math.min(20, atlas.bucketCount); i++) {
    console.log(`  [${i}] az=${atlas.bucketAz[i]} alt=${atlas.bucketAlt[i]}`);
  }
  // Sample a mid-range and tail as well
  const midIdx = Math.floor(atlas.bucketCount / 2);
  console.log(`\nMid-range (around index ${midIdx}):`);
  for (let i = midIdx; i < Math.min(midIdx + 10, atlas.bucketCount); i++) {
    console.log(`  [${i}] az=${atlas.bucketAz[i]} alt=${atlas.bucketAlt[i]}`);
  }
  console.log(`\nTail:`);
  for (let i = Math.max(0, atlas.bucketCount - 10); i < atlas.bucketCount; i++) {
    console.log(`  [${i}] az=${atlas.bucketAz[i]} alt=${atlas.bucketAlt[i]}`);
  }

  // Find the closest populated bucket to the noon target (az=285,alt=100).
  const target = { az: 285, alt: 100 };
  let best = { i: -1, d: Infinity, daz: 0, dalt: 0 };
  for (let i = 0; i < atlas.bucketCount; i++) {
    const daz = atlas.bucketAz[i] - target.az;
    const dalt = atlas.bucketAlt[i] - target.alt;
    const d = daz * daz + dalt * dalt;
    if (d < best.d) {
      best = { i, d, daz, dalt };
    }
  }
  console.log(
    `\nClosest bucket to noon 2026-04-22 target (azB=${target.az}, altB=${target.alt}):`,
  );
  console.log(
    `  [${best.i}] az=${atlas.bucketAz[best.i]} alt=${atlas.bucketAlt[best.i]}  Δaz=${best.daz * atlas.resolutionDegAz}°  Δalt=${best.dalt * atlas.resolutionDegAlt}°  sqrDist=${best.d}`,
  );

  // For each altitude bucket around noon (100 = 50°), list all azimuths present.
  console.log(`\nAzimuth coverage around noon altitude (bucket 100 = alt 50°±0.5°):`);
  for (let altTarget = 95; altTarget <= 112; altTarget++) {
    const azs: number[] = [];
    for (let i = 0; i < atlas.bucketCount; i++) {
      if (atlas.bucketAlt[i] === altTarget) azs.push(atlas.bucketAz[i]);
    }
    if (azs.length > 0) {
      const degs = azs
        .sort((a, b) => a - b)
        .map((b) => (b * atlas.resolutionDegAz).toFixed(1))
        .join(", ");
      console.log(`  alt bucket ${altTarget} (${(altTarget * atlas.resolutionDegAlt).toFixed(1)}°): az deg = [${degs}]`);
    }
  }

  // Enumerate sun positions on 2026-04-22 Europe/Zurich local
  // and for each minute (every 15 min), look up the bucket.
  console.log(
    `\nTimeline for ${DATE} at Riponne — per 15 min:`,
  );
  console.log("  local   az°     alt°   | bucket(az,alt) | sunBits / outdoor");
  const hours = [
    "06:00", "07:00", "08:00", "09:00", "10:00", "11:00",
    "12:00", "13:00", "14:00", "15:00", "16:00", "17:00",
    "18:00", "19:00", "20:00",
  ];
  for (const t of hours) {
    // 2026-04-22 is CEST (+02:00)
    const utc = new Date(`${DATE}T${t}:00+02:00`);
    const pos = SunCalc.getPosition(utc, RIPONNE_LAT, RIPONNE_LON);
    const alt = (pos.altitude * 180) / Math.PI;
    let az = (pos.azimuth * 180) / Math.PI + 180;
    if (az < 0) az += 360;
    if (az >= 360) az -= 360;
    if (alt <= 0) {
      console.log(`  ${t}   ${az.toFixed(2).padStart(6)}° ${alt.toFixed(2).padStart(6)}° | (sun below horizon)`);
      continue;
    }
    // Cascade through all available resolutions (r0.5 → r0.75 → r1).
    const entry = lookupAtlasByAngle(atlases, az, alt);
    if (!entry) {
      console.log(
        `  ${t}   ${az.toFixed(2).padStart(6)}° ${alt.toFixed(2).padStart(6)}° | BUCKET MISSING in all ${atlases.length} atlases`,
      );
      continue;
    }
    const sunBits = popcount(entry.sunMask, bits);
    console.log(
      `  ${t}   ${az.toFixed(2).padStart(6)}° ${alt.toFixed(2).padStart(6)}° | azB=${entry.azBucket} altB=${entry.altBucket} | ${sunBits} / ${bits}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
