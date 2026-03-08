import fs from "node:fs/promises";
import path from "node:path";

import { LAUSANNE_LOCAL_BBOX } from "../../src/lib/config/lausanne";
import {
  PROCESSED_LAUSANNE_PLACES_PATH,
  RAW_LAUSANNE_PLACES_PATH,
} from "../../src/lib/storage/data-paths";

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: {
    lat: number;
    lon: number;
  };
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
  tags: Record<string, string>;
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

function buildOverpassQuery(): string {
  const [minLon, minLat, maxLon, maxLat] = LAUSANNE_LOCAL_BBOX;
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;

  return `
[out:json][timeout:120];
(
  node["leisure"="park"](${bbox});
  way["leisure"="park"](${bbox});
  relation["leisure"="park"](${bbox});
  node["amenity"~"^(cafe|bar|pub|restaurant|biergarten|fast_food|food_court)$"](${bbox});
  way["amenity"~"^(cafe|bar|pub|restaurant|biergarten|fast_food|food_court)$"](${bbox});
  relation["amenity"~"^(cafe|bar|pub|restaurant|biergarten|fast_food|food_court)$"](${bbox});
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

function normalizePlace(element: OverpassElement): NormalizedPlace | null {
  const tags = element.tags ?? {};
  const coordinates = getElementCoordinates(element);
  if (!coordinates) {
    return null;
  }

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

  if (!category) {
    return null;
  }

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
    tags,
  };
}

async function fetchOverpassData(query: string): Promise<OverpassResponse> {
  let lastError: unknown = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: `data=${encodeURIComponent(query)}`,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${endpoint}`);
      }

      return (await response.json()) as OverpassResponse;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `All Overpass endpoints failed. Last error: ${
      lastError instanceof Error ? lastError.message : "Unknown error"
    }`,
  );
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function main() {
  const query = buildOverpassQuery();
  const rawData = await fetchOverpassData(query);

  const normalizedPlaces = rawData.elements
    .map(normalizePlace)
    .filter((value): value is NormalizedPlace => value !== null)
    .sort((a, b) => {
      const categoryOrder = a.category.localeCompare(b.category);
      if (categoryOrder !== 0) {
        return categoryOrder;
      }
      return a.name.localeCompare(b.name);
    });

  const rawPayload = {
    generatedAt: new Date().toISOString(),
    source: "Overpass",
    bbox: LAUSANNE_LOCAL_BBOX,
    query,
    response: rawData,
  };

  const processedPayload = {
    generatedAt: new Date().toISOString(),
    source: "Overpass",
    bbox: LAUSANNE_LOCAL_BBOX,
    totalPlaces: normalizedPlaces.length,
    categories: {
      parks: normalizedPlaces.filter((place) => place.category === "park").length,
      terraceCandidates: normalizedPlaces.filter(
        (place) => place.category === "terrace_candidate",
      ).length,
      outdoorSeatingYes: normalizedPlaces.filter((place) => place.hasOutdoorSeating)
        .length,
    },
    places: normalizedPlaces,
  };

  await ensureParentDirectory(RAW_LAUSANNE_PLACES_PATH);
  await fs.writeFile(
    RAW_LAUSANNE_PLACES_PATH,
    JSON.stringify(rawPayload, null, 2),
    "utf8",
  );

  await ensureParentDirectory(PROCESSED_LAUSANNE_PLACES_PATH);
  await fs.writeFile(
    PROCESSED_LAUSANNE_PLACES_PATH,
    JSON.stringify(processedPayload, null, 2),
    "utf8",
  );

  console.log(
    `[places] Wrote ${normalizedPlaces.length} places to ${PROCESSED_LAUSANNE_PLACES_PATH}.`,
  );
}

main().catch((error) => {
  console.error(
    `[places] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
