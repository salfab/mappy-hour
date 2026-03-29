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
  horizonMask: Awaited<ReturnType<typeof buildPointEvaluationContext>>["horizonMask"];
  buildingShadowEvaluator: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["buildingShadowEvaluator"];
  vegetationShadowEvaluator: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["vegetationShadowEvaluator"];
}

const BBOX = {
  minLon: 6.6322,
  minLat: 46.52255,
  maxLon: 6.63335,
  maxLat: 46.52305,
} as const;
const TIMEZONE = "Europe/Zurich";
const START_DATE = "2026-03-08";
const DAYS = 7;
const GRID_STEP_METERS = 1;
const LOCAL_TIME = "17:45";
const OUTPUT_FILE =
  "docs/progress/analysis/great-escape-7days-pointdiff-1745-20260308.json";

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
      horizonMask: context.horizonMask,
      buildingShadowEvaluator: context.buildingShadowEvaluator,
      vegetationShadowEvaluator: context.vegetationShadowEvaluator,
    });
  }
  return prepared;
}

function evaluateStatesForDay(prepared: PreparedPoint[], date: string): Map<string, boolean> {
  const utcDate = zonedDateTimeToUtc(date, LOCAL_TIME, TIMEZONE);
  const states = new Map<string, boolean>();
  for (const point of prepared) {
    const sample = evaluateInstantSunlight({
      lat: point.lat,
      lon: point.lon,
      utcDate,
      timeZone: TIMEZONE,
      horizonMask: point.horizonMask,
      buildingShadowEvaluator: point.buildingShadowEvaluator,
      vegetationShadowEvaluator: point.vegetationShadowEvaluator,
    });
    states.set(point.id, sample.isSunny);
  }
  return states;
}

function countSunny(states: Map<string, boolean>): number {
  let total = 0;
  for (const isSunny of states.values()) {
    if (isSunny) {
      total += 1;
    }
  }
  return total;
}

function compareStates(previous: Map<string, boolean>, current: Map<string, boolean>) {
  let changedIsSunny = 0;
  let becameSunny = 0;
  let becameShaded = 0;
  for (const [id, prev] of previous.entries()) {
    const curr = current.get(id);
    if (curr === undefined || curr === prev) {
      continue;
    }
    changedIsSunny += 1;
    if (!prev && curr) {
      becameSunny += 1;
    } else if (prev && !curr) {
      becameShaded += 1;
    }
  }
  return { changedIsSunny, becameSunny, becameShaded };
}

async function main() {
  const prepared = await preparePoints();
  console.log(
    `[great-escape-1745-diff] prepared outdoor points: ${prepared.length} (grid ${GRID_STEP_METERS}m)`,
  );

  const dayStates: Array<{
    date: string;
    states: Map<string, boolean>;
    sunnyCount: number;
    sunnyRatioPct: number;
  }> = [];

  for (let i = 0; i < DAYS; i += 1) {
    const date = addDays(START_DATE, i);
    const states = evaluateStatesForDay(prepared, date);
    const sunnyCount = countSunny(states);
    const sunnyRatioPct = round3((sunnyCount / Math.max(1, prepared.length)) * 100);
    dayStates.push({
      date,
      states,
      sunnyCount,
      sunnyRatioPct,
    });
    console.log(
      `[great-escape-1745-diff] ${date} @${LOCAL_TIME}: sunny=${sunnyCount}/${prepared.length} (${sunnyRatioPct}%)`,
    );
  }

  const dayToDay = [];
  for (let i = 1; i < dayStates.length; i += 1) {
    const prev = dayStates[i - 1];
    const curr = dayStates[i];
    const diff = compareStates(prev.states, curr.states);
    dayToDay.push({
      fromDate: prev.date,
      toDate: curr.date,
      localTime: LOCAL_TIME,
      sunnyCountDelta: curr.sunnyCount - prev.sunnyCount,
      sharedPointCount: prepared.length,
      changedIsSunny: diff.changedIsSunny,
      changedIsSunnyRatioPct: round3((diff.changedIsSunny / Math.max(1, prepared.length)) * 100),
      becameSunny: diff.becameSunny,
      becameShaded: diff.becameShaded,
    });
  }

  const versusFirstDay = [];
  const first = dayStates[0];
  for (let i = 1; i < dayStates.length; i += 1) {
    const curr = dayStates[i];
    const diff = compareStates(first.states, curr.states);
    versusFirstDay.push({
      fromDate: first.date,
      toDate: curr.date,
      localTime: LOCAL_TIME,
      sunnyCountDelta: curr.sunnyCount - first.sunnyCount,
      sharedPointCount: prepared.length,
      changedIsSunny: diff.changedIsSunny,
      changedIsSunnyRatioPct: round3((diff.changedIsSunny / Math.max(1, prepared.length)) * 100),
      becameSunny: diff.becameSunny,
      becameShaded: diff.becameShaded,
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    assumptions: {
      bbox: BBOX,
      timezone: TIMEZONE,
      startDate: START_DATE,
      days: DAYS,
      gridStepMeters: GRID_STEP_METERS,
      localTime: LOCAL_TIME,
    },
    preparedOutdoorPoints: prepared.length,
    dailySunnyCounts: dayStates.map((day) => ({
      date: day.date,
      sunnyCount: day.sunnyCount,
      sunnyRatioPct: day.sunnyRatioPct,
    })),
    dayToDay,
    versusFirstDay,
  };

  const outputPath = path.resolve(process.cwd(), OUTPUT_FILE);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`[great-escape-1745-diff] wrote ${outputPath}`);
}

void main();
