import fs from "node:fs/promises";

import { z } from "zod";

import { PROCESSED_LAUSANNE_PLACES_PATH } from "@/lib/storage/data-paths";

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

let cache: LausannePlacesFile | null | undefined;

export async function loadLausannePlaces(): Promise<LausannePlacesFile | null> {
  if (cache !== undefined) {
    return cache;
  }

  try {
    const raw = await fs.readFile(PROCESSED_LAUSANNE_PLACES_PATH, "utf8");
    cache = placesFileSchema.parse(JSON.parse(raw));
    return cache;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      cache = null;
      return null;
    }

    throw error;
  }
}
