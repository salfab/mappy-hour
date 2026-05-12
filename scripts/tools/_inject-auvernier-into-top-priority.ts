/**
 * Injecte commune-auvernier-land-tiles.json dans
 * high-value-tile-selection.top-priority.json avec region=neuchatel,
 * group=neuchatel-city. Déduplique par (region,tileId).
 *
 * Calcule également la bbox WGS84 minimale qui englobe les centres de toutes
 * les tuiles neuchatel (existantes + nouvelles), arrondie avec une marge de
 * 150 m (~0.0014° lat, ~0.002° lon à 47°N), pour informer la widening de
 * NEUCHATEL_LOCAL_BBOX (édité à la main).
 */

import fs from "node:fs/promises";
import path from "node:path";

import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";

const ROOT = path.join("data", "processed", "precompute");
const OUT = path.join(ROOT, "high-value-tile-selection.top-priority.json");
const NEW_TILES = path.join(ROOT, "commune-auvernier-land-tiles.json");

interface TileEntry { region: string; tileId: string; group?: string; score?: number }
interface TopPriority {
  generatedAt: string;
  source: string;
  tiles: TileEntry[];
  [k: string]: unknown;
}

function tileCenterLv95(tid: string): { e: number; n: number } {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tid);
  if (!m) throw new Error(`tileId invalide : ${tid}`);
  return { e: Number(m[1]) + Number(m[3]) / 2, n: Number(m[2]) + Number(m[3]) / 2 };
}

async function main() {
  const doc = JSON.parse(await fs.readFile(OUT, "utf8")) as TopPriority;
  const newTileIds: string[] = JSON.parse(await fs.readFile(NEW_TILES, "utf8"));
  console.log(`[inject] auvernier candidates: ${newTileIds.length}`);

  const existing = new Set(doc.tiles.map((t) => `${t.region}|${t.tileId}`));
  let added = 0;
  for (const tid of newTileIds) {
    const key = `neuchatel|${tid}`;
    if (existing.has(key)) continue;
    existing.add(key);
    doc.tiles.push({ region: "neuchatel", tileId: tid, group: "neuchatel-city" });
    added++;
  }
  console.log(`[inject] new (non-dedup): ${added}`);

  doc.tiles.sort((a, b) => {
    if (a.region !== b.region) return a.region < b.region ? -1 : 1;
    return a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0;
  });

  doc.generatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const auvernierClause =
    " + commune-auvernier-land-tiles (Auvernier village folded into neuchatel-city, " +
    "via Milvignes OSM relation 2758642 wikidata Q251727 BFS 6416 clipped to bbox " +
    "[6.86, 46.945, 6.90, 46.965])";
  if (!doc.source.includes("auvernier")) doc.source += auvernierClause;

  await fs.writeFile(OUT, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.log(`[inject] wrote → ${OUT}`);

  // Diagnostic: compute WGS84 bbox of all neuchatel tile centers
  const neuchatelTiles = doc.tiles.filter((t) => t.region === "neuchatel");
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const t of neuchatelTiles) {
    const { e, n } = tileCenterLv95(t.tileId);
    const { lon, lat } = lv95ToWgs84Precise(e, n);
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  // Margin ~150m
  const dLat = 150 / 111000;
  const meanLat = (minLat + maxLat) / 2;
  const dLon = 150 / (111000 * Math.cos((meanLat * Math.PI) / 180));
  const bboxWithMargin: [number, number, number, number] = [
    minLon - dLon, minLat - dLat, maxLon + dLon, maxLat + dLat,
  ];
  console.log(
    `[bbox] neuchatel tile-centers min/max: lon=${minLon.toFixed(5)}..${maxLon.toFixed(5)} lat=${minLat.toFixed(5)}..${maxLat.toFixed(5)}`,
  );
  console.log(
    `[bbox] with 150m margin: [${bboxWithMargin.map((v) => v.toFixed(5)).join(", ")}]`,
  );

  // Counts
  const byRegion: Record<string, number> = {};
  const byGroup: Record<string, number> = {};
  for (const t of doc.tiles) {
    byRegion[t.region] = (byRegion[t.region] ?? 0) + 1;
    const g = t.group ?? "?";
    byGroup[g] = (byGroup[g] ?? 0) + 1;
  }
  console.log(`[stats] total tiles: ${doc.tiles.length}`);
  console.log(`[stats] by region:`, byRegion);
  console.log(`[stats] by group :`, byGroup);
}

main().catch((e) => {
  console.error(`[inject] Erreur : ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
