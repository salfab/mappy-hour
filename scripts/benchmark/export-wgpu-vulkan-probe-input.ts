/**
 * Export one real tile input for the native Rust wgpu Vulkan probe.
 *
 * The script does not run WebGPU. It reuses the existing tile metadata and
 * mesh-cache conventions, then writes query points as packed vec4<f32>:
 *   x = LV95 easting - mesh originX
 *   y = terrain elevation
 *   z = LV95 northing - mesh originY
 *   w = 1
 */
import fs from "node:fs/promises";
import path from "node:path";

import { getSunlightModelVersion } from "@/lib/precompute/model-version";
import {
  buildRegionTiles,
  buildTilePoints,
  type PrecomputedRegionName,
} from "@/lib/precompute/sunlight-cache";
import { loadTileGridMetadata } from "@/lib/precompute/tile-grid-metadata";
import { loadBuildingsObstacleIndex } from "@/lib/sun/buildings-shadow";
import { normalizeShadowCalibration } from "@/lib/sun/shadow-calibration";

type Args = {
  region: PrecomputedRegionName;
  tileId: string;
  gridStepMeters: number;
  focusMarginMeters: number;
  maxPoints: number | null;
  outputDir: string;
};

type ObstacleArray = NonNullable<Awaited<ReturnType<typeof loadBuildingsObstacleIndex>>>["obstacles"];
type Obstacle = ObstacleArray[number];

function parseArgs(argv: string[]): Args {
  const args: Args = {
    region: "lausanne",
    tileId: "e2538000_n1152250_s250",
    gridStepMeters: 1,
    focusMarginMeters: 500,
    maxPoints: null,
    outputDir: path.join("data", "processed", "wgpu-vulkan-probe"),
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  pnpm exec tsx scripts/benchmark/export-wgpu-vulkan-probe-input.ts -- --tile-id=e2538000_n1152250_s250",
        "",
        "Options:",
        "  --region=lausanne|nyon|morges|geneve",
        "  --tile-id=e2538000_n1152250_s250",
        "  --grid-step-meters=1",
        "  --focus-margin-meters=500",
        "  --max-points=N|all",
        "  --output-dir=data/processed/wgpu-vulkan-probe",
      ].join("\n"));
      process.exit(0);
    }

    const [key, value] = splitArg(arg);
    if (key === "--region") {
      args.region = parseRegion(value);
    } else if (key === "--tile-id") {
      args.tileId = value;
    } else if (key === "--grid-step-meters") {
      args.gridStepMeters = parsePositiveNumber(value, key);
    } else if (key === "--focus-margin-meters") {
      args.focusMarginMeters = parseNonNegativeNumber(value, key);
    } else if (key === "--max-points") {
      args.maxPoints = value === "all" ? null : parsePositiveInteger(value, key);
    } else if (key === "--output-dir") {
      args.outputDir = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function splitArg(arg: string): [string, string] {
  const index = arg.indexOf("=");
  if (index === -1) {
    throw new Error(`Expected --key=value argument, got ${arg}`);
  }
  return [arg.slice(0, index), arg.slice(index + 1)];
}

function parseRegion(value: string): PrecomputedRegionName {
  if (value === "lausanne" || value === "nyon" || value === "morges" || value === "geneve") {
    return value;
  }
  throw new Error(`Unsupported region: ${value}`);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

function parsePositiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${value}`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got ${value}`);
  }
  return parsed;
}

function getCacheKey(originX: number, originY: number, obstacleCount: number): string {
  return `gpu-mesh-${Math.round(originX)}-${Math.round(originY)}-${obstacleCount}`;
}

function computeOrigin(obstacles: Obstacle[]): { originX: number; originY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const obstacle of obstacles) {
    minX = Math.min(minX, obstacle.minX);
    minY = Math.min(minY, obstacle.minY);
    maxX = Math.max(maxX, obstacle.maxX);
    maxY = Math.max(maxY, obstacle.maxY);
  }

  return {
    originX: (minX + maxX) / 2,
    originY: (minY + maxY) / 2,
  };
}

