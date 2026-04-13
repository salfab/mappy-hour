import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const regionSchema = z.enum(["lausanne", "nyon", "morges", "geneve"]);

const areaTileSchema = z
  .object({
    tileId: z.string(),
    score: z.number(),
    totalPlaces: z.number().int().nonnegative(),
    parks: z.number().int().nonnegative(),
    terraceCandidates: z.number().int().nonnegative(),
    outdoorSeating: z.number().int().nonnegative(),
    samplePlaceNames: z.array(z.string()).default([]),
  })
  .passthrough();

const areaSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    region: regionSchema,
    selectedTiles: z.array(areaTileSchema),
    maxTilesInTopPriority: z.number().int().positive().optional(),
  })
  .passthrough();

const globalTileSchema = z
  .object({
    region: regionSchema,
    tileId: z.string(),
    score: z.number(),
    counts: z
      .object({
        totalPlaces: z.number().int().nonnegative(),
        parks: z.number().int().nonnegative(),
        terraceCandidates: z.number().int().nonnegative(),
        outdoorSeating: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();

const selectionSchema = z
  .object({
    generatedAt: z.string(),
    selectionVersion: z.number(),
    source: z.string(),
    tileSizeMeters: z.number(),
    selectionPolicy: z.record(z.string(), z.unknown()).optional(),
    areas: z.array(areaSchema),
    tiles: z.array(globalTileSchema),
  })
  .passthrough();

type AreaTile = z.infer<typeof areaTileSchema>;
type SelectionFile = z.infer<typeof selectionSchema>;

interface Args {
  input: string;
  output: string;
  maxTilesPerArea: number;
  minOutdoorSeating: number;
}

const DEFAULT_INPUT = path.join(
  process.cwd(),
  "data",
  "processed",
  "precompute",
  "high-value-tile-selection.json",
);

const DEFAULT_OUTPUT = path.join(
  process.cwd(),
  "data",
  "processed",
  "precompute",
  "high-value-tile-selection.top-priority.json",
);

const DEFAULT_MAX_TILES_PER_AREA = 4;
const DEFAULT_MIN_OUTDOOR_SEATING = 2;

function parseArgs(argv: string[]): Args {
  const result: Args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    maxTilesPerArea: DEFAULT_MAX_TILES_PER_AREA,
    minOutdoorSeating: DEFAULT_MIN_OUTDOOR_SEATING,
  };

  for (const arg of argv) {
    if (arg.startsWith("--input=")) {
      result.input = path.resolve(process.cwd(), arg.slice("--input=".length));
      continue;
    }
    if (arg.startsWith("--output=")) {
      result.output = path.resolve(process.cwd(), arg.slice("--output=".length));
      continue;
    }
    if (arg.startsWith("--max-tiles-per-area=")) {
      const parsed = Number(arg.slice("--max-tiles-per-area=".length));
      if (Number.isInteger(parsed) && parsed >= 1) {
        result.maxTilesPerArea = parsed;
      }
      continue;
    }
    if (arg.startsWith("--min-outdoor-seating=")) {
      const parsed = Number(arg.slice("--min-outdoor-seating=".length));
      if (Number.isInteger(parsed) && parsed >= 0) {
        result.minOutdoorSeating = parsed;
      }
    }
  }

  return result;
}

function compareTiles(left: AreaTile, right: AreaTile): number {
  if (right.outdoorSeating !== left.outdoorSeating) {
    return right.outdoorSeating - left.outdoorSeating;
  }
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.terraceCandidates !== left.terraceCandidates) {
    return right.terraceCandidates - left.terraceCandidates;
  }
  if (right.totalPlaces !== left.totalPlaces) {
    return right.totalPlaces - left.totalPlaces;
  }
  return left.tileId.localeCompare(right.tileId);
}

function selectTopPriorityTiles(tiles: AreaTile[], maxTiles: number, minOutdoorSeating: number): AreaTile[] {
  const ranked = [...tiles].sort(compareTiles);
  const strict = ranked.filter((tile) => tile.outdoorSeating >= minOutdoorSeating);
  const selection: AreaTile[] = [];

  for (const tile of strict) {
    if (selection.length >= maxTiles) {
      break;
    }
    selection.push(tile);
  }

  if (selection.length < maxTiles) {
    for (const tile of ranked) {
      if (selection.some((selected) => selected.tileId === tile.tileId)) {
        continue;
      }
      selection.push(tile);
      if (selection.length >= maxTiles) {
        break;
      }
    }
  }

  return selection;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(args.input, "utf8");
  const input = selectionSchema.parse(JSON.parse(raw)) as SelectionFile;
  const selectedKeys = new Set<string>();

  const areas = input.areas.map((area) => {
    const effectiveMaxTiles = area.maxTilesInTopPriority ?? args.maxTilesPerArea;
    const selectedTiles = selectTopPriorityTiles(area.selectedTiles, effectiveMaxTiles, args.minOutdoorSeating);
    for (const tile of selectedTiles) {
      selectedKeys.add(`${area.region}:${tile.tileId}`);
    }
    return {
      ...area,
      selectedTiles,
      notes: [
        ...(Array.isArray((area as Record<string, unknown>).notes)
          ? ((area as Record<string, unknown>).notes as string[])
          : []),
        `Top priority: ${args.maxTilesPerArea} tuiles max, priorité aux tuiles avec outdoor seating explicite.`,
      ],
    };
  });

  const tiles = input.tiles.filter((tile) => selectedKeys.has(`${tile.region}:${tile.tileId}`));

  const output = {
    ...input,
    generatedAt: new Date().toISOString(),
    source: `${input.source} (top-priority dérivé)`,
    selectionProfile: "top-priority",
    derivedFrom: path.relative(process.cwd(), args.input).replace(/\\/g, "/"),
    selectionPolicy: {
      ...(input.selectionPolicy ?? {}),
      profile: "top-priority",
      maxTilesPerArea: args.maxTilesPerArea,
      minOutdoorSeating: args.minOutdoorSeating,
    },
    areas,
    tiles,
  };

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(
    `[top-priority-tiles] wrote ${tiles.length} tiles across ${areas.length} areas to ${args.output}`,
  );
}

void main().catch((error) => {
  console.error(
    `[top-priority-tiles] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});