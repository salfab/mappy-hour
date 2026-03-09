import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { POST as areaPost } from "../../src/app/api/sunlight/area/route";
import { LAUSANNE_CENTER, LAUSANNE_LOCAL_BBOX } from "../../src/lib/config/lausanne";
import { NYON_CENTER } from "../../src/lib/config/nyon";
import { buildDynamicHorizonMask } from "../../src/lib/sun/dynamic-horizon-mask";
import { evaluateInstantSunlight } from "../../src/lib/sun/solar";
import { zonedDateTimeToUtc } from "../../src/lib/time/zoned-date";

type BBox = [number, number, number, number];

interface AreaRequestPayload {
  bbox: BBox;
  date: string;
  timezone: string;
  mode: "instant";
  localTime: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  maxPoints: number;
}

interface AreaPoint {
  lat: number;
  lon: number;
  terrainBlocked: boolean;
  horizonAngleDeg: number | null;
  azimuthDeg: number;
  altitudeDeg: number;
  isSunny: boolean;
}

interface AreaResponsePayload {
  pointCount: number;
  gridPointCount: number;
  points: AreaPoint[];
  warnings: string[];
  stats: {
    elapsedMs: number;
    indoorPointsExcluded?: number;
  };
}

interface AreaCallResult {
  wallMs: number;
  payload: AreaResponsePayload;
}

interface ParsedArgs {
  startDate: string;
  days: number;
  localTime: string;
  gridStepMeters: number;
  tileCols: number;
  tileRows: number;
}

const DEFAULT_ARGS: ParsedArgs = {
  startDate: "2026-03-08",
  days: 1,
  localTime: "17:00",
  gridStepMeters: 250,
  tileCols: 4,
  tileRows: 4,
};

const BENCHMARK_OUTPUT_DIR = path.join(
  process.cwd(),
  "docs",
  "progress",
  "benchmarks",
);

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { ...DEFAULT_ARGS };

  for (const arg of argv) {
    if (arg.startsWith("--start-date=")) {
      result.startDate = arg.slice("--start-date=".length);
      continue;
    }
    if (arg.startsWith("--days=")) {
      const parsed = Number(arg.slice("--days=".length));
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 31) {
        result.days = parsed;
      }
      continue;
    }
    if (arg.startsWith("--local-time=")) {
      result.localTime = arg.slice("--local-time=".length);
      continue;
    }
    if (arg.startsWith("--grid-step-meters=")) {
      const parsed = Number(arg.slice("--grid-step-meters=".length));
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 2_000) {
        result.gridStepMeters = parsed;
      }
      continue;
    }
    if (arg.startsWith("--tile-cols=")) {
      const parsed = Number(arg.slice("--tile-cols=".length));
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 20) {
        result.tileCols = parsed;
      }
      continue;
    }
    if (arg.startsWith("--tile-rows=")) {
      const parsed = Number(arg.slice("--tile-rows=".length));
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 20) {
        result.tileRows = parsed;
      }
      continue;
    }
  }

  return result;
}

function addDays(dateInput: string, days: number): string {
  const date = new Date(`${dateInput}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date input: ${dateInput}`);
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function splitBbox(bbox: BBox, cols: number, rows: number): BBox[] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lonStep = (maxLon - minLon) / cols;
  const latStep = (maxLat - minLat) / rows;
  const tiles: BBox[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const tileMinLon = minLon + col * lonStep;
      const tileMaxLon = col === cols - 1 ? maxLon : tileMinLon + lonStep;
      const tileMinLat = minLat + row * latStep;
      const tileMaxLat = row === rows - 1 ? maxLat : tileMinLat + latStep;
      tiles.push([tileMinLon, tileMinLat, tileMaxLon, tileMaxLat]);
    }
  }

  return tiles;
}

function metersToLatitudeDegrees(meters: number): number {
  return meters / 111_320;
}

function metersToLongitudeDegrees(meters: number, atLatDeg: number): number {
  const scale = Math.cos((atLatDeg * Math.PI) / 180);
  const metersPerDegree = Math.max(111_320 * scale, 0.01);
  return meters / metersPerDegree;
}

function bboxAroundPointMeters(
  lat: number,
  lon: number,
  halfSizeMeters: number,
): BBox {
  const deltaLat = metersToLatitudeDegrees(halfSizeMeters);
  const deltaLon = metersToLongitudeDegrees(halfSizeMeters, lat);
  return [lon - deltaLon, lat - deltaLat, lon + deltaLon, lat + deltaLat];
}

