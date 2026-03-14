import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { LAUSANNE_CENTER } from "../../src/lib/config/lausanne";
import { lv95ToWgs84, wgs84ToLv95 } from "../../src/lib/geo/projection";
import { buildDynamicHorizonMask } from "../../src/lib/sun/dynamic-horizon-mask";
import type { HorizonMask } from "../../src/lib/sun/horizon-mask";
import { evaluateInstantSunlight } from "../../src/lib/sun/solar";
import { getZonedDayRangeUtc, zonedDateTimeToUtc } from "../../src/lib/time/zoned-date";

interface ParsedArgs {
  date: string;
  timezone: string;
  localTime: string;
  sampleStepMinutes: number;
  tileSizeMeters: number;
  pointStepMeters: number;
}

interface AnchorPoint {
  name: string;
  lat: number;
  lon: number;
}

interface TilePoint {
  id: string;
  cluster: string;
  lat: number;
  lon: number;
  easting: number;
  northing: number;
}

const DEFAULT_ARGS: ParsedArgs = {
  date: "2026-03-08",
  timezone: "Europe/Zurich",
  localTime: "17:00",
  sampleStepMinutes: 5,
  tileSizeMeters: 250,
  pointStepMeters: 25,
};

const CLUSTERS: AnchorPoint[] = [
  { name: "lausanne-ouest", lat: 46.52, lon: 6.56 },
  { name: "lausanne-est", lat: 46.52, lon: 6.72 },
  { name: "lausanne-nord", lat: 46.6, lon: 6.63 },
  { name: "lausanne-sud", lat: 46.495, lon: 6.63 },
];

const BENCHMARK_OUTPUT_DIR = path.join(
  process.cwd(),
  "docs",
  "progress",
  "benchmarks",
);

function parseArgs(argv: string[]): ParsedArgs {
  const parsed = { ...DEFAULT_ARGS };

  for (const arg of argv) {
    if (arg.startsWith("--date=")) {
      parsed.date = arg.slice("--date=".length);
      continue;
    }
    if (arg.startsWith("--timezone=")) {
      parsed.timezone = arg.slice("--timezone=".length);
      continue;
    }
    if (arg.startsWith("--local-time=")) {
      parsed.localTime = arg.slice("--local-time=".length);
      continue;
    }
    if (arg.startsWith("--sample-step-minutes=")) {
      const value = Number(arg.slice("--sample-step-minutes=".length));
      if (Number.isInteger(value) && value >= 1 && value <= 60) {
        parsed.sampleStepMinutes = value;
      }
      continue;
    }
    if (arg.startsWith("--tile-size-meters=")) {
      const value = Number(arg.slice("--tile-size-meters=".length));
      if (Number.isInteger(value) && value >= 100 && value <= 5_000) {
        parsed.tileSizeMeters = value;
      }
      continue;
    }
    if (arg.startsWith("--point-step-meters=")) {
      const value = Number(arg.slice("--point-step-meters=".length));
      if (Number.isInteger(value) && value >= 5 && value <= 250) {
        parsed.pointStepMeters = value;
      }
    }
  }

  return parsed;
}

function toCenterKey(easting: number, northing: number): string {
  return `${Math.round(easting * 1000)}:${Math.round(northing * 1000)}`;
}

function metersBetween(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): number {
  const dLat = (latB - latA) * 111_320;
  const avgLat = (latA + latB) / 2;
  const dLon = (lonB - lonA) * (111_320 * Math.cos((avgLat * Math.PI) / 180));
  return Math.hypot(dLat, dLon);
}

function buildTilePoints(
  cluster: AnchorPoint,
  tileSizeMeters: number,
  pointStepMeters: number,
): TilePoint[] {
  const centerLv95 = wgs84ToLv95(cluster.lon, cluster.lat);
  const half = tileSizeMeters / 2;
  const points: TilePoint[] = [];
  let index = 0;

  for (let dx = -half; dx <= half + 1e-9; dx += pointStepMeters) {
    for (let dy = -half; dy <= half + 1e-9; dy += pointStepMeters) {
      const easting = centerLv95.easting + dx;
      const northing = centerLv95.northing + dy;
      const wgs84 = lv95ToWgs84(easting, northing);
      points.push({
        id: `${cluster.name}-${index}`,
        cluster: cluster.name,
        lat: wgs84.lat,
        lon: wgs84.lon,
        easting,
        northing,
      });
      index += 1;
    }
  }

  return points;
}

