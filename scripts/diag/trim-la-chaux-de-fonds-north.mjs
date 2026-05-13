#!/usr/bin/env node
/**
 * Trim La Chaux-de-Fonds tiles north of a piecewise-linear path
 * defined by five user-supplied reference tile centres. Unlike the
 * earlier SE line trim, this path is non-monotonic (it arches north
 * then descends) so a linear regression is not appropriate.
 *
 *   Reference centres (LV95, in path order, sorted by E):
 *     (2550875, 1215625)  e2550750_n1215500
 *     (2552125, 1217375)  e2552000_n1217250
 *     (2553125, 1218375)  e2553000_n1218250
 *     (2554125, 1218875)  e2554000_n1218750
 *     (2555625, 1217625)  e2555500_n1217500
 *
 * For each LCDF tile, compute its centre (E_c, N_c). If E_c falls
 * within the path's E range, interpolate the path's N at E_c
 * (piecewise-linear across adjacent path segments) and drop the tile
 * if N_c > path_N. Tiles outside the path's E range are left alone
 * (a previous SE trim already covers the band south of LCDF, and
 * other tiles on the west/east margins aren't intended to be cut).
 *
 *   pnpm tsx scripts/diag/trim-la-chaux-de-fonds-north.mjs            # dry-run
 *   pnpm tsx scripts/diag/trim-la-chaux-de-fonds-north.mjs --apply    # mutate files
 */

import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");

const TOP = path.resolve("data/processed/precompute/high-value-tile-selection.top-priority.json");
const COMMUNE = path.resolve("data/processed/precompute/commune-la-chaux-de-fonds-land-tiles.json");

// User-supplied path, ordered by E (W → E).
const PATH = [
  { e: 2550875, n: 1215625 },
  { e: 2552125, n: 1217375 },
  { e: 2553125, n: 1218375 },
  { e: 2554125, n: 1218875 },
  { e: 2555625, n: 1217625 },
];

function pathNAt(e) {
  // Outside the path's E range → return null (caller leaves the tile alone).
  if (e < PATH[0].e || e > PATH[PATH.length - 1].e) return null;
  for (let i = 0; i < PATH.length - 1; i++) {
    const a = PATH[i];
    const b = PATH[i + 1];
    if (e >= a.e && e <= b.e) {
      const t = (e - a.e) / (b.e - a.e);
      return a.n + t * (b.n - a.n);
    }
  }
  return null;
}

function parseTileId(id) {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id);
  if (!m) throw new Error(`bad tile id: ${id}`);
  const e = Number(m[1]);
  const n = Number(m[2]);
  const s = Number(m[3]);
  return { tileId: id, centerE: e + s / 2, centerN: n + s / 2 };
}

console.log(`Path (W → E, N samples):`);
for (const p of PATH) console.log(`  (${p.e}, ${p.n})`);

const top = JSON.parse(fs.readFileSync(TOP, "utf8"));
const lcdfTiles = top.tiles.filter((t) => t.region === "la_chaux_de_fonds");
const decoded = lcdfTiles.map((t) => ({ ...t, ...parseTileId(t.tileId) }));

const toDrop = [];
const toKeep = [];
const outOfRange = [];
for (const t of decoded) {
  const pn = pathNAt(t.centerE);
  if (pn === null) {
    outOfRange.push(t);
    toKeep.push(t);
    continue;
  }
  if (t.centerN > pn) toDrop.push({ ...t, pathN: pn });
  else toKeep.push(t);
}

console.log(`\nLCDF before: ${lcdfTiles.length}`);
console.log(`  drop (north of path):    ${toDrop.length}`);
console.log(`  keep (south of path):    ${toKeep.length - outOfRange.length}`);
console.log(`  keep (outside E range):  ${outOfRange.length}`);

const byProximity = (t) => Math.abs(t.centerN - t.pathN);
const dropsBorder = [...toDrop].sort((a, b) => byProximity(a) - byProximity(b)).slice(0, 5);
console.log(`\nDrops nearest to the path:`);
for (const t of dropsBorder) console.log(`  ${t.tileId}  N=${t.centerN}  path=${t.pathN.toFixed(0)}  delta=+${(t.centerN - t.pathN).toFixed(0)}`);

if (!apply) {
  console.log(`\n(dry-run — pass --apply to mutate files)`);
  process.exit(0);
}

const dropIds = new Set(toDrop.map((t) => t.tileId));
const before = top.tiles.length;
top.tiles = top.tiles.filter((t) => t.region !== "la_chaux_de_fonds" || !dropIds.has(t.tileId));
top.generatedAt = new Date().toISOString();
top.source += ` — la_chaux_de_fonds: dropped ${toDrop.length} tiles north of 5-point arched path (2026-05-13)`;
fs.writeFileSync(TOP, JSON.stringify(top, null, 2));
console.log(`\ntop-priority: ${before} → ${top.tiles.length}`);

if (fs.existsSync(COMMUNE)) {
  const c = JSON.parse(fs.readFileSync(COMMUNE, "utf8"));
  if (Array.isArray(c.tiles)) {
    const cBefore = c.tiles.length;
    c.tiles = c.tiles.filter((entry) => !dropIds.has(entry.tileId ?? entry));
    if (c.generatedAt !== undefined) c.generatedAt = top.generatedAt;
    fs.writeFileSync(COMMUNE, JSON.stringify(c, null, 2));
    console.log(`commune-la-chaux-de-fonds: ${cBefore} → ${c.tiles.length}`);
  }
}

console.log(`\nNext: \`node scripts/tools/embed-tile-selection-in-map.mjs\` to refresh HTML.`);
