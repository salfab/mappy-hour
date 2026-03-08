import fs from "node:fs/promises";

import { z } from "zod";

import {
  PROCESSED_LAUSANNE_PLACES_PATH,
  PROCESSED_NYON_PLACES_PATH,
} from "@/lib/storage/data-paths";

const placeSchema = z.object({
  id: z.string(),
  source: z.literal("osm"),
  osmType: z.enum(["node", "way", "relation"]),
  osmId: z.number(),
  name: z.string(),
  category: z.enum(["park", "terrace_candidate"]),
  subcategory: z.string(),
  hasOutdoorSeating: z.boolean(),
  lat: z.number(),
  lon: z.number(),
  tags: z.record(z.string(), z.string()),
});

const placesFileSchema = z.object({
  generatedAt: z.string(),
  source: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  totalPlaces: z.number(),
  categories: z.object({
    parks: z.number(),
    terraceCandidates: z.number(),
    outdoorSeatingYes: z.number(),
  }),
  places: z.array(placeSchema),
});

export type LausannePlace = z.infer<typeof placeSchema>;
export type LausannePlacesFile = z.infer<typeof placesFileSchema>;
export type PlacesFile = z.infer<typeof placesFileSchema>;
type PlacesRegion = "lausanne" | "nyon";

const REGION_PATHS: Record<PlacesRegion, string> = {
  lausanne: PROCESSED_LAUSANNE_PLACES_PATH,
  nyon: PROCESSED_NYON_PLACES_PATH,
};

const cacheByRegion: Partial<Record<PlacesRegion, PlacesFile | null>> = {};
let combinedCache: PlacesFile | null | undefined;

async function loadPlacesFromPath(filePath: string): Promise<PlacesFile | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return placesFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}

export async function loadPlacesByRegion(
  region: PlacesRegion,
): Promise<PlacesFile | null> {
  const cached = cacheByRegion[region];
  if (cached !== undefined) {
    return cached;
  }

  const loaded = await loadPlacesFromPath(REGION_PATHS[region]);
  cacheByRegion[region] = loaded;
  return loaded;
}

export async function loadAllPlaces(): Promise<PlacesFile | null> {
  if (combinedCache !== undefined) {
    return combinedCache;
  }

  const files = await Promise.all(
    (Object.keys(REGION_PATHS) as PlacesRegion[]).map((region) =>
      loadPlacesByRegion(region),
    ),
  );
  const existing = files.filter((file): file is PlacesFile => file !== null);
  if (existing.length === 0) {
    combinedCache = null;
    return combinedCache;
  }

  const byId = new Map<string, PlacesFile["places"][number]>();
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const file of existing) {
    const [bboxMinLon, bboxMinLat, bboxMaxLon, bboxMaxLat] = file.bbox;
    minLon = Math.min(minLon, bboxMinLon);
    minLat = Math.min(minLat, bboxMinLat);
    maxLon = Math.max(maxLon, bboxMaxLon);
    maxLat = Math.max(maxLat, bboxMaxLat);

    for (const place of file.places) {
      byId.set(place.id, place);
    }
  }

  const places = Array.from(byId.values());
  combinedCache = {
    generatedAt: new Date().toISOString(),
    source: "Overpass (merged regional datasets)",
    bbox: [minLon, minLat, maxLon, maxLat],
    totalPlaces: places.length,
    categories: {
      parks: places.filter((place) => place.category === "park").length,
      terraceCandidates: places.filter(
        (place) => place.category === "terrace_candidate",
      ).length,
      outdoorSeatingYes: places.filter((place) => place.hasOutdoorSeating).length,
    },
    places,
  };
  return combinedCache;
}

export async function loadLausannePlaces(): Promise<LausannePlacesFile | null> {
  return loadPlacesByRegion("lausanne");
}
