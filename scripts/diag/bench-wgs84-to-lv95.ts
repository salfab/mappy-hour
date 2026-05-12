/**
 * Benchmark proj4 vs Precise (rigorous) WGS84 → LV95.
 *
 * Symmetric to bench-lv95-3algos.ts but for the inverse direction. Validates
 * the new wgs84ToLv95Precise function against proj4 on the precompute grid
 * for a region.
 *
 * Usage: npx tsx scripts/diag/bench-wgs84-to-lv95.ts --region=geneve
 */
import {
  wgs84ToLv95,
  wgs84ToLv95Precise,
  lv95ToWgs84,
} from "../../src/lib/geo/projection";
import { buildRegionTiles } from "../../src/lib/precompute/sunlight-cache";

const ARGS = process.argv.slice(2);
const region = (ARGS.find((a) => a.startsWith("--region="))?.slice(9) ?? "geneve") as
  | "lausanne"
  | "nyon"
  | "morges"
  | "geneve"
  | "vevey"
  | "vevey_city"
  | "neuchatel"
  | "la_chaux_de_fonds";
const gridStepMeters = Number(ARGS.find((a) => a.startsWith("--grid-step="))?.slice(12) ?? "1");
const tileSizeMeters = Number(ARGS.find((a) => a.startsWith("--tile-size="))?.slice(12) ?? "250");

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

  // Sanity at Bern fundamental point: WGS84 of Bern back to LV95 should match (2600000, 1200000)
  const bernWgs = lv95ToWgs84(2600000, 1200000);
  const bernRef = wgs84ToLv95(bernWgs.lon, bernWgs.lat);
  const bernCheck = wgs84ToLv95Precise(bernWgs.lon, bernWgs.lat);
  console.log(`\nSanity at Bern origin (round-trip):`);
  console.log(`  proj4:   E=${bernRef.easting.toFixed(6)}, N=${bernRef.northing.toFixed(6)}`);
  console.log(`  precise: E=${bernCheck.easting.toFixed(6)}, N=${bernCheck.northing.toFixed(6)}`);
  console.log(
    `  delta proj4 vs ideal:   ${Math.hypot(bernRef.easting - 2600000, bernRef.northing - 1200000).toFixed(6)} m`,
  );
  console.log(
    `  delta precise vs ideal: ${Math.hypot(bernCheck.easting - 2600000, bernCheck.northing - 1200000).toFixed(6)} m`,
  );

  // Precision distributions: feed (lat, lon) computed from LV95 grid via proj4
  // (so we cover exactly the precompute domain).
  const preciseVsProj4 = new StreamStats();
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
        const wgs = lv95ToWgs84(e, n);
        const ref = wgs84ToLv95(wgs.lon, wgs.lat);
        const pre = wgs84ToLv95Precise(wgs.lon, wgs.lat);
        preciseVsProj4.add(Math.hypot(ref.easting - pre.easting, ref.northing - pre.northing));
        totalPoints++;
      }
    }
  }

  const fmt = (s: StreamStats, label: string) => {
    console.log(`\n${label}:`);
    console.log(`  mean ${s.mean().toFixed(6)} m`);
    console.log(`  p50  ${s.quantile(0.5).toFixed(6)} m`);
    console.log(`  p99  ${s.quantile(0.99).toFixed(6)} m`);
    console.log(`  max  ${s.max.toFixed(6)} m`);
    if (s.overflow > 0) console.log(`  overflow >5m: ${s.overflow.toLocaleString()}`);
  };

  console.log(`\nTotal points: ${totalPoints.toLocaleString()}`);
  fmt(preciseVsProj4, "Precise vs proj4 (WGS84 → LV95)");

  // Round-trip: LV95 → WGS84 → LV95 should match input within sub-mm.
  const roundTripPrecise = new StreamStats();
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
        const wgs = lv95ToWgs84(e, n);
        const back = wgs84ToLv95Precise(wgs.lon, wgs.lat);
        roundTripPrecise.add(Math.hypot(back.easting - e, back.northing - n));
      }
    }
  }
  fmt(roundTripPrecise, "Round-trip: proj4 forward + Precise inverse vs identity");

  // Speed bench
  // Pre-collect WGS84 points to bench inverse alone (avoid mixing forward time)
  const points: { lat: number; lon: number }[] = [];
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
        points.push(lv95ToWgs84(e, n));
      }
    }
  }

  const bench = (
    fn: (lon: number, lat: number) => { easting: number; northing: number },
    label: string,
  ) => {
    let sum = 0;
    const t0 = performance.now();
    for (const p of points) {
      const r = fn(p.lon, p.lat);
      sum += r.easting;
    }
    const dt = performance.now() - t0;
    console.log(
      `  ${label.padEnd(22)} ${dt.toFixed(0).padStart(7)} ms   ${((points.length / dt) * 1000).toFixed(0).padStart(10)} pts/s`,
    );
    if (Number.isNaN(sum)) console.log("?");
    return dt;
  };
  console.log(`\n--- Runtime (${points.length.toLocaleString()} pts) ---`);
  const tProj = bench(wgs84ToLv95, "proj4");
  const tPre = bench(wgs84ToLv95Precise, "Precise (rigorous)");
  console.log(`\n  speedup Precise / proj4: ${(tProj / tPre).toFixed(1)}x`);
}

main();
