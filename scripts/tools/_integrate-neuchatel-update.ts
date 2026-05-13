/**
 * Integrates the 2026-05-13 neuchatel update:
 *  PART A — Trim NW forest tiles from existing neuchatel selection.
 *           Cut line through villages Corcelles–Peseux–Vauseyon–La Coudre:
 *           lat = 0.176 * lon + 45.79 (linear fit on the 4 points).
 *           Drop tiles where center is north of the line + epsilon (150m, ~0.0014°)
 *           AND lon < 6.97 (NW gate; east side untouched).
 *  PART B — Add commune-hauterive-land-tiles.json + commune-saint-blaise-land-tiles.json
 *           (post-2021 merger into Laténa, polygons from historic OSM relations
 *            1685491 / 1685530).
 *           Both commune lists are clipped to lat ≤ 47.025 to drop the uphill
 *           Jura foothills hidden inside the historic boundaries (forest, not urban).
 *  PART C — Inject into high-value-tile-selection.top-priority.json
 *           and sync commune-neuchatel-land-tiles.json.
 *
 * Reports drop counts and runs village-survival sanity check.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";

const TILE_SIZE = 250;
const SELECTION_PATH = path.join("data", "processed", "precompute", "high-value-tile-selection.top-priority.json");
const NEU_LAND_PATH = path.join("data", "processed", "precompute", "commune-neuchatel-land-tiles.json");
const HAUTERIVE_PATH = path.join("data", "processed", "precompute", "commune-hauterive-land-tiles.json");
const STBLAISE_PATH = path.join("data", "processed", "precompute", "commune-saint-blaise-land-tiles.json");

// Trim line — fit to villages:
//   (6.866, 46.989), (6.886, 46.992), (6.920, 46.998), (6.957, 47.005)
const TRIM_SLOPE = 0.176;
const TRIM_INTERCEPT = 45.79;
// Safety margin ~150m north (1° lat ≈ 111km → 150m ≈ 0.00135°). Be generous.
const TRIM_LAT_EPSILON = 0.0014;
const TRIM_LON_GATE_EAST = 6.97; // only trim west of this lon
// Also keep the existing 47.020 hard cap (Chaumont slope) for the NW side as a backstop.
const HARD_LAT_CAP = 47.020;
// For new east-side commune additions: clip uphill Jura foothills.
const EAST_LAT_CAP = 47.025;

interface TileXY { tileId: string; lon: number; lat: number; e: number; n: number; }

function decodeTile(tileId: string): TileXY {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tileId);
  if (!m) throw new Error(`bad tileId: ${tileId}`);
  const e = Number(m[1]); const n = Number(m[2]); const s = Number(m[3]);
  const cx = e + s / 2; const cy = n + s / 2;
  const { lon, lat } = lv95ToWgs84Precise(cx, cy);
  return { tileId, lon, lat, e, n };
}

function dropByNwForestLine(tiles: TileXY[]): { kept: TileXY[]; dropped: TileXY[]; reason: string[] } {
  const kept: TileXY[] = []; const dropped: TileXY[] = []; const reason: string[] = [];
  for (const t of tiles) {
    const lineLat = TRIM_SLOPE * t.lon + TRIM_INTERCEPT + TRIM_LAT_EPSILON;
    const tooNorthNW = t.lon < TRIM_LON_GATE_EAST && t.lat > lineLat;
    const aboveHardCap = t.lat > HARD_LAT_CAP;
    if (tooNorthNW) { dropped.push(t); reason.push("nw-line"); }
    else if (aboveHardCap && t.lon < TRIM_LON_GATE_EAST) { dropped.push(t); reason.push("hard-cap"); }
    else kept.push(t);
  }
  return { kept, dropped, reason };
}

async function main() {
  // ---- Load existing selection ----
  const sel = JSON.parse(await fs.readFile(SELECTION_PATH, "utf8"));
  const allTiles: { region: string; tileId: string; group: string }[] = sel.tiles;
  const neuRows = allTiles.filter((t) => t.region === "neuchatel");
  const others = allTiles.filter((t) => t.region !== "neuchatel");
  console.log(`[load] selection has ${allTiles.length} rows; neuchatel = ${neuRows.length}`);

  // ---- PART A: trim NW forest ----
  const decoded: TileXY[] = neuRows.map((r) => decodeTile(r.tileId));
  const { kept: keptA, dropped: droppedA, reason: reasonA } = dropByNwForestLine(decoded);

  console.log(`\n=== PART A: trim NW forest line ===`);
  console.log(`Line: lat = ${TRIM_SLOPE} * lon + ${TRIM_INTERCEPT}  (+${TRIM_LAT_EPSILON} epsilon)`);
  console.log(`Gate: lon < ${TRIM_LON_GATE_EAST}`);
  console.log(`Existing neuchatel tiles: ${neuRows.length}`);
  console.log(`Dropped: ${droppedA.length}  (nw-line=${reasonA.filter((r) => r === "nw-line").length}, hard-cap=${reasonA.filter((r) => r === "hard-cap").length})`);
  console.log(`Kept after part A: ${keptA.length}`);

  // Village survival check
  const villages = [
    { name: "Corcelles-Cormondrèche", lat: 46.989, lon: 6.866 },
    { name: "Peseux", lat: 46.992, lon: 6.886 },
    { name: "Vauseyon", lat: 46.998, lon: 6.920 },
    { name: "La Coudre", lat: 47.005, lon: 6.957 },
    { name: "Serrières", lat: 46.987, lon: 6.916 },
    { name: "Centre Neuchâtel", lat: 46.994, lon: 6.931 },
  ];
  console.log(`\nVillage survival check (nearest surviving tile):`);
  for (const v of villages) {
    let best: { t: TileXY; d: number } | null = null;
    for (const t of keptA) {
      const d = Math.hypot((t.lat - v.lat) * 111000, (t.lon - v.lon) * 111000 * Math.cos((v.lat * Math.PI) / 180));
      if (!best || d < best.d) best = { t, d };
    }
    if (!best) console.log(`  ${v.name}: NO SURVIVING TILE`);
    else console.log(`  ${v.name} (${v.lat},${v.lon}) → ${best.t.tileId} @ (${best.t.lat.toFixed(4)},${best.t.lon.toFixed(4)}) dist=${best.d.toFixed(0)}m`);
  }

  // ---- PART B: add Hauterive + Saint-Blaise ----
  const hauteriveIds: string[] = JSON.parse(await fs.readFile(HAUTERIVE_PATH, "utf8"));
  const stBlaiseIds: string[] = JSON.parse(await fs.readFile(STBLAISE_PATH, "utf8"));

  function clipEast(list: string[], label: string): string[] {
    const kept: string[] = []; const dropped: string[] = [];
    let maxLon = -Infinity;
    for (const tid of list) {
      const tx = decodeTile(tid);
      if (tx.lat > EAST_LAT_CAP) { dropped.push(tid); continue; }
      kept.push(tid);
      if (tx.lon > maxLon) maxLon = tx.lon;
    }
    console.log(`[${label}] raw=${list.length} drop(uphill lat>${EAST_LAT_CAP})=${dropped.length} kept=${kept.length} maxCenterLon=${maxLon.toFixed(4)}`);
    return kept;
  }

  console.log(`\n=== PART B: add Hauterive + Saint-Blaise ===`);
  const hauteriveClipped = clipEast(hauteriveIds, "hauterive");
  const stBlaiseClipped = clipEast(stBlaiseIds, "saint-blaise");

  // Check if any new tiles fall outside current bbox (lon > 7.00 → easting > 2566683)
  // Currently selection encodes by easting; the LV95 max useful tile center lon=7.005
  // is at easting~2567032. Tile origin (e) ≤ 2567000 is at center lon ~7.0118.
  // We'll keep all and report.
  const newTiles = [...new Set([...hauteriveClipped, ...stBlaiseClipped])];
  console.log(`[new] union after dedup: ${newTiles.length}`);

  // Dedup against existing post-A neuchatel
  const keptASet = new Set(keptA.map((t) => t.tileId));
  const newlyAdded: string[] = [];
  for (const tid of newTiles) {
    if (!keptASet.has(tid)) newlyAdded.push(tid);
  }
  console.log(`[new] not already in neuchatel selection (post-A): ${newlyAdded.length}`);

  // Bbox check for newly added (lon > 7.00 → outside current NEUCHATEL_LOCAL_BBOX)
  let outsideBbox = 0;
  let newMaxLon = -Infinity;
  for (const tid of newlyAdded) {
    const tx = decodeTile(tid);
    if (tx.lon > 7.00) outsideBbox++;
    if (tx.lon > newMaxLon) newMaxLon = tx.lon;
  }
  console.log(`[new] tiles with center lon > 7.00 (outside current NEUCHATEL_LOCAL_BBOX): ${outsideBbox}`);
  console.log(`[new] max center lon among new tiles: ${newMaxLon.toFixed(4)}`);

  // ---- PART C: inject + sync ----
  console.log(`\n=== PART C: inject + sync ===`);
  const finalNeuTileIds = new Set<string>(keptA.map((t) => t.tileId));
  for (const tid of newlyAdded) finalNeuTileIds.add(tid);
  const sortedFinalNeuTileIds = [...finalNeuTileIds].sort();

  const newNeuRows = sortedFinalNeuTileIds.map((tileId) => ({
    region: "neuchatel",
    tileId,
    group: "neuchatel-city",
  }));

  const finalRows = [...others, ...newNeuRows];
  console.log(`[final] neuchatel tiles: ${newNeuRows.length}  •  total: ${finalRows.length}`);

  // Update generatedAt + source clause
  const today = new Date().toISOString();
  const newSource = sel.source +
    ` — neuchatel 2026-05-13: trimmed NW forest tiles (lat > ${TRIM_SLOPE}*lon+${TRIM_INTERCEPT} for lon<${TRIM_LON_GATE_EAST}), dropped ${droppedA.length} tiles; added Hauterive + Saint-Blaise commune tiles (post-2021 merger Laténa, historic OSM relations 1685491/1685530; clipped lat ≤ ${EAST_LAT_CAP}) for ${newlyAdded.length} new tiles`;

  const updatedSel = {
    ...sel,
    generatedAt: today,
    source: newSource,
    tiles: finalRows,
  };
  await fs.writeFile(SELECTION_PATH, JSON.stringify(updatedSel, null, 2) + "\n", "utf8");
  console.log(`[write] ${SELECTION_PATH}`);

  // Sync commune-neuchatel-land-tiles.json
  const existingLand: string[] = JSON.parse(await fs.readFile(NEU_LAND_PATH, "utf8"));
  const landSet = new Set(existingLand);
  // Apply part A drops to the land tiles too
  for (const t of droppedA) landSet.delete(t.tileId);
  // Add new
  for (const tid of newlyAdded) landSet.add(tid);
  const finalLand = [...landSet].sort();
  await fs.writeFile(NEU_LAND_PATH, JSON.stringify(finalLand, null, 2) + "\n", "utf8");
  console.log(`[write] ${NEU_LAND_PATH} (${existingLand.length} → ${finalLand.length})`);

  console.log(`\n=== SUMMARY ===`);
  console.log(`Final neuchatel tiles: ${newNeuRows.length}  (was ${neuRows.length})`);
  console.log(`  - Part A dropped: ${droppedA.length}`);
  console.log(`  - Part B added:   ${newlyAdded.length}`);
  console.log(`Top-priority total tiles: ${finalRows.length}  (was ${allTiles.length})`);
}

main().catch((e) => {
  console.error(`Erreur: ${e instanceof Error ? e.message : e}\n${e instanceof Error ? e.stack : ""}`);
  process.exitCode = 1;
});