function buildUtcSamples(
  date: string,
  timezone: string,
  sampleStepMinutes: number,
): Date[] {
  const { startUtc, endUtc } = getZonedDayRangeUtc(date, timezone);
  const samples: Date[] = [];
  const stepMs = sampleStepMinutes * 60_000;
  for (
    let cursor = startUtc.getTime();
    cursor < endUtc.getTime();
    cursor += stepMs
  ) {
    samples.push(new Date(cursor));
  }
  return samples;
}

async function ensureMask(
  centerKey: string,
  lat: number,
  lon: number,
  centerBuildMs: Map<string, number>,
  centerMasks: Map<string, HorizonMask>,
): Promise<void> {
  if (centerMasks.has(centerKey)) {
    return;
  }
  const started = performance.now();
  const mask = await buildDynamicHorizonMask({ lat, lon });
  const elapsed = performance.now() - started;
  centerBuildMs.set(centerKey, elapsed);
  if (!mask) {
    throw new Error(`Cannot build dynamic horizon mask at ${lat}, ${lon}.`);
  }
  centerMasks.set(centerKey, mask);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const points = CLUSTERS.flatMap((cluster) =>
    buildTilePoints(cluster, args.tileSizeMeters, args.pointStepMeters),
  );
  if (points.length === 0) {
    throw new Error("No points built for Lausanne tile benchmark.");
  }

  const globalLv95 = wgs84ToLv95(LAUSANNE_CENTER.lon, LAUSANNE_CENTER.lat);
  const globalKey = toCenterKey(globalLv95.easting, globalLv95.northing);
  const clusterCenterByName = new Map(
    CLUSTERS.map((cluster) => [cluster.name, cluster]),
  );

  const centerBuildMs = new Map<string, number>();
  const centerMasks = new Map<string, HorizonMask>();

  await ensureMask(
    globalKey,
    LAUSANNE_CENTER.lat,
    LAUSANNE_CENTER.lon,
    centerBuildMs,
    centerMasks,
  );
  const bootstrapMs = centerBuildMs.get(globalKey) ?? 0;

  for (const cluster of CLUSTERS) {
    const lv95 = wgs84ToLv95(cluster.lon, cluster.lat);
    await ensureMask(
      toCenterKey(lv95.easting, lv95.northing),
      cluster.lat,
      cluster.lon,
      centerBuildMs,
      centerMasks,
    );
  }

  for (const point of points) {
    await ensureMask(
      toCenterKey(point.easting, point.northing),
      point.lat,
      point.lon,
      centerBuildMs,
      centerMasks,
    );
  }

  const samples = buildUtcSamples(args.date, args.timezone, args.sampleStepMinutes);
  const checkUtc = zonedDateTimeToUtc(args.date, args.localTime, args.timezone);

  const localStates: boolean[][] = [];
  const localTerrainAtCheck: boolean[] = [];
  const localHorizonAtCheck: Array<number | null> = [];

  for (const point of points) {
    const localKey = toCenterKey(point.easting, point.northing);
    const localMask = centerMasks.get(localKey);
    if (!localMask) {
      throw new Error(`Missing local mask for point ${point.id}.`);
    }

    const pointStates: boolean[] = [];
    for (const utcDate of samples) {
      const sample = evaluateInstantSunlight({
        lat: point.lat,
        lon: point.lon,
        utcDate,
        timeZone: args.timezone,
        horizonMask: localMask,
      });
      pointStates.push(sample.terrainBlocked);
    }
    localStates.push(pointStates);

    const check = evaluateInstantSunlight({
      lat: point.lat,
      lon: point.lon,
      utcDate: checkUtc,
      timeZone: args.timezone,
      horizonMask: localMask,
    });
    localTerrainAtCheck.push(check.terrainBlocked);
    localHorizonAtCheck.push(check.horizonAngleDeg);
  }

  function evaluateStrategy(name: "tile-mask" | "global-mask") {
    let mismatchComparisons = 0;
    let pointsWithAnyMismatch = 0;
    let maxMismatchFramesPerPoint = 0;
    let checkDifferentTerrain = 0;
    let horizonDeltaAbsTotal = 0;
    let horizonDeltaAbsCount = 0;
    let horizonDeltaAbsMax = 0;

    const perCluster = new Map<
      string,
      {
        points: number;
        mismatchComparisons: number;
        pointsWithAnyMismatch: number;
        maxMismatchFramesPerPoint: number;
      }
    >();

    for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
      const point = points[pointIndex];
      const cluster = clusterCenterByName.get(point.cluster);
      if (!cluster) {
        throw new Error(`Unknown cluster '${point.cluster}' for point ${point.id}.`);
      }

      const strategyKey =
        name === "global-mask"
          ? globalKey
          : toCenterKey(
              wgs84ToLv95(cluster.lon, cluster.lat).easting,
              wgs84ToLv95(cluster.lon, cluster.lat).northing,
            );
      const strategyMask = centerMasks.get(strategyKey);
      if (!strategyMask) {
        throw new Error(`Missing ${name} mask for point ${point.id}.`);
      }

      let pointMismatchFrames = 0;
      for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
        const sample = evaluateInstantSunlight({
          lat: point.lat,
          lon: point.lon,
          utcDate: samples[sampleIndex],
          timeZone: args.timezone,
          horizonMask: strategyMask,
        });
        if (sample.terrainBlocked !== localStates[pointIndex][sampleIndex]) {
          mismatchComparisons += 1;
          pointMismatchFrames += 1;
        }
      }

      if (pointMismatchFrames > 0) {
        pointsWithAnyMismatch += 1;
      }
      maxMismatchFramesPerPoint = Math.max(
        maxMismatchFramesPerPoint,
        pointMismatchFrames,
      );

      const check = evaluateInstantSunlight({
        lat: point.lat,
        lon: point.lon,
        utcDate: checkUtc,
        timeZone: args.timezone,
        horizonMask: strategyMask,
      });
      if (check.terrainBlocked !== localTerrainAtCheck[pointIndex]) {
        checkDifferentTerrain += 1;
      }

      const refHorizon = localHorizonAtCheck[pointIndex];
      if (refHorizon !== null && check.horizonAngleDeg !== null) {
        const absDelta = Math.abs(check.horizonAngleDeg - refHorizon);
        horizonDeltaAbsTotal += absDelta;
        horizonDeltaAbsCount += 1;
        horizonDeltaAbsMax = Math.max(horizonDeltaAbsMax, absDelta);
      }

      const clusterStats = perCluster.get(point.cluster) ?? {
        points: 0,
        mismatchComparisons: 0,
        pointsWithAnyMismatch: 0,
        maxMismatchFramesPerPoint: 0,
      };
      clusterStats.points += 1;
      clusterStats.mismatchComparisons += pointMismatchFrames;
      if (pointMismatchFrames > 0) {
        clusterStats.pointsWithAnyMismatch += 1;
      }
      clusterStats.maxMismatchFramesPerPoint = Math.max(
        clusterStats.maxMismatchFramesPerPoint,
        pointMismatchFrames,
      );
      perCluster.set(point.cluster, clusterStats);
    }

    const totalComparisons = points.length * samples.length;
    return {
      strategy: name,
      qualityVsLocal: {
        pointsWithAnyMismatch,
        pointsWithAnyMismatchPct: Number(
          ((pointsWithAnyMismatch / points.length) * 100).toFixed(3),
        ),
        maxMismatchMinutesPerPoint: maxMismatchFramesPerPoint * args.sampleStepMinutes,
        avgMismatchMinutesPerPoint: Number(
          (
            ((mismatchComparisons * args.sampleStepMinutes) / points.length)
          ).toFixed(3),
        ),
        mismatchComparisons,
        mismatchPctComparisons: Number(
          ((mismatchComparisons / Math.max(totalComparisons, 1)) * 100).toFixed(3),
        ),
        mismatchPointMinutes: mismatchComparisons * args.sampleStepMinutes,
        mismatchPointHours: Number(
          (
            (mismatchComparisons * args.sampleStepMinutes) / 60
          ).toFixed(3),
        ),
      },
      checkAt: {
        localTime: args.localTime,
        differentTerrainBlockedPointCount: checkDifferentTerrain,
        horizonAngleDeltaAbsMeanDeg:
          horizonDeltaAbsCount > 0
            ? Number((horizonDeltaAbsTotal / horizonDeltaAbsCount).toFixed(6))
            : null,
        horizonAngleDeltaAbsMaxDeg: Number(horizonDeltaAbsMax.toFixed(6)),
      },
      byCluster: Array.from(perCluster.entries()).map(([cluster, stats]) => ({
        cluster,
        points: stats.points,
        pointsWithAnyMismatch: stats.pointsWithAnyMismatch,
        pointsWithAnyMismatchPct: Number(
          ((stats.pointsWithAnyMismatch / Math.max(stats.points, 1)) * 100).toFixed(3),
        ),
        avgMismatchMinutesPerPoint: Number(
          ((stats.mismatchComparisons * args.sampleStepMinutes) / Math.max(stats.points, 1)).toFixed(3),
        ),
        maxMismatchMinutesPerPoint:
          stats.maxMismatchFramesPerPoint * args.sampleStepMinutes,
      })),
    };
  }

  const tileCenterKeys = new Set(
    CLUSTERS.map((cluster) => {
      const lv95 = wgs84ToLv95(cluster.lon, cluster.lat);
      return toCenterKey(lv95.easting, lv95.northing);
    }),
  );
  const localCenterKeys = new Set(
    points.map((point) => toCenterKey(point.easting, point.northing)),
  );

  const localMaskBuildMs = Array.from(localCenterKeys).reduce(
    (sum, key) => sum + (centerBuildMs.get(key) ?? 0),
    0,
  );
  const tileMaskBuildMs = Array.from(tileCenterKeys).reduce(
    (sum, key) => sum + (centerBuildMs.get(key) ?? 0),
    0,
  );
  const globalMaskBuildMs = centerBuildMs.get(globalKey) ?? 0;

  const maxDistanceFromGlobalCenterMeters = points.reduce((max, point) => {
    return Math.max(
      max,
      metersBetween(LAUSANNE_CENTER.lat, LAUSANNE_CENTER.lon, point.lat, point.lon),
    );
  }, 0);

  const output = {
    generatedAt: new Date().toISOString(),
    benchmarkVersion: "v1",
    scenario: {
      name: "lausanne-far-tiles",
      clusters: CLUSTERS,
      tileSizeMeters: args.tileSizeMeters,
      pointStepMeters: args.pointStepMeters,
      pointCountTotal: points.length,
      pointCountPerCluster: points.length / CLUSTERS.length,
      maxDistanceFromLausanneCenterMeters: Number(
        maxDistanceFromGlobalCenterMeters.toFixed(3),
      ),
    },
    args,
    maskBuild: {
      bootstrapFirstMaskMs: Number(bootstrapMs.toFixed(3)),
      localPerPoint: {
        maskCount: localCenterKeys.size,
        buildMs: Number(localMaskBuildMs.toFixed(3)),
      },
      tilePerCluster: {
        maskCount: tileCenterKeys.size,
        buildMs: Number(tileMaskBuildMs.toFixed(3)),
        speedupVsLocal:
          tileMaskBuildMs <= 0
            ? null
            : Number((localMaskBuildMs / tileMaskBuildMs).toFixed(3)),
      },
      globalSingleMask: {
        maskCount: 1,
        buildMs: Number(globalMaskBuildMs.toFixed(3)),
        speedupVsLocal:
          globalMaskBuildMs <= 0
            ? null
            : Number((localMaskBuildMs / globalMaskBuildMs).toFixed(3)),
      },
    },
    reference: {
      strategy: "local-per-point",
      sampleCountPerPoint: samples.length,
      sampleStepMinutes: args.sampleStepMinutes,
      checkAtLocalTime: args.localTime,
    },
    comparisons: [evaluateStrategy("tile-mask"), evaluateStrategy("global-mask")],
  };

  await fs.mkdir(BENCHMARK_OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(
    BENCHMARK_OUTPUT_DIR,
    `lausanne-horizon-tile-vs-global-${args.date.replaceAll("-", "")}-s${args.sampleStepMinutes}.json`,
  );
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`[benchmark] Output written: ${outputPath}`);
  console.log(JSON.stringify(output, null, 2));
}

void main().catch((error) => {
  console.error(
    `[benchmark] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
