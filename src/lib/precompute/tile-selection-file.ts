import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { CANONICAL_PRECOMPUTE_TILE_SIZE_METERS } from "@/lib/precompute/constants";
import { buildRegionTiles, type PrecomputedRegionName } from "@/lib/precompute/sunlight-cache";

const regionSchema = z.enum(["lausanne", "nyon", "morges", "geneve", "vevey", "vevey_city"]);

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
    group: z.string().optional(),
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

export type GroupFilter = "top-priority" | "other" | "all";

export async function loadTileSelectionForRegion(params: {
  filePath: string;
  region: PrecomputedRegionName;
  groupFilter?: GroupFilter;
}): Promise<RegionTileSelection> {
  const resolvedPath = path.resolve(process.cwd(), params.filePath);
  const parsed = await loadTileSelectionFile(resolvedPath);

  if (parsed.tileSizeMeters !== CANONICAL_PRECOMPUTE_TILE_SIZE_METERS) {
    throw new Error(
      `Unsupported tileSizeMeters=${parsed.tileSizeMeters} in ${resolvedPath}. Expected ${CANONICAL_PRECOMPUTE_TILE_SIZE_METERS}m.`,
    );
  }

  const filter = params.groupFilter ?? "all";
  const entries = parsed.tiles.filter((entry) => {
    if (entry.region !== params.region) return false;
    if (filter === "top-priority") return entry.group === "top-priority";
    if (filter === "other") return entry.group !== "top-priority";
    return true;
  });
  // Filter out entries whose tileId is mislabeled (claims region X but doesn't
  // exist in buildRegionTiles(X)). Pre-existing data drift in
  // high-value-tile-selection.top-priority.json (group=other) caused
  // precompute-region-sunlight to throw "Unknown tile ids" mid-run on
  // lausanne/vevey. We log a warning so the underlying selection-build can be
  // fixed, but the orchestrator no longer aborts the whole run.
  const validTileIds = new Set(
    buildRegionTiles(params.region, parsed.tileSizeMeters).map((tile) => tile.tileId),
  );
  const droppedTileIds: string[] = [];
  const validEntries = entries.filter((entry) => {
    if (validTileIds.has(entry.tileId)) return true;
    droppedTileIds.push(entry.tileId);
    return false;
  });
  if (droppedTileIds.length > 0) {
    const preview = droppedTileIds.slice(0, 3).join(", ");
    const suffix = droppedTileIds.length > 3 ? ` (+${droppedTileIds.length - 3} more)` : "";
    console.warn(
      `[tile-selection] ${droppedTileIds.length} tile id(s) in ${path.basename(resolvedPath)} ` +
        `claim region=${params.region} but are not part of buildRegionTiles(${params.region}). ` +
        `Skipping: ${preview}${suffix}. Regenerate the selection to fix.`,
    );
  }
  const tileIds = Array.from(new Set(validEntries.map((entry) => entry.tileId))).sort();

  return {
    filePath: resolvedPath,
    generatedAt: parsed.generatedAt,
    tileSizeMeters: parsed.tileSizeMeters,
    tileIds,
    entries: validEntries,
  };
}