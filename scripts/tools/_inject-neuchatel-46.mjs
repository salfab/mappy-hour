import fs from "node:fs";
import path from "node:path";

const JSON_PATH = path.resolve("data/processed/precompute/high-value-tile-selection.top-priority.json");
const COMMUNE_PATH = path.resolve("data/processed/precompute/commune-neuchatel-land-tiles.json");

const NEW_TILES = [
  "e2556750_n1201750_s250","e2556500_n1201750_s250","e2556250_n1201750_s250",
  "e2556250_n1202750_s250","e2556250_n1202500_s250","e2556250_n1202250_s250",
  "e2556250_n1202000_s250","e2556500_n1202000_s250","e2556750_n1202000_s250",
  "e2556500_n1202750_s250","e2558250_n1203250_s250","e2558000_n1203250_s250",
  "e2557750_n1203250_s250","e2557500_n1203250_s250","e2557250_n1203250_s250",
  "e2556500_n1203000_s250","e2556750_n1203000_s250","e2557000_n1203000_s250",
  "e2557250_n1203000_s250","e2557500_n1202750_s250","e2556500_n1202250_s250",
  "e2556750_n1202250_s250","e2556750_n1202750_s250","e2557000_n1202750_s250",
  "e2556500_n1202500_s250","e2556750_n1202500_s250","e2557000_n1202250_s250",
  "e2557500_n1203000_s250","e2557250_n1202750_s250","e2557000_n1202500_s250",
  "e2557250_n1202500_s250","e2557750_n1203000_s250","e2558000_n1203000_s250",
  "e2559000_n1203250_s250","e2560250_n1204000_s250","e2561500_n1204250_s250",
  "e2558250_n1203000_s250","e2557000_n1201000_s250","e2557000_n1200750_s250",
  "e2557000_n1201750_s250","e2557000_n1201500_s250","e2556000_n1201750_s250",
  "e2555750_n1201750_s250","e2556000_n1202250_s250","e2555750_n1202250_s250",
  "e2555750_n1202000_s250","e2556000_n1202000_s250",
];

const j = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
const existingNeuchatel = new Set(j.tiles.filter(t => t.region === "neuchatel").map(t => t.tileId));
const toAdd = NEW_TILES.filter(id => !existingNeuchatel.has(id));
console.log(`requested=${NEW_TILES.length} already-present=${NEW_TILES.length - toAdd.length} new=${toAdd.length}`);
for (const tileId of toAdd) {
  j.tiles.push({ region: "neuchatel", tileId, group: "neuchatel-city" });
}
j.generatedAt = new Date().toISOString();
j.source += " — neuchatel: +46 manual urban-fringe tiles added 2026-05-13";
fs.writeFileSync(JSON_PATH, JSON.stringify(j, null, 2));
console.log(`top-priority total: ${j.tiles.length}`);
console.log(`neuchatel total: ${j.tiles.filter(t => t.region === "neuchatel").length}`);

// Sync into commune-neuchatel-land-tiles.json
if (fs.existsSync(COMMUNE_PATH)) {
  const c = JSON.parse(fs.readFileSync(COMMUNE_PATH, "utf8"));
  const existingC = new Set((c.tiles || c).map(t => t.tileId ?? t));
  let added = 0;
  for (const tileId of toAdd) {
    if (existingC.has(tileId)) continue;
    if (Array.isArray(c.tiles)) c.tiles.push({ tileId, group: "neuchatel-city" });
    else c.push(tileId);
    added++;
  }
  if (c.generatedAt !== undefined) c.generatedAt = j.generatedAt;
  fs.writeFileSync(COMMUNE_PATH, JSON.stringify(c, null, 2));
  console.log(`commune-neuchatel: +${added} tiles, total=${Array.isArray(c.tiles) ? c.tiles.length : c.length}`);
}
