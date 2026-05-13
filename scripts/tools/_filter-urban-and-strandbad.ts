/**
 * One-shot: filter commune-{bern,zurich,thun}-land-tiles.json down to urban-only
 * tiles (preserving contiguous blocks, filling holes), then add the Strandbad
 * Thun lakeside polygon coverage.
 *
 * Approach: OSM Overpass URBAN vs FOREST landuse polygons; tile-centre point-in-
 * polygon classification; ≥8-tile-component filter; hole-fill (>=3/4 neighbours
 * already kept) iterated to fixpoint.
 *
 * Outputs:
 *   - rewrites data/processed/precompute/commune-{region}-land-tiles.json
 *   - rewrites data/processed/precompute/high-value-tile-selection.top-priority.json
 *     (only tiles[].region in {bern,zurich,thun} touched + Strandbad add)
 *   - data/raw/osm/landuse/{region}-urban.json
 *   - data/raw/osm/landuse/{region}-forest.json
 *   - data/raw/osm/strandbad-thun.json
 */
import fs from "node:fs/promises";
import path from "node:path";

import { wgs84ToLv95Precise } from "../../src/lib/geo/projection";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

interface OverpassWayMember {
  type: "way";
  ref: number;
  role: string;
  geometry?: Array<{ lat: number; lon: number }>;
}
interface OverpassWay {
  type: "way";
  id: number;
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}
interface OverpassRelation {
  type: "relation";
  id: number;
  members: OverpassWayMember[];
  tags?: Record<string, string>;
}
type OverpassElement = OverpassWay | OverpassRelation;
interface OverpassResp {
  elements: OverpassElement[];
}

type Ring = Array<[number, number]>; // [lon, lat]
type LV95Ring = Array<[number, number]>; // [easting, northing]
type LV95Poly = LV95Ring[]; // outer, inner...
type LV95MultiPoly = LV95Poly[];

function coordEq(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function stitchRingsFromWays(ways: Array<Array<[number, number]>>): Ring[] {
  const remaining: Ring[] = ways.map((w) => [...w]);
  const rings: Ring[] = [];
  while (remaining.length > 0) {
    const ring = remaining.shift()!;
    if (coordEq(ring[0], ring[ring.length - 1])) {
      rings.push(ring);
      continue;
    }
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

async function overpassQuery(query: string): Promise<OverpassResp> {
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
        return json;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[overpass] ${ep.replace(/https?:\/\//, "")}: ${msg}`);
      }
    }
    if (attempt < 2) await sleep(5000 * (attempt + 1));
  }
  throw new Error(`Overpass failed: ${lastErr instanceof Error ? lastErr.message : "unknown"}`);
}

// Extract polygons from elements (ways=single ring, relations=multipoly)
function elementsToLV95MultiPoly(elements: OverpassElement[]): LV95MultiPoly {
  const polys: LV95Poly[] = [];
  // Closed ways → 1 polygon each
  for (const el of elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 4) continue;
    const ring: Ring = el.geometry.map((p) => [p.lon, p.lat]);
    if (!coordEq(ring[0], ring[ring.length - 1])) ring.push(ring[0]);
    const lv95 = ring.map(([lon, lat]) => {
      const p = wgs84ToLv95Precise(lon, lat);
      return [p.easting, p.northing] as [number, number];
    });
    polys.push([lv95]);
  }
  // Relations → stitch outer + inner separately
  for (const el of elements) {
    if (el.type !== "relation") continue;
    const outerWays: Array<Array<[number, number]>> = [];
    const innerWays: Array<Array<[number, number]>> = [];
    for (const m of el.members) {
      if (m.type !== "way" || !m.geometry) continue;
      const w = m.geometry.map((p) => [p.lon, p.lat] as [number, number]);
      if (m.role === "inner") innerWays.push(w);
      else outerWays.push(w);
    }
    const outerRings = stitchRingsFromWays(outerWays);
    const innerRings = stitchRingsFromWays(innerWays);
    for (const ring of outerRings) {
      const lv95Outer = ring.map(([lon, lat]) => {
        const p = wgs84ToLv95Precise(lon, lat);
        return [p.easting, p.northing] as [number, number];
      });
      // attach inner rings to the FIRST outer (simplification); ok for PIP test
      const poly: LV95Poly = [lv95Outer];
      polys.push(poly);
    }
    // Inner rings: ignored in PIP, since we want the "filled" union of urban areas.
    // For our use case (point-in-any-urban-polygon), treating holes as filled is
    // conservative — leaves more tiles classified urban → fewer drops. Acceptable.
    void innerRings;
  }
  return polys;
}

// Ray-casting PIP against a multi-polygon (LV95)
function pointInLV95MultiPoly(x: number, y: number, mp: LV95MultiPoly): boolean {
  for (const poly of mp) {
    for (let r = 0; r < poly.length; r++) {
      // r=0 is the only outer we care about; we filled holes
      if (r > 0) continue;
      const ring = poly[r];
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const intersect =
          yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
      }
      if (inside) return true;
    }
  }
  return false;
}

