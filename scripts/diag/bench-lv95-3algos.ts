/**
 * Benchmark proj4 vs Fast (polynomial) vs Precise (rigorous) LV95 → WGS84.
 *
 * Usage: npx tsx scripts/diag/bench-lv95-3algos.ts --region=lausanne
 */
import {
  lv95ToWgs84,
  lv95ToWgs84Fast,
  lv95ToWgs84Precise,
} from "../../src/lib/geo/projection";
import { buildRegionTiles } from "../../src/lib/precompute/sunlight-cache";

const ARGS = process.argv.slice(2);
const region = (ARGS.find((a) => a.startsWith("--region="))?.slice(9) ?? "lausanne") as
  | "lausanne"
  | "nyon"
  | "morges"
  | "geneve";
const gridStepMeters = Number(ARGS.find((a) => a.startsWith("--grid-step="))?.slice(12) ?? "1");
const tileSizeMeters = Number(ARGS.find((a) => a.startsWith("--tile-size="))?.slice(12) ?? "250");

const METERS_PER_DEG_LAT = 111139;
const METERS_PER_DEG_LON = 76225;

const HIST_MAX_MM = 5000;
class StreamStats {
  count = 0;
  sum = 0;
  max = 0;
  hist = new Uint32Array(HIST_MAX_MM + 1);
  overflow = 0;
  add(dm: number) {
    this.count++;
    this.sum += dm;
    if (dm > this.max) this.max = dm;
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

  // First: sanity on the Bern fundamental point
  const bernCheck = lv95ToWgs84Precise(2600000, 1200000);
  const bernRef = lv95ToWgs84(2600000, 1200000);
  console.log(`\nSanity at Bern origin:`);
  console.log(`  proj4:   lat=${bernRef.lat.toFixed(9)}, lon=${bernRef.lon.toFixed(9)}`);
  console.log(`  precise: lat=${bernCheck.lat.toFixed(9)}, lon=${bernCheck.lon.toFixed(9)}`);
  const dLatBern = Math.abs(bernRef.lat - bernCheck.lat) * METERS_PER_DEG_LAT;
  const dLonBern = Math.abs(bernRef.lon - bernCheck.lon) * METERS_PER_DEG_LON;
  console.log(`  delta:   ${Math.hypot(dLatBern, dLonBern).toFixed(4)} m`);

  // Precision distributions
  const preciseVsProj4 = new StreamStats();
  const fastVsProj4 = new StreamStats();
  const preciseVsFast = new StreamStats();
  let totalPoints = 0;

  for (const tile of tiles) {
    const startIx = Math.floor(tile.minEasting / gridStepMeters);
    const endIx = Math.ceil(tile.maxEasting / gridStepMeters);
    const startIy = Math.floor(tile.minNorthing / gridStepMeters);
    const endIy = Math.ceil(tile.maxNorthing / gridStepMeters);
    for (let iy = startIy; iy < endIy; iy++) {
      for (let ix = startIx; ix < endIx; ix++) {
        const e = ix * gridStepMeters + gridStepMeters / 2;
        const n = iy * gridStepMeters + gridStepMeters / 2;
        if (e < tile.minEasting || e >= tile.maxEasting || n < tile.minNorthing || n >= tile.maxNorthing) continue;
        const ref = lv95ToWgs84(e, n);
        const pre = lv95ToWgs84Precise(e, n);
        const fst = lv95ToWgs84Fast(e, n);
        preciseVsProj4.add(Math.hypot((ref.lat - pre.lat) * METERS_PER_DEG_LAT, (ref.lon - pre.lon) * METERS_PER_DEG_LON));
        fastVsProj4.add(Math.hypot((ref.lat - fst.lat) * METERS_PER_DEG_LAT, (ref.lon - fst.lon) * METERS_PER_DEG_LON));
        preciseVsFast.add(Math.hypot((pre.lat - fst.lat) * METERS_PER_DEG_LAT, (pre.lon - fst.lon) * METERS_PER_DEG_LON));
        totalPoints++;
      }
    }
  }

  const fmt = (s: StreamStats, label: string) => {
    console.log(`\n${label}:`);
    console.log(`  mean ${s.mean().toFixed(4)} m`);
    console.log(`  p50  ${s.quantile(0.5).toFixed(4)} m`);
    console.log(`  p99  ${s.quantile(0.99).toFixed(4)} m`);
    console.log(`  max  ${s.max.toFixed(4)} m`);
    if (s.overflow > 0) console.log(`  overflow >5m: ${s.overflow.toLocaleString()}`);
  };

  console.log(`\nTotal points: ${totalPoints.toLocaleString()}`);
  fmt(preciseVsProj4, "Precise vs proj4");
  fmt(fastVsProj4, "Fast vs proj4");
  fmt(preciseVsFast, "Precise vs Fast");

  // Pure-speed benches (each algo in isolation)
  const bench = (fn: (e: number, n: number) => { lat: number; lon: number }, label: string) => {
    let sum = 0;
    const t0 = performance.now();
    for (const tile of tiles) {
      const startIx = Math.floor(tile.minEasting / gridStepMeters);
      const endIx = Math.ceil(tile.maxEasting / gridStepMeters);
      const startIy = Math.floor(tile.minNorthing / gridStepMeters);
      const endIy = Math.ceil(tile.maxNorthing / gridStepMeters);
      for (let iy = startIy; iy < endIy; iy++) {
        for (let ix = startIx; ix < endIx; ix++) {
          const e = ix * gridStepMeters + gridStepMeters / 2;
          const n = iy * gridStepMeters + gridStepMeters / 2;
          if (e < tile.minEasting || e >= tile.maxEasting || n < tile.minNorthing || n >= tile.maxNorthing) continue;
          const w = fn(e, n);
          sum += w.lat;
        }
      }
    }
    const dt = performance.now() - t0;
    console.log(`  ${label.padEnd(22)} ${dt.toFixed(0).padStart(7)} ms   ${((totalPoints / dt) * 1000).toFixed(0).padStart(10)} pts/s`);
    if (Number.isNaN(sum)) console.log("?");
    return dt;
  };
  console.log(`\n--- Runtime ---`);
  const tProj = bench(lv95ToWgs84, "proj4");
  const tPre = bench(lv95ToWgs84Precise, "Precise (rigorous)");
  const tFast = bench(lv95ToWgs84Fast, "Fast (polynomial)");
  console.log(`\n  speedup Precise / proj4: ${(tProj / tPre).toFixed(1)}x`);
  console.log(`  speedup Fast    / proj4: ${(tProj / tFast).toFixed(1)}x`);
  console.log(`  speedup Fast    / Precise: ${(tPre / tFast).toFixed(1)}x`);
}

main();
