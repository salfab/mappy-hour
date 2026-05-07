/**
 * Validate lv95ToWgs84Fast (Swisstopo polynomial) against proj4 on the
 * complete precompute grid for a region.
 *
 * Measures:
 * - raw delta on lat/lon (degrees, then converted to meters at CH latitude)
 * - divergence after rounding to 6 decimals (what we actually store)
 * - distribution: max, p99, p90, p50
 * - also: runtime ratio fast/proj4
 *
 * Usage: npx tsx scripts/diag/validate-lv95-fast-vs-proj4.ts --region=lausanne [--grid-step=1]
 */
import { lv95ToWgs84, lv95ToWgs84Fast } from "../../src/lib/geo/projection";
import { buildRegionTiles } from "../../src/lib/precompute/sunlight-cache";

const ARGS = process.argv.slice(2);
const region = (ARGS.find((a) => a.startsWith("--region="))?.slice(9) ?? "lausanne") as
  | "lausanne"
  | "nyon"
  | "morges"
  | "geneve";
const gridStepMeters = Number(
  ARGS.find((a) => a.startsWith("--grid-step="))?.slice(12) ?? "1",
);
const tileSizeMeters = Number(
  ARGS.find((a) => a.startsWith("--tile-size="))?.slice(12) ?? "250",
);

// Meters per degree at CH latitude (~46.8°N):
//   1° lat  ≈ 111139 m
//   1° lon  ≈ 111320 * cos(46.8°) ≈ 76225 m
const METERS_PER_DEG_LAT = 111139;
const METERS_PER_DEG_LON = 76225;
const ROUND_DECIMALS = 1_000_000;

function round6(x: number): number {
  return Math.round(x * ROUND_DECIMALS) / ROUND_DECIMALS;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] * (1 - (pos - lo)) + sorted[hi] * (pos - lo);
}

// Histogram-based stats: buckets in millimeters from 0 to HIST_MAX_MM.
// Any delta >= HIST_MAX_MM falls in the overflow bucket (still counted for max).
const HIST_MAX_MM = 5000; // 5m — covers any plausible polynomial error

class StreamStats {
  count = 0;
  sum = 0;
  max = 0;
  maxE = 0;
  maxN = 0;
  hist = new Uint32Array(HIST_MAX_MM + 1);
  overflow = 0;

  add(dm: number, e: number, n: number): void {
    this.count++;
    this.sum += dm;
    if (dm > this.max) {
      this.max = dm;
      this.maxE = e;
      this.maxN = n;
    }
    const mm = Math.round(dm * 1000);
    if (mm <= HIST_MAX_MM) this.hist[mm]++;
    else this.overflow++;
  }

  quantile(q: number): number {
    if (this.count === 0) return 0;
    const target = q * this.count;
    let acc = 0;
    for (let i = 0; i <= HIST_MAX_MM; i++) {
      acc += this.hist[i];
      if (acc >= target) return i / 1000;
    }
    return this.max;
  }

  mean(): number {
    return this.count === 0 ? 0 : this.sum / this.count;
  }
}