function filterObstaclesForTile(
  obstacles: Obstacle[],
  tile: { minEasting: number; minNorthing: number; maxEasting: number; maxNorthing: number },
  marginMeters: number,
): Obstacle[] {
  return obstacles.filter(
    (obstacle) =>
      obstacle.maxX > tile.minEasting - marginMeters &&
      obstacle.minX < tile.maxEasting + marginMeters &&
      obstacle.maxY > tile.minNorthing - marginMeters &&
      obstacle.minY < tile.maxNorthing + marginMeters,
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tile = buildRegionTiles(args.region, 250).find((candidate) => candidate.tileId === args.tileId);
  if (!tile) {
    throw new Error(`Tile ${args.tileId} not found for region ${args.region}`);
  }

  const model = await getSunlightModelVersion(args.region, normalizeShadowCalibration({}));
  const metadata = await loadTileGridMetadata(
    args.region,
    model.modelVersionHash,
    args.gridStepMeters,
    tile.tileId,
  );
  if (!metadata) {
    throw new Error(
      `Missing tile metadata for ${args.region}/${model.modelVersionHash}/g${args.gridStepMeters}/${tile.tileId}`,
    );
  }

  const buildingsIndex = await loadBuildingsObstacleIndex();
  if (!buildingsIndex) {
    throw new Error(`Missing buildings index for region ${args.region}`);
  }

  const filteredObstacles = filterObstaclesForTile(buildingsIndex.obstacles, tile, args.focusMarginMeters);
  if (filteredObstacles.length === 0) {
    throw new Error(`No obstacles selected for ${tile.tileId} with margin=${args.focusMarginMeters}`);
  }

  const { originX, originY } = computeOrigin(filteredObstacles);
  const cacheKey = getCacheKey(originX, originY, filteredObstacles.length);
  const meshBinPath = path.join("data", "processed", "buildings", `${cacheKey}.bin`);
  const meshHeaderPath = path.join("data", "processed", "buildings", `${cacheKey}.json`);
  if (!(await pathExists(meshBinPath)) || !(await pathExists(meshHeaderPath))) {
    throw new Error(
      `Missing mesh cache ${meshBinPath}. Run an existing WebGPU tile smoke once for this tile/margin to create it.`,
    );
  }

  const rawPoints = buildTilePoints(tile, args.gridStepMeters);
  if (rawPoints.length !== metadata.totalPoints) {
    throw new Error(
      `Tile point count mismatch: buildTilePoints=${rawPoints.length}, metadata=${metadata.totalPoints}`,
    );
  }

  const maxPoints = args.maxPoints ?? Number.POSITIVE_INFINITY;
  const packed: number[] = [];
  let skippedIndoor = 0;
  let skippedMissingElevation = 0;

  for (let index = 0; index < rawPoints.length && packed.length / 4 < maxPoints; index += 1) {
    if (metadata.indoor[index]) {
      skippedIndoor += 1;
      continue;
    }

    const elevation = metadata.elevations[index];
    if (elevation === null) {
      skippedMissingElevation += 1;
      continue;
    }

    packed.push(
      rawPoints[index].lv95Easting - originX,
      elevation,
      rawPoints[index].lv95Northing - originY,
      1,
    );
  }

  if (packed.length === 0) {
    throw new Error(`No outdoor points selected for ${tile.tileId}`);
  }

  await fs.mkdir(args.outputDir, { recursive: true });
  const maxPointsSuffix = args.maxPoints === null ? "all" : String(args.maxPoints);
  const outputBase = `${args.region}-${tile.tileId}-g${args.gridStepMeters}-m${args.focusMarginMeters}-p${maxPointsSuffix}`;
  const pointsBinPath = path.join(args.outputDir, `${outputBase}.points.bin`);
  const manifestPath = path.join(args.outputDir, `${outputBase}.json`);
  const points = new Float32Array(packed);
  await fs.writeFile(pointsBinPath, Buffer.from(points.buffer, points.byteOffset, points.byteLength));

  const maxBuildingHeight = filteredObstacles.reduce((max, obstacle) => Math.max(max, obstacle.height), 0);
  const focusBounds = {
    minX: tile.minEasting - originX,
    minZ: tile.minNorthing - originY,
    maxX: tile.maxEasting - originX,
    maxZ: tile.maxNorthing - originY,
  };
  const manifest = {
    generatedAt: new Date().toISOString(),
    region: args.region,
    tileId: tile.tileId,
    modelVersionHash: model.modelVersionHash,
    gridStepMeters: args.gridStepMeters,
    focusMarginMeters: args.focusMarginMeters,
    selectedPointCount: points.length / 4,
    metadataOutdoorCount: metadata.outdoorCount,
    metadataIndoorCount: metadata.indoorCount,
    skippedIndoor,
    skippedMissingElevation,
    obstacleCount: filteredObstacles.length,
    maxBuildingHeight,
    origin: { originX, originY },
    meshBinPath,
    pointsBinPath,
    focusBounds,
    rustArgs: [
      "--mode=shadow",
      `--mesh-bin=${meshBinPath}`,
      `--points-bin=${pointsBinPath}`,
      `--focus-bounds=${focusBounds.minX},${focusBounds.minZ},${focusBounds.maxX},${focusBounds.maxZ}`,
      `--focus-max-height=${maxBuildingHeight}`,
    ],
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `[wgpu-vulkan-export] tile=${tile.tileId} points=${points.length / 4} obstacles=${filteredObstacles.length} mesh=${meshBinPath}`,
  );
  console.log(`[wgpu-vulkan-export] points=${pointsBinPath}`);
  console.log(`[wgpu-vulkan-export] manifest=${manifestPath}`);
  console.log(`[wgpu-vulkan-export] rust-args=${manifest.rustArgs.join(" ")}`);
}

main().catch((error) => {
  console.error(`[wgpu-vulkan-export] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
