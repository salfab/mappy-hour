import fs from "node:fs/promises";
import path from "node:path";

import SunCalc from "suncalc";

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
  buildingShadowEvaluator: Awaited<ReturnType<typeof buildPointEvaluationContext>>["buildingShadowEvaluator"];
  vegetationShadowEvaluator: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["vegetationShadowEvaluator"];
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
const SCAN_START_LOCAL_TIME = "14:00";
const SLOT_MINUTES = 15;
const THRESHOLDS = [50, 40, 30, 20, 10];

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

function toLocalHm(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function toMinutes(hm: string): number {
  const [h, m] = hm.split(":").map((part) => Number.parseInt(part, 10));
  return h * 60 + m;
}

function toHm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function floorToSlot(hm: string, slotMinutes: number): string {
  const minutes = toMinutes(hm);
  const floored = Math.floor(minutes / slotMinutes) * slotMinutes;
  return toHm(floored);
}

function buildSlots(startHm: string, endHm: string, slotMinutes: number): string[] {
  const slots: string[] = [];
  let cursor = toMinutes(startHm);
  const end = toMinutes(endHm);
  while (cursor <= end) {
    slots.push(toHm(cursor));
    cursor += slotMinutes;
  }
  return slots;
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

function computeSunnyCount(prepared: PreparedPoint[], date: string, localTime: string): number {
  const utcDate = zonedDateTimeToUtc(date, localTime, TIMEZONE);
  let sunnyCount = 0;
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
    if (sample.isSunny) {
      sunnyCount += 1;
    }
  }
  return sunnyCount;
}

async function main() {
  const prepared = await preparePoints();
  const centerLat = (BBOX.minLat + BBOX.maxLat) / 2;
  const centerLon = (BBOX.minLon + BBOX.maxLon) / 2;

  const dayResults: Array<{
    date: string;
    sunsetLocal: string;
    slots: Array<{ localTime: string; sunnyCount: number; sunnyRatioPct: number }>;
    lastMomentByThreshold: Array<{
      thresholdPct: number;
      lastLocalTime: string | null;
      sunnyRatioPct: number | null;
    }>;
  }> = [];

  const aggregateBySlot = new Map<string, { sunnyCountTotal: number; days: number }>();

  for (let i = 0; i < DAYS; i += 1) {
    const date = addDays(START_DATE, i);
    const noonUtc = zonedDateTimeToUtc(date, "12:00", TIMEZONE);
    const sunTimes = SunCalc.getTimes(noonUtc, centerLat, centerLon);
    if (!sunTimes.sunset) {
      throw new Error(`Missing sunset for ${date}`);
    }
    const sunsetLocal = toLocalHm(sunTimes.sunset, TIMEZONE);
    const endSlot = floorToSlot(sunsetLocal, SLOT_MINUTES);
    const slots = buildSlots(SCAN_START_LOCAL_TIME, endSlot, SLOT_MINUTES);

    console.log(`[pepinet-evening] ${date}: ${slots.length} slots (${SCAN_START_LOCAL_TIME} -> ${endSlot})`);

    const slotRows: Array<{ localTime: string; sunnyCount: number; sunnyRatioPct: number }> = [];
    for (const localTime of slots) {
      const sunnyCount = computeSunnyCount(prepared, date, localTime);
      const sunnyRatioPct = round3((sunnyCount / Math.max(1, prepared.length)) * 100);
      slotRows.push({ localTime, sunnyCount, sunnyRatioPct });

      const aggregate = aggregateBySlot.get(localTime) ?? { sunnyCountTotal: 0, days: 0 };
      aggregate.sunnyCountTotal += sunnyCount;
      aggregate.days += 1;
      aggregateBySlot.set(localTime, aggregate);
    }

    const lastMomentByThreshold = THRESHOLDS.map((thresholdPct) => {
      const row =
        [...slotRows]
          .reverse()
          .find((candidate) => candidate.sunnyRatioPct >= thresholdPct) ?? null;
      return {
        thresholdPct,
        lastLocalTime: row?.localTime ?? null,
        sunnyRatioPct: row?.sunnyRatioPct ?? null,
      };
    });

    dayResults.push({
      date,
      sunsetLocal,
      slots: slotRows,
      lastMomentByThreshold,
    });
  }

  const recommendedSlot = [...aggregateBySlot.entries()]
    .map(([localTime, aggregate]) => ({
      localTime,
      avgSunnyCount: round3(aggregate.sunnyCountTotal / Math.max(1, aggregate.days)),
      avgSunnyRatioPct: round3(
        (aggregate.sunnyCountTotal / Math.max(1, aggregate.days * prepared.length)) * 100,
      ),
    }))
    .filter((row) => row.avgSunnyRatioPct >= 10)
    .sort((a, b) => (a.localTime < b.localTime ? 1 : -1))[0] ?? null;

  const report = {
    generatedAt: new Date().toISOString(),
    assumptions: {
      startDate: START_DATE,
      days: DAYS,
      timezone: TIMEZONE,
      bbox: BBOX,
      gridStepMeters: GRID_STEP_METERS,
      scanStartLocalTime: SCAN_START_LOCAL_TIME,
      slotMinutes: SLOT_MINUTES,
      thresholdsPct: THRESHOLDS,
    },
    preparedOutdoorPoints: prepared.length,
    recommendedFixedComparisonSlot: recommendedSlot,
    days: dayResults,
  };

  const outputPath = path.join(
    process.cwd(),
    "docs",
    "progress",
    "analysis",
    "pepinet-7days-evening-scan-20260308.json",
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[pepinet-evening] wrote ${outputPath}`);
}

void main().catch((error) => {
  console.error(
    `[pepinet-evening] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