interface TileXY {
  id: string;
  e: number; // easting (SW corner)
  n: number; // northing (SW corner)
  s: number; // size
  cx: number;
  cy: number;
}

function parseTile(id: string): TileXY {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id);
  if (!m) throw new Error(`bad tile id: ${id}`);
  const e = Number(m[1]);
  const n = Number(m[2]);
  const s = Number(m[3]);
  return { id, e, n, s, cx: e + s / 2, cy: n + s / 2 };
}

function bboxOfTilesWgs(tiles: TileXY[]): [number, number, number, number] {
  // Build LV95 bbox from corners, add buffer, convert each corner.
  // Simpler: take ext LV95 then convert 4 corners → bbox of those in lonlat.
  let minE = +Infinity,
    maxE = -Infinity,
    minN = +Infinity,
    maxN = -Infinity;
  for (const t of tiles) {
    if (t.e < minE) minE = t.e;
    if (t.e + t.s > maxE) maxE = t.e + t.s;
    if (t.n < minN) minN = t.n;
    if (t.n + t.s > maxN) maxN = t.n + t.s;
  }
  // 2km buffer in LV95 metres
  minE -= 2000;
  maxE += 2000;
  minN -= 2000;
  maxN += 2000;
  // Use the inverse via proj4 — but we only have wgs→lv95 *precise* here.
  // Import lv95ToWgs84Precise dynamically? We have it in the same module.
  return [minE, minN, maxE, maxN]; // we'll convert outside
}

// 4-connectivity adjacency for tiles (axis-aligned, 250m grid)
function neighbours(t: TileXY): Array<[number, number]> {
  return [
    [t.e - t.s, t.n],
    [t.e + t.s, t.n],
    [t.e, t.n - t.s],
    [t.e, t.n + t.s],
  ];
}

function tileKey(e: number, n: number): string {
  return `${e}_${n}`;
}

function connectedComponents(tiles: TileXY[]): TileXY[][] {
  const byKey = new Map<string, TileXY>();
  for (const t of tiles) byKey.set(tileKey(t.e, t.n), t);
  const visited = new Set<string>();
  const components: TileXY[][] = [];
  for (const t of tiles) {
    const k = tileKey(t.e, t.n);
    if (visited.has(k)) continue;
    const comp: TileXY[] = [];
    const stack = [t];
    visited.add(k);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const [ne, nn] of neighbours(cur)) {
        const nk = tileKey(ne, nn);
        if (visited.has(nk)) continue;
        const nt = byKey.get(nk);
        if (!nt) continue;
        visited.add(nk);
        stack.push(nt);
      }
    }
    components.push(comp);
  }
  return components;
}

interface RegionSpec {
  region: string;
  // local bbox in WGS84 (lonMin, latMin, lonMax, latMax) — used to filter Overpass query
  bbox: [number, number, number, number];
}

const REGIONS: RegionSpec[] = [
  { region: "bern", bbox: [7.39, 46.92, 7.50, 46.98] },
  { region: "zurich", bbox: [8.46, 47.32, 8.62, 47.44] },
  { region: "thun", bbox: [7.58, 46.72, 7.68, 46.79] },
];

const URBAN_LANDUSE_RE =
  "^(residential|commercial|industrial|retail|education|institutional)$";
const FOREST_LANDUSE_RE =
  "^(forest|grass|meadow|farmland|cemetery|recreation_ground|orchard|vineyard|allotments)$";

