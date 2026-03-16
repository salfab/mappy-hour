import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_SHADOW_CALIBRATION } from "@/lib/sun/shadow-calibration";
import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "@/lib/sun/evaluation-context";
import {
  createDetailedBuildingShadowVerifier,
  evaluateBuildingsShadow,
  evaluateBuildingsShadowTwoLevel,
  type BuildingShadowDebugPass,
} from "@/lib/sun/buildings-shadow";
import { evaluateInstantSunlight } from "@/lib/sun/solar";
import {
  createUtcSamples,
} from "@/lib/precompute/sunlight-tile-service";
import {
  buildRegionTiles,
  buildTilePoints,
  type PrecomputedRegionName,
  type RegionTileSpec,
} from "@/lib/precompute/sunlight-cache";
import { getSunlightModelVersion } from "@/lib/precompute/model-version";
import { resolveAdaptiveTerrainHorizonForTile } from "@/lib/sun/adaptive-horizon-sharing";

type BuildingsShadowMode = "detailed" | "two-level" | "prism";

interface ParsedArgs {
  region: PrecomputedRegionName;
  tileId: string;
  date: string;
  timezone: string;
  startLocalTime: string;
  endLocalTime: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  mode: BuildingsShadowMode;
}

const DEFAULT_ARGS: ParsedArgs = {
  region: "lausanne",
  tileId: "e2538000_n1152250_s250",
  date: "2026-03-08",
  timezone: "Europe/Zurich",
  startLocalTime: "08:00",
  endLocalTime: "12:00",
  sampleEveryMinutes: 15,
  gridStepMeters: 5,
  mode: "detailed",
};

const REPORT_DIR = path.join(process.cwd(), "docs", "progress", "analysis");

function parseIntArg(value: string, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function parseMode(value: string): BuildingsShadowMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "detailed" || normalized === "two-level" || normalized === "prism") {
    return normalized;
  }
  return null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { ...DEFAULT_ARGS };
  for (const arg of argv) {
    if (arg.startsWith("--region=")) {
      const region = arg.slice("--region=".length);
      if (region === "lausanne" || region === "nyon") {
        args.region = region;
      }
      continue;
    }
    if (arg.startsWith("--tile-id=")) {
      args.tileId = arg.slice("--tile-id=".length);
      continue;
    }
    if (arg.startsWith("--date=")) {
      args.date = arg.slice("--date=".length);
      continue;
    }
    if (arg.startsWith("--timezone=")) {
      args.timezone = arg.slice("--timezone=".length);
      continue;
    }
    if (arg.startsWith("--start-local-time=")) {
      args.startLocalTime = arg.slice("--start-local-time=".length);
      continue;
    }
    if (arg.startsWith("--end-local-time=")) {
      args.endLocalTime = arg.slice("--end-local-time=".length);
      continue;
    }
    if (arg.startsWith("--sample-every-minutes=")) {
      const parsed = parseIntArg(arg.slice("--sample-every-minutes=".length), 1, 60);
      if (parsed !== null) {
        args.sampleEveryMinutes = parsed;
      }
      continue;
    }
    if (arg.startsWith("--grid-step-meters=")) {
      const parsed = parseIntArg(arg.slice("--grid-step-meters=".length), 1, 50);
      if (parsed !== null) {
        args.gridStepMeters = parsed;
      }
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const parsed = parseMode(arg.slice("--mode=".length));
      if (parsed) {
        args.mode = parsed;
      }
    }
  }
  return args;
}

