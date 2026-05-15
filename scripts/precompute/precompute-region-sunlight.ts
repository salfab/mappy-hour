import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";
import { buildRegionTiles, getIntersectingTileIds } from "../../src/lib/precompute/sunlight-cache";
import { loadTileSelectionForRegion } from "../../src/lib/precompute/tile-selection-file";
import { runPreflight } from "../../src/lib/precompute/preflight-atlas-health";
import { getHorizonCacheStats } from "../../src/lib/sun/adaptive-horizon-sharing";

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
  groupFilter: "top-priority" | "other" | "all";
  buildingsShadowMode: ExperimentalBuildingsShadowMode | null;
  atlasResolutionDeg: number;
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
  groupFilter: "all",
  buildingsShadowMode: null,
  atlasResolutionDeg: 0.75,
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
        region === "geneve" ||
        region === "vevey" ||
        region === "vevey_city" ||
        region === "neuchatel" ||
        region === "la_chaux_de_fonds" ||
        region === "bern" ||
        region === "zurich" ||
        region === "thun"
      ) {
        result.region = region;
      } else {
        // Fail fast on unknown region — prior behaviour silently fell back to
        // the default "lausanne" and the misrouted run looked successful but
        // produced no atlas under the intended region cache dir.
        throw new Error(
          `Unknown --region=${region}. Expected lausanne|nyon|morges|geneve|vevey|vevey_city|neuchatel|la_chaux_de_fonds|bern|zurich|thun.`,
        );
      }
      continue;
    }
    if (arg.startsWith("--start-date=")) {
      result.startDate = arg.slice("--start-date=".length);
      continue;
    }
    if (arg.startsWith("--days=")) {
      const raw = arg.slice("--days=".length);
      const parsed = Number(raw);
      const MAX_DAYS = 1464; // ~4 ans (cycle Gregorien complet)
      if (Number.isInteger(parsed) && parsed >= 1) {
        if (parsed > MAX_DAYS) {
          console.warn(
            `\x1b[33m[precompute] --days=${parsed} clampé à ${MAX_DAYS} (4 ans Gregorien). Au-delà, l'analemme repasse sur les mêmes buckets — précomputer plus longtemps n'apporte rien.\x1b[0m`,
          );
          result.days = MAX_DAYS;
        } else {
          result.days = parsed;
        }
      } else {
        console.warn(
          `\x1b[33m[precompute] --days=${raw} invalide — valeur par défaut ${result.days} utilisée.\x1b[0m`,
        );
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
    if (arg.startsWith("--group-filter=")) {
      const v = arg.slice("--group-filter=".length);
      if (v !== "top-priority" && v !== "other" && v !== "all") {
        throw new Error(`Invalid --group-filter=${v}. Expected top-priority|other|all.`);
      }
      result.groupFilter = v;
      continue;
    }
    if (arg.startsWith("--buildings-shadow-mode=")) {
      result.buildingsShadowMode = parseBuildingsShadowMode(
        arg.slice("--buildings-shadow-mode=".length),
      );
      continue;
    }
    if (arg.startsWith("--atlas-resolution-deg=")) {
      const parsed = Number(arg.slice("--atlas-resolution-deg=".length));
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10) {
        result.atlasResolutionDeg = parsed;
      } else {
        throw new Error(
          `Invalid --atlas-resolution-deg=${arg.slice("--atlas-resolution-deg=".length)}. Expected a positive number <= 10.`,
        );
      }
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

/** Sliding window of recent tile-completion wall-clock timestamps (ms since epoch). */
const RECENT_WINDOW_SIZE = 5;

/**
 * Compute ETA using wall-clock throughput. Three-tier estimator, all pipeline-aware:
 *
 *   1. **Steady-state**: 2+ completions in the recent window
 *      → `(window_span / (N-1)) × remaining`
 *      Naturally captures pipeline depth (N tiles finishing in T wall-time =
 *      throughput N/T, not avg(individual_durations) which overcounts by depth×).
 *
 *   2. **Bootstrap**: ≥1 completion ever, but <2 in window (e.g. very first
 *      tile just landed) → `(now - firstCompletionTs) / completedCount × remaining`.
 *      Same physical interpretation, longer baseline, less recency.
 *
 *   3. **Warming**: 0 completions → return null (caller displays "warming").
 *      Falsely-confident early ETAs (e.g. extrapolating from in-flight tile
 *      fraction) are worse than admitting we don't know yet.
 */
function computeEta(stats: {
  recentCompletionTimestamps: number[];
  firstCompletionTs: number | null;
  completedCount: number;
  totalTiles: number;
  completedTiles: number;
  currentTileRunningFrac: number;
  nowMs: number;
}): number | null {
  const remaining = Math.max(stats.totalTiles - stats.completedTiles - stats.currentTileRunningFrac, 0);
  if (remaining <= 0) return 0;

  // Tier 1: recent-window wall-clock throughput.
  const ts = stats.recentCompletionTimestamps;
  if (ts.length >= 2) {
    const windowSpanMs = ts[ts.length - 1] - ts[0];
    const intervals = ts.length - 1;
    if (windowSpanMs > 0) {
      return Math.max(0, Math.round((windowSpanMs / intervals) * remaining / 1000));
    }
  }

  // Tier 2: full-history wall-clock since first completion.
  if (stats.firstCompletionTs !== null && stats.completedCount >= 1) {
    const elapsedSinceFirst = stats.nowMs - stats.firstCompletionTs;
    if (elapsedSinceFirst > 0 && stats.completedCount > 0) {
      // Use completedCount as the "intervals" denominator: from t=firstCompletion
      // to now, we observed completedCount tile-completions (the 1st marked t=0,
      // and N more arrived since — but the simpler model treats it as N tiles
      // completing in the elapsed interval). For N=1 we don't yet have an
      // interval; we'd need a 2nd completion. Use msPerTile = elapsedSinceFirst /
      // completedCount as a rough rate.
      const msPerTile = elapsedSinceFirst / stats.completedCount;
      return Math.max(0, Math.round((msPerTile * remaining) / 1000));
    }
  }

  // Tier 3: no completions yet — honest "--".
  return null;
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

  // Preflight (A) refuse to start without a horizon DEM manifest, and (B)
  // quarantine atlases on disk that were generated without one. The orphan-
  // atlas bug surfaced in 2026-05-15 made it clear we cannot trust skip-
  // existing to leave behind only sane caches. See
  // src/lib/precompute/preflight-atlas-health.ts.
  //
  // The multi-region orchestrator runs the preflight itself for each region
  // before spawning us and sets MAPPY_PREFLIGHT_DONE=1 to avoid scanning twice.
  if (process.env.MAPPY_PREFLIGHT_DONE !== "1") {
    const preflight = await runPreflight(args.region);
    if (!preflight.ok) {
      console.error(`\x1b[1;31m[precompute] ${preflight.reason}\x1b[0m`);
      process.exitCode = 1;
      return;
    }
  }

  const { precomputeCacheRuns } = await import("../../src/lib/admin/cache-admin");
  const shadowMode = process.env.MAPPY_BUILDINGS_SHADOW_MODE?.trim().toLowerCase();
  const isGpuIpcBackend = shadowMode === "rust-wgpu-vulkan" || shadowMode === "webgpu-compute";
  const workers =
    process.env.MAPPY_PRECOMPUTE_WORKERS?.trim() ||
    (isGpuIpcBackend
      ? "(auto: 1, GPU-IPC backend forces single-worker — see ADR-0019)"
      : "(auto: min(4, max(2, cpu-1)))");

  // Resolve bbox to tile IDs if specified
  let tileIds: string[] | undefined;
  if (args.tileSelectionFile) {
    const selection = await loadTileSelectionForRegion({
      filePath: args.tileSelectionFile,
      region: args.region,
      groupFilter: args.groupFilter,
    });
    tileIds = selection.tileIds;
    console.log(
      `[precompute] tileSelectionFile=${selection.filePath} generatedAt=${selection.generatedAt} groupFilter=${args.groupFilter} → ${selection.tileIds.length} tiles`,
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
    // Empty result is a benign no-op when this script is called as part of
    // a 2-pass × N-region matrix by precompute-all-regions: most cells of
    // the matrix have no tiles for the (region, group-filter) combo, and
    // throwing here surfaced as a misleading `✗ a échoué (exit 1)` line in
    // the parent log even though nothing was wrong.
    console.log(
      `[precompute] no tiles selected after applying tile-selection-file/bbox/group filters — exiting cleanly.`,
    );
    return;
  }

  const allTiles = buildRegionTiles(args.region, 250);
  const tileCount = tileIds ? tileIds.length : allTiles.length;

  const shadowModeLabel = process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "(unset, default cpu)";
  console.log(
    `[precompute] engine=cache-admin shadowMode=${shadowModeLabel} workers=${workers} region=${args.region} startDate=${args.startDate} days=${args.days} gridStep=${args.gridStepMeters}m sampleEvery=${args.sampleEveryMinutes}min window=${args.startLocalTime}-${args.endLocalTime} atlasRes=${args.atlasResolutionDeg}° skipExisting=${args.skipExisting} tiles=${tileCount}`,
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

  // ETA tracking: a sliding wall-clock window for steady-state throughput,
  // plus the timestamp of the first ever completion as a tier-2 fallback.
  let computedTileCount = 0;
  let firstCompletionTs: number | null = null;
  let currentComputeTileIndex = -1;
  let currentTileStartMs = 0;
  let firstTileStartMs = 0; // timestamp of the very first "running" callback — used in the cold-start breakdown
  let computedTileMs = 0; // accumulator of per-tile compute duration (running → computed) — used in the gap breakdown
  const recentCompletionTimestamps: number[] = [];

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
      atlasResolutionDeg: args.atlasResolutionDeg,
      tileIds,
    },
    {
      onProgress: (progress) => {
        // ── wall-clock-only ETA tracking ─────────────────────────────
        const now = Date.now();
        let currentTileRunningFrac = 0;

        if (progress.currentTileState === "running") {
          if (progress.tileIndex !== currentComputeTileIndex) {
            currentComputeTileIndex = progress.tileIndex;
            currentTileStartMs = now;
            if (firstTileStartMs === 0) firstTileStartMs = now;
          }
          currentTileRunningFrac =
            typeof progress.currentTileProgressPercent === "number"
              ? Math.max(0, Math.min(1, progress.currentTileProgressPercent / 100))
              : 0;
        } else if (progress.currentTileState === "computed") {
          computedTileCount++;
          if (currentTileStartMs > 0) {
            computedTileMs += now - currentTileStartMs;
          }
          currentComputeTileIndex = -1;
          recentCompletionTimestamps.push(now);
          if (firstCompletionTs === null) firstCompletionTs = now;
          while (recentCompletionTimestamps.length > RECENT_WINDOW_SIZE) {
            recentCompletionTimestamps.shift();
          }
        }

        const eta = computeEta({
          recentCompletionTimestamps,
          firstCompletionTs,
          completedCount: computedTileCount,
          totalTiles: progress.totalTiles,
          completedTiles: progress.completedTiles,
          currentTileRunningFrac,
          nowMs: now,
        });
        const etaStr = eta != null ? formatDuration(eta) : "--";
        const globalBar = progressBar(progress.percent, 24);

        // ── warming (préchargement parallèle des sidecars .atlas.idx) ─────
        if (progress.currentTileState === "warming") {
          eraseLiveZone();
          const loaded = progress.warmLoaded ?? 0;
          const total = progress.warmTotal ?? progress.tilesTotal;
          const migrated = progress.warmMigrated ?? 0;
          const pct = total === 0 ? 100 : (loaded / total) * 100;
          const bar = progressBar(pct, 24);
          const migSuffix = migrated > 0 ? `  (${migrated} migré${migrated > 1 ? "s" : ""})` : "";
          process.stdout.write(
            `  ⚡ Warm-up cache atlas  [${bar}] ${pct.toFixed(1).padStart(5)}%  ${loaded}/${total}${migSuffix}\x1b[K\n`,
          );
          liveLineCount = 1;
          return;
        }
        if (progress.currentTileState === "warming-done") {
          eraseLiveZone();
          const loaded = progress.warmLoaded ?? 0;
          const total = progress.warmTotal ?? progress.tilesTotal;
          const migrated = progress.warmMigrated ?? 0;
          const elapsedStr = progress.warmElapsedMs != null
            ? (progress.warmElapsedMs < 1000
                ? `${progress.warmElapsedMs}ms`
                : formatDuration(progress.warmElapsedMs / 1000))
            : "";
          const migSuffix = migrated > 0 ? `, ${migrated} migré${migrated > 1 ? "s" : ""}` : "";
          printPermanent(
            `  ⚡ Warm-up cache atlas terminé  ${loaded}/${total} tuile(s)${migSuffix}  (${elapsedStr})`,
          );
          return;
        }

        // ── day-skipped (toutes les tuiles du jour déjà en cache) ─────────
        if (progress.currentTileState === "day-skipped") {
          flushSkips();
          runningSlots.clear();
          eraseLiveZone();
          printPermanent(
            `  ⏭  Jour ${progress.dayIndex}/${progress.daysTotal}  ${progress.date}  déjà précalculé (${progress.tilesTotal} tuiles)  [${globalBar}] ${progress.percent.toFixed(1).padStart(5)}%  ETA ${etaStr}`,
          );
          lastDayIndex = progress.dayIndex;
          renderLiveZone(globalBar, progress.percent, etaStr);
          return;
        }

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

  // ── Diagnostic summary: cold-start, inter-tile gap, horizon cache ────
  // Turns "somme des logs [tile]" vs "wall-time script" into an explicit
  // breakdown so we can see where optim headroom lives.
  const coldStartMs = firstTileStartMs > 0 ? firstTileStartMs - startedAt : 0;
  const sumTileMs = computedTileMs;
  const gapMs = Math.max(0, elapsedMs - coldStartMs - sumTileMs);
  const coldPct = elapsedMs > 0 ? (coldStartMs / elapsedMs) * 100 : 0;
  const tilePct = elapsedMs > 0 ? (sumTileMs / elapsedMs) * 100 : 0;
  const gapPct = elapsedMs > 0 ? (gapMs / elapsedMs) * 100 : 0;
  console.log(
    `[precompute] breakdown  cold-start ${formatDuration(coldStartMs / 1000)} (${coldPct.toFixed(0)}%)` +
      `  tiles ${formatDuration(sumTileMs / 1000)} (${tilePct.toFixed(0)}%)` +
      `  gap ${formatDuration(gapMs / 1000)} (${gapPct.toFixed(0)}%)`,
  );
  const hs = getHorizonCacheStats();
  const hsTotal = hs.hits + hs.misses;
  if (hsTotal > 0) {
    console.log(
      `[precompute] horizon-cache  ${hs.hits}/${hsTotal} hits (${(hs.hitRatio * 100).toFixed(0)}%)` +
        `  builds=${hs.misses} (${formatDuration(hs.totalBuildMs / 1000)})` +
        `  lookup=${formatDuration(hs.totalHitLookupMs / 1000)}`,
    );
  }

  for (const day of result.dates) {
    const icon = day.complete ? "✓" : day.failedTiles > 0 ? "✗" : "~";
    console.log(
      `  ${icon} ${day.date}  ok=${day.succeededTiles}  skip=${day.skippedTiles}  fail=${day.failedTiles}  durée=${formatDuration(day.elapsedMs / 1000)}`,
    );
  }

  // Atlas drift recovery: if mergeBucketsIntoAtlas had to gracefully invalidate
  // any stale atlas during this run (Option A), generate a patch script the
  // operator can run to fill the gaps.
  if (result.atlasDriftRecords.length > 0) {
    const { writeAtlasDriftPatchScript } = await import(
      "../../src/lib/precompute/atlas-drift-patch-script"
    );
    const scriptPath = await writeAtlasDriftPatchScript({
      records: result.atlasDriftRecords,
      run: {
        region: args.region,
        startDate: args.startDate,
        days: args.days,
        timezone: args.timezone,
        sampleEveryMinutes: args.sampleEveryMinutes,
        gridStepMeters: args.gridStepMeters,
        startLocalTime: args.startLocalTime,
        endLocalTime: args.endLocalTime,
        buildingHeightBiasMeters: args.buildingHeightBiasMeters,
        buildingsShadowMode: args.buildingsShadowMode,
        atlasResolutionDeg: args.atlasResolutionDeg,
      },
    });
    console.warn("");
    console.warn(
      `⚠️  Atlas drift detected on ${result.atlasDriftRecords.length} tile(s) during this run.`,
    );
    console.warn(
      `   Stale atlases were gracefully invalidated; per-day tile artifacts for these tiles`,
    );
    console.warn(
      `   are now incoherent with the fresh atlases and should be regenerated.`,
    );
    console.warn("");
    console.warn(`   Run the following to fill the gaps (idempotent):`);
    console.warn("");
    console.warn(`       bash ${scriptPath}`);
    console.warn("");
    console.warn(
      `   Affected tiles: ${result.atlasDriftRecords
        .slice(0, 5)
        .map((r) => `${r.region}/${r.tileId}`)
        .join(", ")}${result.atlasDriftRecords.length > 5 ? ", ..." : ""}`,
    );
  }

  // ── End-of-run sanity check: scan adaptive-horizon assignment JSONs ────
  // ADR-0023: non-atomic writes in `persistAssignment()` can leave a
  // corrupt JSON behind (trailing garbage / truncation) — invisible until
  // a runtime SSE request surfaces the warning. Running the scan here gives
  // operators an immediate signal about which tile/date pairs are now
  // impaired in the region they just precomputed.
  try {
    const { scanAdaptiveHorizonAssignments } = await import(
      "../../src/lib/diag/adaptive-horizon-check"
    );
    const path = await import("node:path");
    const scanRoot = path.resolve(
      process.cwd(),
      "data/processed/horizon/adaptive-sharing",
      args.region,
    );
    const scan = await scanAdaptiveHorizonAssignments({ root: scanRoot });
    console.log("");
    if (scan.corrupt.length === 0) {
      console.log(
        `[precompute] adaptive-horizon sanity: ✓ ${scan.okCount} assignment(s) parse cleanly`,
      );
    } else {
      // Group by (date, window) so the operator sees the tile-dates impacted,
      // not just raw JSON paths.
      console.warn(
        `\x1b[1;31m[precompute] adaptive-horizon sanity: ✗ ${scan.corrupt.length}/${scan.corrupt.length + scan.okCount} assignment(s) corrupt\x1b[0m`,
      );
      console.warn(
        `   Atlas binaries themselves are unaffected — but tiles served for the dates`,
      );
      console.warn(
        `   below will log "missing terrain horizon mask" warnings and skip far-horizon`,
      );
      console.warn(`   blocking until the assignments are regenerated.`);
      console.warn("");
      const byDate = new Map<string, Set<string>>();
      for (const c of scan.corrupt) {
        const key = c.date ?? "<unknown-date>";
        if (!byDate.has(key)) byDate.set(key, new Set());
        byDate.get(key)!.add(c.window ?? "<unknown-window>");
      }
      for (const [date, windows] of [...byDate.entries()].sort()) {
        console.warn(`     ${date}  windows: ${[...windows].sort().join(", ")}`);
      }
      console.warn("");
      console.warn(
        `   Run \x1b[1mpnpm diag:adaptive-horizon --quarantine\x1b[0m to mark them for`,
      );
      console.warn(
        `   regeneration on the next precompute touching these tile/date pairs.`,
      );
    }
  } catch (err) {
    // Sanity check failure shouldn't fail the run — log and move on.
    console.warn(
      `[precompute] adaptive-horizon sanity scan failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

void main().catch((error) => {
  // ANSI red + bright so the fatal stands out among the (otherwise plain)
  // tile-progress chatter — previously easy to miss when scrolling back.
  const msg = error instanceof Error ? (error.stack ?? error.message) : "unknown error";
  process.stderr.write(`\x1b[1;31m[precompute] fatal: ${msg}\x1b[0m\n`);
  process.exitCode = 1;
});