async function fetchLanduse(
  bbox: [number, number, number, number],
  variant: "urban" | "forest",
): Promise<OverpassResp> {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  // bbox in overpass: south,west,north,east
  const bboxStr = `${minLat},${minLon},${maxLat},${maxLon}`;
  let query: string;
  if (variant === "urban") {
    query = `
[out:json][timeout:120];
(
  way["landuse"~"${URBAN_LANDUSE_RE}"](${bboxStr});
  relation["landuse"~"${URBAN_LANDUSE_RE}"](${bboxStr});
);
out geom;
`;
  } else {
    query = `
[out:json][timeout:120];
(
  way["landuse"~"${FOREST_LANDUSE_RE}"](${bboxStr});
  way["natural"="wood"](${bboxStr});
  way["natural"="scrub"](${bboxStr});
  relation["landuse"~"${FOREST_LANDUSE_RE}"](${bboxStr});
  relation["natural"="wood"](${bboxStr});
);
out geom;
`;
  }
  return await overpassQuery(query);
}

async function fetchStrandbadThun(): Promise<OverpassResp> {
  // Targeted name-regex query in the lakeside area
  const query = `
[out:json][timeout:60];
(
  way["leisure"~"^(swimming_pool|sports_centre|water_park|park)$"]["name"~"Strandbad",i](46.74,7.62,46.76,7.66);
  relation["leisure"~"^(swimming_pool|sports_centre|water_park|park)$"]["name"~"Strandbad",i](46.74,7.62,46.76,7.66);
  way["natural"="beach"](46.74,7.62,46.76,7.66);
  way["leisure"="beach_resort"](46.74,7.62,46.76,7.66);
);
out geom;
`;
  return await overpassQuery(query);
}

async function ensureOsmCache(
  cachePath: string,
  fetcher: () => Promise<OverpassResp>,
): Promise<OverpassResp> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw) as OverpassResp;
  } catch {
    /* fallthrough */
  }
  console.log(`[osm] fetching → ${cachePath}`);
  const data = await fetcher();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(data, null, 2), "utf8");
  console.log(`[osm] cached ${data.elements.length} elements → ${cachePath}`);
  return data;
}

interface RegionResult {
  region: string;
  inputCount: number;
  urbanCount: number;
  forestCount: number;
  unclassifiedCount: number;
  componentSizes: number[];
  componentsDiscarded: number;
  holesFilled: number;
  finalKept: number;
  finalKeptIds: string[];
}