function requireTile(region: PrecomputedRegionName, tileId: string): RegionTileSpec {
  const tile = buildRegionTiles(region, 250).find((entry) => entry.tileId === tileId);
  if (!tile) {
    throw new Error(`Tile ${tileId} not found for region ${region}.`);
  }
  return tile;
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topUnused(params: {
  keptCounts: Map<string, number>;
  impactedSet: Set<string>;
  limit?: number;
}) {
  const limit = params.limit ?? 20;
  return Array.from(params.keptCounts.entries())
    .filter(([key]) => !params.impactedSet.has(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({
      key,
      keptCount: count,
    }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tile = requireTile(args.region, args.tileId);
  const modelVersion = await getSunlightModelVersion(args.region, DEFAULT_SHADOW_CALIBRATION);
  const adaptiveHorizon = await resolveAdaptiveTerrainHorizonForTile({
    region: args.region,
    modelVersionHash: modelVersion.modelVersionHash,
    tile,
    date: args.date,
    timezone: args.timezone,
    sampleEveryMinutes: args.sampleEveryMinutes,
    startLocalTime: args.startLocalTime,
    endLocalTime: args.endLocalTime,
    gridStepMeters: args.gridStepMeters,
  });

  const sharedSources = await buildSharedPointEvaluationSources({
    terrainHorizonOverride: adaptiveHorizon.horizonMask ?? undefined,
    lv95Bounds: {
      minX: tile.minEasting,
      minY: tile.minNorthing,
      maxX: tile.maxEasting,
      maxY: tile.maxNorthing,
    },
  });

  if (!sharedSources.buildingsIndex) {
    throw new Error("Buildings index unavailable.");
  }

  const buildingsIndex = sharedSources.buildingsIndex;
  const obstacles = buildingsIndex.obstacles;
  const spatialGrid = buildingsIndex.spatialGrid;
  const detailedVerifier =
    args.mode === "prism" ? null : createDetailedBuildingShadowVerifier(obstacles);

  const obstacleCellKeys = new Map<string, Set<string>>();
  if (spatialGrid) {
    for (const [cellKey, indices] of Object.entries(spatialGrid.cells)) {
      for (const obstacleIndex of indices) {
        const obstacle = obstacles[obstacleIndex];
        if (!obstacle) {
          continue;
        }
        const current = obstacleCellKeys.get(obstacle.id);
        if (current) {
          current.add(cellKey);
        } else {
          obstacleCellKeys.set(obstacle.id, new Set([cellKey]));
        }
      }
    }
  }

  const samples = createUtcSamples(
    args.date,
    args.timezone,
    args.sampleEveryMinutes,
    args.startLocalTime,
    args.endLocalTime,
  );
  const tilePoints = buildTilePoints(tile, args.gridStepMeters);

  const keptCellSet = new Set<string>();
  const impactedCellSet = new Set<string>();
  const keptBuildingSet = new Set<string>();
  const impactedBuildingSet = new Set<string>();
  const keptCellCounts = new Map<string, number>();
  const keptBuildingCounts = new Map<string, number>();
  const checkedBuildingCounts = new Map<string, number>();
  const blockerBuildingCounts = new Map<string, number>();
  const impactedCellCounts = new Map<string, number>();
  const impactedBuildingCounts = new Map<string, number>();
  const debugStatsTotals = {
    skippedExcludedBlockerId: 0,
    skippedDistance: 0,
    skippedLateral: 0,
    skippedBBoxMissOrTooFar: 0,
    skippedByExistingCloserBlocker: 0,
    skippedBelowRayAltitude: 0,
    rejectedNoIntersection: 0,
    rejectedIntersectionTooFar: 0,
    rejectedVerticalClearance: 0,
    rejectedByAltitudeAngle: 0,
    wouldBlockButFarther: 0,
    acceptedAsBlocker: 0,
  };

  let totalPoints = tilePoints.length;
  let indoorPoints = 0;
  let outdoorPoints = 0;
  let pointsWithoutElevation = 0;
  let buildingEvaluatorCalls = 0;
  let buildingEvaluationPasses = 0;
  let totalCandidateObstacles = 0;
  let totalCheckedObstacles = 0;
  let totalSamples = 0;
  let samplesWithBuildingBlocked = 0;

  for (const point of tilePoints) {
    const context = await buildPointEvaluationContext(point.lat, point.lon, {
      skipTerrainSamplingWhenIndoor: true,
      terrainHorizonOverride: adaptiveHorizon.horizonMask ?? undefined,
      shadowCalibration: DEFAULT_SHADOW_CALIBRATION,
      sharedSources,
    });

    if (context.insideBuilding) {
      indoorPoints += 1;
      continue;
    }
    if (context.pointElevationMeters === null) {
      pointsWithoutElevation += 1;
      continue;
    }
    outdoorPoints += 1;

    const debugCollector = (debug: BuildingShadowDebugPass) => {
      buildingEvaluationPasses += 1;
      totalCandidateObstacles += debug.candidateObstacleCount;
      totalCheckedObstacles += debug.checkedObstaclesCount;
      for (const cellKey of debug.candidateCellKeys) {
        keptCellSet.add(cellKey);
        incrementCount(keptCellCounts, cellKey);
      }
      for (const obstacleId of debug.checkedObstacleIds) {
        keptBuildingSet.add(obstacleId);
        incrementCount(keptBuildingCounts, obstacleId);
        incrementCount(checkedBuildingCounts, obstacleId);
      }
      if (debug.blockerId) {
        incrementCount(blockerBuildingCounts, debug.blockerId);
      }
      if (debug.stats) {
        debugStatsTotals.skippedExcludedBlockerId += debug.stats.skippedExcludedBlockerId;
        debugStatsTotals.skippedDistance += debug.stats.skippedDistance;
        debugStatsTotals.skippedLateral += debug.stats.skippedLateral;
        debugStatsTotals.skippedBBoxMissOrTooFar += debug.stats.skippedBBoxMissOrTooFar;
        debugStatsTotals.skippedByExistingCloserBlocker +=
          debug.stats.skippedByExistingCloserBlocker;
        debugStatsTotals.skippedBelowRayAltitude += debug.stats.skippedBelowRayAltitude;
        debugStatsTotals.rejectedNoIntersection += debug.stats.rejectedNoIntersection;
        debugStatsTotals.rejectedIntersectionTooFar +=
          debug.stats.rejectedIntersectionTooFar;
        debugStatsTotals.rejectedVerticalClearance +=
          debug.stats.rejectedVerticalClearance;
        debugStatsTotals.rejectedByAltitudeAngle += debug.stats.rejectedByAltitudeAngle;
        debugStatsTotals.wouldBlockButFarther += debug.stats.wouldBlockButFarther;
        debugStatsTotals.acceptedAsBlocker += debug.stats.acceptedAsBlocker;
      }
    };

    const buildingShadowEvaluator = (sample: { azimuthDeg: number; altitudeDeg: number }) => {
      buildingEvaluatorCalls += 1;
      const baseInput = {
        pointX: point.lv95Easting,
        pointY: point.lv95Northing,
        pointElevation: context.pointElevationMeters ?? 0,
        buildingHeightBiasMeters: DEFAULT_SHADOW_CALIBRATION.buildingHeightBiasMeters,
        solarAzimuthDeg: sample.azimuthDeg,
        solarAltitudeDeg: sample.altitudeDeg,
        debugCollector,
      };
      if (args.mode === "prism" || !detailedVerifier) {
        return evaluateBuildingsShadow(obstacles, baseInput, spatialGrid);
      }
      if (args.mode === "two-level") {
        return evaluateBuildingsShadowTwoLevel(
          obstacles,
          baseInput,
          spatialGrid,
          {
            detailedVerifier,
            nearThresholdDegrees: 2,
            maxRefinementSteps: 3,
          },
        );
      }
      return evaluateBuildingsShadowTwoLevel(
        obstacles,
        baseInput,
        spatialGrid,
        {
          detailedVerifier,
          nearThresholdDegrees: Number.POSITIVE_INFINITY,
          maxRefinementSteps: 32,
        },
      );
    };

    for (const utcDate of samples) {
      totalSamples += 1;
      const sample = evaluateInstantSunlight({
        lat: point.lat,
        lon: point.lon,
        utcDate,
        timeZone: args.timezone,
        horizonMask: context.horizonMask,
        buildingShadowEvaluator,
      });
      if (sample.buildingsBlocked && sample.buildingBlockerId) {
        samplesWithBuildingBlocked += 1;
        impactedBuildingSet.add(sample.buildingBlockerId);
        incrementCount(impactedBuildingCounts, sample.buildingBlockerId);
        const cells = obstacleCellKeys.get(sample.buildingBlockerId);
        if (cells) {
          for (const cellKey of cells) {
            impactedCellSet.add(cellKey);
            incrementCount(impactedCellCounts, cellKey);
          }
        }
      }
    }
  }

  const keptNoImpactCells = Array.from(keptCellSet).filter(
    (cellKey) => !impactedCellSet.has(cellKey),
  );
  const keptNoImpactBuildings = Array.from(keptBuildingSet).filter(
    (obstacleId) => !impactedBuildingSet.has(obstacleId),
  );
  let checkedOnImpactedBuildings = 0;
  let checkedOnNeverImpactedBuildings = 0;
  for (const [obstacleId, count] of checkedBuildingCounts.entries()) {
    if (impactedBuildingSet.has(obstacleId)) {
      checkedOnImpactedBuildings += count;
    } else {
      checkedOnNeverImpactedBuildings += count;
    }
  }
  const checkedOnImpactedButNotFinalForSample = Math.max(
    0,
    checkedOnImpactedBuildings - samplesWithBuildingBlocked,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    params: args,
    tile,
    modelVersionHash: modelVersion.modelVersionHash,
    adaptiveTerrainMethod: adaptiveHorizon.terrainMethod,
    counts: {
      totalPoints,
      indoorPoints,
      outdoorPoints,
      pointsWithoutElevation,
      sampleCount: samples.length,
      totalPointFrames: outdoorPoints * samples.length,
      totalSamplesEvaluated: totalSamples,
      buildingEvaluatorCalls,
      buildingEvaluationPasses,
      samplesWithBuildingBlocked,
    },
    cullingYield: {
      cells: {
        keptCount: keptCellSet.size,
        impactedCount: impactedCellSet.size,
        keptButNoImpactCount: keptNoImpactCells.length,
        keptButNoImpactRatio: keptCellSet.size === 0 ? 0 : keptNoImpactCells.length / keptCellSet.size,
      },
      buildings: {
        keptCount: keptBuildingSet.size,
        impactedCount: impactedBuildingSet.size,
        keptButNoImpactCount: keptNoImpactBuildings.length,
        keptButNoImpactRatio:
          keptBuildingSet.size === 0 ? 0 : keptNoImpactBuildings.length / keptBuildingSet.size,
      },
    },
    workload: {
      totalCandidateObstacles,
      totalCheckedObstacles,
      avgCandidateObstaclesPerPass:
        buildingEvaluationPasses === 0 ? 0 : totalCandidateObstacles / buildingEvaluationPasses,
      avgCheckedObstaclesPerPass:
        buildingEvaluationPasses === 0 ? 0 : totalCheckedObstacles / buildingEvaluationPasses,
    },
    categories: {
      category1_legitimateFinalBlockerForPoint: {
        occurrences: samplesWithBuildingBlocked,
        ratioOfSamples:
          totalSamples === 0 ? 0 : samplesWithBuildingBlocked / totalSamples,
      },
      category2_checkedOnBuildingThatImpactsTileButNotThisPoint: {
        occurrences: checkedOnImpactedButNotFinalForSample,
        ratioOfChecked:
          totalCheckedObstacles === 0
            ? 0
            : checkedOnImpactedButNotFinalForSample / totalCheckedObstacles,
      },
      category3_wouldBlockButBehindCloserBuilding: {
        occurrences: debugStatsTotals.wouldBlockButFarther,
        ratioOfChecked:
          totalCheckedObstacles === 0
            ? 0
            : debugStatsTotals.wouldBlockButFarther / totalCheckedObstacles,
      },
      category4_checkedOnBuildingThatNeverImpactsTile: {
        occurrences: checkedOnNeverImpactedBuildings,
        ratioOfChecked:
          totalCheckedObstacles === 0
            ? 0
            : checkedOnNeverImpactedBuildings / totalCheckedObstacles,
      },
    },
    operationsBreakdown: {
      ...debugStatsTotals,
      checkedOnImpactedBuildings,
      checkedOnNeverImpactedBuildings,
      blockerPassesTotal: Array.from(blockerBuildingCounts.values()).reduce(
        (sum, value) => sum + value,
        0,
      ),
    },
    topUnusedCells: topUnused({
      keptCounts: keptCellCounts,
      impactedSet: impactedCellSet,
      limit: 30,
    }).map((entry) => ({
      cellKey: entry.key,
      keptCount: entry.keptCount,
      impactedCount: impactedCellCounts.get(entry.key) ?? 0,
    })),
    topUnusedBuildings: topUnused({
      keptCounts: keptBuildingCounts,
      impactedSet: impactedBuildingSet,
      limit: 30,
    }).map((entry) => ({
      obstacleId: entry.key,
      keptCount: entry.keptCount,
      impactedCount: impactedBuildingCounts.get(entry.key) ?? 0,
    })),
  };

  await fs.mkdir(REPORT_DIR, { recursive: true });
  const outputPath = path.join(
    REPORT_DIR,
    `culling-yield-${args.region}-${args.tileId}-${args.date}-${args.startLocalTime.replace(":", "")}-${args.endLocalTime.replace(":", "")}-g${args.gridStepMeters}-m${args.sampleEveryMinutes}-${args.mode}.json`,
  );
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        outputPath: outputPath.replace(process.cwd() + path.sep, ""),
        counts: report.counts,
        cullingYield: report.cullingYield,
        workload: report.workload,
        categories: report.categories,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    `[analyze-building-culling-yield] Failed: ${
      error instanceof Error ? error.message : "Unknown error"
    }`,
  );
  process.exitCode = 1;
});
