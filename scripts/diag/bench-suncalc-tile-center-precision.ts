/**
 * Bench the precision loss of computing SunCalc at the tile center vs per-point.
 *
 * MappyHour's hot loop (sunlight-tile-service.ts:1244) calls
 *   SunCalc.getPosition(date, tileCenter.lat, tileCenter.lon)
 * once per frame per tile, and applies that single (az, alt) to all 62500
 * points of a 250m × 250m tile. This bench measures:
 *   - max/mean/p99 delta in azimuth and altitude across the tile
 *   - the resulting shadow displacement error, which is what actually
 *     matters for our in-shadow/out-of-shadow boolean masks.
 *
 * Usage: npx tsx scripts/diag/bench-suncalc-tile-center-precision.ts
 */
import SunCalc from "suncalc";
import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

// Lausanne-ish tile (centre ville)
const TILE_MIN_E = 2538000;
const TILE_MIN_N = 1152000;
const TILE_SIZE_M = 250;

// Grid of 21×21 sample points across the tile (pitch ~12.5m) — dense enough
// to capture the worst corner deviations without flooding the output.
const GRID_N = 21;

// Frame sample times across a summer day (30min steps 05:00→21:00, local time
// UTC+2). Covers low-sun and high-sun regimes.
const SAMPLES: Date[] = [];
for (let hour = 5; hour <= 21; hour += 0.5) {
  const d = new Date(Date.UTC(2026, 5, 21, hour - 2, 0, 0)); // 21 juin, UTC+2
  SAMPLES.push(d);
}

// Building heights to convert shadow-angle error into shadow-displacement error
const BUILDING_HEIGHTS_M = [5, 10, 20, 50];

type Stats = {
  n: number;
  sum: number;
  sumSq: number;
  max: number;
  vals: number[];
};
function mkStats(): Stats {
  return { n: 0, sum: 0, sumSq: 0, max: 0, vals: [] };
}
function push(s: Stats, v: number) {
  s.n += 1;
  s.sum += v;
  s.sumSq += v * v;
  if (v > s.max) s.max = v;
  s.vals.push(v);
}
function summarize(s: Stats) {
  s.vals.sort((a, b) => a - b);
  const mean = s.sum / s.n;
  const p50 = s.vals[Math.floor(s.n * 0.5)];
  const p99 = s.vals[Math.floor(s.n * 0.99)];
  return { mean, p50, p99, max: s.max };
}

const tileCenterE = TILE_MIN_E + TILE_SIZE_M / 2;
const tileCenterN = TILE_MIN_N + TILE_SIZE_M / 2;
const centerWgs = lv95ToWgs84Precise(tileCenterE, tileCenterN);

const azDeltaDeg = mkStats();
const altDeltaDeg = mkStats();
const shadowDisplacementMm: Record<number, Stats> = {};
for (const h of BUILDING_HEIGHTS_M) shadowDisplacementMm[h] = mkStats();

let framesAboveHorizon = 0;

for (const date of SAMPLES) {
  const centerPos = SunCalc.getPosition(date, centerWgs.lat, centerWgs.lon);
  const centerAltDeg = centerPos.altitude * RAD_TO_DEG;
  const centerAzRad = centerPos.azimuth; // SunCalc: 0 = south, positive west

  if (centerAltDeg <= 1) continue; // skip below-horizon and grazing frames
  framesAboveHorizon += 1;

  for (let iy = 0; iy < GRID_N; iy += 1) {
    for (let ix = 0; ix < GRID_N; ix += 1) {
      const e = TILE_MIN_E + (ix / (GRID_N - 1)) * TILE_SIZE_M;
      const n = TILE_MIN_N + (iy / (GRID_N - 1)) * TILE_SIZE_M;
      const w = lv95ToWgs84Precise(e, n);
      const p = SunCalc.getPosition(date, w.lat, w.lon);

      const dAz = Math.abs(p.azimuth - centerAzRad) * RAD_TO_DEG;
      const dAlt = Math.abs(p.altitude * RAD_TO_DEG - centerAltDeg);
      push(azDeltaDeg, dAz);
      push(altDeltaDeg, dAlt);

      // Shadow displacement at a point standing next to a building of height h:
      //   shadow length L = h / tan(alt)
      //   δL due to δalt  = h · δalt / sin²(alt)       (along-shadow shift)
      //   lateral shift   = L · sin(δaz) ≈ L · δaz     (perpendicular shift)
      // We take max(along, lateral) as the worst-case mask error in mm.
      const altRad = centerPos.altitude;
      const sinAlt = Math.sin(altRad);
      const dAzRad = dAz * DEG_TO_RAD;
      const dAltRad = dAlt * DEG_TO_RAD;
      for (const h of BUILDING_HEIGHTS_M) {
        const L = h / Math.tan(altRad);
        const alongShiftM = (h * dAltRad) / (sinAlt * sinAlt);
        const lateralShiftM = L * dAzRad;
        const worstMm = Math.max(alongShiftM, lateralShiftM) * 1000;
        push(shadowDisplacementMm[h], worstMm);
      }
    }
  }
}

console.log(`\nBench: SunCalc tile-center vs per-point precision`);
console.log(`Tile: Lausanne-ish, E=${TILE_MIN_E}, N=${TILE_MIN_N}, size=${TILE_SIZE_M}m`);
console.log(`Grid: ${GRID_N}×${GRID_N} = ${GRID_N * GRID_N} points/frame`);
console.log(`Frames above horizon: ${framesAboveHorizon} (21 juin 2026, 05:00→21:00 UTC+2, step 30min)`);
console.log(``);

const az = summarize(azDeltaDeg);
const alt = summarize(altDeltaDeg);
console.log(`Azimuth delta (deg):   mean=${az.mean.toExponential(2)}  p50=${az.p50.toExponential(2)}  p99=${az.p99.toExponential(2)}  max=${az.max.toExponential(2)}`);
console.log(`Azimuth delta (arcsec): mean=${(az.mean * 3600).toFixed(2)}  p99=${(az.p99 * 3600).toFixed(2)}  max=${(az.max * 3600).toFixed(2)}`);
console.log(``);
console.log(`Altitude delta (deg):  mean=${alt.mean.toExponential(2)}  p50=${alt.p50.toExponential(2)}  p99=${alt.p99.toExponential(2)}  max=${alt.max.toExponential(2)}`);
console.log(`Altitude delta (arcsec): mean=${(alt.mean * 3600).toFixed(2)}  p99=${(alt.p99 * 3600).toFixed(2)}  max=${(alt.max * 3600).toFixed(2)}`);
console.log(``);
console.log(`Shadow displacement error vs tile-center approximation:`);
console.log(`Height | mean      | p99       | max`);
for (const h of BUILDING_HEIGHTS_M) {
  const s = summarize(shadowDisplacementMm[h]);
  console.log(`  ${h.toString().padStart(3)}m | ${s.mean.toFixed(2).padStart(6)} mm | ${s.p99.toFixed(2).padStart(6)} mm | ${s.max.toFixed(2).padStart(6)} mm`);
}
console.log(``);
console.log(`Note: our grid pitch is 1m, so any error < 500mm is sub-pixel.`);
