import fs from "node:fs/promises";
import path from "node:path";

import { buildGridFromBbox } from "@/lib/geo/grid";
import { wgs84ToLv95 } from "@/lib/geo/projection";
import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "@/lib/sun/evaluation-context";
import { evaluateInstantSunlight } from "@/lib/sun/solar";
import { zonedDateTimeToUtc } from "@/lib/time/zoned-date";

interface PreparedPoint {
  id: string;
  lat: number;
  lon: number;
  indoor: boolean;
  buildingShadowEvaluator: Awaited<ReturnType<typeof buildPointEvaluationContext>>["buildingShadowEvaluator"];
  vegetationShadowEvaluator: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["vegetationShadowEvaluator"];
  horizonMask: Awaited<ReturnType<typeof buildPointEvaluationContext>>["horizonMask"];
}

interface InstantPoint {
  id: string;
  lat: number;
  lon: number;
  isSunny: boolean;
  terrainBlocked: boolean;
  buildingsBlocked: boolean;
  vegetationBlocked: boolean;
}

interface InstantSnapshot {
  date: string;
  localTime: string;
  utcTime: string;
  pointCount: number;
  sunnyCount: number;
  terrainBlockedCount: number;
  buildingsBlockedCount: number;
  vegetationBlockedCount: number;
  points: InstantPoint[];
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
const GRID_STEP_METERS = 1;
const LOCAL_TIMES = ["14:00"] as const;

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

async function preparePoints(): Promise<PreparedPoint[]> {
  const grid = buildGridFromBbox(BBOX, GRID_STEP_METERS);
  const corners = [
    wgs84ToLv95(BBOX.minLon, BBOX.minLat),
    wgs84ToLv95(BBOX.minLon, BBOX.maxLat),
    wgs84ToLv95(BBOX.maxLon, BBOX.minLat),
    wgs84ToLv95(BBOX.maxLon, BBOX.maxLat),
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

  const prepared: PreparedPoint[] = [];
  for (const point of grid) {
    const context = await buildPointEvaluationContext(point.lat, point.lon, {
      sharedSources,
    });
    if (context.insideBuilding) {
      continue;
    }
    prepared.push({
      id: point.id,
      lat: point.lat,
      lon: point.lon,
      indoor: context.insideBuilding,
      buildingShadowEvaluator: context.buildingShadowEvaluator,
      vegetationShadowEvaluator: context.vegetationShadowEvaluator,
      horizonMask: context.horizonMask,
    });
  }

  return prepared;
}

function computeSnapshot(
  preparedPoints: PreparedPoint[],
  date: string,
  localTime: string,
): InstantSnapshot {
  const utcDate = zonedDateTimeToUtc(date, localTime, TIMEZONE);
  const points: InstantPoint[] = [];

  for (const point of preparedPoints) {
    const sample = evaluateInstantSunlight({
      lat: point.lat,
      lon: point.lon,
      utcDate,
      timeZone: TIMEZONE,
      horizonMask: point.horizonMask,
      buildingShadowEvaluator: point.buildingShadowEvaluator,
      vegetationShadowEvaluator: point.vegetationShadowEvaluator,
    });
    points.push({
      id: point.id,
      lat: point.lat,
      lon: point.lon,
      isSunny: sample.isSunny,
      terrainBlocked: sample.terrainBlocked,
      buildingsBlocked: sample.buildingsBlocked,
      vegetationBlocked: sample.vegetationBlocked,
    });
  }

  return {
    date,
    localTime,
    utcTime: utcDate.toISOString(),
    pointCount: points.length,
    sunnyCount: points.filter((point) => point.isSunny).length,
    terrainBlockedCount: points.filter((point) => point.terrainBlocked).length,
    buildingsBlockedCount: points.filter((point) => point.buildingsBlocked).length,
    vegetationBlockedCount: points.filter((point) => point.vegetationBlocked).length,
    points,
  };
}

function compareSnapshots(previous: InstantSnapshot, current: InstantSnapshot) {
  const previousById = new Map(previous.points.map((point) => [point.id, point] as const));
  const currentById = new Map(current.points.map((point) => [point.id, point] as const));
  const sharedIds = [...currentById.keys()].filter((id) => previousById.has(id));

  let changedIsSunny = 0;
  let becameSunny = 0;
  let becameShaded = 0;
  let changedTerrainBlocked = 0;
  let changedBuildingsBlocked = 0;
  let changedVegetationBlocked = 0;

  for (const id of sharedIds) {
    const prev = previousById.get(id)!;
    const curr = currentById.get(id)!;
    if (prev.isSunny !== curr.isSunny) {
      changedIsSunny += 1;
      if (!prev.isSunny && curr.isSunny) {
        becameSunny += 1;
      } else if (prev.isSunny && !curr.isSunny) {
        becameShaded += 1;
      }
    }
    if (prev.terrainBlocked !== curr.terrainBlocked) {
      changedTerrainBlocked += 1;
    }
    if (prev.buildingsBlocked !== curr.buildingsBlocked) {
      changedBuildingsBlocked += 1;
    }
    if (prev.vegetationBlocked !== curr.vegetationBlocked) {
      changedVegetationBlocked += 1;
    }
  }

  return {
    fromDate: previous.date,
    toDate: current.date,
    localTime: current.localTime,
    sharedPointCount: sharedIds.length,
    changedIsSunny,
    changedIsSunnyRatioPct:
      sharedIds.length === 0 ? 0 : round3((changedIsSunny / sharedIds.length) * 100),
    becameSunny,
    becameShaded,
    changedTerrainBlocked,
    changedBuildingsBlocked,
    changedVegetationBlocked,
    sunnyCountDelta: current.sunnyCount - previous.sunnyCount,
  };
}

async function main() {
  const preparedPoints = await preparePoints();
  const byTime: Record<string, InstantSnapshot[]> = {};

  for (const localTime of LOCAL_TIMES) {
    const snapshots: InstantSnapshot[] = [];
    for (let i = 0; i < DAYS; i += 1) {
      const date = addDays(START_DATE, i);
      console.log(`[low-sun] computing ${date} ${localTime}...`);
      snapshots.push(computeSnapshot(preparedPoints, date, localTime));
    }
    byTime[localTime] = snapshots;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    assumptions: {
      startDate: START_DATE,
      days: DAYS,
      timezone: TIMEZONE,
      gridStepMeters: GRID_STEP_METERS,
      bbox: BBOX,
      localTimes: [...LOCAL_TIMES],
      notableThresholdPct: 5,
    },
    preparedPoints: preparedPoints.length,
    perTime: Object.fromEntries(
      Object.entries(byTime).map(([localTime, snapshots]) => {
        const dayToDay = [];
        for (let i = 1; i < snapshots.length; i += 1) {
          dayToDay.push(compareSnapshots(snapshots[i - 1], snapshots[i]));
        }
        return [
          localTime,
          {
            days: snapshots.map((snapshot) => ({
              date: snapshot.date,
              utcTime: snapshot.utcTime,
              pointCount: snapshot.pointCount,
              sunnyCount: snapshot.sunnyCount,
              sunnyRatioPct:
                snapshot.pointCount === 0
                  ? 0
                  : round3((snapshot.sunnyCount / snapshot.pointCount) * 100),
              terrainBlockedCount: snapshot.terrainBlockedCount,
              buildingsBlockedCount: snapshot.buildingsBlockedCount,
              vegetationBlockedCount: snapshot.vegetationBlockedCount,
            })),
            dayToDay,
          },
        ];
      }),
    ),
  };

  const outputPath = path.join(
    process.cwd(),
    "docs",
    "progress",
    "analysis",
    "pepinet-7days-instant-low-sun-diff-20260308.json",
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[low-sun] wrote ${outputPath}`);
}

void main().catch((error) => {
  console.error(
    `[low-sun] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
