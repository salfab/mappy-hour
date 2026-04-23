/**
 * Calcule la liste des tuiles LV95 (250m) intersectant une ou plusieurs communes
 * OSM (admin_level=8). Utilisé pour injecter dans build-high-value-tile-selection.ts
 * une couverture complète de Genève + Carouge (ou autre).
 *
 * Usage :
 *   npx tsx scripts/tools/compute-commune-tile-coverage.ts --communes="Genève,Carouge" [--tile-size=250]
 */

import polyClip from "polygon-clipping";

import { wgs84ToLv95, lv95ToWgs84 } from "../../src/lib/geo/projection";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

type Ring = Array<[number, number]>; // [lon, lat]

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
          const rev = [...w].reverse();
          ring.push(...rev.slice(1));
          remaining.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    if (!coordEq(ring[0], ring[ring.length - 1])) {
      ring.push(ring[0]); // force closure (should already be closed)
    }
    rings.push(ring);
  }
  return rings;
}

async function fetchCommuneRelation(communeName: string): Promise<OverpassRelation> {
  const query = `
[out:json][timeout:60];
relation["boundary"="administrative"]["admin_level"="8"]["name"="${communeName}"];
out geom;
`;
  const maxAttempts = 3;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const resp = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (resp.status === 429) {
          throw new Error(`HTTP 429 (rate-limited)`);
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = (await resp.json()) as { elements: OverpassRelation[] };
        const relations = json.elements.filter((e) => e.type === "relation");
        if (relations.length === 0) throw new Error(`No admin_level=8 relation named "${communeName}"`);
        if (relations.length > 1) {
          console.warn(
            `[commune] ${relations.length} relations matching "${communeName}"; using first (id=${relations[0].id})`,
          );
        }
        return relations[0];
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[commune] attempt ${attempt + 1}/${maxAttempts} ${endpoint.replace(/https?:\/\//, "")}: ${msg}`);
      }
    }
    if (attempt < maxAttempts - 1) {
      const waitMs = 5000 * (attempt + 1);
      console.warn(`[commune] all endpoints failed for "${communeName}", waiting ${waitMs}ms before retry…`);
      await sleep(waitMs);
    }
  }
  throw new Error(
    `Overpass failed for commune="${communeName}" after ${maxAttempts} attempts on ${OVERPASS_ENDPOINTS.length} endpoints: ${
      lastError instanceof Error ? lastError.message : "unknown"
    }`,
  );
}

function ringBboxLv95(ring: Ring): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [lon, lat] of ring) {
    const { easting, northing } = wgs84ToLv95(lon, lat);
    if (easting < minX) minX = easting;
    if (easting > maxX) maxX = easting;
    if (northing < minY) minY = northing;
    if (northing > maxY) maxY = northing;
  }
  return { minX, minY, maxX, maxY };
}

interface Args {
  communes: string[];
  tileSizeMeters: number;
  output: string | null;
}

function parseArgs(argv: string[]): Args {
  let communes: string[] = [];
  let tileSizeMeters = 250;
  let output: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--communes=")) communes = a.slice("--communes=".length).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--tile-size=")) tileSizeMeters = Number(a.slice("--tile-size=".length));
    else if (a.startsWith("--output=")) output = a.slice("--output=".length);
  }
  if (communes.length === 0) throw new Error("Usage: --communes=\"Genève,Carouge\"");
  if (!Number.isFinite(tileSizeMeters) || tileSizeMeters <= 0) throw new Error("--tile-size invalide");
  return { communes, tileSizeMeters, output };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1) Fetch each commune relation + stitch outer rings
  const allRings: Ring[] = [];
  for (const commune of args.communes) {
    console.log(`[commune] fetching "${commune}"…`);
    const relation = await fetchCommuneRelation(commune);
    const rings = stitchOuterRings(relation);
    console.log(`[commune] "${commune}" id=${relation.id} → ${rings.length} outer ring(s)`);
    for (const r of rings) allRings.push(r);
  }

  if (allRings.length === 0) throw new Error("No rings collected.");

  // 2) Build polygon-clipping MultiPolygon in LV95 space.
  //    Each outer ring → its own polygon (we ignore inner/holes; rare for communes).
  const lv95MultiPoly: polyClip.MultiPolygon = allRings.map((ring) => [
    ring.map(([lon, lat]) => {
      const { easting, northing } = wgs84ToLv95(lon, lat);
      return [easting, northing] as [number, number];
    }),
  ]);

  // 3) Compute global bbox of all communes
  const communesBbox = allRings.reduce(
    (acc, r) => {
      const b = ringBboxLv95(r);
      return {
        minX: Math.min(acc.minX, b.minX),
        minY: Math.min(acc.minY, b.minY),
        maxX: Math.max(acc.maxX, b.maxX),
        maxY: Math.max(acc.maxY, b.maxY),
      };
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );

  const tileSize = args.tileSizeMeters;
  const tMinX = Math.floor(communesBbox.minX / tileSize) * tileSize;
  const tMaxX = Math.ceil(communesBbox.maxX / tileSize) * tileSize;
  const tMinY = Math.floor(communesBbox.minY / tileSize) * tileSize;
  const tMaxY = Math.ceil(communesBbox.maxY / tileSize) * tileSize;
  const candidateCount = ((tMaxX - tMinX) / tileSize) * ((tMaxY - tMinY) / tileSize);
  console.log(
    `[commune] bbox LV95: E=${tMinX}..${tMaxX} N=${tMinY}..${tMaxY} → ${candidateCount} candidate tiles`,
  );

  // 4) For each candidate tile, test intersection with the MultiPolygon.
  const tileIds: string[] = [];
  for (let e = tMinX; e < tMaxX; e += tileSize) {
    for (let n = tMinY; n < tMaxY; n += tileSize) {
      const tile: polyClip.Polygon = [
        [
          [e, n],
          [e + tileSize, n],
          [e + tileSize, n + tileSize],
          [e, n + tileSize],
          [e, n],
        ],
      ];
      const inter = polyClip.intersection(tile, lv95MultiPoly);
      if (inter.length > 0) {
        tileIds.push(`e${e}_n${n}_s${tileSize}`);
      }
    }
  }
  tileIds.sort();

  console.log(`[commune] ${tileIds.length} tuiles intersectent la couverture communale`);
  if (args.output) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = await import("node:path");
    await mkdir(path.dirname(args.output), { recursive: true });
    await writeFile(args.output, JSON.stringify(tileIds, null, 2) + "\n", "utf8");
    console.log(`[commune] écrit → ${args.output}`);
  } else {
    console.log(`\n${JSON.stringify(tileIds, null, 2)}`);
  }
}

main().catch((e) => {
  console.error(`[commune] Erreur : ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
