#!/usr/bin/env node
/**
 * Refine the Neuchâtel selection by applying TWO line cuts:
 *
 *   (a) NW shoreline cut — six lakeside reference tiles fit to a
 *       SW→NE line `N = 0.413·E + 148 409`. Drop tiles whose centres
 *       are above (= northwest of) the line — mostly inland forest
 *       and Chaumont slope.
 *
 *   (b) East boundary cut — five reference tiles near the
 *       Hauterive/Saint-Blaise eastern edge fit to a near-vertical
 *       NW→SE line `N = -1.786·E + 5 791 242` (steep negative slope).
 *       Drop tiles "east of" that line, which for a negative-slope
 *       line means above it. This trims Marin / La Tène outliers
 *       that overshot eastward.
 *
 * A tile is dropped if it falls on the dropped side of EITHER line.
 *
 *   pnpm tsx scripts/diag/trim-neuchatel-shoreline.mjs            # dry-run
 *   pnpm tsx scripts/diag/trim-neuchatel-shoreline.mjs --apply    # mutate files
 */

import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");

const TOP = path.resolve("data/processed/precompute/high-value-tile-selection.top-priority.json");
const COMMUNE = path.resolve("data/processed/precompute/commune-neuchatel-land-tiles.json");

const REF_NW = [
  { id: "e2554750_n1204000_s250", e: 2554875, n: 1204125 },
  { id: "e2558250_n1205000_s250", e: 2558375, n: 1205125 },
  { id: "e2558750_n1204500_s250", e: 2558875, n: 1204625 },
  { id: "e2560500_n1205250_s250", e: 2560625, n: 1205375 },
  { id: "e2563500_n1207000_s250", e: 2563625, n: 1207125 },
  { id: "e2565000_n1208250_s250", e: 2565125, n: 1208375 },
];

const REF_EAST = [
  { id: "e2566000_n1208000_s250", e: 2566125, n: 1208125 },
  { id: "e2566250_n1207750_s250", e: 2566375, n: 1207875 },
  { id: "e2566250_n1207500_s250", e: 2566375, n: 1207625 },
  { id: "e2566500_n1207250_s250", e: 2566625, n: 1207375 },
  { id: "e2566500_n1207000_s250", e: 2566625, n: 1207125 },
];

function fitLine(points) {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.e, 0) / n;
  const my = points.reduce((s, p) => s + p.n, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    const dx = p.e - mx;
    const dy = p.n - my;
    sxy += dx * dy;
    sxx += dx * dx;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  return { slope, intercept };
}

function parseTileId(id) {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id);
  if (!m) throw new Error(`bad tile id: ${id}`);
  const e = Number(m[1]);
  const n = Number(m[2]);
  const s = Number(m[3]);
  return { tileId: id, centerE: e + s / 2, centerN: n + s / 2 };
}

function printLineFit(label, refs, line) {
  console.log(`\n${label}: N = ${line.slope.toFixed(4)} · E + (${line.intercept.toFixed(0)})`);
  for (const r of refs) {
    const lineN = line.slope * r.e + line.intercept;
    console.log(`  ref ${r.id}: N=${r.n}, line=${lineN.toFixed(0)}, delta=${(r.n - lineN).toFixed(0)}`);
  }
}

const lineNW = fitLine(REF_NW);
const lineEast = fitLine(REF_EAST);
printLineFit("NW line (drop above)", REF_NW, lineNW);
printLineFit("East line (drop above)", REF_EAST, lineEast);

// For both lines, "drop" = `centreN > slope · centreE + intercept`.
// - NW line has slope ≈ +0.41 (SW→NE). Above = literally north — that's
//   the inland forest side.
// - East line has slope ≈ −1.79 (NW→SE, near-vertical). Above the line
//   = upper-right of the plot = east of the line — the Marin/La Tène
//   overshoot.
function aboveLine(decoded, line) {
  return decoded.centerN > line.slope * decoded.centerE + line.intercept;
}

const top = JSON.parse(fs.readFileSync(TOP, "utf8"));
const neuTiles = top.tiles.filter((t) => t.region === "neuchatel");
const decoded = neuTiles.map((t) => ({ ...t, ...parseTileId(t.tileId) }));

const dropNW = decoded.filter((t) => aboveLine(t, lineNW));
const dropEast = decoded.filter((t) => aboveLine(t, lineEast));
const dropIds = new Set([...dropNW.map((t) => t.tileId), ...dropEast.map((t) => t.tileId)]);
const dropOnly = (set) => set.filter((t) => !dropIds.has(t.tileId) ? false : true);
const keep = decoded.filter((t) => !dropIds.has(t.tileId));

console.log(`\nneuchatel before: ${neuTiles.length}`);
console.log(`  drop NW only:        ${dropNW.filter((t) => !dropEast.find((d) => d.tileId === t.tileId)).length}`);
console.log(`  drop East only:      ${dropEast.filter((t) => !dropNW.find((d) => d.tileId === t.tileId)).length}`);
console.log(`  drop both:           ${dropNW.filter((t) => dropEast.find((d) => d.tileId === t.tileId)).length}`);
console.log(`  drop union:          ${dropIds.size}`);
console.log(`  keep:                ${keep.length}`);

function near(line) {
  return (t) => Math.abs(t.centerN - (line.slope * t.centerE + line.intercept));
}
console.log(`\nNW line — drops nearest:`);
for (const t of [...dropNW].sort((a, b) => near(lineNW)(a) - near(lineNW)(b)).slice(0, 3)) {
  console.log(`  ${t.tileId}  N=${t.centerN}  line=${(lineNW.slope * t.centerE + lineNW.intercept).toFixed(0)}`);
}
console.log(`East line — drops nearest:`);
for (const t of [...dropEast].sort((a, b) => near(lineEast)(a) - near(lineEast)(b)).slice(0, 3)) {
  console.log(`  ${t.tileId}  N=${t.centerN}  line=${(lineEast.slope * t.centerE + lineEast.intercept).toFixed(0)}`);
}

if (!apply) {
  console.log(`\n(dry-run — pass --apply to mutate files)`);
  process.exit(0);
}

const before = top.tiles.length;
top.tiles = top.tiles.filter((t) => t.region !== "neuchatel" || !dropIds.has(t.tileId));
top.generatedAt = new Date().toISOString();
top.source += ` — neuchatel: dropped ${dropIds.size} tiles (NW shoreline + East boundary 2026-05-13)`;
fs.writeFileSync(TOP, JSON.stringify(top, null, 2));
console.log(`\ntop-priority: ${before} → ${top.tiles.length}`);

if (fs.existsSync(COMMUNE)) {
  const c = JSON.parse(fs.readFileSync(COMMUNE, "utf8"));
  if (Array.isArray(c.tiles)) {
    const cBefore = c.tiles.length;
    c.tiles = c.tiles.filter((entry) => !dropIds.has(entry.tileId ?? entry));
    if (c.generatedAt !== undefined) c.generatedAt = top.generatedAt;
    fs.writeFileSync(COMMUNE, JSON.stringify(c, null, 2));
    console.log(`commune-neuchatel: ${cBefore} → ${c.tiles.length}`);
  }
}

console.log(`\nNext: \`node scripts/tools/embed-tile-selection-in-map.mjs\` to refresh HTML.`);
