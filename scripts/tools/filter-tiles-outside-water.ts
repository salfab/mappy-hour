/**
 * Filtre une liste de tuiles LV95 250m en retirant celles dont le centre est
 * à l'intérieur d'un polygone d'eau OSM (par défaut : Lac Léman).
 *
 * Cas d'usage : `commune-vevey-tiles.json` couvre la juridiction lacustre
 * de la commune (~3 km au large). On veut exclure les tuiles purement lac.
 *
 * Usage :
 *   npx tsx scripts/tools/filter-tiles-outside-water.ts \
 *     --input=data/processed/precompute/commune-vevey-tiles.json \
 *     --output=data/processed/precompute/commune-vevey-land-tiles.json \
 *     --water-name="Lac Léman"
 */

import fs from "node:fs/promises";
import path from "node:path";

import polyClip from "polygon-clipping";

import { wgs84ToLv95Precise } from "../../src/lib/geo/projection";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];

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

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function coordEq(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function stitchRings(rels: OverpassRelation[], role: "outer" | "inner"): Ring[] {
  const ways: Ring[] = [];
  for (const rel of rels) {
    for (const m of rel.members) {
      if (m.type !== "way" || m.role !== role || !m.geometry) continue;
      ways.push(m.geometry.map((p) => [p.lon, p.lat] as [number, number]));
    }
  }
  const remaining: Ring[] = ways.map((w) => [...w]);
  const rings: Ring[] = [];
  while (remaining.length > 0) {
    const ring = remaining.shift()!;
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

async function fetchWaterRelations(name: string): Promise<OverpassRelation[]> {
  // Query by name regex on multiple name-* fields, because the canonical OSM
  // name of Lac Léman is "Le Léman", not "Lac Léman".
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
        const json = (await resp.json()) as { elements: OverpassRelation[] };
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
    if (attempt < 2) await sleep(5000 * (attempt + 1));
  }
  throw new Error(`Overpass failed: ${lastErr instanceof Error ? lastErr.message : "unknown"}`);
}

// Ray-casting point-in-polygon in LV95 space against a MultiPolygon
function pointInMultiPoly(x: number, y: number, mp: polyClip.MultiPolygon): boolean {
  let inside = false;
  for (const poly of mp) {
    for (let r = 0; r < poly.length; r++) {
      const ring = poly[r];
      let rInside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersect) rInside = !rInside;
      }
      if (r === 0) {
        if (rInside) inside = !inside;
      } else if (rInside) {
        // inner ring (hole) flips it back
        inside = !inside;
      }
    }
  }
  return inside;
}

interface Args {
  input: string;
  output: string;
  waterName: string;
}

function parseArgs(argv: string[]): Args {
  let input = "";
  let output = "";
  let waterName = "Lac Léman";
  for (const a of argv) {
    if (a.startsWith("--input=")) input = a.slice("--input=".length);
    else if (a.startsWith("--output=")) output = a.slice("--output=".length);
    else if (a.startsWith("--water-name=")) waterName = a.slice("--water-name=".length);
  }
  if (!input || !output) throw new Error("Usage: --input=<tiles.json> --output=<filtered.json> [--water-name=\"Lac Léman\"]");
  return { input, output, waterName };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const tileIds: string[] = JSON.parse(await fs.readFile(args.input, "utf8"));
  console.log(`[filter] ${tileIds.length} tuiles d'entrée`);

  const rels = await fetchWaterRelations(args.waterName);
  const outerRings = stitchRings(rels, "outer");
  const innerRings = stitchRings(rels, "inner");
  console.log(`[water] ${outerRings.length} outer ring(s), ${innerRings.length} inner ring(s)`);

  // Build LV95 MultiPolygon: each outer ring → one polygon (we lose ring-to-hole pairing,
  // but for Lac Léman the inner rings are small islands not adjacent to Vevey, so this is fine
  // for a point-in-polygon test that decides "is this tile center in the lake")
  const lakeMp: polyClip.MultiPolygon = outerRings.map((ring) => [
    ring.map(([lon, lat]) => {
      const { easting, northing } = wgs84ToLv95Precise(lon, lat);
      return [easting, northing] as [number, number];
    }),
  ]);
  // Add inner rings as additional polygons that will toggle inside/outside (islands = land)
  for (const ring of innerRings) {
    lakeMp.push([
      ring.map(([lon, lat]) => {
        const { easting, northing } = wgs84ToLv95Precise(lon, lat);
        return [easting, northing] as [number, number];
      }),
    ]);
  }

  const kept: string[] = [];
  const dropped: string[] = [];
  for (const tid of tileIds) {
    const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tid);
    if (!m) throw new Error(`tileId invalide : ${tid}`);
    const e = Number(m[1]);
    const n = Number(m[2]);
    const s = Number(m[3]);
    const cx = e + s / 2;
    const cy = n + s / 2;
    if (pointInMultiPoly(cx, cy, lakeMp)) {
      dropped.push(tid);
    } else {
      kept.push(tid);
    }
  }

  console.log(`[filter] gardées : ${kept.length}  •  retirées (centre dans le lac) : ${dropped.length}`);

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, JSON.stringify(kept, null, 2) + "\n", "utf8");
  console.log(`[filter] écrit → ${args.output}`);
}

main().catch((e) => {
  console.error(`[filter] Erreur : ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
