import fs from "node:fs/promises";
import path from "node:path";

import type { BBox } from "../../src/lib/config/lausanne";
import { LAUSANNE_LOCAL_BBOX } from "../../src/lib/config/lausanne";
import { NYON_LOCAL_BBOX } from "../../src/lib/config/nyon";
import { MORGES_LOCAL_BBOX } from "../../src/lib/config/morges";
import { GENEVE_LOCAL_BBOX } from "../../src/lib/config/geneve";
import { VEVEY_LOCAL_BBOX } from "../../src/lib/config/vevey";
import { VEVEY_CITY_LOCAL_BBOX } from "../../src/lib/config/vevey_city";
import { NEUCHATEL_LOCAL_BBOX } from "../../src/lib/config/neuchatel";
import { LA_CHAUX_DE_FONDS_LOCAL_BBOX } from "../../src/lib/config/la_chaux_de_fonds";
import { PROCESSED_PLACES_DIR, RAW_OSM_ROOT } from "../../src/lib/storage/data-paths";

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  version: number;
  generator: string;
  osm3s: Record<string, unknown>;
  elements: OverpassElement[];
}

interface NormalizedPlace {
  id: string;
  source: "osm";
  osmType: "node" | "way" | "relation";
  osmId: number;
  name: string;
  category: "park" | "terrace_candidate";
  subcategory: string;
  hasOutdoorSeating: boolean;
  lat: number;
  lon: number;
  region: string;
  tags: Record<string, string>;
}

const REGION_BBOXES: Record<string, BBox> = {
  lausanne: LAUSANNE_LOCAL_BBOX,
  nyon: NYON_LOCAL_BBOX,
  morges: MORGES_LOCAL_BBOX,
  geneve: GENEVE_LOCAL_BBOX,
  vevey: VEVEY_LOCAL_BBOX,
  vevey_city: VEVEY_CITY_LOCAL_BBOX,
  neuchatel: NEUCHATEL_LOCAL_BBOX,
  la_chaux_de_fonds: LA_CHAUX_DE_FONDS_LOCAL_BBOX,
};

const ALL_REGIONS = Object.keys(REGION_BBOXES);

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildOverpassQuery(bbox: BBox): string {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const bboxStr = `${minLat},${minLon},${maxLat},${maxLon}`;
  return `
[out:json][timeout:120];
(
  node["leisure"="park"](${bboxStr});
  way["leisure"="park"](${bboxStr});
  relation["leisure"="park"](${bboxStr});
  node["amenity"~"^(cafe|bar|pub|restaurant|biergarten|fast_food|food_court)$"](${bboxStr});
  way["amenity"~"^(cafe|bar|pub|restaurant|biergarten|fast_food|food_court)$"](${bboxStr});
  relation["amenity"~"^(cafe|bar|pub|restaurant|biergarten|fast_food|food_court)$"](${bboxStr});
);
out center tags;
  `.trim();
}

function getElementCoordinates(element: OverpassElement): { lat: number; lon: number } | null {
  if (element.lat !== undefined && element.lon !== undefined) {
    return { lat: element.lat, lon: element.lon };
  }
  if (element.center?.lat !== undefined && element.center?.lon !== undefined) {
    return { lat: element.center.lat, lon: element.center.lon };
  }
  return null;
}

function normalizePlace(element: OverpassElement, region: string): NormalizedPlace | null {
  const tags = element.tags ?? {};
  const coordinates = getElementCoordinates(element);
  if (!coordinates) return null;

  const amenity = tags.amenity;
  const leisure = tags.leisure;
  let category: NormalizedPlace["category"] | null = null;
  let subcategory = "unknown";

  if (leisure === "park") {
    category = "park";
    subcategory = "park";
  } else if (
    amenity === "cafe" ||
    amenity === "bar" ||
    amenity === "pub" ||
    amenity === "restaurant" ||
    amenity === "biergarten" ||
    amenity === "fast_food" ||
    amenity === "food_court"
  ) {
    category = "terrace_candidate";
    subcategory = amenity;
  }
  if (!category) return null;

  const hasOutdoorSeating =
    tags.outdoor_seating === "yes" ||
    tags["terrace"] === "yes" ||
    tags["garden"] === "yes";

  return {
    id: `osm:${element.type}:${element.id}`,
    source: "osm",
    osmType: element.type,
    osmId: element.id,
    name: tags.name ?? `${subcategory}-${element.type}-${element.id}`,
    category,
    subcategory,
    hasOutdoorSeating,
    lat: Math.round(coordinates.lat * 1_000_000) / 1_000_000,
    lon: Math.round(coordinates.lon * 1_000_000) / 1_000_000,
    region,
    tags,
  };
}