async function processRegion(spec: RegionSpec): Promise<RegionResult> {
  const { region, bbox } = spec;
  console.log(`\n=== ${region} ===`);
  const landTilesPath = `data/processed/precompute/commune-${region}-land-tiles.json`;
  const tileIds: string[] = JSON.parse(await fs.readFile(landTilesPath, "utf8"));
  const tiles = tileIds.map(parseTile);
  console.log(`[${region}] input tiles: ${tiles.length}`);

  const urbanData = await ensureOsmCache(
    `data/raw/osm/landuse/${region}-urban.json`,
    () => fetchLanduse(bbox, "urban"),
  );
  const forestData = await ensureOsmCache(
    `data/raw/osm/landuse/${region}-forest.json`,
    () => fetchLanduse(bbox, "forest"),
  );
  console.log(
    `[${region}] osm: urban=${urbanData.elements.length} forest=${forestData.elements.length}`,
  );

  const urbanMP = elementsToLV95MultiPoly(urbanData.elements);
  const forestMP = elementsToLV95MultiPoly(forestData.elements);
  console.log(
    `[${region}] polygons: urban=${urbanMP.length} forest=${forestMP.length}`,
  );

  // Classify each tile
  const classification = new Map<string, "URBAN" | "FOREST" | "UNCLASSIFIED">();
  let urbanCount = 0,
    forestCount = 0,
    unclassifiedCount = 0;
  for (const t of tiles) {
    if (pointInLV95MultiPoly(t.cx, t.cy, urbanMP)) {
      classification.set(t.id, "URBAN");
      urbanCount++;
    } else if (pointInLV95MultiPoly(t.cx, t.cy, forestMP)) {
      classification.set(t.id, "FOREST");
      forestCount++;
    } else {
      classification.set(t.id, "UNCLASSIFIED");
      unclassifiedCount++;
    }
  }
  console.log(
    `[${region}] classified: urban=${urbanCount} forest=${forestCount} unclassified=${unclassifiedCount}`,
  );

  // Initial kept set = urban tiles
  const byId = new Map<string, TileXY>();
  for (const t of tiles) byId.set(t.id, t);
  const keptIds = new Set<string>();
  for (const t of tiles) if (classification.get(t.id) === "URBAN") keptIds.add(t.id);

  // Connected components on kept set
  const keptTiles = [...keptIds].map((id) => byId.get(id)!);
  const comps = connectedComponents(keptTiles);
  comps.sort((a, b) => b.length - a.length);
  const componentSizes = comps.map((c) => c.length);
  console.log(
    `[${region}] components: ${comps.length} sizes=[${componentSizes.slice(0, 10).join(",")}${comps.length > 10 ? ",..." : ""}]`,
  );

  // Discard small components (< 8 tiles)
  let componentsDiscarded = 0;
  for (const c of comps) {
    if (c.length < 8) {
      componentsDiscarded++;
      for (const t of c) keptIds.delete(t.id);
    }
  }
  console.log(
    `[${region}] discarded ${componentsDiscarded} components (<8 tiles), kept set now ${keptIds.size}`,
  );

  // Iterative hole-fill: re-add UNCLASSIFIED/FOREST tile if it has ≥3 kept axis-neighbours
  let holesFilled = 0;
  for (let pass = 0; pass < 20; pass++) {
    const added: string[] = [];
    for (const t of tiles) {
      if (keptIds.has(t.id)) continue;
      let n = 0;
      for (const [ne, nn] of neighbours(t)) {
        // look up tile at exact neighbour coords
        // we only consider neighbour-tiles that exist in our INPUT set
        // (otherwise we'd extend beyond commune coverage)
        for (const other of tiles) {
          if (other.e === ne && other.n === nn) {
            if (keptIds.has(other.id)) n++;
            break;
          }
        }
      }
      if (n >= 3) added.push(t.id);
    }
    if (added.length === 0) break;
    for (const id of added) keptIds.add(id);
    holesFilled += added.length;
    console.log(`[${region}] hole-fill pass ${pass + 1}: +${added.length} (total ${keptIds.size})`);
  }

  // Final post-pass: any remaining FOREST tile whose centre is inside an URBAN polygon
  let lateAdded = 0;
  for (const t of tiles) {
    if (keptIds.has(t.id)) continue;
    if (classification.get(t.id) !== "FOREST") continue;
    if (pointInLV95MultiPoly(t.cx, t.cy, urbanMP)) {
      keptIds.add(t.id);
      lateAdded++;
    }
  }
  if (lateAdded > 0)
    console.log(`[${region}] late-add forest∩urban: ${lateAdded} (total ${keptIds.size})`);

  const finalKeptIds = [...keptIds].sort();
  console.log(`[${region}] FINAL kept: ${finalKeptIds.length}  (drop ${tiles.length - finalKeptIds.length})`);

  return {
    region,
    inputCount: tiles.length,
    urbanCount,
    forestCount,
    unclassifiedCount,
    componentSizes,
    componentsDiscarded,
    holesFilled,
    finalKept: finalKeptIds.length,
    finalKeptIds,
  };
}

// Compute Strandbad tiles
interface StrandbadResult {
  added: string[];
  rawPolyTiles: number;
  bufferAdded: number;
}

