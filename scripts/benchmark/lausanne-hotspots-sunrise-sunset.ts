import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import SunCalc from "suncalc";

import { buildSharedPointEvaluationSources, buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import {
  createDetailedBuildingShadowVerifier,
  evaluateBuildingsShadowTwoLevel,
} from "@/lib/sun/buildings-shadow";
import {
  evaluateInstantSunlight,
  type InstantSunlightProfiler,
  type SunSample,
} from "@/lib/sun/solar";
import { DEFAULT_SHADOW_CALIBRATION } from "@/lib/sun/shadow-calibration";
import { lv95ToWgs84, wgs84ToLv95 } from "@/lib/geo/projection";
import { zonedDateTimeToUtc } from "@/lib/time/zoned-date";

type ModeName = "detailed" | "two-level";

interface Hotspot {
  id: string;
  name: string;
  bbox: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
}

interface PointContext {
  id: string;
  row: number;
  col: number;
  lat: number;
  lon: number;
  pointElevationMeters: number | null;
  insideBuilding: boolean;
  horizonMask: Awaited<ReturnType<typeof buildPointEvaluationContext>>["horizonMask"];
  vegetationShadowEvaluator: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["vegetationShadowEvaluator"];
  detailedBuildingShadowEvaluator: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["buildingShadowEvaluator"];
  twoLevelBuildingShadowEvaluator: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["buildingShadowEvaluator"];
}

interface ModeRunResult {
  mode: ModeName;
  elapsedMs: number;
  profiler: InstantSunlightProfiler;
  samples: SunSample[];
}

const DATE = "2026-03-08";
const TIMEZONE = "Europe/Zurich";
const GRID_STEP_METERS = 1;
const SUN_OFFSET_MINUTES = 10;

const HOTSPOTS: Hotspot[] = [
  {
    id: "pepinet-mccarthys",
    name: "Place Pépinet / Mc Carthy's",
    bbox: {
      minLon: 6.63195,
      minLat: 46.5213,
      maxLon: 6.63255,
      maxLat: 46.5217,
    },
  },
  {
    id: "grandes-roches",
    name: "Terrasse des Grandes Roches",
    bbox: {
      minLon: 6.63555,
      minLat: 46.52125,
      maxLon: 6.6362,
      maxLat: 46.52165,
    },
  },
  {
    id: "great-escape-rumine",
    name: "The Great Escape / Rumine",
    bbox: {
      minLon: 6.6322,
      minLat: 46.52255,
      maxLon: 6.63335,
      maxLat: 46.52305,
    },
  },
];

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function toLocalDateTime(value: Date, timeZone: string): string {
  const datePart = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
  const timePart = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
  return `${datePart} ${timePart}`;
}

function createEmptyProfiler(): InstantSunlightProfiler {
  return {
    evaluations: 0,
    totalMs: 0,
    solarPositionMs: 0,
    terrainMs: 0,
    buildingsMs: 0,
    vegetationMs: 0,
    finalizeMs: 0,
    belowAstronomicalHorizonCount: 0,
    terrainCheckNeededCount: 0,
    terrainBlockedCount: 0,
    secondarySkippedByTerrainCount: 0,
    buildingsEvaluatorCalls: 0,
    vegetationEvaluatorCalls: 0,
  };
}

function buildGridPoints(hotspot: Hotspot): Array<{
  id: string;
  row: number;
  col: number;
  lat: number;
  lon: number;
}> {
  const points: Array<{ id: string; row: number; col: number; lat: number; lon: number }> = [];
  const corners = [
    wgs84ToLv95(hotspot.bbox.minLon, hotspot.bbox.minLat),
    wgs84ToLv95(hotspot.bbox.minLon, hotspot.bbox.maxLat),
    wgs84ToLv95(hotspot.bbox.maxLon, hotspot.bbox.minLat),
    wgs84ToLv95(hotspot.bbox.maxLon, hotspot.bbox.maxLat),
  ];
  const minX = Math.floor(Math.min(...corners.map((point) => point.easting)));
  const maxX = Math.ceil(Math.max(...corners.map((point) => point.easting)));
  const minY = Math.floor(Math.min(...corners.map((point) => point.northing)));
  const maxY = Math.ceil(Math.max(...corners.map((point) => point.northing)));

  let row = 0;
  for (
    let northing = minY + GRID_STEP_METERS / 2;
    northing <= maxY;
    northing += GRID_STEP_METERS
  ) {
    let col = 0;
    for (
      let easting = minX + GRID_STEP_METERS / 2;
      easting <= maxX;
      easting += GRID_STEP_METERS
    ) {
      const wgs = lv95ToWgs84(easting, northing);
      if (
        wgs.lon < hotspot.bbox.minLon ||
        wgs.lon > hotspot.bbox.maxLon ||
        wgs.lat < hotspot.bbox.minLat ||
        wgs.lat > hotspot.bbox.maxLat
      ) {
        col += 1;
        continue;
      }
      points.push({
        id: `${hotspot.id}-r${row}-c${col}`,
        row,
        col,
        lat: wgs.lat,
        lon: wgs.lon,
      });
      col += 1;
    }
    row += 1;
  }

  return points;
}

function getSunEdgeTimes(centerLat: number, centerLon: number): {
  sunriseUtc: Date;
  sunsetUtc: Date;
  firstRaysUtc: Date;
  lastRaysUtc: Date;
} {
  const utcNoon = zonedDateTimeToUtc(DATE, "12:00", TIMEZONE);
  const times = SunCalc.getTimes(utcNoon, centerLat, centerLon);
  if (!times.sunrise || !times.sunset) {
    throw new Error("Impossible de calculer sunrise/sunset pour ce hotspot.");
  }
  const sunriseUtc = times.sunrise;
  const sunsetUtc = times.sunset;
  return {
    sunriseUtc,
    sunsetUtc,
    firstRaysUtc: new Date(sunriseUtc.getTime() + SUN_OFFSET_MINUTES * 60_000),
    lastRaysUtc: new Date(sunsetUtc.getTime() - SUN_OFFSET_MINUTES * 60_000),
  };
}

async function buildPointContexts(hotspot: Hotspot): Promise<PointContext[]> {
  const corners = [
    wgs84ToLv95(hotspot.bbox.minLon, hotspot.bbox.minLat),
    wgs84ToLv95(hotspot.bbox.minLon, hotspot.bbox.maxLat),
    wgs84ToLv95(hotspot.bbox.maxLon, hotspot.bbox.minLat),
    wgs84ToLv95(hotspot.bbox.maxLon, hotspot.bbox.maxLat),
  ];
  const minX = Math.floor(Math.min(...corners.map((point) => point.easting))) - 20;
  const minY = Math.floor(Math.min(...corners.map((point) => point.northing))) - 20;
  const maxX = Math.ceil(Math.max(...corners.map((point) => point.easting))) + 20;
  const maxY = Math.ceil(Math.max(...corners.map((point) => point.northing))) + 20;

  const sharedSources = await buildSharedPointEvaluationSources({
    lv95Bounds: {
      minX,
      minY,
      maxX,
      maxY,
    },
  });
  const detailedVerifier = sharedSources.buildingsIndex
    ? createDetailedBuildingShadowVerifier(sharedSources.buildingsIndex.obstacles)
    : null;
  const buildingHeightBiasMeters = DEFAULT_SHADOW_CALIBRATION.buildingHeightBiasMeters;

  const gridPoints = buildGridPoints(hotspot);
  const contexts: PointContext[] = [];
  for (const point of gridPoints) {
    const context = await buildPointEvaluationContext(point.lat, point.lon, {
      sharedSources,
    });
    const hasBuildingData =
      !!sharedSources.buildingsIndex &&
      context.pointElevationMeters !== null &&
      !context.insideBuilding &&
      detailedVerifier !== null;

    const twoLevelBuildingShadowEvaluator = hasBuildingData
      ? (sample: { azimuthDeg: number; altitudeDeg: number }) =>
          evaluateBuildingsShadowTwoLevel(
            sharedSources.buildingsIndex!.obstacles,
            {
              pointX: context.pointLv95.easting,
              pointY: context.pointLv95.northing,
              pointElevation: context.pointElevationMeters!,
              solarAzimuthDeg: sample.azimuthDeg,
              solarAltitudeDeg: sample.altitudeDeg,
              buildingHeightBiasMeters,
            },
            sharedSources.buildingsIndex!.spatialGrid,
            {
              detailedVerifier,
              nearThresholdDegrees: 2,
              maxRefinementSteps: 3,
            },
          )
      : undefined;

    contexts.push({
      id: point.id,
      row: point.row,
      col: point.col,
      lat: point.lat,
      lon: point.lon,
      pointElevationMeters: context.pointElevationMeters,
      insideBuilding: context.insideBuilding,
      horizonMask: context.horizonMask,
      vegetationShadowEvaluator: context.vegetationShadowEvaluator,
      detailedBuildingShadowEvaluator: context.buildingShadowEvaluator,
      twoLevelBuildingShadowEvaluator,
    });
  }

  return contexts;
}

function runModeAtTime(
  contexts: PointContext[],
  utcDate: Date,
  mode: ModeName,
): ModeRunResult {
  const profiler = createEmptyProfiler();
  const samples: SunSample[] = [];
  const startedAt = performance.now();
  for (const context of contexts) {
    const sample = evaluateInstantSunlight({
      lat: context.lat,
      lon: context.lon,
      utcDate,
      timeZone: TIMEZONE,
      horizonMask: context.horizonMask,
      buildingShadowEvaluator:
        mode === "detailed"
          ? context.detailedBuildingShadowEvaluator
          : context.twoLevelBuildingShadowEvaluator,
      vegetationShadowEvaluator: context.vegetationShadowEvaluator,
      profiler,
    });
    samples.push(sample);
  }
  const elapsedMs = performance.now() - startedAt;
  return {
    mode,
    elapsedMs,
    profiler,
    samples,
  };
}

function compareModes(
  contexts: PointContext[],
  detailed: ModeRunResult,
  twoLevel: ModeRunResult,
) {
  let mismatchIsSunny = 0;
  let mismatchBuildingsBlocked = 0;
  let mismatchBuildingBlockerId = 0;
  const mismatches: Array<{
    id: string;
    lat: number;
    lon: number;
    detailed: Pick<SunSample, "isSunny" | "buildingsBlocked" | "buildingBlockerId">;
    twoLevel: Pick<SunSample, "isSunny" | "buildingsBlocked" | "buildingBlockerId">;
  }> = [];

  for (let i = 0; i < contexts.length; i += 1) {
    const d = detailed.samples[i];
    const t = twoLevel.samples[i];
    const context = contexts[i];
    const isSunnyMismatch = d.isSunny !== t.isSunny;
    const buildingsBlockedMismatch = d.buildingsBlocked !== t.buildingsBlocked;
    const blockerIdMismatch = d.buildingBlockerId !== t.buildingBlockerId;

    if (isSunnyMismatch) {
      mismatchIsSunny += 1;
    }
    if (buildingsBlockedMismatch) {
      mismatchBuildingsBlocked += 1;
    }
    if (blockerIdMismatch) {
      mismatchBuildingBlockerId += 1;
    }

    if (isSunnyMismatch || buildingsBlockedMismatch || blockerIdMismatch) {
      mismatches.push({
        id: context.id,
        lat: round6(context.lat),
        lon: round6(context.lon),
        detailed: {
          isSunny: d.isSunny,
          buildingsBlocked: d.buildingsBlocked,
          buildingBlockerId: d.buildingBlockerId,
        },
        twoLevel: {
          isSunny: t.isSunny,
          buildingsBlocked: t.buildingsBlocked,
          buildingBlockerId: t.buildingBlockerId,
        },
      });
    }
  }

  return {
    mismatchIsSunny,
    mismatchBuildingsBlocked,
    mismatchBuildingBlockerId,
    mismatchAny: mismatches.length,
    mismatchRatioPct: round3((mismatches.length / Math.max(1, contexts.length)) * 100),
    sampleMismatches: mismatches.slice(0, 12),
  };
}

async function main() {
  const report: {
    generatedAt: string;
    setup: {
      date: string;
      timezone: string;
      gridStepMeters: number;
      sunOffsetMinutes: number;
    };
    hotspots: unknown[];
  } = {
    generatedAt: new Date().toISOString(),
    setup: {
      date: DATE,
      timezone: TIMEZONE,
      gridStepMeters: GRID_STEP_METERS,
      sunOffsetMinutes: SUN_OFFSET_MINUTES,
    },
    hotspots: [],
  };

  for (const hotspot of HOTSPOTS) {
    const centerLat = (hotspot.bbox.minLat + hotspot.bbox.maxLat) / 2;
    const centerLon = (hotspot.bbox.minLon + hotspot.bbox.maxLon) / 2;
    const sunTimes = getSunEdgeTimes(centerLat, centerLon);
    const contexts = await buildPointContexts(hotspot);

    const windows = [
      {
        key: "first-rays",
        utcDate: sunTimes.firstRaysUtc,
        localDateTime: toLocalDateTime(sunTimes.firstRaysUtc, TIMEZONE),
      },
      {
        key: "last-rays",
        utcDate: sunTimes.lastRaysUtc,
        localDateTime: toLocalDateTime(sunTimes.lastRaysUtc, TIMEZONE),
      },
    ];

    const windowResults = windows.map((window) => {
      const detailed = runModeAtTime(contexts, window.utcDate, "detailed");
      const twoLevel = runModeAtTime(contexts, window.utcDate, "two-level");
      const comparison = compareModes(contexts, detailed, twoLevel);

      return {
        key: window.key,
        localDateTime: window.localDateTime,
        utcTime: window.utcDate.toISOString(),
        performance: {
          detailedElapsedMs: round3(detailed.elapsedMs),
          twoLevelElapsedMs: round3(twoLevel.elapsedMs),
          speedupX: round3(detailed.elapsedMs / Math.max(twoLevel.elapsedMs, 1e-9)),
          detailedProfiler: {
            totalMs: round3(detailed.profiler.totalMs),
            buildingsMs: round3(detailed.profiler.buildingsMs),
            terrainMs: round3(detailed.profiler.terrainMs),
            vegetationMs: round3(detailed.profiler.vegetationMs),
          },
          twoLevelProfiler: {
            totalMs: round3(twoLevel.profiler.totalMs),
            buildingsMs: round3(twoLevel.profiler.buildingsMs),
            terrainMs: round3(twoLevel.profiler.terrainMs),
            vegetationMs: round3(twoLevel.profiler.vegetationMs),
          },
        },
        precision: comparison,
      };
    });

    report.hotspots.push({
      id: hotspot.id,
      name: hotspot.name,
      bbox: hotspot.bbox,
      pointsEvaluated: contexts.length,
      sunTimes: {
        sunriseLocal: toLocalDateTime(sunTimes.sunriseUtc, TIMEZONE),
        sunsetLocal: toLocalDateTime(sunTimes.sunsetUtc, TIMEZONE),
      },
      windows: windowResults,
    });
  }

  const outputDir = path.join(process.cwd(), "docs", "progress", "benchmarks");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "lausanne-hotspots-first-last-rays-20260308.json");
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[hotspots-benchmark] wrote ${outputPath}`);
}

void main().catch((error) => {
  if (error instanceof Error) {
    console.error(`[hotspots-benchmark] Failed: ${error.message}`);
    console.error(error.stack ?? "(no stack)");
  } else {
    console.error("[hotspots-benchmark] Failed: Unknown error");
  }
  process.exitCode = 1;
});
