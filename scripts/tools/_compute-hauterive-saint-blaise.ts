/**
 * One-shot:
 *  1) Fetch OSM admin_level=8 relations for Hauterive (NE) + Saint-Blaise,
 *     filtered by canton de Neuchâtel (BFS 6453 / 6459) to avoid namesakes.
 *  2) Compute 250m LV95 tile coverage for each commune.
 *  3) Filter out tiles whose center is in Lac de Neuchâtel.
 *  4) Save raw OSM responses + per-commune land-tile JSONs.
 *
 * Outputs:
 *   data/raw/osm/communes/hauterive.json
 *   data/raw/osm/communes/saint-blaise.json
 *   data/processed/precompute/commune-hauterive-land-tiles.json
 *   data/processed/precompute/commune-saint-blaise-land-tiles.json
 */

import fs from "node:fs/promises";
import path from "node:path";

import polyClip from "polygon-clipping";

import { wgs84ToLv95Precise } from "../../src/lib/geo/projection";

interface OverpassWayMember {
  type: "way";
  ref: number;
  role: "outer" | "inner" | string;
  geometry?: Array<{ lat: number; lon: number }>;
}
interface OverpassRelation {
  type: "relation";
  id: number;
  members: OverpassWayMember[];
  tags?: Record<string, string>;
}
type Ring = Array<[number, number]>;

const TILE_SIZE = 250;
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
function coordEq(a: [number, number], b: [number, number]) { return a[0] === b[0] && a[1] === b[1]; }