async function processStrandbad(thunKeptSet: Set<string>): Promise<StrandbadResult> {
  console.log(`\n=== Strandbad Thun ===`);
  const data = await ensureOsmCache(
    "data/raw/osm/strandbad-thun.json",
    fetchStrandbadThun,
  );
  // Inspect names
  const names = data.elements
    .map((e: OverpassElement) => e.tags?.name)
    .filter((n): n is string => !!n);
  console.log(`[strandbad] elements: ${data.elements.length}, names: ${[...new Set(names)].join(" | ")}`);
  // Filter elements whose name contains 'Strandbad' OR which are natural=beach near our coords
  const filtered = data.elements.filter((e: OverpassElement) => {
    const n = e.tags?.name?.toLowerCase() ?? "";
    if (n.includes("strandbad")) return true;
    if (e.tags?.natural === "beach") return true;
    if (e.tags?.leisure === "beach_resort") return true;
    return false;
  });
  console.log(`[strandbad] filtered to ${filtered.length} elements`);
  if (filtered.length === 0) {
    console.warn("[strandbad] EMPTY — fallback to hard-coded centre area");
  }
  const mp = elementsToLV95MultiPoly(filtered);

  // Determine candidate LV95 tile grid covering the polygon
  let minE = +Infinity,
    maxE = -Infinity,
    minN = +Infinity,
    maxN = -Infinity;
  for (const poly of mp) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < minE) minE = x;
        if (x > maxE) maxE = x;
        if (y < minN) minN = y;
        if (y > maxN) maxN = y;
      }
    }
  }
  if (!Number.isFinite(minE)) {
    // Hard-coded fallback near 46.747, 7.640
    const fallback = wgs84ToLv95Precise(7.640, 46.747);
    minE = fallback.easting - 200;
    maxE = fallback.easting + 200;
    minN = fallback.northing - 200;
    maxN = fallback.northing + 200;
    console.warn(`[strandbad] using hard-coded fallback near ${fallback.easting},${fallback.northing}`);
  }
  console.log(`[strandbad] LV95 bbox E=${minE.toFixed(0)}..${maxE.toFixed(0)} N=${minN.toFixed(0)}..${maxN.toFixed(0)}`);

  const TS = 250;
  // Expand the search by 1 tile (buffer) in each direction
  const eStart = Math.floor((minE - TS) / TS) * TS;
  const eEnd = Math.ceil((maxE + TS) / TS) * TS;
  const nStart = Math.floor((minN - TS) / TS) * TS;
  const nEnd = Math.ceil((maxN + TS) / TS) * TS;

  // Tiles whose CENTRE is inside the polygon
  const polyTiles: string[] = [];
  // ALSO tiles whose SQUARE intersects the polygon bbox (the Strandbad polygon
  // is small enough — ~250×270m — that it can sit between tile centres without
  // covering any. So also include tiles that contain any polygon vertex.)
  const polyTileSet = new Set<string>();
  for (let e = eStart; e < eEnd; e += TS) {
    for (let n = nStart; n < nEnd; n += TS) {
      const cx = e + TS / 2;
      const cy = n + TS / 2;
      if (pointInLV95MultiPoly(cx, cy, mp)) {
        const id = `e${e}_n${n}_s${TS}`;
        if (!polyTileSet.has(id)) {
          polyTiles.push(id);
          polyTileSet.add(id);
        }
      }
    }
  }
  // Tile-of-each-vertex inclusion (catches tiny polygons offset from any centre)
  for (const poly of mp) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        const e = Math.floor(x / TS) * TS;
        const n = Math.floor(y / TS) * TS;
        const id = `e${e}_n${n}_s${TS}`;
        if (!polyTileSet.has(id)) {
          polyTiles.push(id);
          polyTileSet.add(id);
        }
      }
    }
  }
  console.log(`[strandbad] tiles intersecting polygon (centres + vertex tiles): ${polyTiles.length}`);

  // 1-tile buffer
  const allKept = new Set<string>(polyTiles);
  for (const id of polyTiles) {
    const t = parseTile(id);
    for (const [ne, nn] of neighbours(t)) {
      allKept.add(`e${ne}_n${nn}_s${TS}`);
    }
  }
  const bufferAdded = allKept.size - polyTiles.length;
  console.log(`[strandbad] +1-tile buffer: +${bufferAdded} (total ${allKept.size})`);

  // Filter tiles whose centre is in Thunersee (we want shoreline land tiles)
  // Use a minimal Thunersee polygon query
  const thunerseeData = await ensureOsmCache(
    "data/raw/osm/thunersee.json",
    () =>
      overpassQuery(`
[out:json][timeout:60];
(
  relation["water"="lake"]["name"="Thunersee"];
  relation["natural"="water"]["name"="Thunersee"];
);
out geom;
`),
  );
  const lakeMP = elementsToLV95MultiPoly(thunerseeData.elements);
  console.log(`[strandbad] Thunersee polys: ${lakeMP.length}`);

  const finalAdded: string[] = [];
  let droppedLake = 0;
  for (const id of allKept) {
    if (thunKeptSet.has(id)) continue; // already kept by urban filter
    const t = parseTile(id);
    if (pointInLV95MultiPoly(t.cx, t.cy, lakeMP)) {
      // tile centre in lake; check if at least one axis-neighbour is land (= NOT in lake)
      let oneSideLand = false;
      for (const [ne, nn] of neighbours(t)) {
        const ncx = ne + t.s / 2;
        const ncy = nn + t.s / 2;
        if (!pointInLV95MultiPoly(ncx, ncy, lakeMP)) {
          oneSideLand = true;
          break;
        }
      }
      if (!oneSideLand) {
        droppedLake++;
        continue;
      }
    }
    finalAdded.push(id);
  }
  finalAdded.sort();
  console.log(`[strandbad] dropped purely-in-lake tiles: ${droppedLake}`);
  console.log(`[strandbad] FINAL new added (not already kept): ${finalAdded.length}`);

  return {
    added: finalAdded,
    rawPolyTiles: polyTiles.length,
    bufferAdded,
  };
}

