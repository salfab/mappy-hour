// Analyse + trim of neuchatel tile selection.
// Drops Chaumont forest tiles (north of urban band) while keeping all lakeside villages.
//
// Usage:
//   node scripts/diag/trim-neuchatel-urban.mjs            # analysis only (no writes)
//   node scripts/diag/trim-neuchatel-urban.mjs --apply    # writes the trim

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const TOP_PRIORITY_PATH = path.join(
  ROOT,
  "data/processed/precompute/high-value-tile-selection.top-priority.json",
);
const COMMUNE_PATH = path.join(
  ROOT,
  "data/processed/precompute/commune-neuchatel-land-tiles.json",
);

const LAT_CAP = 47.020; // chosen from histogram: natural elbow at 47.020 where urban band tapers into Chaumont slope
const APPLY = process.argv.includes("--apply");

// --- LV95 <-> WGS84 (precise) ----------------------------------------------
// Port of wgs84ToLv95Precise / lv95ToWgs84Precise constants from src/lib/geo/projection.ts.
// Bessel ellipsoid Swiss oblique Mercator (LV95) Bern fundamental point.
function lv95ToWgs84Precise(E, N) {
  const y = (E - 2600000) / 1_000_000;
  const x = (N - 1200000) / 1_000_000;
  const lambda =
    2.6779094 +
    4.728982 * y +
    0.791484 * y * x +
    0.1306 * y * x * x -
    0.0436 * y * y * y;
  const phi =
    16.9023892 +
    3.238272 * x -
    0.270978 * y * y -
    0.002528 * x * x -
    0.0447 * y * y * x -
    0.014 * x * x * x;
  return { lon: (lambda * 100) / 36, lat: (phi * 100) / 36 };
}

// --- Tile decoding ----------------------------------------------------------
function decodeTile(tileId) {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tileId);
  if (!m) throw new Error(`bad tileId: ${tileId}`);
  const E = Number(m[1]);
  const N = Number(m[2]);
  const s = Number(m[3]);
  return { E, N, s, centerE: E + s / 2, centerN: N + s / 2 };
}

function tileCenterLatLon(tileId) {
  const { centerE, centerN } = decodeTile(tileId);
  return lv95ToWgs84Precise(centerE, centerN);
}

// --- Load data --------------------------------------------------------------
const topPriority = JSON.parse(fs.readFileSync(TOP_PRIORITY_PATH, "utf8"));
const communeTiles = JSON.parse(fs.readFileSync(COMMUNE_PATH, "utf8"));

const allTiles = topPriority.tiles ?? [];
const neuchatelTiles = allTiles.filter((t) => t.region === "neuchatel");

console.log(`Total tiles in top-priority: ${allTiles.length}`);
console.log(`neuchatel tiles: ${neuchatelTiles.length}`);
console.log(`commune-neuchatel-land-tiles count: ${communeTiles.length}`);

// --- Augment with lat/lon ---------------------------------------------------
const augmented = neuchatelTiles.map((t) => {
  const { lon, lat } = tileCenterLatLon(t.tileId);
  return { ...t, lon, lat };
});

// --- Histogram --------------------------------------------------------------
const BIN = 0.005;
const bins = new Map();
let minLat = Infinity,
  maxLat = -Infinity;
for (const t of augmented) {
  if (t.lat < minLat) minLat = t.lat;
  if (t.lat > maxLat) maxLat = t.lat;
  const k = Math.floor(t.lat / BIN) * BIN;
  bins.set(k, (bins.get(k) ?? 0) + 1);
}
const sortedBins = [...bins.entries()].sort((a, b) => a[0] - b[0]);
console.log(`\nLatitude range: ${minLat.toFixed(5)} .. ${maxLat.toFixed(5)}`);
console.log(`Histogram (bin = ${BIN}°):`);
for (const [k, c] of sortedBins) {
  const bar = "#".repeat(Math.round(c / 2));
  console.log(`  ${k.toFixed(3)} - ${(k + BIN).toFixed(3)} : ${String(c).padStart(4)} ${bar}`);
}

