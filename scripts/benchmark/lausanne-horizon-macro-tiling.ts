import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { LAUSANNE_CENTER, LAUSANNE_LOCAL_BBOX } from "../../src/lib/config/lausanne";
import { buildGridFromBbox } from "../../src/lib/geo/grid";
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
  pointGridStepMeters: number;
  maxPoints: number;
  macroCellSizesMeters: number[];
}

interface SamplePoint {
  id: string;
  lat: number;
  lon: number;
  easting: number;
  northing: number;
}

interface MaskCenter {
  key: string;
  lat: number;
  lon: number;
  easting: number;
  northing: number;
}

interface Strategy {
  name: string;
  kind: "global" | "macro" | "local";
  cellSizeMeters?: number;
}

const DEFAULT_ARGS: ParsedArgs = {
  date: "2026-03-08",
  timezone: "Europe/Zurich",
  localTime: "17:00",
  sampleStepMinutes: 5,
  pointGridStepMeters: 500,
  maxPoints: 220,
  macroCellSizesMeters: [250, 500, 1000, 2000],
};

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
    if (arg.startsWith("--point-grid-step-meters=")) {
      const value = Number(arg.slice("--point-grid-step-meters=".length));
      if (Number.isInteger(value) && value >= 25 && value <= 5_000) {
        parsed.pointGridStepMeters = value;
      }
      continue;
    }
    if (arg.startsWith("--max-points=")) {
      const value = Number(arg.slice("--max-points=".length));
      if (Number.isInteger(value) && value >= 20 && value <= 10_000) {
        parsed.maxPoints = value;
      }
      continue;
    }
    if (arg.startsWith("--macro-cell-sizes=")) {
      const raw = arg.slice("--macro-cell-sizes=".length);
      const parsedSizes = raw
        .split(",")
        .map((chunk) => Number(chunk.trim()))
        .filter(
          (size) =>
            Number.isInteger(size) &&
            Number.isFinite(size) &&
            size >= 50 &&
            size <= 20_000,
        );
      if (parsedSizes.length > 0) {
        parsed.macroCellSizesMeters = Array.from(new Set(parsedSizes)).sort(
          (left, right) => left - right,
        );
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

function deterministicDownsample<T>(items: T[], maxItems: number): T[] {
  if (items.length <= maxItems) {
    return items;
  }
  const sampled: T[] = [];
  for (let i = 0; i < maxItems; i += 1) {
    const index = Math.floor((i * items.length) / maxItems);
    sampled.push(items[index]);
  }
  return sampled;
}

function buildSamplePoints(args: ParsedArgs): SamplePoint[] {
  const [minLon, minLat, maxLon, maxLat] = LAUSANNE_LOCAL_BBOX;
  const raw = buildGridFromBbox(
    { minLon, minLat, maxLon, maxLat },
    args.pointGridStepMeters,
  );
  const sampled = deterministicDownsample(raw, args.maxPoints);
  return sampled.map((point) => {
    const lv95 = wgs84ToLv95(point.lon, point.lat);
    return {
      id: point.id,
      lat: point.lat,
      lon: point.lon,
      easting: lv95.easting,
      northing: lv95.northing,
    };
  });
}

function resolveMaskCenter(point: SamplePoint, strategy: Strategy): MaskCenter {
  if (strategy.kind === "global") {
    const lv95 = wgs84ToLv95(LAUSANNE_CENTER.lon, LAUSANNE_CENTER.lat);
    return {
      key: toCenterKey(lv95.easting, lv95.northing),
      lat: LAUSANNE_CENTER.lat,
      lon: LAUSANNE_CENTER.lon,
      easting: lv95.easting,
      northing: lv95.northing,
    };
  }

  if (strategy.kind === "local") {
    return {
      key: toCenterKey(point.easting, point.northing),
      lat: point.lat,
      lon: point.lon,
      easting: point.easting,
      northing: point.northing,
    };
  }

  const cellSize = strategy.cellSizeMeters ?? 250;
  const cellEasting =
    Math.floor(point.easting / cellSize) * cellSize + cellSize / 2;
  const cellNorthing =
    Math.floor(point.northing / cellSize) * cellSize + cellSize / 2;
  const center = lv95ToWgs84(cellEasting, cellNorthing);
  return {
    key: toCenterKey(cellEasting, cellNorthing),
    lat: center.lat,
    lon: center.lon,
    easting: cellEasting,
    northing: cellNorthing,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const points = buildSamplePoints(args);
  if (points.length === 0) {
    throw new Error("No points generated for Lausanne benchmark.");
  }

  const strategies: Strategy[] = [
    { name: "global-single-mask", kind: "global" },
    ...args.macroCellSizesMeters.map((cellSizeMeters) => ({
      name: `macro-${cellSizeMeters}m`,
      kind: "macro" as const,
      cellSizeMeters,
    })),
  ];
  const referenceStrategy: Strategy = { name: "local-per-point", kind: "local" };

  const strategyCenterByPoint = new Map<string, string[]>();
  const centerCatalog = new Map<string, MaskCenter>();

  const allStrategies = [referenceStrategy, ...strategies];
  for (const strategy of allStrategies) {
    const centerKeys: string[] = [];
    for (const point of points) {
      const center = resolveMaskCenter(point, strategy);
      centerCatalog.set(center.key, center);
      centerKeys.push(center.key);
    }
    strategyCenterByPoint.set(strategy.name, centerKeys);
  }

  const centerBuildMs = new Map<string, number>();
  const centerMask = new Map<string, HorizonMask>();
  const centerKeysOrdered = [
    resolveMaskCenter(points[0], { name: "bootstrap", kind: "global" }).key,
    ...Array.from(centerCatalog.keys()),
  ].filter((value, index, array) => array.indexOf(value) === index);

  let bootstrapMs = 0;
  for (let index = 0; index < centerKeysOrdered.length; index += 1) {
    const key = centerKeysOrdered[index];
    const center = centerCatalog.get(key);
    if (!center) {
      continue;
    }
    const started = performance.now();
    const mask = await buildDynamicHorizonMask({
      lat: center.lat,
      lon: center.lon,
    });
    const elapsed = performance.now() - started;
    centerBuildMs.set(key, elapsed);
    if (!mask) {
      throw new Error(
        `Cannot build horizon mask for center ${center.lat}, ${center.lon}.`,
      );
    }
    centerMask.set(key, mask);
    if (index === 0) {
      bootstrapMs = elapsed;
    }
  }

  const utcSamples = buildUtcSamples(
    args.date,
    args.timezone,
    args.sampleStepMinutes,
  );
  const referenceUtc = zonedDateTimeToUtc(
    args.date,
    args.localTime,
    args.timezone,
  );

  const referenceStates: boolean[][] = [];
  const referenceTerrainAtCheck: boolean[] = [];
  const referenceSunnyAtCheck: boolean[] = [];
  const referenceHorizonAngleAtCheck: Array<number | null> = [];

  const referenceCenterKeys = strategyCenterByPoint.get(referenceStrategy.name);
  if (!referenceCenterKeys) {
    throw new Error("Missing reference center map.");
  }

  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    const key = referenceCenterKeys[pointIndex];
    const mask = centerMask.get(key);
    if (!mask) {
      throw new Error(`Missing reference mask for point ${point.id}.`);
    }

    const perFrame: boolean[] = [];
    for (const utcDate of utcSamples) {
      const sample = evaluateInstantSunlight({
        lat: point.lat,
        lon: point.lon,
        utcDate,
        timeZone: args.timezone,
        horizonMask: mask,
      });
      perFrame.push(sample.terrainBlocked);
    }
    referenceStates.push(perFrame);

    const check = evaluateInstantSunlight({
      lat: point.lat,
      lon: point.lon,
      utcDate: referenceUtc,
      timeZone: args.timezone,
      horizonMask: mask,
    });
    referenceTerrainAtCheck.push(check.terrainBlocked);
    referenceSunnyAtCheck.push(check.isSunny);
    referenceHorizonAngleAtCheck.push(check.horizonAngleDeg);
  }

  const referenceMaskCount = new Set(referenceCenterKeys).size;
  const referenceMaskBuildMs = Array.from(
    new Set(referenceCenterKeys).values(),
  ).reduce((sum, key) => sum + (centerBuildMs.get(key) ?? 0), 0);

  const strategyResults = strategies.map((strategy) => {
    const centerKeys = strategyCenterByPoint.get(strategy.name);
    if (!centerKeys) {
      throw new Error(`Missing center map for strategy ${strategy.name}.`);
    }

    let mismatchComparisons = 0;
    let pointsWithAnyMismatch = 0;
    let maxMismatchFramesPerPoint = 0;
    let differentTerrainBlockedAtCheckCount = 0;
    let differentSunnyAtCheckCount = 0;
    let horizonDeltaAbsTotal = 0;
    let horizonDeltaAbsCount = 0;
    let horizonDeltaAbsMax = 0;

    for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
      const point = points[pointIndex];
      const key = centerKeys[pointIndex];
      const mask = centerMask.get(key);
      if (!mask) {
        throw new Error(
          `Missing strategy mask (${strategy.name}) for point ${point.id}.`,
        );
      }

      let mismatchFramesForPoint = 0;
      for (let sampleIndex = 0; sampleIndex < utcSamples.length; sampleIndex += 1) {
        const sample = evaluateInstantSunlight({
          lat: point.lat,
          lon: point.lon,
          utcDate: utcSamples[sampleIndex],
          timeZone: args.timezone,
          horizonMask: mask,
        });
        if (sample.terrainBlocked !== referenceStates[pointIndex][sampleIndex]) {
          mismatchComparisons += 1;
          mismatchFramesForPoint += 1;
        }
      }

      if (mismatchFramesForPoint > 0) {
        pointsWithAnyMismatch += 1;
      }
      if (mismatchFramesForPoint > maxMismatchFramesPerPoint) {
        maxMismatchFramesPerPoint = mismatchFramesForPoint;
      }

      const check = evaluateInstantSunlight({
        lat: point.lat,
        lon: point.lon,
        utcDate: referenceUtc,
        timeZone: args.timezone,
        horizonMask: mask,
      });

      if (check.terrainBlocked !== referenceTerrainAtCheck[pointIndex]) {
        differentTerrainBlockedAtCheckCount += 1;
      }
      if (check.isSunny !== referenceSunnyAtCheck[pointIndex]) {
        differentSunnyAtCheckCount += 1;
      }
      const refHorizon = referenceHorizonAngleAtCheck[pointIndex];
      if (refHorizon !== null && check.horizonAngleDeg !== null) {
        const absDelta = Math.abs(check.horizonAngleDeg - refHorizon);
        horizonDeltaAbsTotal += absDelta;
        horizonDeltaAbsCount += 1;
        if (absDelta > horizonDeltaAbsMax) {
          horizonDeltaAbsMax = absDelta;
        }
      }
    }

    const uniqueCenterKeys = new Set(centerKeys);
    const strategyMaskBuildMs = Array.from(uniqueCenterKeys).reduce(
      (sum, key) => sum + (centerBuildMs.get(key) ?? 0),
      0,
    );
    const totalComparisons = points.length * utcSamples.length;

    return {
      strategy: strategy.name,
      cellSizeMeters: strategy.cellSizeMeters ?? null,
      masks: {
        count: uniqueCenterKeys.size,
        buildMs: Number(strategyMaskBuildMs.toFixed(3)),
        buildSpeedupVsLocal:
          strategyMaskBuildMs <= 0
            ? null
            : Number((referenceMaskBuildMs / strategyMaskBuildMs).toFixed(3)),
      },
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
        differentTerrainBlockedPointCount: differentTerrainBlockedAtCheckCount,
        differentSunnyPointCount: differentSunnyAtCheckCount,
        horizonAngleDeltaAbsMeanDeg:
          horizonDeltaAbsCount === 0
            ? null
            : Number((horizonDeltaAbsTotal / horizonDeltaAbsCount).toFixed(6)),
        horizonAngleDeltaAbsMaxDeg: Number(horizonDeltaAbsMax.toFixed(6)),
      },
    };
  });

  const maxDistanceFromCenterMeters = points.reduce((max, point) => {
    const distance = metersBetween(
      LAUSANNE_CENTER.lat,
      LAUSANNE_CENTER.lon,
      point.lat,
      point.lon,
    );
    return Math.max(max, distance);
  }, 0);

  const output = {
    generatedAt: new Date().toISOString(),
    benchmarkVersion: "v1",
    area: {
      name: "lausanne-local-bbox",
      bbox: {
        minLon: LAUSANNE_LOCAL_BBOX[0],
        minLat: LAUSANNE_LOCAL_BBOX[1],
        maxLon: LAUSANNE_LOCAL_BBOX[2],
        maxLat: LAUSANNE_LOCAL_BBOX[3],
      },
      center: LAUSANNE_CENTER,
      pointCount: points.length,
      maxDistanceFromCenterMeters: Number(maxDistanceFromCenterMeters.toFixed(3)),
    },
    args,
    maskBuild: {
      bootstrapFirstMaskMs: Number(bootstrapMs.toFixed(3)),
      referenceLocalMasksCount: referenceMaskCount,
      referenceLocalMasksBuildMs: Number(referenceMaskBuildMs.toFixed(3)),
      notes:
        "bootstrapFirstMaskMs captures DEM load + first mask build. Strategy buildMs includes all distinct centers required by the strategy.",
    },
    reference: {
      strategy: referenceStrategy.name,
      sampleCountPerPoint: utcSamples.length,
      sampleStepMinutes: args.sampleStepMinutes,
      checkAtLocalTime: args.localTime,
    },
    strategies: strategyResults,
  };

  await fs.mkdir(BENCHMARK_OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(
    BENCHMARK_OUTPUT_DIR,
    `lausanne-horizon-macro-tiling-${args.date.replaceAll("-", "")}-s${args.sampleStepMinutes}.json`,
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