async function main() {
  const results: RegionResult[] = [];
  for (const spec of REGIONS) {
    results.push(await processRegion(spec));
  }

  const thunKept = new Set(results.find((r) => r.region === "thun")!.finalKeptIds);
  const strandbad = await processStrandbad(thunKept);
  for (const id of strandbad.added) thunKept.add(id);
  // Update thun result
  const thunRes = results.find((r) => r.region === "thun")!;
  thunRes.finalKeptIds = [...thunKept].sort();
  thunRes.finalKept = thunRes.finalKeptIds.length;

  // Write commune-{region}-land-tiles.json
  for (const r of results) {
    const out = `data/processed/precompute/commune-${r.region}-land-tiles.json`;
    await fs.writeFile(out, JSON.stringify(r.finalKeptIds, null, 2) + "\n", "utf8");
    console.log(`[${r.region}] wrote ${r.finalKeptIds.length} → ${out}`);
  }

  // Update top-priority JSON
  const tpPath = "data/processed/precompute/high-value-tile-selection.top-priority.json";
  const tp = JSON.parse(await fs.readFile(tpPath, "utf8"));
  const targetRegions = new Set(["bern", "zurich", "thun"]);
  const keptByRegion = new Map<string, Set<string>>();
  for (const r of results) keptByRegion.set(r.region, new Set(r.finalKeptIds));

  const beforeTp = tp.tiles.length;
  const newTiles: Array<{ region: string; tileId: string; group: string }> = [];
  for (const t of tp.tiles) {
    if (!targetRegions.has(t.region)) {
      newTiles.push(t);
      continue;
    }
    const kept = keptByRegion.get(t.region)!;
    if (kept.has(t.tileId)) newTiles.push(t);
  }
  // For thun, append any Strandbad tiles not already present
  const existingThun = new Set(
    newTiles.filter((t) => t.region === "thun").map((t) => t.tileId),
  );
  let strandbadAddedToTp = 0;
  for (const tid of strandbad.added) {
    if (!existingThun.has(tid)) {
      newTiles.push({ region: "thun", tileId: tid, group: "thun-city" });
      strandbadAddedToTp++;
    }
  }
  tp.tiles = newTiles;
  tp.generatedAt = new Date().toISOString();
  tp.source =
    (tp.source as string) +
    ` — bern/zurich/thun trimmed to urban+contiguous via OSM landuse (drop forest/farmland singletons, hole-fill ≥3/4) + Strandbad Thun lakeside added (2026-05-13)`;

  await fs.writeFile(tpPath, JSON.stringify(tp, null, 2) + "\n", "utf8");
  console.log(
    `\n[top-priority] tiles: ${beforeTp} → ${tp.tiles.length} (strandbad added to TP: ${strandbadAddedToTp})`,
  );

  // Final report
  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(
      `${r.region.padEnd(8)} in=${r.inputCount} urban=${r.urbanCount} forest=${r.forestCount} unclass=${r.unclassifiedCount} compsDisc=${r.componentsDiscarded} holesFilled=${r.holesFilled} OUT=${r.finalKept} (largest comps: ${r.componentSizes.slice(0, 5).join(",")})`,
    );
  }
  console.log(`strandbad added: ${strandbad.added.length} (raw polyTiles=${strandbad.rawPolyTiles}, buffer+=${strandbad.bufferAdded})`);
}

main().catch((e) => {
  console.error(`[filter-urban] Erreur : ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exitCode = 1;
});