// --- Cumulative dropped/kept across candidate caps --------------------------
console.log(`\nCandidate latitude caps (would drop tiles with center lat > cap):`);
for (const cap of [47.010, 47.015, 47.018, 47.020, 47.022, 47.025, 47.030]) {
  const drop = augmented.filter((t) => t.lat > cap).length;
  console.log(`  cap=${cap.toFixed(3)} -> drop ${String(drop).padStart(4)} / keep ${neuchatelTiles.length - drop}`);
}

// --- Village verification ---------------------------------------------------
const VILLAGES = [
  { name: "Auvernier", lat: 46.95, lon: 6.88 },
  { name: "Serrières", lat: 46.99, lon: 6.91 },
  { name: "Central Neuchâtel", lat: 46.99, lon: 6.93 },
  { name: "La Coudre / Monruz", lat: 47.0, lon: 6.96 },
  { name: "Hauterive", lat: 47.01, lon: 6.98 },
  { name: "Saint-Blaise", lat: 47.02, lon: 7.0 },
  { name: "La Tène / Marin-Epagnier", lat: 47.01, lon: 7.04 },
];

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

console.log(`\nNearest tile to each lakeside village (using cap=${LAT_CAP}):`);
for (const v of VILLAGES) {
  let best = null;
  for (const t of augmented) {
    const d = haversineMeters(v.lat, v.lon, t.lat, t.lon);
    if (!best || d < best.d) best = { d, t };
  }
  const survives = best.t.lat <= LAT_CAP;
  console.log(
    `  ${v.name.padEnd(28)} -> ${best.t.tileId}  dist=${best.d.toFixed(0)}m  lat=${best.t.lat.toFixed(5)}  ${survives ? "KEPT" : "DROPPED !!!"}`,
  );
}

// --- Inspect what's near the cap (lat 47.018-47.025) -----------------------
console.log(`\nTiles near the cap boundary (lat 47.018 .. 47.025), sorted by lon:`);
const nearBoundary = augmented
  .filter((t) => t.lat > 47.018 && t.lat <= 47.025)
  .sort((a, b) => a.lon - b.lon);
for (const t of nearBoundary) {
  console.log(`  ${t.tileId}  lat=${t.lat.toFixed(5)}  lon=${t.lon.toFixed(5)}`);
}

// --- Compute final keep/drop set --------------------------------------------
const dropped = augmented.filter((t) => t.lat > LAT_CAP);
const kept = augmented.filter((t) => t.lat <= LAT_CAP);
console.log(`\nFinal with cap=${LAT_CAP}:`);
console.log(`  drop ${dropped.length}, keep ${kept.length}`);

if (!APPLY) {
  console.log(`\n(dry run — pass --apply to write)`);
  process.exit(0);
}

// --- Apply trim -------------------------------------------------------------
const droppedIds = new Set(dropped.map((t) => t.tileId));

const newTiles = allTiles.filter(
  (t) => !(t.region === "neuchatel" && droppedIds.has(t.tileId)),
);
topPriority.tiles = newTiles;
topPriority.generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const trimNote = ` — neuchatel: trimmed to urban + lakeside, dropped ${dropped.length} tiles on Chaumont slope above lat ${LAT_CAP}`;
if (!topPriority.source.includes("trimmed to urban")) {
  topPriority.source += trimNote;
}

fs.writeFileSync(
  TOP_PRIORITY_PATH,
  JSON.stringify(topPriority, null, 2) + "\n",
  "utf8",
);
console.log(`\nWrote ${TOP_PRIORITY_PATH}`);

// Also update commune-neuchatel-land-tiles.json (drop same ids).
const newCommune = communeTiles.filter((id) => !droppedIds.has(id));
console.log(
  `commune-neuchatel-land-tiles: ${communeTiles.length} -> ${newCommune.length} (-${communeTiles.length - newCommune.length})`,
);
fs.writeFileSync(
  COMMUNE_PATH,
  JSON.stringify(newCommune, null, 2) + "\n",
  "utf8",
);
console.log(`Wrote ${COMMUNE_PATH}`);
