import fs from "node:fs/promises";
import path from "node:path";

import {
  aggregateDailyAreaFromArtifacts,
  buildTimelineFromArtifacts,
  resolveSunlightTilesForBbox,
} from "@/lib/precompute/sunlight-tile-service";
import { normalizeShadowCalibration } from "@/lib/sun/shadow-calibration";

interface DailyPoint {
  id: string;
  lat: number;
  lon: number;
  sunnyMinutes: number;
}

interface DayCoverageSnapshot {
  thresholdPct: number;
  lastFrameLocalTime: string | null;
  lastFrameCoveragePct: number | null;
  lastFrameSunnyCount: number | null;
}

interface DailyDayResult {
  date: string;
  pointCount: number;
  sunnyPointCount: number;
  shadedPointCount: number;
  totalSunnyMinutes: number;
  averageSunnyMinutes: number;
  points: DailyPoint[];
  cache: {
    hit: boolean;
    layer: string;
    fullyCovered: boolean;
  };
  endOfDayCoverage: DayCoverageSnapshot[];
}

const BBOX = {
  minLon: 6.63195,
  minLat: 46.5213,
  maxLon: 6.63255,
  maxLat: 46.5217,
} as const;
const TIMEZONE = "Europe/Zurich";
const START_DATE = "2026-03-08";
const DAYS = 7;
const SAMPLE_EVERY_MINUTES = 15;
const GRID_STEP_METERS = 1;
const MAX_POINTS = 10_000;
const COVERAGE_THRESHOLDS_PCT = [50, 60, 70];

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  const year = base.getUTCFullYear();
  const month = String(base.getUTCMonth() + 1).padStart(2, "0");
  const day = String(base.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toHour(localTime: string): number {
  const timePart = localTime.includes(" ") ? localTime.split(" ")[1] : localTime;
  const [hh] = timePart.split(":");
  return Number.parseInt(hh ?? "0", 10);
}

function computeEndOfDayCoverage(params: {
  timeline: ReturnType<typeof buildTimelineFromArtifacts>;
  thresholdsPct: number[];
}) {
  const pointCount = Math.max(1, params.timeline.pointCount);
  const eveningFrames = params.timeline.frames.filter(
    (frame) => toHour(frame.localTime) >= 12,
  );

  return params.thresholdsPct.map((thresholdPct) => {
    let selected:
      | {
          localTime: string;
          coveragePct: number;
          sunnyCount: number;
        }
      | null = null;
    const thresholdRatio = thresholdPct / 100;

    for (const frame of eveningFrames) {
      const ratio = frame.sunnyCount / pointCount;
      if (ratio >= thresholdRatio) {
        selected = {
          localTime: frame.localTime,
          coveragePct: round3(ratio * 100),
          sunnyCount: frame.sunnyCount,
        };
      }
    }

    return {
      thresholdPct,
      lastFrameLocalTime: selected?.localTime ?? null,
      lastFrameCoveragePct: selected?.coveragePct ?? null,
      lastFrameSunnyCount: selected?.sunnyCount ?? null,
    };
  });
}

async function computeDaily(date: string): Promise<DailyDayResult> {
  const resolved = await resolveSunlightTilesForBbox({
    bbox: BBOX,
    date,
    timezone: TIMEZONE,
    sampleEveryMinutes: SAMPLE_EVERY_MINUTES,
    gridStepMeters: GRID_STEP_METERS,
    startLocalTime: "00:00",
    endLocalTime: "23:59",
    shadowCalibration: normalizeShadowCalibration({}),
    persistMissingTiles: true,
  });

  if (!resolved) {
    throw new Error(`No supported precompute region for ${date}.`);
  }

  const daily = aggregateDailyAreaFromArtifacts({
    artifacts: resolved.artifacts,
    bbox: BBOX,
    date,
    timezone: TIMEZONE,
    sampleEveryMinutes: SAMPLE_EVERY_MINUTES,
    maxPoints: MAX_POINTS,
    ignoreVegetation: false,
  });

  if ("error" in daily) {
    throw new Error(`Daily aggregation failed for ${date}: ${daily.detail}`);
  }

  const timeline = buildTimelineFromArtifacts({
    artifacts: resolved.artifacts,
    bbox: BBOX,
    timezone: TIMEZONE,
  });
  const endOfDayCoverage = computeEndOfDayCoverage({
    timeline,
    thresholdsPct: COVERAGE_THRESHOLDS_PCT,
  });

  const points: DailyPoint[] = daily.points.map((point) => ({
    id: point.id,
    lat: point.lat,
    lon: point.lon,
    sunnyMinutes: point.sunnyMinutes,
  }));
  const totalSunnyMinutes = points.reduce(
    (sum, point) => sum + point.sunnyMinutes,
    0,
  );
  const sunnyPointCount = points.filter((point) => point.sunnyMinutes > 0).length;

  return {
    date,
    pointCount: points.length,
    sunnyPointCount,
    shadedPointCount: points.length - sunnyPointCount,
    totalSunnyMinutes,
    averageSunnyMinutes:
      points.length === 0 ? 0 : round3(totalSunnyMinutes / points.length),
    points,
    cache: {
      hit: resolved.cache.hit,
      layer: resolved.cache.layer,
      fullyCovered: resolved.cache.fullyCovered,
    },
    endOfDayCoverage,
  };
}

function compareConsecutiveDays(previous: DailyDayResult, current: DailyDayResult) {
  const previousById = new Map(previous.points.map((point) => [point.id, point] as const));
  const currentById = new Map(current.points.map((point) => [point.id, point] as const));
  const sharedIds = [...currentById.keys()].filter((id) => previousById.has(id));

  let changedSunnyMinutesCount = 0;
  let becameSunnyCount = 0;
  let becameShadedCount = 0;
  let totalAbsDeltaSunnyMinutes = 0;
  let maxAbsDeltaSunnyMinutes = -1;
  let maxAbsDeltaPoint:
    | { id: string; lat: number; lon: number; previous: number; current: number; delta: number }
    | null = null;

  for (const id of sharedIds) {
    const previousPoint = previousById.get(id)!;
    const currentPoint = currentById.get(id)!;
    const delta = currentPoint.sunnyMinutes - previousPoint.sunnyMinutes;
    const absDelta = Math.abs(delta);
    totalAbsDeltaSunnyMinutes += absDelta;

    if (absDelta > 0) {
      changedSunnyMinutesCount += 1;
      if (previousPoint.sunnyMinutes === 0 && currentPoint.sunnyMinutes > 0) {
        becameSunnyCount += 1;
      }
      if (previousPoint.sunnyMinutes > 0 && currentPoint.sunnyMinutes === 0) {
        becameShadedCount += 1;
      }
    }

    if (absDelta > maxAbsDeltaSunnyMinutes) {
      maxAbsDeltaSunnyMinutes = absDelta;
      maxAbsDeltaPoint = {
        id,
        lat: currentPoint.lat,
        lon: currentPoint.lon,
        previous: previousPoint.sunnyMinutes,
        current: currentPoint.sunnyMinutes,
        delta,
      };
    }
  }

  return {
    fromDate: previous.date,
    toDate: current.date,
    previousPointCount: previous.pointCount,
    currentPointCount: current.pointCount,
    sharedPointCount: sharedIds.length,
    changedSunnyMinutesCount,
    changedRatioPct:
      sharedIds.length === 0 ? 0 : round3((changedSunnyMinutesCount / sharedIds.length) * 100),
    becameSunnyCount,
    becameShadedCount,
    totalSunnyMinutesDelta: current.totalSunnyMinutes - previous.totalSunnyMinutes,
    averageAbsDeltaSunnyMinutes:
      sharedIds.length === 0 ? 0 : round3(totalAbsDeltaSunnyMinutes / sharedIds.length),
    maxAbsDeltaSunnyMinutes: Math.max(maxAbsDeltaSunnyMinutes, 0),
    maxAbsDeltaPoint,
  };
}

async function main() {
  const dayResults: DailyDayResult[] = [];

  for (let i = 0; i < DAYS; i += 1) {
    const date = addDays(START_DATE, i);
    console.log(`[pepinet-7days] computing ${date}...`);
    dayResults.push(await computeDaily(date));
  }

  const dayDiffs = [];
  for (let i = 1; i < dayResults.length; i += 1) {
    dayDiffs.push(compareConsecutiveDays(dayResults[i - 1], dayResults[i]));
  }

  const allPointIds = new Set(dayResults.flatMap((day) => day.points.map((point) => point.id)));
  let varyingPointsAcrossWeek = 0;
  for (const id of allPointIds) {
    const values = dayResults
      .map((day) => day.points.find((point) => point.id === id)?.sunnyMinutes)
      .filter((value): value is number => value !== undefined);
    if (values.length < 2) {
      continue;
    }
    const first = values[0];
    if (values.some((value) => value !== first)) {
      varyingPointsAcrossWeek += 1;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    assumptions: {
      startDate: START_DATE,
      days: DAYS,
      timezone: TIMEZONE,
      mode: "daily",
      sampleEveryMinutes: SAMPLE_EVERY_MINUTES,
      gridStepMeters: GRID_STEP_METERS,
      maxPoints: MAX_POINTS,
      bbox: [BBOX.minLon, BBOX.minLat, BBOX.maxLon, BBOX.maxLat] as [
        number,
        number,
        number,
        number,
      ],
      ignoreVegetation: false,
      endOfDayCoverageThresholdsPct: COVERAGE_THRESHOLDS_PCT,
    },
    summary: {
      pointUniverseCount: allPointIds.size,
      varyingPointsAcrossWeek,
      varyingPointsAcrossWeekRatioPct:
        allPointIds.size === 0 ? 0 : round3((varyingPointsAcrossWeek / allPointIds.size) * 100),
    },
    days: dayResults.map((day) => ({
      date: day.date,
      pointCount: day.pointCount,
      sunnyPointCount: day.sunnyPointCount,
      shadedPointCount: day.shadedPointCount,
      totalSunnyMinutes: day.totalSunnyMinutes,
      averageSunnyMinutes: day.averageSunnyMinutes,
      cache: day.cache,
      endOfDayCoverage: day.endOfDayCoverage,
    })),
    dayToDayDiffs: dayDiffs,
  };

  const outputPath = path.join(
    process.cwd(),
    "docs",
    "progress",
    "analysis",
    "pepinet-maccarthys-7days-daily-grid1m-diff-20260308.json",
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[pepinet-7days] wrote ${outputPath}`);
}

void main().catch((error) => {
  console.error(
    `[pepinet-7days] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
