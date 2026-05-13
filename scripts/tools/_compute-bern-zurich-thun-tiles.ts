/**
 * One-shot: from already-downloaded commune polygons (data/raw/osm/communes/{bern,zurich,thun}.json),
 * compute the 250m LV95 tile coverage restricted to each region's localBbox
 * (centre-ville only, exclut les grandes banlieues).
 *
 * Output:
 *   data/processed/precompute/commune-{bern,zurich,thun}-tiles.json  (raw, bbox-clipped)
 *
 * For zurich + thun, follow up with filter-tiles-outside-water.ts to drop
 * lake tiles (Zürichsee / Thunersee) → -land-tiles.json variants.
 */

import fs from "node:fs/promises";
import path from "node:path";

import polyClip from "polygon-clipping";

import { wgs84ToLv95Precise } from "../../src/lib/geo/projection";
import { BERN_LOCAL_BBOX } from "../../src/lib/config/bern";
import { ZURICH_LOCAL_BBOX } from "../../src/lib/config/zurich";
import { THUN_LOCAL_BBOX } from "../../src/lib/config/thun";

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

function stitchRings(relation: OverpassRelation, role: "outer" | "inner"): Ring[] {
  const ways = relation.members
    .filter((m) => m.type === "way" && m.role === role && m.geometry)
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

const TILE_SIZE = 250;

const REGIONS: Record<string, { rawFile: string; localBbox: readonly [number, number, number, number]; outFile: string }> = {
  bern: {
    rawFile: "data/raw/osm/communes/bern.json",
    localBbox: BERN_LOCAL_BBOX,
    outFile: "data/processed/precompute/commune-bern-tiles.json",
  },
  zurich: {
    rawFile: "data/raw/osm/communes/zurich.json",
    localBbox: ZURICH_LOCAL_BBOX,
    outFile: "data/processed/precompute/commune-zurich-tiles.json",
  },
  thun: {
    rawFile: "data/raw/osm/communes/thun.json",
    localBbox: THUN_LOCAL_BBOX,
    outFile: "data/processed/precompute/commune-thun-tiles.json",
  },
};

async function computeForRegion(region: string): Promise<{ raw: number; kept: number; out: string }> {
  const cfg = REGIONS[region];
  const data = JSON.parse(await fs.readFile(cfg.rawFile, "utf8")) as { elements: OverpassRelation[] };
  const rel = data.elements.find((e) => e.type === "relation");
  if (!rel) throw new Error(`No relation in ${cfg.rawFile}`);
  const outerRings = stitchRings(rel, "outer");
  const innerRings = stitchRings(rel, "inner");
  console.log(`[${region}] rel=${rel.id} name="${rel.tags?.name}" outer=${outerRings.length} inner=${innerRings.length}`);

  // Build LV95 MultiPolygon (outer rings only; inner = lake/hole, but we want LAND
  // so excluding inner rings produces commune-land coverage)
  const lv95MultiPoly: polyClip.MultiPolygon = outerRings.map((ring) => {
    const outer = ring.map(([lon, lat]) => {
      const { easting, northing } = wgs84ToLv95Precise(lon, lat);
      return [easting, northing] as [number, number];
    });
    return [outer];
  });

  // bbox-clip rectangle in LV95
  const [minLon, minLat, maxLon, maxLat] = cfg.localBbox;
  const corners = [
    wgs84ToLv95Precise(minLon, minLat),
    wgs84ToLv95Precise(minLon, maxLat),
    wgs84ToLv95Precise(maxLon, minLat),
    wgs84ToLv95Precise(maxLon, maxLat),
  ];
  const bMinE = Math.min(...corners.map((c) => c.easting));
  const bMaxE = Math.max(...corners.map((c) => c.easting));
  const bMinN = Math.min(...corners.map((c) => c.northing));
  const bMaxN = Math.max(...corners.map((c) => c.northing));

  const tMinX = Math.floor(bMinE / TILE_SIZE) * TILE_SIZE;
  const tMaxX = Math.ceil(bMaxE / TILE_SIZE) * TILE_SIZE;
  const tMinY = Math.floor(bMinN / TILE_SIZE) * TILE_SIZE;
  const tMaxY = Math.ceil(bMaxN / TILE_SIZE) * TILE_SIZE;
  console.log(`[${region}] bbox LV95: E=${tMinX}..${tMaxX} N=${tMinY}..${tMaxY}`);

  const tileIds: string[] = [];
  let rawCount = 0;
  for (let e = tMinX; e < tMaxX; e += TILE_SIZE) {
    for (let n = tMinY; n < tMaxY; n += TILE_SIZE) {
      rawCount++;
      const tile: polyClip.Polygon = [
        [
          [e, n],
          [e + TILE_SIZE, n],
          [e + TILE_SIZE, n + TILE_SIZE],
          [e, n + TILE_SIZE],
          [e, n],
        ],
      ];
      const inter = polyClip.intersection(tile, lv95MultiPoly);
      if (inter.length > 0) {
        tileIds.push(`e${e}_n${n}_s${TILE_SIZE}`);
      }
    }
  }
  tileIds.sort();
  console.log(`[${region}] ${rawCount} candidats bbox → ${tileIds.length} tuiles intersectent la commune ∩ bbox`);

  await fs.mkdir(path.dirname(cfg.outFile), { recursive: true });
  await fs.writeFile(cfg.outFile, JSON.stringify(tileIds, null, 2) + "\n", "utf8");
  console.log(`[${region}] écrit → ${cfg.outFile}`);
  return { raw: rawCount, kept: tileIds.length, out: cfg.outFile };
}

async function main() {
  const regions = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const targets = regions.length > 0 ? regions : ["bern", "zurich", "thun"];
  const summary: Record<string, { raw: number; kept: number; out: string }> = {};
  for (const r of targets) {
    if (!REGIONS[r]) throw new Error(`Unknown region: ${r}`);
    summary[r] = await computeForRegion(r);
  }
  console.log("\n=== Summary ===");
  for (const [r, s] of Object.entries(summary)) {
    console.log(`${r.padEnd(8)} raw=${s.raw} → kept=${s.kept}  ${s.out}`);
  }
}

main().catch((e) => {
  console.error(`[bzt] Erreur : ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
