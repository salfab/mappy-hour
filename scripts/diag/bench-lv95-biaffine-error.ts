/**
 * Quantify the error of a biaffine LV95→WebMercator mapping vs the
 * point-for-point polynomial projection (`lv95ToWgs84Fast`).
 *
 * Context: Leaflet's ImageOverlay projects the 4 corners of a bbox and
 * stretches the bitmap linearly (biaffine) between them. If this stretch
 * is close enough to the true LV95→WGS84 projection, pre-rendering a
 * LV95 bitmap and plaquing it via ImageOverlay is a viable replacement
 * for expensive vector rendering when zoomed out.
 *
 * We sample a N×N grid inside each bbox, compute the "true" WGS84 position
 * via the polynomial formula, compare with the biaffine-interpolated
 * position from the 4 corners, and report the max error in meters and
 * pixels at several OSM zoom levels.
 *
 * Usage: npx tsx scripts/diag/bench-lv95-biaffine-error.ts
 */
import { lv95ToWgs84Fast } from "../../src/lib/geo/projection";

// Test bboxes centered roughly on Lausanne (46.52°N, 6.63°E).
// We pick sizes from one atlas tile up to the Swiss extent.
const CENTER_E = 2538000; // LV95 easting
const CENTER_N = 1152000; // LV95 northing

const BBOX_SIZES_M = [250, 1_000, 10_000, 50_000, 200_000];

const ZOOMS = [8, 10, 12, 14, 16];

// OSM / WebMercator pixel size at zoom Z at the equator (tile size = 256px).
// Earth circumference at equator ~ 40 075 017 m.
const EARTH_CIRC_M = 40_075_017;
function metersPerPixel(zoom: number, latDeg: number): number {
  const latRad = (latDeg * Math.PI) / 180;
  return (EARTH_CIRC_M * Math.cos(latRad)) / (256 * Math.pow(2, zoom));
}

// Flat-earth distance between two WGS84 points (good enough for small deltas).
function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

interface Wgs84 {
  lon: number;
  lat: number;
}

/** Biaffine interpolation: given the 4 corners of the bbox in WGS84, return
 *  the WGS84 position of an interior point at normalized coords (u, v) ∈ [0,1].
 *  This is exactly what Leaflet ImageOverlay does under the hood (modulo the
 *  mercator Y stretch, which we approximate as linear over a small bbox). */
function biaffine(
  nw: Wgs84,
  ne: Wgs84,
  sw: Wgs84,
  se: Wgs84,
  u: number,
  v: number,
): Wgs84 {
  // u grows west→east, v grows south→north
  const top = { lon: nw.lon + u * (ne.lon - nw.lon), lat: nw.lat + u * (ne.lat - nw.lat) };
  const bot = { lon: sw.lon + u * (se.lon - sw.lon), lat: sw.lat + u * (se.lat - sw.lat) };
  return {
    lon: bot.lon + v * (top.lon - bot.lon),
    lat: bot.lat + v * (top.lat - bot.lat),
  };
}

function benchBbox(sizeMeters: number): {
  sizeMeters: number;
  maxErrM: number;
  meanErrM: number;
  maxAtLat: number;
} {
  const half = sizeMeters / 2;
  const minE = CENTER_E - half;
  const maxE = CENTER_E + half;
  const minN = CENTER_N - half;
  const maxN = CENTER_N + half;

  // 4 corners: NW (minE, maxN), NE (maxE, maxN), SW (minE, minN), SE (maxE, minN)
  const nw = lv95ToWgs84Fast(minE, maxN);
  const ne = lv95ToWgs84Fast(maxE, maxN);
  const sw = lv95ToWgs84Fast(minE, minN);
  const se = lv95ToWgs84Fast(maxE, minN);

  const N_SAMPLES = 64;
  let maxErr = 0;
  let sumErr = 0;
  let count = 0;
  let maxAtLat = 0;

  for (let i = 0; i <= N_SAMPLES; i++) {
    const u = i / N_SAMPLES;
    for (let j = 0; j <= N_SAMPLES; j++) {
      const v = j / N_SAMPLES;
      const easting = minE + u * (maxE - minE);
      const northing = minN + v * (maxN - minN);

      const truth = lv95ToWgs84Fast(easting, northing);
      const approx = biaffine(nw, ne, sw, se, u, v);
      const errM = haversineMeters(truth.lon, truth.lat, approx.lon, approx.lat);
      sumErr += errM;
      count += 1;
      if (errM > maxErr) {
        maxErr = errM;
        maxAtLat = truth.lat;
      }
    }
  }
  return { sizeMeters, maxErrM: maxErr, meanErrM: sumErr / count, maxAtLat };
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits).padStart(8, " ");
}

function main() {
  console.log(`[bench] LV95→WGS84 biaffine (4-corner stretch) vs polynomial point-for-point`);
  console.log(`[bench] Center: LV95 (${CENTER_E}, ${CENTER_N}) ≈ WGS84 ${(() => {
    const p = lv95ToWgs84Fast(CENTER_E, CENTER_N);
    return `(${p.lon.toFixed(4)}°E, ${p.lat.toFixed(4)}°N)`;
  })()}`);
  console.log();

  console.log(`  bbox size │ max err │ mean err │  error in pixels at OSM zoom`);
  console.log(`    (m)     │   (m)   │   (m)    │ ${ZOOMS.map((z) => `z${z}`.padStart(7, " ")).join("  ")}`);
  console.log(`──────────────┼─────────┼──────────┼${ZOOMS.map(() => "─────────").join("┼")}`);

  for (const size of BBOX_SIZES_M) {
    const r = benchBbox(size);
    const pxAtZoom = ZOOMS.map((z) => {
      const mpp = metersPerPixel(z, r.maxAtLat);
      return r.maxErrM / mpp;
    });
    const pxCols = pxAtZoom.map((p) => `${fmt(p, 3)}`).join("  ");
    console.log(
      `  ${size.toString().padStart(9, " ")} │ ${fmt(r.maxErrM)} │ ${fmt(r.meanErrM)} │ ${pxCols}`,
    );
  }

  console.log();
  console.log(`Interpretation:`);
  console.log(`- ≤1 px at the target zoom → biaffine overlay is visually indistinguishable.`);
  console.log(`- 1–3 px → acceptable for most overlays; may be visible on edges.`);
  console.log(`- >3 px → visible misalignment; WebGL fragment warp required.`);
}

main();