function stitchOuterRings(relation: OverpassRelation): Ring[] {
  const ways = relation.members
    .filter((m) => m.type === "way" && m.role === "outer" && m.geometry)
    .map((m) => m.geometry!.map((p) => [p.lon, p.lat] as [number, number]));
  const remaining: Ring[] = ways.map((w) => [...w]);
  const rings: Ring[] = [];
  while (remaining.length > 0) {
    const ring: Ring = remaining.shift()!;
    let grew = true;
    while (grew && !coordEq(ring[0], ring[ring.length - 1])) {
      grew = false;
      for (let i = 0; i < remaining.length; i++) {
        const w = remaining[i];
        const last = ring[ring.length - 1];
        if (coordEq(w[0], last)) {
          ring.push(...w.slice(1));
          remaining.splice(i, 1);
          grew = true;
          break;
        }
        if (coordEq(w[w.length - 1], last)) {
          ring.push(...[...w].reverse().slice(1));
          remaining.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    if (!coordEq(ring[0], ring[ring.length - 1])) ring.push(ring[0]);
    rings.push(ring);
  }
  return rings;
}

async function overpass(query: string): Promise<{ elements: OverpassRelation[] }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const ep of OVERPASS_ENDPOINTS) {
      try {
        const resp = await fetch(ep, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": "mappy-hour-tooling/1.0 (contact: fabio.salvalai@swisscaution.ch)",
          },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return (await resp.json()) as { elements: OverpassRelation[] };
      } catch (e) {
        lastErr = e;
        console.warn(`[ovp] ${ep.replace(/https?:\/\//, "")}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (attempt < 2) await sleep(5000 * (attempt + 1));
  }
  throw new Error(`Overpass failed: ${lastErr instanceof Error ? lastErr.message : "unknown"}`);
}

async function fetchRelationById(id: number, label: string): Promise<OverpassRelation> {
  // The 2021 merger created "Laténa" (BFS 6513) from Hauterive (NE), Saint-Blaise and
  // La Tène. So as of OSM today there is no admin_level=8 active relation for
  // Hauterive (NE) or Saint-Blaise — only HISTORIC boundary relations remain. We
  // fetch those by ID directly.
  //   Hauterive (NE): relation 1685491 (boundary=historic, wikidata Q70432)
  //   Saint-Blaise:   relation 1685530 (boundary=historic, wikidata Q70424)
  const query = `
[out:json][timeout:60];
relation(${id});
out geom;
`;
  const json = await overpass(query);
  const rels = json.elements.filter((e) => e.type === "relation");
  if (rels.length === 0) throw new Error(`No relation id=${id} (${label})`);
  const r = rels[0];
  console.log(`[ovp] ${label}: id=${r.id} name=${r.tags?.name} boundary=${r.tags?.boundary} wikidata=${r.tags?.wikidata} postal=${r.tags?.postal_code}`);
  return r;
}

async function fetchLac(): Promise<OverpassRelation[]> {
  const query = `
[out:json][timeout:120];
(
  relation["water"="lake"]["name"~"Lac de Neuchâtel"];
  relation["water"="lake"]["name:fr"~"Lac de Neuchâtel"];
  relation["natural"="water"]["name"~"Lac de Neuchâtel"];
  relation["natural"="water"]["name:fr"~"Lac de Neuchâtel"];
);
out geom;
`;
  const json = await overpass(query);
  const rels = json.elements.filter((e) => e.type === "relation");
  if (rels.length === 0) throw new Error("No Lac de Neuchâtel relation");
  console.log(`[lake] ${rels.length} relation(s): [${rels.map((r) => r.id).join(", ")}]`);
  return rels;
}

function pointInRing(x: number, y: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInMultiPoly(x: number, y: number, mp: polyClip.MultiPolygon): boolean {
  let inside = false;
  for (const poly of mp) {
    for (let r = 0; r < poly.length; r++) {
      const rInside = pointInRing(x, y, poly[r] as Array<[number, number]>);
      if (r === 0) { if (rInside) inside = !inside; }
      else if (rInside) inside = !inside;
    }
  }
  return inside;
}

function relationToLv95(rel: OverpassRelation): polyClip.MultiPolygon {
  const rings = stitchOuterRings(rel);
  return rings.map((ring) => [
    ring.map(([lon, lat]) => {
      const { easting, northing } = wgs84ToLv95Precise(lon, lat);
      return [easting, northing] as [number, number];
    }),
  ]);
}

function tilesForCommune(mp: polyClip.MultiPolygon): string[] {
  // Compute bbox
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const poly of mp) for (const ring of poly) for (const [e, n] of ring) {
    if (e < minE) minE = e; if (e > maxE) maxE = e;
    if (n < minN) minN = n; if (n > maxN) maxN = n;
  }
  const tMinX = Math.floor(minE / TILE_SIZE) * TILE_SIZE;
  const tMaxX = Math.ceil(maxE / TILE_SIZE) * TILE_SIZE;
  const tMinY = Math.floor(minN / TILE_SIZE) * TILE_SIZE;
  const tMaxY = Math.ceil(maxN / TILE_SIZE) * TILE_SIZE;
  const tiles: string[] = [];
  for (let e = tMinX; e < tMaxX; e += TILE_SIZE) {
    for (let n = tMinY; n < tMaxY; n += TILE_SIZE) {
      const tile: polyClip.Polygon = [[
        [e, n], [e + TILE_SIZE, n], [e + TILE_SIZE, n + TILE_SIZE], [e, n + TILE_SIZE], [e, n],
      ]];
      const inter = polyClip.intersection(tile, mp);
      if (inter.length > 0) tiles.push(`e${e}_n${n}_s${TILE_SIZE}`);
    }
  }
  tiles.sort();
  return tiles;
}

async function main() {
  const rawDir = path.join("data", "raw", "osm", "communes");
  const procDir = path.join("data", "processed", "precompute");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(procDir, { recursive: true });

  // ----- 1) Fetch commune polygons (historic boundaries, post-2021 merger into Laténa) -----
  const hauteriveRel = await fetchRelationById(1685491, "Hauterive (NE) historic");
  await fs.writeFile(path.join(rawDir, "hauterive.json"), JSON.stringify({ elements: [hauteriveRel] }, null, 2));

  const stBlaiseRel = await fetchRelationById(1685530, "Saint-Blaise historic");
  await fs.writeFile(path.join(rawDir, "saint-blaise.json"), JSON.stringify({ elements: [stBlaiseRel] }, null, 2));

  // ----- 2) Lac de Neuchâtel for water filter -----
  const lacRels = await fetchLac();
  const lacOuter: Ring[] = [];
  for (const r of lacRels) lacOuter.push(...stitchOuterRings(r));
  const lacMp: polyClip.MultiPolygon = lacOuter.map((ring) => [
    ring.map(([lon, lat]) => {
      const { easting, northing } = wgs84ToLv95Precise(lon, lat);
      return [easting, northing] as [number, number];
    }),
  ]);

  // ----- 3) Per-commune tile coverage + water filter -----
  for (const [name, rel, outName] of [
    ["hauterive", hauteriveRel, "commune-hauterive-land-tiles.json"],
    ["saint-blaise", stBlaiseRel, "commune-saint-blaise-land-tiles.json"],
  ] as const) {
    const mp = relationToLv95(rel);
    const tiles = tilesForCommune(mp);
    console.log(`[${name}] raw tiles intersecting commune: ${tiles.length}`);
    const land: string[] = []; const lake: string[] = [];
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const tid of tiles) {
      const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tid)!;
      const e = Number(m[1]); const n = Number(m[2]); const s = Number(m[3]);
      const cx = e + s / 2; const cy = n + s / 2;
      // Compute center lon/lat for bbox check using inverse projection (only for bbox stats)
      // We need lv95ToWgs84Precise; import lazily
      if (pointInMultiPoly(cx, cy, lacMp)) lake.push(tid);
      else {
        land.push(tid);
        // we'll compute lon/lat separately below
      }
    }
    console.log(`[${name}] land: ${land.length}  •  lake: ${lake.length}`);
    // Compute lon/lat bbox of land tiles
    const { lv95ToWgs84Precise } = await import("../../src/lib/geo/projection");
    for (const tid of land) {
      const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tid)!;
      const e = Number(m[1]); const n = Number(m[2]); const s = Number(m[3]);
      const cx = e + s / 2; const cy = n + s / 2;
      const { lon, lat } = lv95ToWgs84Precise(cx, cy);
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
    console.log(`[${name}] land bbox (centers): lon=[${minLon.toFixed(4)}, ${maxLon.toFixed(4)}] lat=[${minLat.toFixed(4)}, ${maxLat.toFixed(4)}]`);
    await fs.writeFile(path.join(procDir, outName), JSON.stringify(land, null, 2) + "\n", "utf8");
    console.log(`[${name}] → ${outName}`);
  }
}

main().catch((e) => {
  console.error(`Erreur: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
