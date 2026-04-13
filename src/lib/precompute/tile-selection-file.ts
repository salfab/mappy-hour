import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { CANONICAL_PRECOMPUTE_TILE_SIZE_METERS } from "@/lib/precompute/constants";
import type { PrecomputedRegionName } from "@/lib/precompute/sunlight-cache";

const regionSchema = z.enum(["lausanne", "nyon", "morges", "geneve"]);

const tileSelectionEntrySchema = z
  .object({
    region: regionSchema,
    tileId: z.string().min(1),
    score: z.number().optional(),
    targetAreaIds: z.array(z.string()).optional(),
    targetAreaLabels: z.array(z.string()).optional(),
    counts: z
      .object({
        totalPlaces: z.number().int().nonnegative().optional(),
        parks: z.number().int().nonnegative().optional(),
        terraceCandidates: z.number().int().nonnegative().optional(),
        outdoorSeating: z.number().int().nonnegative().optional(),
      })
      .partial()
      .optional(),
    samplePlaceNames: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
  })
  .passthrough();

const tileSelectionFileSchema = z
  .object({
    generatedAt: z.string(),
    selectionVersion: z.number().int().positive().default(1),
    tileSizeMeters: z.number().int().positive().default(CANONICAL_PRECOMPUTE_TILE_SIZE_METERS),
    tiles: z.array(tileSelectionEntrySchema),
  })
  .passthrough();

export type TileSelectionEntry = z.infer<typeof tileSelectionEntrySchema>;
export type TileSelectionFile = z.infer<typeof tileSelectionFileSchema>;

export interface RegionTileSelection {
  filePath: string;
  generatedAt: string;
  tileSizeMeters: number;
  tileIds: string[];
  entries: TileSelectionEntry[];
}

export async function loadTileSelectionFile(filePath: string): Promise<TileSelectionFile> {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const raw = await fs.readFile(resolvedPath, "utf8");
  return tileSelectionFileSchema.parse(JSON.parse(raw));
}

export async function loadTileSelectionForRegion(params: {
  filePath: string;
  region: PrecomputedRegionName;
}): Promise<RegionTileSelection> {
  const resolvedPath = path.resolve(process.cwd(), params.filePath);
  const parsed = await loadTileSelectionFile(resolvedPath);

  if (parsed.tileSizeMeters !== CANONICAL_PRECOMPUTE_TILE_SIZE_METERS) {
    throw new Error(
      `Unsupported tileSizeMeters=${parsed.tileSizeMeters} in ${resolvedPath}. Expected ${CANONICAL_PRECOMPUTE_TILE_SIZE_METERS}m.`,
    );
  }

  const entries = parsed.tiles.filter((entry) => entry.region === params.region);
  const tileIds = Array.from(new Set(entries.map((entry) => entry.tileId))).sort();

  return {
    filePath: resolvedPath,
    generatedAt: parsed.generatedAt,
    tileSizeMeters: parsed.tileSizeMeters,
    tileIds,
    entries,
  };
}