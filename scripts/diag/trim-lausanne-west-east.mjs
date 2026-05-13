#!/usr/bin/env node
/**
 * Trim `region=lausanne ∧ group=lausanne-west` tiles that fall east
 * of a near-vertical path of 5 user-supplied reference centres. The
 * path bends slightly east mid-way:
 *
 *     N=1156375 → E=2541375
 *     N=1154625 → E=2541375
 *     N=1154375 → E=2541625
 *     N=1154125 → E=2541625
 *     N=1153875 → E=2541625
 *
 * For each candidate tile, interpolate `path_E` at its centre N
 * (piecewise-linear, clamped at the endpoints) and drop if
 * `centre_E > path_E`.
 *
 *   pnpm tsx scripts/diag/trim-lausanne-west-east.mjs            # dry-run
 *   pnpm tsx scripts/diag/trim-lausanne-west-east.mjs --apply    # mutate files
 */

import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");
const TOP = path.resolve("data/processed/precompute/high-value-tile-selection.top-priority.json");

// Path samples, sorted by N descending so we can scan top → bottom.
const PATH = [
  { n: 1156375, e: 2541375 },
  { n: 1154625, e: 2541375 },
  { n: 1154375, e: 2541625 },
  { n: 1154125, e: 2541625 },
  { n: 1153875, e: 2541625 },
];

function pathEAt(n) {
  // Clamp outside the path's N range — for a near-vertical cut the
  // natural extension is "same E as the nearest endpoint".
  if (n >= PATH[0].n) return PATH[0].e;
  if (n <= PATH[PATH.length - 1].n) return PATH[PATH.length - 1].e;
  for (let i = 0; i < PATH.length - 1; i++) {
    const a = PATH[i];
    const b = PATH[i + 1];
    if (n <= a.n && n >= b.n) {
      const t = (a.n - n) / (a.n - b.n);
      return a.e + t * (b.e - a.e);
    }
  }
  return PATH[PATH.length - 1].e;
}

function parseTileId(id) {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id);
  if (!m) throw new Error(`bad tile id: ${id}`);
  const e = Number(m[1]);
  const n = Number(m[2]);
  const s = Number(m[3]);
  return { tileId: id, centerE: e + s / 2, centerN: n + s / 2 };
}

const top = JSON.parse(fs.readFileSync(TOP, "utf8"));
const candidates = top.tiles.filter((t) => t.region === "lausanne" && t.group === "lausanne-west");
const decoded = candidates.map((t) => ({ ...t, ...parseTileId(t.tileId) }));

const toDrop = [];
const toKeep = [];
for (const t of decoded) {
  const pe = pathEAt(t.centerN);
  if (t.centerE > pe) toDrop.push({ ...t, pathE: pe });
  else toKeep.push(t);
}

console.log(`lausanne-west before: ${candidates.length}`);
console.log(`  drop (east of path): ${toDrop.length}`);
console.log(`  keep:                ${toKeep.length}`);

const byProx = (t) => Math.abs(t.centerE - t.pathE);
const dropsBorder = [...toDrop].sort((a, b) => byProx(a) - byProx(b)).slice(0, 5);
console.log(`\nDrops nearest to the path (smallest east overshoot):`);
for (const t of dropsBorder) console.log(`  ${t.tileId}  E=${t.centerE}  path=${t.pathE.toFixed(0)}  delta=+${(t.centerE - t.pathE).toFixed(0)}`);

if (!apply) {
  console.log(`\n(dry-run — pass --apply to mutate files)`);
  process.exit(0);
}

const dropIds = new Set(toDrop.map((t) => t.tileId));
const before = top.tiles.length;
top.tiles = top.tiles.filter((t) => !(t.region === "lausanne" && t.group === "lausanne-west" && dropIds.has(t.tileId)));
top.generatedAt = new Date().toISOString();
top.source += ` — lausanne-west: dropped ${toDrop.length} tiles east of 5-point near-vertical path (2026-05-13)`;
fs.writeFileSync(TOP, JSON.stringify(top, null, 2));
console.log(`\ntop-priority: ${before} → ${top.tiles.length}`);
console.log(`\nNext: \`node scripts/tools/embed-tile-selection-in-map.mjs\` to refresh HTML.`);
