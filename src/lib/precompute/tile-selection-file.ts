import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { CANONICAL_PRECOMPUTE_TILE_SIZE_METERS } from "@/lib/precompute/constants";
import { buildRegionTiles, type PrecomputedRegionName } from "@/lib/precompute/sunlight-cache";
import { DATA_ROOT } from "@/lib/storage/data-paths";

const regionSchema = z.enum(["lausanne", "nyon", "morges", "geneve", "vevey", "vevey_city", "neuchatel", "la_chaux_de_fonds", "bern", "zurich", "thun"]);

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

function resolveSelectionPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  // "data/..." → DATA_ROOT/... so MAPPY_DATA_ROOT is honoured
  if (filePath.startsWith("data/") || filePath.startsWith("data\\")) {
    return path.join(DATA_ROOT, filePath.slice("data/".length));
  }
  return path.resolve(process.cwd(), filePath);
}

export async function loadTileSelectionFile(filePath: string): Promise<TileSelectionFile> {
  const resolvedPath = resolveSelectionPath(filePath);
  const raw = await fs.readFile(resolvedPath, "utf8");
  return tileSelectionFileSchema.parse(JSON.parse(raw));
}

export type GroupFilter = "top-priority" | "other" | "all";

export async function loadTileSelectionForRegion(params: {
  filePath: string;
  region: PrecomputedRegionName;
  groupFilter?: GroupFilter;
}): Promise<RegionTileSelection> {
  const resolvedPath = resolveSelectionPath(params.filePath);
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
    // Bright-red bold banner — silently dropping tiles is the kind of mistake
    // that's trivially missed in a verbose precompute log (e.g. a region bbox
    // that excludes part of its declared selection). Make it impossible to miss.
    const RED = "\x1b[1;91m";
    const RESET = "\x1b[0m";
    const PREVIEW_LIMIT = 20;
    const previewList = droppedTileIds.slice(0, PREVIEW_LIMIT).map((id) => `      ${id}`).join("\n");
    const previewSuffix =
      droppedTileIds.length > PREVIEW_LIMIT
        ? `\n      … (+${droppedTileIds.length - PREVIEW_LIMIT} more)`
        : "";
    console.warn(
      `${RED}` +
        `[tile-selection] ╔══ WARNING: ${droppedTileIds.length} TILE(S) SILENTLY DROPPED ═══════════════════════\n` +
        `[tile-selection] ║ Source: ${path.basename(resolvedPath)}\n` +
        `[tile-selection] ║ These tiles declare region="${params.region}" but fall OUTSIDE\n` +
        `[tile-selection] ║ buildRegionTiles("${params.region}"). They will NOT be precomputed.\n` +
        `[tile-selection] ║\n` +
        `[tile-selection] ║ Likely cause: the region's localBbox excludes part of its selection.\n` +
        `[tile-selection] ║ Fix: widen the bbox in src/lib/config/<region>.ts, OR regenerate the\n` +
        `[tile-selection] ║       selection to match the current bbox.\n` +
        `[tile-selection] ║\n` +
        `[tile-selection] ║ Dropped tile ids:\n` +
        `[tile-selection] ${previewList}${previewSuffix}\n` +
        `[tile-selection] ╚══════════════════════════════════════════════════════════════════════` +
        `${RESET}`,
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