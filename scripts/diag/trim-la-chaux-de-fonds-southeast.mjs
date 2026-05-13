#!/usr/bin/env node
/**
 * Trim La Chaux-de-Fonds tiles southeast of the line defined by three
 * user-supplied reference tile centres. The southeast side in LV95 is
 * `N < slope * E + intercept` (lower northing for a given easting).
 *
 *   Reference tiles:
 *     C  e2553000_n1215000_s250  → centre (2553125, 1215125)
 *     A  e2554500_n1215750_s250  → centre (2554625, 1215875)
 *     B  e2555750_n1218000_s250  → centre (2555875, 1218125)
 *
 *   Linear regression: N ≈ 1.0714 · E − 1 520 894.
 *
 * Drops every la_chaux_de_fonds tile whose centre falls south-east of
 * that line, syncs `commune-la-chaux-de-fonds-land-tiles.json`, and
 * regenerates the embedded HTML map. No ingest re-run needed — we only
 * remove tiles, the buildings/terrain/VHM envelope is unchanged.
 *
 *   pnpm tsx scripts/diag/trim-la-chaux-de-fonds-southeast.mjs           # dry-run
 *   pnpm tsx scripts/diag/trim-la-chaux-de-fonds-southeast.mjs --apply   # mutate files
 */

import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");

const TOP = path.resolve("data/processed/precompute/high-value-tile-selection.top-priority.json");
const COMMUNE = path.resolve("data/processed/precompute/commune-la-chaux-de-fonds-land-tiles.json");

const REF = [
  { id: "e2553000_n1215000_s250", e: 2553125, n: 1215125 },
  { id: "e2554500_n1215750_s250", e: 2554625, n: 1215875 },
  { id: "e2555750_n1218000_s250", e: 2555875, n: 1218125 },
];

function leastSquaresLine(points) {
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.e, 0) / n;
  const meanY = points.reduce((s, p) => s + p.n, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    const dx = p.e - meanX;
    const dy = p.n - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  return { slope, intercept };
}

function parseTileId(id) {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id);
  if (!m) throw new Error(`bad tile id: ${id}`);
  const e = Number(m[1]);
  const n = Number(m[2]);
  const s = Number(m[3]);
  return { e, n, s, centerE: e + s / 2, centerN: n + s / 2 };
}

const { slope, intercept } = leastSquaresLine(REF);
console.log(`Line: N = ${slope.toFixed(4)} · E + (${intercept.toFixed(0)})`);

// Sanity check: each reference tile centre should fall on (or very near) the line.
for (const r of REF) {
  const lineN = slope * r.e + intercept;
  console.log(`  ref ${r.id}: centre N=${r.n}, line N=${lineN.toFixed(0)}, delta=${(r.n - lineN).toFixed(0)}`);
}

function isSoutheast(tile) {
  const lineN = slope * tile.centerE + intercept;
  return tile.centerN < lineN;
}

// ── Read JSON and partition ──────────────────────────────────────────────
const top = JSON.parse(fs.readFileSync(TOP, "utf8"));
const lcdfTiles = top.tiles.filter((t) => t.region === "la_chaux_de_fonds");
const decoded = lcdfTiles.map((t) => ({ ...t, ...parseTileId(t.tileId) }));
const toDrop = decoded.filter(isSoutheast);
const toKeep = decoded.filter((t) => !isSoutheast(t));

console.log(`\nLCDF before: ${lcdfTiles.length}`);
console.log(`  drop (southeast of line): ${toDrop.length}`);
console.log(`  keep:                     ${toKeep.length}`);

// Sample the first few drops + keeps near the boundary so we can sanity check.
const byProximity = (t) => Math.abs(t.centerN - (slope * t.centerE + intercept));
const dropsBorder = [...toDrop].sort((a, b) => byProximity(a) - byProximity(b)).slice(0, 3);
const keepsBorder = [...toKeep].sort((a, b) => byProximity(a) - byProximity(b)).slice(0, 3);
console.log(`\nDrops nearest to the line:`);
for (const t of dropsBorder) console.log(`  ${t.tileId}  N=${t.centerN}  line=${(slope * t.centerE + intercept).toFixed(0)}`);
console.log(`Keeps nearest to the line:`);
for (const t of keepsBorder) console.log(`  ${t.tileId}  N=${t.centerN}  line=${(slope * t.centerE + intercept).toFixed(0)}`);

if (!apply) {
  console.log(`\n(dry-run — pass --apply to mutate files)`);
  process.exit(0);
}

// ── Mutate the top-priority JSON ─────────────────────────────────────────
const dropIds = new Set(toDrop.map((t) => t.tileId));
const before = top.tiles.length;
top.tiles = top.tiles.filter((t) => t.region !== "la_chaux_de_fonds" || !dropIds.has(t.tileId));
top.generatedAt = new Date().toISOString();
top.source += ` — la_chaux_de_fonds: dropped ${toDrop.length} tiles southeast of giratoire Bas du Reymond line (2026-05-13)`;
fs.writeFileSync(TOP, JSON.stringify(top, null, 2));
console.log(`\ntop-priority: ${before} → ${top.tiles.length}`);

// ── Sync the commune file ────────────────────────────────────────────────
if (fs.existsSync(COMMUNE)) {
  const c = JSON.parse(fs.readFileSync(COMMUNE, "utf8"));
  const filterTile = (entry) => {
    const tileId = entry.tileId ?? entry;
    return !dropIds.has(tileId);
  };
  if (Array.isArray(c.tiles)) {
    const cBefore = c.tiles.length;
    c.tiles = c.tiles.filter(filterTile);
    if (c.generatedAt !== undefined) c.generatedAt = top.generatedAt;
    fs.writeFileSync(COMMUNE, JSON.stringify(c, null, 2));
    console.log(`commune-la-chaux-de-fonds: ${cBefore} → ${c.tiles.length}`);
  } else if (Array.isArray(c)) {
    const cBefore = c.length;
    const next = c.filter(filterTile);
    fs.writeFileSync(COMMUNE, JSON.stringify(next, null, 2));
    console.log(`commune-la-chaux-de-fonds: ${cBefore} → ${next.length}`);
  }
}

console.log(`\nNext step: \`node scripts/tools/embed-tile-selection-in-map.mjs\` to refresh the HTML.`);
