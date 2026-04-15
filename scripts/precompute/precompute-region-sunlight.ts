import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";
import { buildRegionTiles, getIntersectingTileIds } from "../../src/lib/precompute/sunlight-cache";
import { loadTileSelectionForRegion } from "../../src/lib/precompute/tile-selection-file";

type ExperimentalBuildingsShadowMode = "gpu-raster" | "rust-wgpu-vulkan";

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
  bbox: [number, number, number, number] | null;
  tileSelectionFile: string | null;
  buildingsShadowMode: ExperimentalBuildingsShadowMode | null;
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
  bbox: null,
  tileSelectionFile: null,
  buildingsShadowMode: null,
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

function parseBuildingsShadowMode(value: string): ExperimentalBuildingsShadowMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "gpu-raster" || normalized === "rust-wgpu-vulkan") {
    return normalized;
  }
  throw new Error(
    `Invalid --buildings-shadow-mode=${value}. Expected gpu-raster or rust-wgpu-vulkan.`,
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { ...DEFAULT_ARGS };
  for (const arg of argv) {
    if (arg.startsWith("--region=")) {
      const region = arg.slice("--region=".length);
      if (
        region === "lausanne" ||
        region === "nyon" ||
        region === "morges" ||
        region === "geneve"
      ) {
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
    if (arg.startsWith("--bbox=")) {
      const parts = arg.slice("--bbox=".length).split(",").map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        result.bbox = parts as [number, number, number, number];
      }
      continue;
    }
    if (arg.startsWith("--tile-selection-file=")) {
      result.tileSelectionFile = arg.slice("--tile-selection-file=".length);
      continue;
    }
    if (arg.startsWith("--buildings-shadow-mode=")) {
      result.buildingsShadowMode = parseBuildingsShadowMode(
        arg.slice("--buildings-shadow-mode=".length),
      );
      continue;
    }
  }
  return result;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h${String(m).padStart(2, "0")}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}j${String(h).padStart(2, "0")}h${String(m).padStart(2, "0")}m`;
}

function progressBar(percent: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function computeEta(stats: {
  computedCount: number;
  computedMs: number;
  totalTiles: number;
  completedTiles: number;
  currentTileRunningFrac: number;
  currentTileRunningMs: number;
}): number | null {
  const effectiveComputed = stats.computedCount + stats.currentTileRunningFrac;
  const effectiveMs = stats.computedMs + stats.currentTileRunningMs;
  if (effectiveComputed < 0.05 || effectiveMs <= 0) return null;

  const avgMs = effectiveMs / effectiveComputed;
  // Treat every remaining tile as needing full computation.
  // Pessimistic but converges fast: cached days zip through and
  // reduce `remaining` without inflating the compute average.
  const remaining = Math.max(stats.totalTiles - stats.completedTiles - stats.currentTileRunningFrac, 0);
  return Math.max(0, Math.round((avgMs * remaining) / 1000));
}

// ── multi-worker live display helpers ───────────────────────────────────────
interface RunningSlot {
  tileIndex: number;
  phase: string;
  tilePercent: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.buildingsShadowMode) {
    process.env.MAPPY_BUILDINGS_SHADOW_MODE = args.buildingsShadowMode;
  }
  const { precomputeCacheRuns } = await import("../../src/lib/admin/cache-admin");
  const workers =
    process.env.MAPPY_PRECOMPUTE_WORKERS?.trim() ||
    "(auto: min(4, max(2, cpu-1)))";

  // Resolve bbox to tile IDs if specified
  let tileIds: string[] | undefined;
  if (args.tileSelectionFile) {
    const selection = await loadTileSelectionForRegion({
      filePath: args.tileSelectionFile,
      region: args.region,
    });
    tileIds = selection.tileIds;
    console.log(
      `[precompute] tileSelectionFile=${selection.filePath} generatedAt=${selection.generatedAt} → ${selection.tileIds.length} tiles`,
    );
  }
  if (args.bbox) {
    const [minLon, minLat, maxLon, maxLat] = args.bbox;
    const tileSizeMeters = 250;
    const bboxTileIds = getIntersectingTileIds({
      region: args.region,
      tileSizeMeters,
      bbox: { minLon, minLat, maxLon, maxLat },
    });
    tileIds = tileIds
      ? tileIds.filter((tileId) => bboxTileIds.includes(tileId))
      : bboxTileIds;
    console.log(
      `[precompute] bbox=[${args.bbox.join(",")}] → ${bboxTileIds.length} tiles (${tileIds.length} after filters)`,
    );
  }

  if (tileIds && tileIds.length === 0) {
    throw new Error("No tiles selected after applying tile-selection-file/bbox filters.");
  }

  const allTiles = buildRegionTiles(args.region, 250);
  const tileCount = tileIds ? tileIds.length : allTiles.length;

  const shadowMode = process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "(unset, default cpu)";
  console.log(
    `[precompute] engine=cache-admin shadowMode=${shadowMode} workers=${workers} region=${args.region} startDate=${args.startDate} days=${args.days} gridStep=${args.gridStepMeters}m sampleEvery=${args.sampleEveryMinutes}min window=${args.startLocalTime}-${args.endLocalTime} skipExisting=${args.skipExisting} tiles=${tileCount}`,
  );
  if (shadowMode === "rust-wgpu-vulkan") {
    console.warn(
      `[precompute] EXPERIMENTAL buildingsShadowMode=rust-wgpu-vulkan cachePolicy=shared-contract skipExisting=${args.skipExisting}`,
    );
    if (args.skipExisting) {
      console.warn(
        "[precompute] skip-existing=true réutilise volontairement les tuiles déjà calculées avec gpu-raster si elles partagent le même modèle de cache.",
      );
    }
  }

  // ── display state ────────────────────────────────────────────────────────
  let lastDayIndex = -1;
  let skipAccumCount = 0;
  const runningSlots = new Map<number, RunningSlot>();
  let liveLineCount = 0;

  // ETA tracking: only count time spent actually computing tiles
  let computedTileCount = 0;
  let computedTileMs = 0;
  let currentComputeTileIndex = -1;
  let currentTileStartMs = 0;

  // Day context for live zone
  let currentDayLabel = "";

  function eraseLiveZone(): void {
    if (liveLineCount === 0) return;
    process.stdout.write(`\x1b[${liveLineCount}A\x1b[J`);
    liveLineCount = 0;
  }

  function renderLiveZone(globalBar: string, globalPct: number, etaStr: string): void {
    const cols = process.stdout.columns || 120;
    const slots = Array.from(runningSlots.values()).sort((a, b) => a.tileIndex - b.tileIndex);
    const out: string[] = [];
    if (skipAccumCount > 0) {
      out.push(`  ⟿ ${skipAccumCount} tuile(s) ignorée(s) (cache existant)`);
    }
    // Always show global progress with day context
    const dayCtx = currentDayLabel ? `  ${currentDayLabel}` : "";
    out.push(`  ⟳${dayCtx}  [${globalBar}] ${globalPct.toFixed(1).padStart(5)}%  ETA ${etaStr}`);
    for (const slot of slots) {
      const tileBar = progressBar(slot.tilePercent, 12);
      out.push(
        `    t${String(slot.tileIndex).padStart(3)}  [${tileBar}] ${String(Math.round(slot.tilePercent)).padStart(3)}%  ${slot.phase}`,
      );
    }
    // Truncate to terminal width + clear-to-EOL to prevent wrapping artefacts
    process.stdout.write(out.map((l) => l.slice(0, cols) + "\x1b[K").join("\n") + "\n");
    liveLineCount = out.length;
  }

  function printPermanent(line: string): void {
    eraseLiveZone();
    process.stdout.write(line + "\n");
  }

  function flushSkips(): void {
    if (skipAccumCount === 0) return;
    const count = skipAccumCount;
    skipAccumCount = 0;
    printPermanent(`  ⟿ ${count} tuile(s) ignorée(s) (cache existant)`);
  }
  // ─────────────────────────────────────────────────────────────────────────

  const startedAt = Date.now();

  // Intercept console.log/warn so that log lines from internal modules
  // (evaluation-context, gpu-mesh-loader, etc.) go through printPermanent
  // instead of breaking the ANSI live zone cursor tracking.
  const _origLog = console.log;
  const _origWarn = console.warn;
  console.log = (...args: unknown[]) => {
    printPermanent(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    printPermanent(args.map(String).join(" "));
  };

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
      tileIds,
    },
    {
      onProgress: (progress) => {
        // ── track compute-only ETA metrics ─────────────────────────────
        const now = Date.now();
        let currentTileRunningFrac = 0;
        let currentTileRunningMs = 0;

        if (progress.currentTileState === "running") {
          if (progress.tileIndex !== currentComputeTileIndex) {
            currentComputeTileIndex = progress.tileIndex;
            currentTileStartMs = now;
          }
          currentTileRunningFrac =
            typeof progress.currentTileProgressPercent === "number"
              ? Math.max(0, Math.min(1, progress.currentTileProgressPercent / 100))
              : 0;
          currentTileRunningMs = now - currentTileStartMs;
        } else if (progress.currentTileState === "computed") {
          if (currentComputeTileIndex >= 0) {
            computedTileMs += now - currentTileStartMs;
          }
          computedTileCount++;
          currentComputeTileIndex = -1;
        }

        const eta = computeEta({
          computedCount: computedTileCount,
          computedMs: computedTileMs,
          totalTiles: progress.totalTiles,
          completedTiles: progress.completedTiles,
          currentTileRunningFrac,
          currentTileRunningMs,
        });
        const etaStr = eta != null ? formatDuration(eta) : "--";
        const globalBar = progressBar(progress.percent, 24);

        // ── new day header ────────────────────────────────────────────────
        if (progress.dayIndex !== lastDayIndex) {
          flushSkips();
          currentDayLabel = `Jour ${progress.dayIndex}/${progress.daysTotal}  ${progress.date}`;
          printPermanent(`\n  ── ${currentDayLabel} ──`);
          lastDayIndex = progress.dayIndex;
        }

        // ── skipped ───────────────────────────────────────────────────────
        if (progress.currentTileState === "skipped") {
          runningSlots.delete(progress.tileIndex);
          skipAccumCount++;
          eraseLiveZone();
          renderLiveZone(globalBar, progress.percent, etaStr);
          return;
        }

        // ── running ───────────────────────────────────────────────────────
        if (progress.currentTileState === "running") {
          runningSlots.set(progress.tileIndex, {
            tileIndex: progress.tileIndex,
            phase: progress.currentTilePhase ?? "...",
            tilePercent: progress.currentTileProgressPercent ?? 0,
          });
          eraseLiveZone();
          renderLiveZone(globalBar, progress.percent, etaStr);
          return;
        }

        // ── computed / failed ─────────────────────────────────────────────
        flushSkips();
        runningSlots.delete(progress.tileIndex);

        if (progress.currentTileState === "computed") {
          const pts =
            progress.currentTilePointCountOutdoor != null
              ? `  ${progress.currentTilePointCountOutdoor.toLocaleString()} pts outdoor`
              : "";
          printPermanent(
            `  ✓ t${progress.tileIndex}/${progress.tilesTotal}${pts}  [${globalBar}] ${progress.percent.toFixed(1).padStart(5)}%  ETA ${etaStr}`,
          );
        } else if (progress.currentTileState === "failed") {
          printPermanent(`  ✗ t${progress.tileIndex}/${progress.tilesTotal}  ÉCHEC`);
        }

        eraseLiveZone();
        renderLiveZone(globalBar, progress.percent, etaStr);
      },
    },
  );

  // Flush any trailing live zone
  flushSkips();
  eraseLiveZone();

  // Restore original console methods for final summary
  console.log = _origLog;
  console.warn = _origWarn;

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `\n[precompute] ✓ terminé  region=${result.region}  model=${result.modelVersionHash}  totalDates=${result.totalDates}  totalTiles=${result.totalTiles}  durée=${formatDuration(elapsedMs / 1000)}`,
  );
  for (const day of result.dates) {
    const icon = day.complete ? "✓" : day.failedTiles > 0 ? "✗" : "~";
    console.log(
      `  ${icon} ${day.date}  ok=${day.succeededTiles}  skip=${day.skippedTiles}  fail=${day.failedTiles}  durée=${formatDuration(day.elapsedMs / 1000)}`,
    );
  }
}

void main().catch((error) => {
  console.error(
    `[precompute] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});
