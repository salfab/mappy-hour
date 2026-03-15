import { precomputeCacheRuns, type CachePrecomputeProgress } from "../../src/lib/admin/cache-admin";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";

interface ParsedArgs {
  region: PrecomputedRegionName;
  startDate: string;
  days: number;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  buildingHeightBiasMeters: number;
  skipExisting: boolean;
}

const DEFAULT_ARGS: ParsedArgs = {
  region: "lausanne",
  startDate: "2026-03-08",
  days: 1,
  timezone: "Europe/Zurich",
  sampleEveryMinutes: 15,
  gridStepMeters: 1,
  startLocalTime: "00:00",
  endLocalTime: "23:59",
  buildingHeightBiasMeters: 0,
  skipExisting: true,
};

function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { ...DEFAULT_ARGS };
  for (const arg of argv) {
    if (arg.startsWith("--region=")) {
      const region = arg.slice("--region=".length);
      if (region === "lausanne" || region === "nyon") {
        result.region = region;
      }
      continue;
    }
    if (arg.startsWith("--start-date=")) {
      result.startDate = arg.slice("--start-date=".length);
      continue;
    }
    if (arg.startsWith("--days=")) {
      const parsed = Number(arg.slice("--days=".length));
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 366) {
        result.days = parsed;
      }
      continue;
    }
    if (arg.startsWith("--timezone=")) {
      result.timezone = arg.slice("--timezone=".length);
      continue;
    }
    if (arg.startsWith("--sample-every-minutes=")) {
      const parsed = Number(arg.slice("--sample-every-minutes=".length));
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 60) {
        result.sampleEveryMinutes = parsed;
      }
      continue;
    }
    if (arg.startsWith("--grid-step-meters=")) {
      const parsed = Number(arg.slice("--grid-step-meters=".length));
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 2000) {
        result.gridStepMeters = parsed;
      }
      continue;
    }
    if (arg.startsWith("--tile-size-meters=")) {
      throw new Error(
        "The --tile-size-meters option was removed. Tile size is fixed to 250m.",
      );
    }
    if (arg.startsWith("--start-local-time=")) {
      result.startLocalTime = arg.slice("--start-local-time=".length);
      continue;
    }
    if (arg.startsWith("--end-local-time=")) {
      result.endLocalTime = arg.slice("--end-local-time=".length);
      continue;
    }
    if (arg.startsWith("--building-height-bias-meters=")) {
      result.buildingHeightBiasMeters = Number(
        arg.slice("--building-height-bias-meters=".length),
      );
      continue;
    }
    if (arg.startsWith("--skip-existing=")) {
      const parsed = parseBoolean(arg.slice("--skip-existing=".length));
      if (parsed !== null) {
        result.skipExisting = parsed;
      }
      continue;
    }
  }
  return result;
}

function shouldLogProgress(
  current: CachePrecomputeProgress,
  previous: CachePrecomputeProgress | null,
): boolean {
  if (!previous) {
    return true;
  }
  if (current.date !== previous.date) {
    return true;
  }
  if (current.currentTileState !== previous.currentTileState) {
    return true;
  }
  if (current.currentTilePhase !== previous.currentTilePhase) {
    return true;
  }
  if (current.tileIndex !== previous.tileIndex) {
    if (
      current.tileIndex <= 3 ||
      current.tileIndex === current.tilesTotal ||
      current.tileIndex % 100 === 0
    ) {
      return true;
    }
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workers =
    process.env.MAPPY_PRECOMPUTE_WORKERS?.trim() ||
    "(auto: min(4, max(2, cpu-1)))";

  console.log(
    `[precompute] engine=cache-admin workers=${workers} region=${args.region} startDate=${args.startDate} days=${args.days} gridStep=${args.gridStepMeters}m sampleEvery=${args.sampleEveryMinutes}min window=${args.startLocalTime}-${args.endLocalTime} skipExisting=${args.skipExisting}`,
  );

  let lastProgress: CachePrecomputeProgress | null = null;
  const startedAt = Date.now();

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
      skipExisting: args.skipExisting,
      buildingHeightBiasMeters: args.buildingHeightBiasMeters,
    },
    {
      onProgress: (progress) => {
        if (!shouldLogProgress(progress, lastProgress)) {
          return;
        }
        lastProgress = progress;
        console.log(
          `[precompute] date=${progress.date} day=${progress.dayIndex}/${progress.daysTotal} tile=${progress.tileIndex}/${progress.tilesTotal} state=${progress.currentTileState} phase=${progress.currentTilePhase ?? "none"} progress=${progress.percent.toFixed(1)}% tileProgress=${(progress.currentTileProgressPercent ?? 0).toFixed(1)}%`,
        );
      },
    },
  );

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[precompute] completed region=${result.region} model=${result.modelVersionHash} totalDates=${result.totalDates} totalTiles=${result.totalTiles} elapsedMs=${elapsedMs}`,
  );
  for (const day of result.dates) {
    console.log(
      `[precompute] date=${day.date} ok=${day.succeededTiles} skipped=${day.skippedTiles} failed=${day.failedTiles} complete=${day.complete} elapsedMs=${day.elapsedMs}`,
    );
  }
}

void main().catch((error) => {
  console.error(
    `[precompute] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});