function normalizeAzimuth(azimuthDeg: number): number {
  const rounded = Math.round(azimuthDeg) % 360;
  return rounded >= 0 ? rounded : rounded + 360;
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

async function callArea(payload: AreaRequestPayload): Promise<AreaCallResult> {
  const request = new Request("http://localhost/api/sunlight/area", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const started = performance.now();
  const response = await areaPost(request);
  const wallMs = performance.now() - started;
  const json = (await response.json()) as
    | AreaResponsePayload
    | { error?: string; detail?: string; details?: string };

  if (!response.ok) {
    const message =
      (json as { detail?: string; details?: string; error?: string }).detail ??
      (json as { detail?: string; details?: string; error?: string }).details ??
      (json as { detail?: string; details?: string; error?: string }).error ??
      "Unknown error";
    throw new Error(`Area benchmark request failed (${response.status}): ${message}`);
  }

  return {
    wallMs,
    payload: json as AreaResponsePayload,
  };
}

async function warmup(args: ParsedArgs): Promise<void> {
  await callArea({
    bbox: bboxAroundPointMeters(LAUSANNE_CENTER.lat, LAUSANNE_CENTER.lon, 60),
    date: args.startDate,
    timezone: "Europe/Zurich",
    mode: "instant",
    localTime: args.localTime,
    sampleEveryMinutes: 15,
    gridStepMeters: Math.max(20, Math.min(100, args.gridStepMeters)),
    maxPoints: 3_000,
  });
}

async function runLargeVsTiledBenchmark(args: ParsedArgs) {
  const tiles = splitBbox(LAUSANNE_LOCAL_BBOX, args.tileCols, args.tileRows);
  const largeRuns: AreaCallResult[] = [];
  const tiledRuns: AreaCallResult[] = [];

  for (let dayIndex = 0; dayIndex < args.days; dayIndex += 1) {
    const date = addDays(args.startDate, dayIndex);
    const payloadBase = {
      date,
      timezone: "Europe/Zurich",
      mode: "instant" as const,
      localTime: args.localTime,
      sampleEveryMinutes: 15,
      gridStepMeters: args.gridStepMeters,
      maxPoints: 5_000,
    };

    largeRuns.push(
      await callArea({
        ...payloadBase,
        bbox: LAUSANNE_LOCAL_BBOX,
      }),
    );

    for (const tileBbox of tiles) {
      tiledRuns.push(
        await callArea({
          ...payloadBase,
          bbox: tileBbox,
        }),
      );
    }
  }

  const largeTotalWallMs = largeRuns.reduce((sum, run) => sum + run.wallMs, 0);
  const largeTotalElapsedMs = largeRuns.reduce(
    (sum, run) => sum + run.payload.stats.elapsedMs,
    0,
  );
  const largeTotalPoints = largeRuns.reduce(
    (sum, run) => sum + run.payload.pointCount,
    0,
  );
  const largeTotalIndoorExcluded = largeRuns.reduce(
    (sum, run) => sum + (run.payload.stats.indoorPointsExcluded ?? 0),
    0,
  );

  const tiledTotalWallMs = tiledRuns.reduce((sum, run) => sum + run.wallMs, 0);
  const tiledTotalElapsedMs = tiledRuns.reduce(
    (sum, run) => sum + run.payload.stats.elapsedMs,
    0,
  );
  const tiledTotalPoints = tiledRuns.reduce(
    (sum, run) => sum + run.payload.pointCount,
    0,
  );
  const tiledTotalIndoorExcluded = tiledRuns.reduce(
    (sum, run) => sum + (run.payload.stats.indoorPointsExcluded ?? 0),
    0,
  );

  const largePointsPerSecond = largeTotalPoints / (largeTotalWallMs / 1_000);
  const tiledPointsPerSecond = tiledTotalPoints / (tiledTotalWallMs / 1_000);

  return {
    args,
    large: {
      requestCount: largeRuns.length,
      totalWallMs: Number(largeTotalWallMs.toFixed(3)),
      totalApiElapsedMs: Number(largeTotalElapsedMs.toFixed(3)),
      totalPoints: largeTotalPoints,
      totalIndoorExcluded: largeTotalIndoorExcluded,
      pointsPerSecond: Number(largePointsPerSecond.toFixed(3)),
    },
    tiled: {
      requestCount: tiledRuns.length,
      tileCountPerDay: tiles.length,
      totalWallMs: Number(tiledTotalWallMs.toFixed(3)),
      totalApiElapsedMs: Number(tiledTotalElapsedMs.toFixed(3)),
      totalPoints: tiledTotalPoints,
      totalIndoorExcluded: tiledTotalIndoorExcluded,
      pointsPerSecond: Number(tiledPointsPerSecond.toFixed(3)),
    },
    ratios: {
      tiledVsLargeWallTime: Number((tiledTotalWallMs / largeTotalWallMs).toFixed(3)),
      tiledVsLargeThroughput: Number(
        (tiledPointsPerSecond / largePointsPerSecond).toFixed(3),
      ),
      tiledVsLargePointCount: Number((tiledTotalPoints / largeTotalPoints).toFixed(3)),
    },
  };
}

async function runParallaxScenario(args: ParsedArgs) {
  const utcDate = zonedDateTimeToUtc(
    args.startDate,
    args.localTime,
    "Europe/Zurich",
  );

  const [lausanneMask, nyonMask] = await Promise.all([
    buildDynamicHorizonMask({
      lat: LAUSANNE_CENTER.lat,
      lon: LAUSANNE_CENTER.lon,
    }),
    buildDynamicHorizonMask({
      lat: NYON_CENTER.lat,
      lon: NYON_CENTER.lon,
    }),
  ]);
  if (!lausanneMask || !nyonMask) {
    throw new Error("Unable to build horizon masks for Lausanne and/or Nyon.");
  }

  const sampleWithLausanneMask = evaluateInstantSunlight({
    lat: NYON_CENTER.lat,
    lon: NYON_CENTER.lon,
    utcDate,
    timeZone: "Europe/Zurich",
    horizonMask: lausanneMask,
  });
  const sampleWithNyonMask = evaluateInstantSunlight({
    lat: NYON_CENTER.lat,
    lon: NYON_CENTER.lon,
    utcDate,
    timeZone: "Europe/Zurich",
    horizonMask: nyonMask,
  });

  const area100mResult = await callArea({
    bbox: bboxAroundPointMeters(NYON_CENTER.lat, NYON_CENTER.lon, 50),
    date: args.startDate,
    timezone: "Europe/Zurich",
    mode: "instant",
    localTime: args.localTime,
    sampleEveryMinutes: 15,
    gridStepMeters: 10,
    maxPoints: 3_000,
  });
  const nearestPoint = [...area100mResult.payload.points].sort(
    (left, right) =>
      metersBetween(left.lat, left.lon, NYON_CENTER.lat, NYON_CENTER.lon) -
      metersBetween(right.lat, right.lon, NYON_CENTER.lat, NYON_CENTER.lon),
  )[0];
  if (!nearestPoint) {
    throw new Error("No points returned for Nyon 100m area benchmark.");
  }

  const nearestPointWithLausanneMask = evaluateInstantSunlight({
    lat: nearestPoint.lat,
    lon: nearestPoint.lon,
    utcDate,
    timeZone: "Europe/Zurich",
    horizonMask: lausanneMask,
  });

  const ridgeWithLausanneMask = lausanneMask.ridgePoints?.find(
    (point) =>
      point.azimuthDeg === normalizeAzimuth(sampleWithLausanneMask.azimuthDeg),
  );
  const ridgeWithNyonMask = nyonMask.ridgePoints?.find(
    (point) => point.azimuthDeg === normalizeAzimuth(sampleWithNyonMask.azimuthDeg),
  );

  return {
    scenario: {
      point: NYON_CENTER,
      date: args.startDate,
      localTime: args.localTime,
      timezone: "Europe/Zurich",
    },
    nyonPointComparedMasks: {
      withLausanneCenteredMask: {
        terrainBlocked: sampleWithLausanneMask.terrainBlocked,
        horizonAngleDeg: sampleWithLausanneMask.horizonAngleDeg,
        isSunny: sampleWithLausanneMask.isSunny,
        ridgeDistanceMeters: ridgeWithLausanneMask?.distanceMeters ?? null,
      },
      withNyonCenteredMask: {
        terrainBlocked: sampleWithNyonMask.terrainBlocked,
        horizonAngleDeg: sampleWithNyonMask.horizonAngleDeg,
        isSunny: sampleWithNyonMask.isSunny,
        ridgeDistanceMeters: ridgeWithNyonMask?.distanceMeters ?? null,
      },
      deltas: {
        horizonAngleDeg:
          sampleWithNyonMask.horizonAngleDeg === null ||
          sampleWithLausanneMask.horizonAngleDeg === null
            ? null
            : Number(
                (
                  sampleWithNyonMask.horizonAngleDeg -
                  sampleWithLausanneMask.horizonAngleDeg
                ).toFixed(6),
              ),
      },
    },
    nyon100mArea: {
      wallMs: Number(area100mResult.wallMs.toFixed(3)),
      pointCount: area100mResult.payload.pointCount,
      nearestPoint: {
        lat: nearestPoint.lat,
        lon: nearestPoint.lon,
        distanceToCenterMeters: Number(
          metersBetween(
            nearestPoint.lat,
            nearestPoint.lon,
            NYON_CENTER.lat,
            NYON_CENTER.lon,
          ).toFixed(3),
        ),
        terrainBlockedWithLocalAreaCenterMask: nearestPoint.terrainBlocked,
        horizonAngleDegWithLocalAreaCenterMask: nearestPoint.horizonAngleDeg,
        terrainBlockedWithLausanneCenteredMask:
          nearestPointWithLausanneMask.terrainBlocked,
        horizonAngleDegWithLausanneCenteredMask:
          nearestPointWithLausanneMask.horizonAngleDeg,
      },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("[benchmark] Warmup...");
  await warmup(args);

  console.log("[benchmark] Running large-vs-tiled benchmark...");
  const largeVsTiled = await runLargeVsTiledBenchmark(args);

  console.log("[benchmark] Running Lausanne-vs-Nyon parallax scenario...");
  const parallax = await runParallaxScenario(args);

  const result = {
    generatedAt: new Date().toISOString(),
    benchmarkVersion: "v1",
    largeVsTiled,
    parallax,
  };

  await fs.mkdir(BENCHMARK_OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(
    BENCHMARK_OUTPUT_DIR,
    `precompute-lausanne-${args.startDate}-d${args.days}-g${args.gridStepMeters}.json`,
  );
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log(`[benchmark] Output written: ${outputPath}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    `[benchmark] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
