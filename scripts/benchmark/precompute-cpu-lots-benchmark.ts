import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { LAUSANNE_CONFIG } from "@/lib/config/lausanne";
import { buildTilePoints, buildRegionTiles } from "@/lib/precompute/sunlight-cache";
import { getSunlightModelVersion } from "@/lib/precompute/model-version";
import { resolveAdaptiveTerrainHorizonForTile } from "@/lib/sun/adaptive-horizon-sharing";
import { evaluateBuildingsShadow } from "@/lib/sun/buildings-shadow";
import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "@/lib/sun/evaluation-context";
import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";

const OUTPUT_DIR = path.join(process.cwd(), "docs", "progress", "benchmarks");

interface TestObstacle {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  height: number;
  centerX: number;
  centerY: number;
  halfDiagonal: number;
  footprint: Array<{ x: number; y: number }>;
  footprintArea: number;
  sourceZip: string;
}

function createRectangleObstacle(params: {
  id: string;
  centerX: number;
  centerY: number;
  width: number;
  depth: number;
  maxZ: number;
}): TestObstacle {
  const minX = params.centerX - params.width / 2;
  const maxX = params.centerX + params.width / 2;
  const minY = params.centerY - params.depth / 2;
  const maxY = params.centerY + params.depth / 2;
  return {
    id: params.id,
    minX,
    minY,
    maxX,
    maxY,
    minZ: 0,
    maxZ: params.maxZ,
    height: params.maxZ,
    centerX: params.centerX,
    centerY: params.centerY,
    halfDiagonal: Math.hypot(params.width, params.depth) / 2,
    footprint: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
    footprintArea: params.width * params.depth,
    sourceZip: "benchmark.zip",
  };
}

function buildSpatialGrid(obstacles: TestObstacle[], cellSizeMeters: number) {
  const cells: Record<string, number[]> = {};
  for (let i = 0; i < obstacles.length; i += 1) {
    const obstacle = obstacles[i];
    const minCellX = Math.floor(obstacle.minX / cellSizeMeters);
    const maxCellX = Math.floor(obstacle.maxX / cellSizeMeters);
    const minCellY = Math.floor(obstacle.minY / cellSizeMeters);
    const maxCellY = Math.floor(obstacle.maxY / cellSizeMeters);
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const key = `${cellX}:${cellY}`;
        if (!cells[key]) {
          cells[key] = [];
        }
        cells[key].push(i);
      }
    }
  }

  return {
    version: 1,
    cellSizeMeters,
    cells,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1))),
  );
  return sorted[index];
}

