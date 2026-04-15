/**
 * Experimental Rust/wgpu Vulkan precompute dry-run.
 *
 * Computes one tile through the normal tile artifact path with an explicit
 * GPU building-shadow mode, but never writes the precomputed sunlight cache.
 * Use --write-artifact=PATH only for an explicit local diagnostic artifact.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type {
  PrecomputedRegionName,
  PrecomputedSunlightTileArtifact,
} from "@/lib/precompute/sunlight-cache";

type DryRunBuildingsMode = "gpu-raster" | "rust-wgpu-vulkan" | "detailed";

type Args = {
  mode: DryRunBuildingsMode;
  region: PrecomputedRegionName;
  tileId: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  focusMarginMeters: number;
  maxOutdoorPoints: number | null;
  writeArtifact: string | null;
  writeValueSummary: string | null;
};

type DryRunTileGridMetadata = {
  tileId: string;
  modelVersionHash: string;
  gridStepMeters: number;
  totalPoints: number;
  outdoorCount: number;
  indoorCount: number;
  elevations: (number | null)[];
  indoor: boolean[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "rust-wgpu-vulkan",
    region: "lausanne",
    tileId: "e2538000_n1152250_s250",
    date: "2026-04-13",
    timezone: "Europe/Zurich",
    sampleEveryMinutes: 15,
    gridStepMeters: 1,
    startLocalTime: "12:00",
    endLocalTime: "13:00",
    focusMarginMeters: 500,
    maxOutdoorPoints: null,
    writeArtifact: null,
    writeValueSummary: null,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  pnpm exec tsx scripts/precompute/precompute-rust-wgpu-vulkan-dry-run.ts -- --tile-id=e2538000_n1152250_s250",
        "",
        "Options:",
        "  --mode=rust-wgpu-vulkan|gpu-raster|detailed",
        "  --region=lausanne|nyon|morges|geneve",
        "  --tile-id=e2538000_n1152250_s250",
        "  --date=2026-04-13",
        "  --timezone=Europe/Zurich",
        "  --sample-every-minutes=15",
        "  --grid-step-meters=1",
        "  --start-local-time=12:00",
        "  --end-local-time=13:00",
        "  --focus-margin-meters=500",
        "  --max-outdoor-points=2048",
        "  --write-artifact=data/processed/wgpu-vulkan-probe/dry-run.json",
        "  --write-value-summary=data/processed/wgpu-vulkan-probe/dry-run.values.json",
      ].join("\n"));
      process.exit(0);
    }

    const [key, value] = splitArg(arg);
    if (key === "--mode") args.mode = parseMode(value);
    else if (key === "--region") args.region = parseRegion(value);
    else if (key === "--tile-id") args.tileId = value;
    else if (key === "--date") args.date = value;
    else if (key === "--timezone") args.timezone = value;
    else if (key === "--sample-every-minutes") args.sampleEveryMinutes = parsePositiveInteger(value, key);
    else if (key === "--grid-step-meters") args.gridStepMeters = parsePositiveNumber(value, key);
    else if (key === "--start-local-time") args.startLocalTime = value;
    else if (key === "--end-local-time") args.endLocalTime = value;
    else if (key === "--focus-margin-meters") args.focusMarginMeters = parseNonNegativeNumber(value, key);
    else if (key === "--max-outdoor-points") args.maxOutdoorPoints = value === "all" ? null : parsePositiveInteger(value, key);
    else if (key === "--write-artifact") args.writeArtifact = value;
    else if (key === "--write-value-summary") args.writeValueSummary = value;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function parseMode(value: string): DryRunBuildingsMode {
  if (value === "rust-wgpu-vulkan" || value === "gpu-raster" || value === "detailed") {
    return value;
  }
  throw new Error(`Unsupported mode: ${value}`);
}

function splitArg(arg: string): [string, string] {
  const index = arg.indexOf("=");
  if (index === -1) throw new Error(`Expected --key=value argument, got ${arg}`);
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

function limitOutdoorPointsForDryRun(
  metadata: DryRunTileGridMetadata,
  maxOutdoorPoints: number | null,
): DryRunTileGridMetadata {
  if (maxOutdoorPoints === null || metadata.outdoorCount <= maxOutdoorPoints) {
    return metadata;
  }

  const indoor = [...metadata.indoor];
  const elevations = [...metadata.elevations];
  let keptOutdoor = 0;
  for (let index = 0; index < metadata.totalPoints; index += 1) {
    if (metadata.indoor[index] || metadata.elevations[index] === null) {
      continue;
    }
    keptOutdoor += 1;
    if (keptOutdoor > maxOutdoorPoints) {
      indoor[index] = true;
      elevations[index] = null;
    }
  }

  return {
    ...metadata,
    outdoorCount: maxOutdoorPoints,
    indoorCount: metadata.totalPoints - maxOutdoorPoints,
    indoor,
    elevations,
  };
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function toValueSummary(
  artifact: PrecomputedSunlightTileArtifact,
  mode: DryRunBuildingsMode,
) {
  const outdoorPoints = artifact.points
    .filter((point) => point.outdoorIndex !== null)
    .sort((left, right) => (left.outdoorIndex ?? 0) - (right.outdoorIndex ?? 0))
    .map((point) => ({
      outdoorIndex: point.outdoorIndex ?? 0,
      id: point.id,
      lat: point.lat,
      lon: point.lon,
      lv95Easting: point.lv95Easting,
      lv95Northing: point.lv95Northing,
      pointElevationMeters: point.pointElevationMeters,
    }));

  return {
    generatedAt: new Date().toISOString(),
    mode,
    region: artifact.region,
    tileId: artifact.tile.tileId,
    date: artifact.date,
    timezone: artifact.timezone,
    gridStepMeters: artifact.gridStepMeters,
    sampleEveryMinutes: artifact.sampleEveryMinutes,
    startLocalTime: artifact.startLocalTime,
    endLocalTime: artifact.endLocalTime,
    model: artifact.model,
    stats: {
      gridPointCount: artifact.stats.gridPointCount,
      pointCount: artifact.stats.pointCount,
      indoorPointsExcluded: artifact.stats.indoorPointsExcluded,
      pointsWithElevation: artifact.stats.pointsWithElevation,
      pointsWithoutElevation: artifact.stats.pointsWithoutElevation,
      totalEvaluations: artifact.stats.totalEvaluations,
    },
    points: outdoorPoints,
    frames: artifact.frames.map((frame) => ({
      index: frame.index,
      localTime: frame.localTime,
      utcTime: frame.utcTime,
      sunnyCount: frame.sunnyCount,
      sunnyCountNoVegetation: frame.sunnyCountNoVegetation,
      sunMaskBase64: frame.sunMaskBase64,
      sunMaskNoVegetationBase64: frame.sunMaskNoVegetationBase64,
      terrainBlockedMaskBase64: frame.terrainBlockedMaskBase64,
      buildingsBlockedMaskBase64: frame.buildingsBlockedMaskBase64,
      vegetationBlockedMaskBase64: frame.vegetationBlockedMaskBase64,
    })),
    warnings: artifact.warnings,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.env.MAPPY_BUILDINGS_SHADOW_MODE = args.mode;
  process.env.MAPPY_RUST_WGPU_FOCUS_MARGIN_METERS = String(args.focusMarginMeters);

  const [
    { buildRegionTiles },
    { getSunlightModelVersion },
    { computeSunlightTileArtifact, disposeSunlightTileEvaluationBackends },
    { loadTileGridMetadata },
    { normalizeShadowCalibration },
  ] = await Promise.all([
    import("@/lib/precompute/sunlight-cache"),
    import("@/lib/precompute/model-version"),
    import("@/lib/precompute/sunlight-tile-service"),
    import("@/lib/precompute/tile-grid-metadata"),
    import("@/lib/sun/shadow-calibration"),
  ]);

  const tile = buildRegionTiles(args.region, 250).find((candidate) => candidate.tileId === args.tileId);
  if (!tile) {
    throw new Error(`Tile ${args.tileId} not found for region ${args.region}`);
  }

  const shadowCalibration = normalizeShadowCalibration({});
  const model = await getSunlightModelVersion(args.region, shadowCalibration);
  const loadedGridMetadata = await loadTileGridMetadata(
    args.region,
    model.modelVersionHash,
    args.gridStepMeters,
    tile.tileId,
  );
  if (!loadedGridMetadata) {
    throw new Error(`Missing tile grid metadata for ${args.region}/${model.modelVersionHash}/g${args.gridStepMeters}/${tile.tileId}`);
  }
  const gridMetadata = limitOutdoorPointsForDryRun(
    loadedGridMetadata as DryRunTileGridMetadata,
    args.maxOutdoorPoints,
  );

  console.log(
    `[precompute-gpu-dry-run] mode=${process.env.MAPPY_BUILDINGS_SHADOW_MODE} region=${args.region} tile=${tile.tileId} date=${args.date} window=${args.startLocalTime}-${args.endLocalTime} focusMargin=${args.focusMarginMeters}m outdoor=${gridMetadata.outdoorCount}/${loadedGridMetadata.outdoorCount}`,
  );

  const started = performance.now();
  try {
    const artifact = await computeSunlightTileArtifact({
      region: args.region,
      modelVersionHash: model.modelVersionHash,
      algorithmVersion: model.algorithmVersion,
      date: args.date,
      timezone: args.timezone,
      sampleEveryMinutes: args.sampleEveryMinutes,
      gridStepMeters: args.gridStepMeters,
      startLocalTime: args.startLocalTime,
      endLocalTime: args.endLocalTime,
      tile,
      shadowCalibration,
      cooperativeYieldEveryPoints: 5000,
      gridMetadata,
      onProgress: (progress) => {
        console.log(
          `[precompute-gpu-dry-run] progress stage=${progress.stage} completed=${progress.completed}/${progress.total} frame=${progress.frameIndex ?? "-"} elapsed=${(progress.elapsedMs / 1000).toFixed(1)}s`,
        );
      },
    });

    if (args.writeArtifact) {
      await writeJsonFile(args.writeArtifact, artifact);
      console.log(`[precompute-gpu-dry-run] wrote diagnostic artifact=${args.writeArtifact}`);
    }

    if (args.writeValueSummary) {
      await writeJsonFile(args.writeValueSummary, toValueSummary(artifact, args.mode));
      console.log(`[precompute-gpu-dry-run] wrote value summary=${args.writeValueSummary}`);
    }

    console.log(
      `[precompute-gpu-dry-run] done in ${((performance.now() - started) / 1000).toFixed(1)}s frames=${artifact.frames.length} outdoor=${artifact.stats.pointCount} model=${artifact.model.buildingsShadowMethod}`,
    );
  } finally {
    await disposeSunlightTileEvaluationBackends();
  }
}

main().catch((error) => {
  console.error(`[precompute-gpu-dry-run] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
