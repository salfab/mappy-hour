import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { LAUSANNE_CENTER } from "@/lib/config/lausanne";
import { NYON_CENTER } from "@/lib/config/nyon";
import { precomputeCacheRuns } from "@/lib/admin/cache-admin";
import { buildRegionTiles, type PrecomputedRegionName } from "@/lib/precompute/sunlight-cache";

interface ParsedArgs {
  region: PrecomputedRegionName;
  startDate: string;
  days: number;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tileCount: number;
  repeats: number;
  workers: number[];
}

interface RunSample {
  repeat: number;
  workerCount: number;
  elapsedMs: number;
  processedTiles: number;
  tilePerMinute: number;
  totalFailedTiles: number;
}

const OUTPUT_DIR = path.join(process.cwd(), "docs", "progress", "benchmarks");

const DEFAULT_ARGS: ParsedArgs = {
  region: "lausanne",
  startDate: "2026-03-08",
  days: 1,
  timezone: "Europe/Zurich",
  sampleEveryMinutes: 15,
  gridStepMeters: 5,
  startLocalTime: "08:00",
  endLocalTime: "12:00",
  tileCount: 12,
  repeats: 2,
  workers: [1, 2, 4],
};

function parseIntArg(value: string, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  if (parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function parseWorkers(value: string): number[] {
  const unique = new Set<number>();
  for (const item of value.split(",")) {
    const parsed = Number(item.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 64) {
      continue;
    }
    unique.add(parsed);
  }
  return Array.from(unique).sort((a, b) => a - b);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { ...DEFAULT_ARGS };

  for (const arg of argv) {
    if (arg.startsWith("--region=")) {
      const region = arg.slice("--region=".length);
      if (region === "lausanne" || region === "nyon") {
        args.region = region;
      }
      continue;
    }
    if (arg.startsWith("--start-date=")) {
      args.startDate = arg.slice("--start-date=".length);
      continue;
    }
    if (arg.startsWith("--days=")) {
      const parsed = parseIntArg(arg.slice("--days=".length), 1, 31);
      if (parsed !== null) {
        args.days = parsed;
      }
      continue;
    }
    if (arg.startsWith("--timezone=")) {
      args.timezone = arg.slice("--timezone=".length);
      continue;
    }
    if (arg.startsWith("--sample-every-minutes=")) {
      const parsed = parseIntArg(arg.slice("--sample-every-minutes=".length), 1, 60);
      if (parsed !== null) {
        args.sampleEveryMinutes = parsed;
      }
      continue;
    }
    if (arg.startsWith("--grid-step-meters=")) {
      const parsed = parseIntArg(arg.slice("--grid-step-meters=".length), 1, 2000);
      if (parsed !== null) {
        args.gridStepMeters = parsed;
      }
      continue;
    }
    if (arg.startsWith("--start-local-time=")) {
      args.startLocalTime = arg.slice("--start-local-time=".length);
      continue;
    }
    if (arg.startsWith("--end-local-time=")) {
      args.endLocalTime = arg.slice("--end-local-time=".length);
      continue;
    }
    if (arg.startsWith("--tile-count=")) {
      const parsed = parseIntArg(arg.slice("--tile-count=".length), 1, 5000);
      if (parsed !== null) {
        args.tileCount = parsed;
      }
      continue;
    }
    if (arg.startsWith("--repeats=")) {
      const parsed = parseIntArg(arg.slice("--repeats=".length), 1, 20);
      if (parsed !== null) {
        args.repeats = parsed;
      }
      continue;
    }
    if (arg.startsWith("--workers=")) {
      const workers = parseWorkers(arg.slice("--workers=".length));
      if (workers.length > 0) {
        args.workers = workers;
      }
    }
  }

  return args;
}

function centerForRegion(region: PrecomputedRegionName): { lat: number; lon: number } {
  return region === "lausanne" ? LAUSANNE_CENTER : NYON_CENTER;
}

function distanceSquaredMeters(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): number {
  const dLatMeters = (latB - latA) * 111_320;
  const avgLat = (latA + latB) / 2;
  const dLonMeters = (lonB - lonA) * (111_320 * Math.cos((avgLat * Math.PI) / 180));
  return dLatMeters * dLatMeters + dLonMeters * dLonMeters;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const center = centerForRegion(args.region);
  const tiles = buildRegionTiles(args.region, 250)
    .map((tile) => {
      const centerLat = (tile.bbox.minLat + tile.bbox.maxLat) / 2;
      const centerLon = (tile.bbox.minLon + tile.bbox.maxLon) / 2;
      return {
        tile,
        distance2: distanceSquaredMeters(center.lat, center.lon, centerLat, centerLon),
      };
    })
    .sort((left, right) => left.distance2 - right.distance2)
    .slice(0, args.tileCount)
    .map((entry) => entry.tile);

  if (tiles.length === 0) {
    throw new Error("No tiles selected for benchmark.");
  }

  const selectedTileIds = tiles.map((tile) => tile.tileId);
  const baselineWorker = args.workers.includes(1) ? 1 : args.workers[0];
  const samples: RunSample[] = [];
  const originalWorkersEnv = process.env.MAPPY_PRECOMPUTE_WORKERS;
  const originalStrictEnv = process.env.MAPPY_PRECOMPUTE_WORKERS_STRICT;

  console.log(
    `[benchmark:precompute-workers] region=${args.region} date=${args.startDate} days=${args.days} tileCount=${tiles.length} gridStep=${args.gridStepMeters}m sampleEvery=${args.sampleEveryMinutes}min window=${args.startLocalTime}-${args.endLocalTime} repeats=${args.repeats} workers=${args.workers.join(",")}`,
  );

  try {
    process.env.MAPPY_PRECOMPUTE_WORKERS_STRICT = "1";
    for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
      const runOrder =
        repeat % 2 === 1 ? [...args.workers] : [...args.workers].reverse();
      console.log(
        `[benchmark:precompute-workers] repeat=${repeat}/${args.repeats} order=${runOrder.join(",")}`,
      );

      for (const workerCount of runOrder) {
        process.env.MAPPY_PRECOMPUTE_WORKERS = String(workerCount);
        const startedAt = performance.now();
        const result = await precomputeCacheRuns(
          {
            region: args.region,
            startDate: args.startDate,
            days: args.days,
            timezone: args.timezone,
            sampleEveryMinutes: args.sampleEveryMinutes,
            gridStepMeters: args.gridStepMeters,
            startLocalTime: args.startLocalTime,
            endLocalTime: args.endLocalTime,
            tileIds: selectedTileIds,
            skipExisting: false,
            buildingHeightBiasMeters: 0,
          },
          {},
        );
        const elapsedMs = performance.now() - startedAt;
        const processedTiles = result.totalTiles * result.totalDates;
        const totalFailedTiles = result.dates.reduce(
          (total, day) => total + day.failedTiles,
          0,
        );
        const tilePerMinute =
          elapsedMs <= 0 ? 0 : processedTiles / (elapsedMs / 60_000);
        samples.push({
          repeat,
          workerCount,
          elapsedMs: Math.round(elapsedMs * 1000) / 1000,
          processedTiles,
          tilePerMinute: Math.round(tilePerMinute * 1000) / 1000,
          totalFailedTiles,
        });
        console.log(
          `[benchmark:precompute-workers] repeat=${repeat} workers=${workerCount} elapsedMs=${Math.round(elapsedMs)} processedTiles=${processedTiles} tilesPerMin=${tilePerMinute.toFixed(3)} failedTiles=${totalFailedTiles}`,
        );
      }
    }
  } finally {
    if (originalWorkersEnv === undefined) {
      delete process.env.MAPPY_PRECOMPUTE_WORKERS;
    } else {
      process.env.MAPPY_PRECOMPUTE_WORKERS = originalWorkersEnv;
    }
    if (originalStrictEnv === undefined) {
      delete process.env.MAPPY_PRECOMPUTE_WORKERS_STRICT;
    } else {
      process.env.MAPPY_PRECOMPUTE_WORKERS_STRICT = originalStrictEnv;
    }
  }

  const byWorker = new Map<number, RunSample[]>();
  for (const sample of samples) {
    const existing = byWorker.get(sample.workerCount) ?? [];
    existing.push(sample);
    byWorker.set(sample.workerCount, existing);
  }

  const baselineSamples = byWorker.get(baselineWorker) ?? [];
  const baselineMedianElapsed = median(baselineSamples.map((sample) => sample.elapsedMs));

  const summary = Array.from(byWorker.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([workerCount, workerSamples]) => {
      const elapsedValues = workerSamples.map((sample) => sample.elapsedMs);
      const throughputValues = workerSamples.map((sample) => sample.tilePerMinute);
      const elapsedMedianMs = median(elapsedValues);
      const throughputMedian = median(throughputValues);
      const speedupVsBaseline =
        baselineMedianElapsed <= 0
          ? null
          : Math.round((baselineMedianElapsed / elapsedMedianMs) * 1000) / 1000;
      return {
        workerCount,
        runs: workerSamples.length,
        elapsedMs: {
          min: Math.min(...elapsedValues),
          median: Math.round(elapsedMedianMs * 1000) / 1000,
          max: Math.max(...elapsedValues),
        },
        tilesPerMinute: {
          min: Math.min(...throughputValues),
          median: Math.round(throughputMedian * 1000) / 1000,
          max: Math.max(...throughputValues),
        },
        totalFailedTiles: workerSamples.reduce(
          (total, sample) => total + sample.totalFailedTiles,
          0,
        ),
        speedupVsBaseline,
      };
    });

  const report = {
    generatedAt: new Date().toISOString(),
    params: args,
    selectedTileIds,
    selectedTileCount: selectedTileIds.length,
    baselineWorkerCount: baselineWorker,
    summary,
    samples,
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(
    OUTPUT_DIR,
    `precompute-workers-${args.region}-${args.startDate}-d${args.days}-g${args.gridStepMeters}-t${args.tileCount}.json`,
  );
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[benchmark:precompute-workers] wrote ${outputPath}`);
}

void main().catch((error) => {
  console.error(
    `[benchmark:precompute-workers] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