async function benchmarkLotA() {
  const blocker = createRectangleObstacle({
    id: "blocker",
    centerX: 0,
    centerY: 50,
    width: 20,
    depth: 20,
    maxZ: 35,
  });
  const distractors = Array.from({ length: 1000 }, (_, index) =>
    createRectangleObstacle({
      id: `d${index}`,
      centerX: 200 + (index % 40) * 35,
      centerY: -500 - Math.floor(index / 40) * 30,
      width: 18,
      depth: 18,
      maxZ: 22,
    }),
  );
  const obstacles = [blocker, ...distractors];
  const spatialGrid = buildSpatialGrid(obstacles, 64);

  const iterations = 500;
  let baselineChecked = 0;
  let indexedChecked = 0;
  const baselineCheckedSeries: number[] = [];
  const indexedCheckedSeries: number[] = [];

  const baselineStarted = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const result = evaluateBuildingsShadow(obstacles, {
      pointX: 0,
      pointY: 0,
      pointElevation: 0,
      solarAzimuthDeg: 0,
      solarAltitudeDeg: 15,
      maxDistanceMeters: 1800,
    });
    baselineChecked += result.checkedObstaclesCount;
    baselineCheckedSeries.push(result.checkedObstaclesCount);
  }
  const baselineElapsedMs = performance.now() - baselineStarted;

  const indexedStarted = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const result = evaluateBuildingsShadow(
      obstacles,
      {
        pointX: 0,
        pointY: 0,
        pointElevation: 0,
        solarAzimuthDeg: 0,
        solarAltitudeDeg: 15,
        maxDistanceMeters: 1800,
      },
      spatialGrid,
    );
    indexedChecked += result.checkedObstaclesCount;
    indexedCheckedSeries.push(result.checkedObstaclesCount);
  }
  const indexedElapsedMs = performance.now() - indexedStarted;

  return {
    iterations,
    baselineElapsedMs: Math.round(baselineElapsedMs * 1000) / 1000,
    indexedElapsedMs: Math.round(indexedElapsedMs * 1000) / 1000,
    baselineCheckedAvg: Math.round((baselineChecked / iterations) * 1000) / 1000,
    indexedCheckedAvg: Math.round((indexedChecked / iterations) * 1000) / 1000,
    baselineCheckedP50: percentile(baselineCheckedSeries, 50),
    baselineCheckedP95: percentile(baselineCheckedSeries, 95),
    indexedCheckedP50: percentile(indexedCheckedSeries, 50),
    indexedCheckedP95: percentile(indexedCheckedSeries, 95),
    speedup:
      indexedElapsedMs <= 0
        ? null
        : Math.round((baselineElapsedMs / indexedElapsedMs) * 1000) / 1000,
  };
}

async function benchmarkLotB() {
  const tiles = buildRegionTiles("lausanne", 250);
  const tile =
    tiles.find((candidate) => {
      const centerLat = (candidate.bbox.minLat + candidate.bbox.maxLat) / 2;
      const centerLon = (candidate.bbox.minLon + candidate.bbox.maxLon) / 2;
      return (
        centerLon >= LAUSANNE_CONFIG.localBbox[0] &&
        centerLon <= LAUSANNE_CONFIG.localBbox[2] &&
        centerLat >= LAUSANNE_CONFIG.localBbox[1] &&
        centerLat <= LAUSANNE_CONFIG.localBbox[3]
      );
    }) ?? null;
  if (!tile) {
    return {
      skipped: true,
      reason: "No Lausanne tile available for benchmark.",
    };
  }

  const points = buildTilePoints(tile, 5).slice(0, 180);
  if (points.length === 0) {
    return {
      skipped: true,
      reason: "No grid points in selected tile.",
    };
  }

  const noSharedStarted = performance.now();
  const noSharedContexts = [];
  for (const point of points) {
    noSharedContexts.push(
      await buildPointEvaluationContext(point.lat, point.lon, {
        skipTerrainSamplingWhenIndoor: true,
      }),
    );
  }
  const noSharedElapsedMs = performance.now() - noSharedStarted;

  const sharedSources = await buildSharedPointEvaluationSources({
    lv95Bounds: {
      minX: tile.minEasting,
      minY: tile.minNorthing,
      maxX: tile.maxEasting,
      maxY: tile.maxNorthing,
    },
  });
  const sharedStarted = performance.now();
  const sharedContexts = [];
  for (const point of points) {
    sharedContexts.push(
      await buildPointEvaluationContext(point.lat, point.lon, {
        skipTerrainSamplingWhenIndoor: true,
        sharedSources,
      }),
    );
  }
  const sharedElapsedMs = performance.now() - sharedStarted;

  let parityMismatchCount = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = noSharedContexts[i];
    const b = sharedContexts[i];
    if (
      a.insideBuilding !== b.insideBuilding ||
      a.indoorBuildingId !== b.indoorBuildingId ||
      a.pointElevationMeters !== b.pointElevationMeters ||
      a.terrainHorizonMethod !== b.terrainHorizonMethod ||
      a.buildingsShadowMethod !== b.buildingsShadowMethod ||
      (a.vegetationShadowMethod ?? "none") !== (b.vegetationShadowMethod ?? "none")
    ) {
      parityMismatchCount += 1;
    }
  }

  return {
    sampledPoints: points.length,
    noSharedElapsedMs: Math.round(noSharedElapsedMs * 1000) / 1000,
    sharedElapsedMs: Math.round(sharedElapsedMs * 1000) / 1000,
    speedup:
      sharedElapsedMs <= 0
        ? null
        : Math.round((noSharedElapsedMs / sharedElapsedMs) * 1000) / 1000,
    parityMismatchCount,
  };
}

