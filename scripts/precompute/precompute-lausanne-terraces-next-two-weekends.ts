import fs from "node:fs/promises";
import path from "node:path";

import { precomputeCacheRuns } from "@/lib/admin/cache-admin";
import { CANONICAL_PRECOMPUTE_TILE_SIZE_METERS } from "@/lib/precompute/constants";
import {
  getIntersectingTileIds,
  type RegionBbox,
} from "@/lib/precompute/sunlight-cache";

interface TerraceZone {
  id: string;
  label: string;
  lat: number;
  lon: number;
  radiusMeters: number;
}

interface WeekendWindow {
  date: string;
  startLocalTime: string;
  endLocalTime: string;
}

const REGION = "lausanne" as const;
const TIMEZONE = "Europe/Zurich";
const SAMPLE_EVERY_MINUTES = 15;
const GRID_STEP_METERS = 1;
const BUILDING_HEIGHT_BIAS_METERS = 0;
const SKIP_EXISTING = true;
const OUTPUT_PATH = path.join(
  process.cwd(),
  "docs",
  "progress",
  "cache",
  "lausanne-terraces-next-two-weekends-precompute.json",
);

const TERRACE_ZONES: TerraceZone[] = [
  {
    id: "grandes-roches",
    label: "Terrasse des Grandes Roches",
    lat: 46.521448,
    lon: 6.6359,
    radiusMeters: 40,
  },
  {
    id: "montriond",
    label: "Le Cabanon du Montriond",
    lat: 46.514974,
    lon: 6.625165,
    radiusMeters: 40,
  },
  {
    id: "mccarthys",
    label: "Mc Carthy's",
    lat: 46.52137,
    lon: 6.632301,
    radiusMeters: 40,
  },
];

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  const year = base.getUTCFullYear();
  const month = String(base.getUTCMonth() + 1).padStart(2, "0");
  const day = String(base.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function zoneBboxFromRadius(zone: TerraceZone): RegionBbox {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon =
    metersPerDegreeLat * Math.cos((zone.lat * Math.PI) / 180);
  const latDelta = zone.radiusMeters / metersPerDegreeLat;
  const lonDelta =
    Math.abs(metersPerDegreeLon) < 1e-9 ? 0 : zone.radiusMeters / metersPerDegreeLon;

  return {
    minLon: zone.lon - lonDelta,
    minLat: zone.lat - latDelta,
    maxLon: zone.lon + lonDelta,
    maxLat: zone.lat + latDelta,
  };
}

function nextFridaysFrom(anchor: Date, count: number): string[] {
  const result: string[] = [];
  const date = new Date(anchor.getTime());
  date.setUTCHours(0, 0, 0, 0);

  while (result.length < count) {
    const day = date.getUTCDay();
    if (day === 5 && date.getTime() >= anchor.getTime()) {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const dayOfMonth = String(date.getUTCDate()).padStart(2, "0");
      result.push(`${year}-${month}-${dayOfMonth}`);
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }

  return result;
}

function buildWeekendWindows(fridayDate: string): WeekendWindow[] {
  return [
    {
      date: fridayDate,
      startLocalTime: "15:00",
      endLocalTime: "18:00",
    },
    {
      date: addDays(fridayDate, 1),
      startLocalTime: "15:00",
      endLocalTime: "18:00",
    },
    {
      date: addDays(fridayDate, 2),
      startLocalTime: "15:00",
      endLocalTime: "18:00",
    },
  ];
}

async function main() {
  const now = new Date();
  const fridays = nextFridaysFrom(now, 2);
  const weekendWindows = fridays.flatMap((fridayDate) =>
    buildWeekendWindows(fridayDate),
  );

  const tileIds = Array.from(
    new Set(
      TERRACE_ZONES.flatMap((zone) =>
        getIntersectingTileIds({
          region: REGION,
          tileSizeMeters: CANONICAL_PRECOMPUTE_TILE_SIZE_METERS,
          bbox: zoneBboxFromRadius(zone),
        }),
      ),
    ),
  ).sort();

  if (tileIds.length === 0) {
    throw new Error("No tile selected for requested terrace zones.");
  }

  console.log(
    `[precompute:terraces-weekend] region=${REGION} zones=${TERRACE_ZONES.length} selectedTiles=${tileIds.length}`,
  );
  console.log(
    `[precompute:terraces-weekend] tileIds=${tileIds.join(",")}`,
  );

  const runSummaries: Array<{
    date: string;
    startLocalTime: string;
    endLocalTime: string;
    modelVersionHash: string;
    algorithmVersion: string;
    succeededTiles: number;
    skippedTiles: number;
    failedTiles: number;
    complete: boolean;
    elapsedMs: number;
  }> = [];

  for (const window of weekendWindows) {
    console.log(
      `[precompute:terraces-weekend] start date=${window.date} window=${window.startLocalTime}-${window.endLocalTime}`,
    );
    const result = await precomputeCacheRuns(
      {
        region: REGION,
        startDate: window.date,
        days: 1,
        timezone: TIMEZONE,
        sampleEveryMinutes: SAMPLE_EVERY_MINUTES,
        gridStepMeters: GRID_STEP_METERS,
        startLocalTime: window.startLocalTime,
        endLocalTime: window.endLocalTime,
        tileIds,
        skipExisting: SKIP_EXISTING,
        buildingHeightBiasMeters: BUILDING_HEIGHT_BIAS_METERS,
      },
      {},
    );
    const day = result.dates[0];
    runSummaries.push({
      date: window.date,
      startLocalTime: window.startLocalTime,
      endLocalTime: window.endLocalTime,
      modelVersionHash: result.modelVersionHash,
      algorithmVersion: result.algorithmVersion,
      succeededTiles: day?.succeededTiles ?? 0,
      skippedTiles: day?.skippedTiles ?? 0,
      failedTiles: day?.failedTiles ?? 0,
      complete: day?.complete ?? false,
      elapsedMs: day?.elapsedMs ?? 0,
    });
    console.log(
      `[precompute:terraces-weekend] done date=${window.date} ok=${day?.succeededTiles ?? 0} skipped=${day?.skippedTiles ?? 0} failed=${day?.failedTiles ?? 0} complete=${day?.complete ?? false} elapsedMs=${day?.elapsedMs ?? 0}`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    region: REGION,
    timezone: TIMEZONE,
    sampleEveryMinutes: SAMPLE_EVERY_MINUTES,
    gridStepMeters: GRID_STEP_METERS,
    buildingHeightBiasMeters: BUILDING_HEIGHT_BIAS_METERS,
    skipExisting: SKIP_EXISTING,
    zones: TERRACE_ZONES,
    selectedTileCount: tileIds.length,
    selectedTileIds: tileIds,
    weekends: fridays,
    runs: runSummaries,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`[precompute:terraces-weekend] wrote ${OUTPUT_PATH}`);
}

void main().catch((error) => {
  console.error(
    `[precompute:terraces-weekend] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