function main() {
  const tiles = buildRegionTiles(region, tileSizeMeters);
  console.log(`Region: ${region}, tiles: ${tiles.length}, grid step: ${gridStepMeters}m`);

  const raw = new StreamStats();
  const rounded = new StreamStats();
  let pointsDifferingAfterRound = 0;
  let totalPoints = 0;

  const tFast0 = performance.now();
  let fastSum = 0;
  let proj4Sum = 0;
  const tProj0 = performance.now();

  for (const tile of tiles) {
    const startIx = Math.floor(tile.minEasting / gridStepMeters);
    const endIxExclusive = Math.ceil(tile.maxEasting / gridStepMeters);
    const startIy = Math.floor(tile.minNorthing / gridStepMeters);
    const endIyExclusive = Math.ceil(tile.maxNorthing / gridStepMeters);

    for (let iy = startIy; iy < endIyExclusive; iy++) {
      for (let ix = startIx; ix < endIxExclusive; ix++) {
        const easting = ix * gridStepMeters + gridStepMeters / 2;
        const northing = iy * gridStepMeters + gridStepMeters / 2;
        if (
          easting < tile.minEasting ||
          easting >= tile.maxEasting ||
          northing < tile.minNorthing ||
          northing >= tile.maxNorthing
        ) {
          continue;
        }

        const ref = lv95ToWgs84(easting, northing);
        const fast = lv95ToWgs84Fast(easting, northing);
        proj4Sum += ref.lat;
        fastSum += fast.lat;

        const dLatM = Math.abs(ref.lat - fast.lat) * METERS_PER_DEG_LAT;
        const dLonM = Math.abs(ref.lon - fast.lon) * METERS_PER_DEG_LON;
        const dm = Math.hypot(dLatM, dLonM);
        raw.add(dm, easting, northing);

        const refR = { lon: round6(ref.lon), lat: round6(ref.lat) };
        const fastR = { lon: round6(fast.lon), lat: round6(fast.lat) };
        if (refR.lon !== fastR.lon || refR.lat !== fastR.lat) {
          const afterDm = Math.hypot(
            Math.abs(refR.lat - fastR.lat) * METERS_PER_DEG_LAT,
            Math.abs(refR.lon - fastR.lon) * METERS_PER_DEG_LON,
          );
          rounded.add(afterDm, easting, northing);
          pointsDifferingAfterRound++;
        }
        totalPoints++;
      }
    }
  }

  const tAll = performance.now() - tProj0;

  // Separate timing run (fast-only)
  const tPure0 = performance.now();
  let pureSum = 0;
  for (const tile of tiles) {
    const startIx = Math.floor(tile.minEasting / gridStepMeters);
    const endIxExclusive = Math.ceil(tile.maxEasting / gridStepMeters);
    const startIy = Math.floor(tile.minNorthing / gridStepMeters);
    const endIyExclusive = Math.ceil(tile.maxNorthing / gridStepMeters);
    for (let iy = startIy; iy < endIyExclusive; iy++) {
      for (let ix = startIx; ix < endIxExclusive; ix++) {
        const easting = ix * gridStepMeters + gridStepMeters / 2;
        const northing = iy * gridStepMeters + gridStepMeters / 2;
        if (
          easting < tile.minEasting ||
          easting >= tile.maxEasting ||
          northing < tile.minNorthing ||
          northing >= tile.maxNorthing
        ) continue;
        const w = lv95ToWgs84Fast(easting, northing);
        pureSum += w.lat;
      }
    }
  }
  const tPureFast = performance.now() - tPure0;

  const tPP0 = performance.now();
  let ppSum = 0;
  for (const tile of tiles) {
    const startIx = Math.floor(tile.minEasting / gridStepMeters);
    const endIxExclusive = Math.ceil(tile.maxEasting / gridStepMeters);
    const startIy = Math.floor(tile.minNorthing / gridStepMeters);
    const endIyExclusive = Math.ceil(tile.maxNorthing / gridStepMeters);
    for (let iy = startIy; iy < endIyExclusive; iy++) {
      for (let ix = startIx; ix < endIxExclusive; ix++) {
        const easting = ix * gridStepMeters + gridStepMeters / 2;
        const northing = iy * gridStepMeters + gridStepMeters / 2;
        if (
          easting < tile.minEasting ||
          easting >= tile.maxEasting ||
          northing < tile.minNorthing ||
          northing >= tile.maxNorthing
        ) continue;
        const w = lv95ToWgs84(easting, northing);
        ppSum += w.lat;
      }
    }
  }
  const tPureProj4 = performance.now() - tPP0;

  console.log(`\nTotal points sampled: ${totalPoints.toLocaleString()}`);
  console.log(`\n--- Raw delta (pre-rounding) ---`);
  console.log(`  mean:      ${raw.mean().toFixed(3)} m`);
  console.log(`  p50:       ${raw.quantile(0.5).toFixed(3)} m`);
  console.log(`  p90:       ${raw.quantile(0.9).toFixed(3)} m`);
  console.log(`  p99:       ${raw.quantile(0.99).toFixed(3)} m`);
  console.log(`  p99.9:     ${raw.quantile(0.999).toFixed(3)} m`);
  console.log(`  max:       ${raw.max.toFixed(3)} m  at E=${raw.maxE} N=${raw.maxN}`);
  if (raw.overflow > 0) console.log(`  (overflow >5m: ${raw.overflow.toLocaleString()})`);

  console.log(`\n--- After rounding to 6 decimals (what we store) ---`);
  const rate = pointsDifferingAfterRound / totalPoints;
  console.log(
    `  points differing: ${pointsDifferingAfterRound.toLocaleString()} / ${totalPoints.toLocaleString()} (${(rate * 100).toFixed(2)}%)`,
  );
  if (rounded.count > 0) {
    console.log(`  max post-round delta: ${rounded.max.toFixed(3)} m`);
  }

  console.log(`\n--- Runtime ---`);
  console.log(`  lv95ToWgs84     (proj4): ${tPureProj4.toFixed(0)} ms  (${(totalPoints / tPureProj4 * 1000).toFixed(0)} pts/s)`);
  console.log(`  lv95ToWgs84Fast (poly):  ${tPureFast.toFixed(0)} ms  (${(totalPoints / tPureFast * 1000).toFixed(0)} pts/s)`);
  console.log(`  speedup: ${(tPureProj4 / tPureFast).toFixed(1)}x`);

  // Sanity: prevent dead code elimination
  if (Number.isNaN(fastSum + proj4Sum + pureSum + ppSum + tAll)) console.log("?");
}

main();