async function benchmarkLotC() {
  const tiles = buildRegionTiles("lausanne", 250).slice(0, 24);
  if (tiles.length === 0) {
    return {
      skipped: true,
      reason: "No Lausanne tiles available.",
    };
  }

  const model = await getSunlightModelVersion("lausanne", {
    observerHeightMeters: 0,
    buildingHeightBiasMeters: 0,
  });

  const localStarted = performance.now();
  let localMaskCount = 0;
  for (const tile of tiles) {
    const centerLat = (tile.bbox.minLat + tile.bbox.maxLat) / 2;
    const centerLon = (tile.bbox.minLon + tile.bbox.maxLon) / 2;
    const mask = await buildDynamicHorizonMask({
      lat: centerLat,
      lon: centerLon,
    });
    if (mask) {
      localMaskCount += 1;
    }
  }
  const localElapsedMs = performance.now() - localStarted;

  const adaptiveFirstStarted = performance.now();
  let sharedCount = 0;
  let localCount = 0;
  let noneCount = 0;
  for (const tile of tiles) {
    const resolution = await resolveAdaptiveTerrainHorizonForTile({
      region: "lausanne",
      modelVersionHash: model.modelVersionHash,
      tile,
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      sampleEveryMinutes: 15,
      startLocalTime: "08:00",
      endLocalTime: "19:00",
      gridStepMeters: 5,
    });
    if (resolution.strategy === "shared") {
      sharedCount += 1;
    } else if (resolution.strategy === "local") {
      localCount += 1;
    } else {
      noneCount += 1;
    }
  }
  const adaptiveFirstElapsedMs = performance.now() - adaptiveFirstStarted;

  const adaptiveWarmStarted = performance.now();
  for (const tile of tiles) {
    await resolveAdaptiveTerrainHorizonForTile({
      region: "lausanne",
      modelVersionHash: model.modelVersionHash,
      tile,
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      sampleEveryMinutes: 15,
      startLocalTime: "08:00",
      endLocalTime: "19:00",
      gridStepMeters: 5,
    });
  }
  const adaptiveWarmElapsedMs = performance.now() - adaptiveWarmStarted;

  return {
    tilesMeasured: tiles.length,
    localOnlyElapsedMs: Math.round(localElapsedMs * 1000) / 1000,
    localMaskCount,
    adaptiveFirstElapsedMs: Math.round(adaptiveFirstElapsedMs * 1000) / 1000,
    adaptiveWarmElapsedMs: Math.round(adaptiveWarmElapsedMs * 1000) / 1000,
    decisions: {
      shared: sharedCount,
      local: localCount,
      none: noneCount,
    },
  };
}

async function main() {
  const started = performance.now();
  const [lotA, lotB, lotC] = await Promise.all([
    benchmarkLotA(),
    benchmarkLotB(),
    benchmarkLotC(),
  ]);
  const result = {
    generatedAt: new Date().toISOString(),
    benchmarkDate: "2026-03-15",
    lots: {
      lotA,
      lotB,
      lotC,
    },
    elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(
    OUTPUT_DIR,
    "precompute-cpu-lots-20260315.json",
  );
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({ outputPath, result }, null, 2));
}

main().catch((error) => {
  console.error(
    `[benchmark:precompute-cpu-lots] Failed: ${
      error instanceof Error ? error.message : "Unknown error"
    }`,
  );
  process.exitCode = 1;
});
