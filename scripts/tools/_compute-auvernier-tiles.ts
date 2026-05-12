/**
 * One-shot: from already-downloaded Milvignes commune polygon
 * (data/raw/osm/communes/milvignes.json), compute the 250m LV95 tile coverage
 * restricted to the Auvernier village bbox [6.86, 46.945, 6.90, 46.965], then
 * filter out tiles whose center falls in Lac de Neuchâtel.
 *
 * Output: data/processed/precompute/commune-auvernier-land-tiles.json
 *
 * Pourquoi pas réutiliser compute-commune-tile-coverage.ts ?
 *  - Auvernier n'a pas de relation OSM propre (locality, node-only).
 *  - On utilise donc Milvignes (Q251727, BFS 6416, relation 2758642) puis on
 *    clippe à la bbox du village pour ignorer Bôle + Colombier.
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

function coordEq(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

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

// Auvernier village bbox [minLon, minLat, maxLon, maxLat]
const AUVERNIER_BBOX: [number, number, number, number] = [6.86, 46.945, 6.90, 46.965];
const TILE_SIZE = 250;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];

interface OverpassResp { elements: OverpassRelation[] }

async function fetchWaterRelations(name: string): Promise<OverpassRelation[]> {
  const query = `
[out:json][timeout:120];
(
  relation["water"="lake"]["name"~"${name}"];
  relation["water"="lake"]["name:fr"~"${name}"];
  relation["natural"="water"]["name"~"${name}"];
  relation["natural"="water"]["name:fr"~"${name}"];
);
out geom;
`;
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
        const json = (await resp.json()) as OverpassResp;
        const rels = json.elements.filter((e) => e.type === "relation");
        if (rels.length === 0) throw new Error(`No water relation named "${name}"`);
        console.log(`[water] "${name}" → ${rels.length} relation(s) [${rels.map((r) => r.id).join(", ")}]`);
        return rels;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[water] ${ep.replace(/https?:\/\//, "")}: ${msg}`);
      }
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw new Error(`Overpass failed: ${lastErr instanceof Error ? lastErr.message : "unknown"}`);
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
      if (r === 0) {
        if (rInside) inside = !inside;
      } else if (rInside) {
        inside = !inside;
      }
    }
  }
  return inside;
}

async function main() {
  const milvignesPath = path.join("data", "raw", "osm", "communes", "milvignes.json");
  const raw = JSON.parse(await fs.readFile(milvignesPath, "utf8")) as { elements: OverpassRelation[] };
  const rel = raw.elements.find((e) => e.type === "relation");
  if (!rel) throw new Error("No relation in milvignes.json");
  console.log(
    `[milvignes] relation ${rel.id} name=${rel.tags?.name} admin_level=${rel.tags?.admin_level} wikidata=${rel.tags?.wikidata} BFS=${rel.tags?.["swisstopo:BFS_NUMMER"]}`,
  );

  const outerRings = stitchOuterRings(rel);
  console.log(`[milvignes] ${outerRings.length} outer ring(s)`);

  // Convert to LV95 MultiPolygon (one polygon per outer ring; no holes for now)
  const lv95Commune: polyClip.MultiPolygon = outerRings.map((ring) => [
    ring.map(([lon, lat]) => {
      const { easting, northing } = wgs84ToLv95Precise(lon, lat);
      return [easting, northing] as [number, number];
    }),
  ]);

  // Build the Auvernier bbox polygon in LV95 (corners projected)
  const [minLon, minLat, maxLon, maxLat] = AUVERNIER_BBOX;
  const bboxCorners: Array<[number, number]> = [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ];
  const bboxLv95Ring: Array<[number, number]> = bboxCorners.map(([lon, lat]) => {
    const { easting, northing } = wgs84ToLv95Precise(lon, lat);
    return [easting, northing];
  });
  const bboxLv95Poly: polyClip.Polygon = [bboxLv95Ring];

  // Compute commune ∩ bbox in LV95
  const clipped = polyClip.intersection(bboxLv95Poly, lv95Commune);
  if (clipped.length === 0) throw new Error("Commune ∩ bbox empty: check bbox");
  console.log(`[clip] commune ∩ bbox → ${clipped.length} polygon(s)`);

  // Compute bbox of the clipped area in LV95
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const poly of clipped) {
    for (const ring of poly) {
      for (const [e, n] of ring) {
        if (e < minE) minE = e;
        if (e > maxE) maxE = e;
        if (n < minN) minN = n;
        if (n > maxN) maxN = n;
      }
    }
  }
  const tMinX = Math.floor(minE / TILE_SIZE) * TILE_SIZE;
  const tMaxX = Math.ceil(maxE / TILE_SIZE) * TILE_SIZE;
  const tMinY = Math.floor(minN / TILE_SIZE) * TILE_SIZE;
  const tMaxY = Math.ceil(maxN / TILE_SIZE) * TILE_SIZE;
  console.log(`[clip] LV95 bbox of intersection: E=${tMinX}..${tMaxX} N=${tMinY}..${tMaxY}`);

  // For each candidate tile, test intersection with the clipped polygon
  const tileIds: string[] = [];
  for (let e = tMinX; e < tMaxX; e += TILE_SIZE) {
    for (let n = tMinY; n < tMaxY; n += TILE_SIZE) {
      const tile: polyClip.Polygon = [[
        [e, n],
        [e + TILE_SIZE, n],
        [e + TILE_SIZE, n + TILE_SIZE],
        [e, n + TILE_SIZE],
        [e, n],
      ]];
      const inter = polyClip.intersection(tile, clipped as polyClip.MultiPolygon);
      if (inter.length > 0) tileIds.push(`e${e}_n${n}_s${TILE_SIZE}`);
    }
  }
  tileIds.sort();
  console.log(`[clip] ${tileIds.length} tuiles intersectent Auvernier (Milvignes ∩ bbox)`);

  // Now filter out tiles whose center is in Lac de Neuchâtel
  const waterRels = await fetchWaterRelations("Lac de Neuchâtel");
  const lakeOuter = stitchOuterRings({ ...waterRels[0], members: waterRels.flatMap((r) => r.members) });
  const lakeInner = (() => {
    const innerWays: Array<{ geometry?: Array<{ lat: number; lon: number }> }> = [];
    for (const r of waterRels) {
      for (const m of r.members) {
        if (m.type === "way" && m.role === "inner" && m.geometry) innerWays.push(m);
      }
    }
    // (cheap shortcut: islands in Lac de Neuchâtel are not near Auvernier)
    return innerWays;
  })();
  void lakeInner;
  const lakeMp: polyClip.MultiPolygon = lakeOuter.map((ring) => [
    ring.map(([lon, lat]) => {
      const { easting, northing } = wgs84ToLv95Precise(lon, lat);
      return [easting, northing] as [number, number];
    }),
  ]);

  const landTiles: string[] = [];
  const lakeTiles: string[] = [];
  for (const tid of tileIds) {
    const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tid);
    if (!m) throw new Error(`tileId invalide : ${tid}`);
    const e = Number(m[1]); const n = Number(m[2]); const s = Number(m[3]);
    const cx = e + s / 2; const cy = n + s / 2;
    if (pointInMultiPoly(cx, cy, lakeMp)) lakeTiles.push(tid);
    else landTiles.push(tid);
  }
  console.log(`[water] gardées : ${landTiles.length}  •  retirées (centre lac) : ${lakeTiles.length}`);

  const outPath = path.join("data", "processed", "precompute", "commune-auvernier-land-tiles.json");
  await fs.writeFile(outPath, JSON.stringify(landTiles, null, 2) + "\n", "utf8");
  console.log(`[out] écrit → ${outPath}`);
}

main().catch((e) => {
  console.error(`[auvernier] Erreur : ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