async function fetchOverpassData(query: string): Promise<OverpassResponse> {
  let lastError: unknown = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "User-Agent": "mappy-hour/1.0 (data ingest)" },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(180_000),
        });
        if (response.status === 429) {
          const delay = (attempt + 1) * 15_000;
          console.error(`[places] ${endpoint} rate-limited (attempt ${attempt + 1}/3), retry in ${delay / 1000}s...`);
          await sleep(delay);
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${endpoint}`);
        return (await response.json()) as OverpassResponse;
      } catch (error) {
        lastError = error;
        console.error(`[places] ${endpoint} attempt ${attempt + 1}/3 failed: ${error instanceof Error ? error.message : error}`);
        if (attempt < 2) await sleep(5_000);
      }
    }
  }
  throw new Error(
    `All Overpass endpoints failed. Last error: ${lastError instanceof Error ? lastError.message : "Unknown error"}`,
  );
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function parseArgs(argv: string[]): { regions: string[] } {
  let regions: string[] = ALL_REGIONS;
  for (const arg of argv) {
    if (arg.startsWith("--regions=")) {
      regions = arg
        .slice("--regions=".length)
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
    }
  }
  for (const r of regions) {
    if (!REGION_BBOXES[r]) {
      throw new Error(`Unknown region "${r}". Known: ${ALL_REGIONS.join(", ")}`);
    }
  }
  return { regions };
}

interface PerRegionFile {
  generatedAt: string;
  source: string;
  bbox: BBox;
  totalPlaces: number;
  categories: { parks: number; terraceCandidates: number; outdoorSeatingYes: number };
  places: NormalizedPlace[];
}

function buildPerRegionPayload(region: string, places: NormalizedPlace[]): PerRegionFile {
  return {
    generatedAt: new Date().toISOString(),
    source: "Overpass",
    bbox: REGION_BBOXES[region],
    totalPlaces: places.length,
    categories: {
      parks: places.filter((p) => p.category === "park").length,
      terraceCandidates: places.filter((p) => p.category === "terrace_candidate").length,
      outdoorSeatingYes: places.filter((p) => p.hasOutdoorSeating).length,
    },
    places,
  };
}

async function main() {
  const { regions } = parseArgs(process.argv.slice(2));
  console.log(`[places] Ingesting regions: ${regions.join(", ")}`);

  const perRegion = new Map<string, NormalizedPlace[]>();

  for (const region of regions) {
    const bbox = REGION_BBOXES[region];
    const query = buildOverpassQuery(bbox);
    console.log(`[places] [${region}] querying Overpass…`);
    const rawData = await fetchOverpassData(query);

    const normalized = rawData.elements
      .map((el) => normalizePlace(el, region))
      .filter((v): v is NormalizedPlace => v !== null)
      .sort((a, b) => {
        const c = a.category.localeCompare(b.category);
        return c !== 0 ? c : a.name.localeCompare(b.name);
      });

    perRegion.set(region, normalized);

    const rawPath = path.join(RAW_OSM_ROOT, `${region}-places-overpass.json`);
    await ensureParentDirectory(rawPath);
    await fs.writeFile(
      rawPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), source: "Overpass", bbox, query, response: rawData }, null, 2),
      "utf8",
    );

    const perRegionPath = path.join(PROCESSED_PLACES_DIR, `${region}-places.json`);
    await ensureParentDirectory(perRegionPath);
    await fs.writeFile(perRegionPath, JSON.stringify(buildPerRegionPayload(region, normalized), null, 2), "utf8");
    console.log(`[places] [${region}] wrote ${normalized.length} places to ${perRegionPath}`);
  }

  // Combined file with version (semver placeholder — bumped by publish-places).
  const allPlaces: NormalizedPlace[] = [];
  for (const list of perRegion.values()) allPlaces.push(...list);

  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const region of regions) {
    const [a, b, c, d] = REGION_BBOXES[region];
    if (a < minLon) minLon = a;
    if (b < minLat) minLat = b;
    if (c > maxLon) maxLon = c;
    if (d > maxLat) maxLat = d;
  }

  const combined = {
    version: "0.0.0",
    generatedAt: new Date().toISOString(),
    source: "Overpass (combined)",
    regions,
    bbox: [minLon, minLat, maxLon, maxLat] as BBox,
    totalPlaces: allPlaces.length,
    categories: {
      parks: allPlaces.filter((p) => p.category === "park").length,
      terraceCandidates: allPlaces.filter((p) => p.category === "terrace_candidate").length,
      outdoorSeatingYes: allPlaces.filter((p) => p.hasOutdoorSeating).length,
    },
    places: allPlaces,
  };

  const combinedPath = path.join(PROCESSED_PLACES_DIR, "places.json");
  await ensureParentDirectory(combinedPath);
  await fs.writeFile(combinedPath, JSON.stringify(combined, null, 2), "utf8");
  console.log(`[places] wrote combined places.json (${allPlaces.length} places across ${regions.length} regions) to ${combinedPath}`);
}

main().catch((error) => {
  console.error(`[places] Failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
