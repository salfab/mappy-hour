import fs from "node:fs/promises";
import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  buildRegionTiles,
  loadPrecomputedSunlightManifest,
  loadPrecomputedSunlightTile,
  writePrecomputedSunlightManifest,
  writePrecomputedSunlightTile,
  type PrecomputedRegionName,
  type PrecomputedSunlightManifest,
  type RegionTileSpec,
} from "@/lib/precompute/sunlight-cache";
import { getSunlightModelVersion, SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION } from "@/lib/precompute/model-version";
import { computeSunlightTileArtifact } from "@/lib/precompute/sunlight-tile-service";
import { getSunlightCacheStorage } from "@/lib/precompute/sunlight-cache-storage";
import { CANONICAL_PRECOMPUTE_TILE_SIZE_METERS } from "@/lib/precompute/constants";
import { buildOutlineRingsFromTileIds } from "@/lib/admin/cache-run-outline";
import type {
  CacheRunCanonicalRef,
  CacheRunDetailResponse,
} from "@/lib/admin/cache-run-detail";
import { normalizeShadowCalibration } from "@/lib/sun/shadow-calibration";
import { CACHE_SUNLIGHT_DIR } from "@/lib/storage/data-paths";

export interface CacheAdminFilters {
  region?: PrecomputedRegionName;
  modelVersionHash?: string;
  startDate?: string;
  endDate?: string;
}

export type CacheRunSortField =
  | "date"
  | "generatedAt"
  | "sizeBytes"
  | "tileCount"
  | "failedTileCount"
  | "gridStepMeters"
  | "sampleEveryMinutes";

export interface CacheListOptions {
  sortBy?: CacheRunSortField;
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface CacheRunSummary {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  tileSizeMeters: number;
  tileCount: number;
  failedTileCount: number;
  complete: boolean;
  generatedAt: string;
  runDir: string;
  sizeBytes: number | null;
  fileCount: number | null;
  bbox: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
}

export interface CacheRunsOverview {
  generatedAt: string;
  root: string;
  filters: CacheAdminFilters;
  pagination: {
    page: number;
    pageSize: number;
    totalRuns: number;
    totalPages: number;
    sortBy: CacheRunSortField;
    sortOrder: "asc" | "desc";
  };
  summary: {
    runCount: number;
    totalTiles: number;
    totalFailedTiles: number;
    completeRuns: number;
    totalSizeBytes: number | null;
    totalFiles: number | null;
  };
  runs: CacheRunSummary[];
}

export type CacheRunDetailRequest = CacheRunCanonicalRef;

export interface CacheVerifyResult {
  generatedAt: string;
  root: string;
  filters: CacheAdminFilters;
  manifestsMatched: number;
  tilesVerified: number;
  strictChecks: {
    expectedFrameCountChecks: number;
    expectedMaskSizeChecks: number;
    pointIndexChecks: number;
  };
  problems: string[];
}

export interface CachePurgeResult {
  generatedAt: string;
  root: string;
  filters: CacheAdminFilters;
  dryRun: boolean;
  runsMatched: number;
  removedRunDirs: string[];
  runs: CacheRunSummary[];
}

export interface CachePrecomputeRequest {
  region: PrecomputedRegionName;
  startDate: string;
  days: number;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tileIds?: string[];
  skipExisting?: boolean;
  buildingHeightBiasMeters?: number;
}

export interface CachePrecomputeResult {
  generatedAt: string;
  region: PrecomputedRegionName;
  modelVersionHash: string;
  algorithmVersion: string;
  totalTiles: number;
  totalDates: number;
  params: Omit<CachePrecomputeRequest, "buildingHeightBiasMeters"> & {
    tileSizeMeters: number;
    buildingHeightBiasMeters: number;
  };
  dates: Array<{
    date: string;
    succeededTiles: number;
    skippedTiles: number;
    failedTiles: number;
    complete: boolean;
    elapsedMs: number;
  }>;
}

export interface CachePrecomputeProgress {
  stage: "running" | "finalizing";
  date: string;
  dayIndex: number;
  daysTotal: number;
  tileIndex: number;
  tilesTotal: number;
  completedTiles: number;
  totalTiles: number;
  percent: number;
  currentTileState: "running" | "computed" | "skipped" | "failed";
  currentTilePhase?: "prepare-context" | "prepare-points" | "evaluate-frames" | null;
  currentTileProgressPercent?: number | null;
  currentTilePointCountTotal?: number | null;
  currentTilePointCountOutdoor?: number | null;
  currentTileFrameCountTotal?: number | null;
  currentTileFrameIndex?: number | null;
}

interface WorkerPoolTileTask {
  taskId: string;
  tileIndex: number;
  tile: RegionTileSpec;
}

interface WorkerPoolTaskPayload {
  taskId: string;
  region: PrecomputedRegionName;
  modelVersionHash: string;
  algorithmVersion: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tile: RegionTileSpec;
  shadowCalibration: {
    buildingHeightBiasMeters: number;
  };
  skipExisting: boolean;
}

type WorkerPoolMessage =
  | {
      type: "progress";
      taskId: string;
      stage: "prepare-points" | "evaluate-frames";
      completed: number;
      total: number;
      pointCountTotal: number;
      pointCountOutdoor: number;
      frameCountTotal: number;
      frameIndex: number | null;
    }
  | {
      type: "done";
      taskId: string;
      state: "computed" | "skipped" | "failed" | "cancelled";
      pointCountTotal: number | null;
      pointCountOutdoor: number | null;
      frameCountTotal: number | null;
      error?: string;
    };

interface WorkerPoolRunResult {
  succeededTileIds: string[];
  skippedTileIds: string[];
  failedTileIds: string[];
  completedTiles: number;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function resolvePrecomputeWorkerCount(tileCount: number): number {
  if (tileCount <= 1) {
    return 1;
  }
  if (process.env.NODE_ENV === "test") {
    return 1;
  }
  const fromEnvRaw = process.env.MAPPY_PRECOMPUTE_WORKERS?.trim();
  if (fromEnvRaw) {
    const parsed = Number(fromEnvRaw);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(tileCount, Math.floor(parsed)));
    }
  }
  const cpuCount = os.cpus().length;
  const suggested = Math.min(4, Math.max(2, cpuCount - 1));
  return Math.max(1, Math.min(tileCount, suggested));
}

function getPrecomputeTileWorkerPath(): string {
  return path.join(process.cwd(), "scripts", "precompute", "cache-precompute-tile-worker.ts");
}

async function runDateTilesWithWorkerPool(params: {
  workerCount: number;
  region: PrecomputedRegionName;
  modelVersionHash: string;
  algorithmVersion: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tiles: RegionTileSpec[];
  skipExisting: boolean;
  shadowCalibration: {
    buildingHeightBiasMeters: number;
  };
  dayIndex: number;
  daysTotal: number;
  totalTiles: number;
  completedTiles: number;
  onProgress?: (progress: CachePrecomputeProgress) => void;
  signal?: AbortSignal;
}): Promise<WorkerPoolRunResult> {
  const succeededTileIds: string[] = [];
  const skippedTileIds: string[] = [];
  const failedTileIds: string[] = [];
  const tasks: WorkerPoolTileTask[] = params.tiles.map((tile, tileIndex) => ({
    taskId: `${params.date}:${tile.tileId}:${tileIndex}`,
    tileIndex,
    tile,
  }));
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const runningFractions = new Map<string, number>();
  const workerPath = getPrecomputeTileWorkerPath();
  let completedTiles = params.completedTiles;
  let completedInDay = 0;

  type WorkerSlot = {
    worker: ChildProcess;
    currentTaskId: string | null;
  };

  const workers: WorkerSlot[] = [];
  let nextTask = 0;
  let settled = false;

  const sumRunningFractions = () => {
    let total = 0;
    for (const fraction of runningFractions.values()) {
      total += clampRatio(fraction);
    }
    return total;
  };

  const emitRunningProgress = (task: WorkerPoolTileTask, message: WorkerPoolMessage) => {
    if (!params.onProgress || message.type !== "progress") {
      return;
    }
    const tileFraction =
      message.total <= 0 ? 0 : clampRatio(message.completed / message.total);
    runningFractions.set(task.taskId, tileFraction);
    const totalProgress = completedTiles + sumRunningFractions();
    params.onProgress({
      stage: "running",
      date: params.date,
      dayIndex: params.dayIndex,
      daysTotal: params.daysTotal,
      tileIndex: task.tileIndex + 1,
      tilesTotal: params.tiles.length,
      completedTiles,
      totalTiles: params.totalTiles,
      percent:
        params.totalTiles === 0
          ? 100
          : Math.round((totalProgress / params.totalTiles) * 1000) / 10,
      currentTileState: "running",
      currentTilePhase: message.stage,
      currentTileProgressPercent: Math.round(tileFraction * 1000) / 10,
      currentTilePointCountTotal: message.pointCountTotal,
      currentTilePointCountOutdoor: message.pointCountOutdoor,
      currentTileFrameCountTotal: message.frameCountTotal,
      currentTileFrameIndex: message.frameIndex,
    });
  };

  const emitDoneProgress = (
    task: WorkerPoolTileTask,
    message: Extract<WorkerPoolMessage, { type: "done" }>,
  ) => {
    if (!params.onProgress) {
      return;
    }
    const state = message.state === "cancelled" ? "failed" : message.state;
    params.onProgress({
      stage: "running",
      date: params.date,
      dayIndex: params.dayIndex,
      daysTotal: params.daysTotal,
      tileIndex: task.tileIndex + 1,
      tilesTotal: params.tiles.length,
      completedTiles,
      totalTiles: params.totalTiles,
      percent:
        params.totalTiles === 0
          ? 100
          : Math.round((completedTiles / params.totalTiles) * 1000) / 10,
      currentTileState: state,
      currentTilePhase: null,
      currentTileProgressPercent: 100,
      currentTilePointCountTotal: message.pointCountTotal,
      currentTilePointCountOutdoor: message.pointCountOutdoor,
      currentTileFrameCountTotal: message.frameCountTotal,
      currentTileFrameIndex: message.frameCountTotal,
    });
  };

  const postRunMessage = (slot: WorkerSlot, task: WorkerPoolTileTask) => {
    const payload: WorkerPoolTaskPayload = {
      taskId: task.taskId,
      region: params.region,
      modelVersionHash: params.modelVersionHash,
      algorithmVersion: params.algorithmVersion,
      date: params.date,
      timezone: params.timezone,
      sampleEveryMinutes: params.sampleEveryMinutes,
      gridStepMeters: params.gridStepMeters,
      startLocalTime: params.startLocalTime,
      endLocalTime: params.endLocalTime,
      tile: task.tile,
      shadowCalibration: params.shadowCalibration,
      skipExisting: params.skipExisting,
    };
    slot.currentTaskId = task.taskId;
    slot.worker.send?.({
      type: "run",
      task: payload,
    });
    params.onProgress?.({
      stage: "running",
      date: params.date,
      dayIndex: params.dayIndex,
      daysTotal: params.daysTotal,
      tileIndex: task.tileIndex + 1,
      tilesTotal: params.tiles.length,
      completedTiles,
      totalTiles: params.totalTiles,
      percent:
        params.totalTiles === 0
          ? 100
          : Math.round(((completedTiles + sumRunningFractions()) / params.totalTiles) * 1000) / 10,
      currentTileState: "running",
      currentTilePhase: "prepare-context",
      currentTileProgressPercent: 0,
      currentTilePointCountTotal: null,
      currentTilePointCountOutdoor: null,
      currentTileFrameCountTotal: null,
      currentTileFrameIndex: null,
    });
  };

  const terminateWorkers = async () => {
    await Promise.all(
      workers.map(async (slot) => {
        try {
          const worker = slot.worker;
          if (worker.exitCode !== null || worker.killed) {
            return;
          }
          await new Promise<void>((resolve) => {
            const onExit = () => resolve();
            worker.once("exit", onExit);
            worker.kill("SIGTERM");
            setTimeout(() => {
              try {
                worker.kill("SIGKILL");
              } catch {
                // Ignore hard-stop failures.
              }
              resolve();
            }, 1000);
          });
        } catch {
          // Ignore worker shutdown failures.
        }
      }),
    );
  };

  const runPromise = new Promise<void>((resolve, reject) => {
    const dispatch = (slot: WorkerSlot) => {
      if (settled) {
        return;
      }
      if (params.signal?.aborted) {
        settled = true;
        reject(new Error("Precompute aborted."));
        return;
      }
      if (nextTask >= tasks.length) {
        slot.currentTaskId = null;
        if (completedInDay >= tasks.length) {
          settled = true;
          resolve();
        }
        return;
      }
      const task = tasks[nextTask];
      nextTask += 1;
      postRunMessage(slot, task);
    };

    const handleWorkerFailure = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    for (let workerIndex = 0; workerIndex < params.workerCount; workerIndex += 1) {
      const worker = fork(workerPath, [], {
        execArgv: ["--import", "tsx"],
        env: {
          ...process.env,
          NODE_OPTIONS: "",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const slot: WorkerSlot = {
        worker,
        currentTaskId: null,
      };
      workers.push(slot);

      worker.on("message", (message: WorkerPoolMessage) => {
        if (settled) {
          return;
        }
        const task = taskById.get(message.taskId);
        if (!task) {
          return;
        }

        if (message.type === "progress") {
          emitRunningProgress(task, message);
          return;
        }

        runningFractions.delete(task.taskId);
        slot.currentTaskId = null;
        completedTiles += 1;
        completedInDay += 1;

        if (message.state === "skipped") {
          skippedTileIds.push(task.tile.tileId);
          succeededTileIds.push(task.tile.tileId);
        } else if (message.state === "computed") {
          succeededTileIds.push(task.tile.tileId);
        } else if (message.state === "failed") {
          failedTileIds.push(task.tile.tileId);
        } else if (message.state === "cancelled") {
          if (params.signal?.aborted) {
            if (!settled) {
              settled = true;
              reject(new Error("Precompute aborted."));
            }
            return;
          }
          failedTileIds.push(task.tile.tileId);
        }

        emitDoneProgress(task, message);
        dispatch(slot);
      });

      worker.on("error", (error) => {
        handleWorkerFailure(
          new Error(
            `Precompute worker failed: ${error instanceof Error ? error.message : "unknown error"}`,
          ),
        );
      });

      worker.on("exit", (code) => {
        if (settled) {
          return;
        }
        if (code !== 0 && slot.currentTaskId) {
          const task = taskById.get(slot.currentTaskId);
          handleWorkerFailure(
            new Error(
              `Precompute worker exited with code ${code} while processing ${task?.tile.tileId ?? "unknown tile"}.`,
            ),
          );
        }
      });
    }

    for (const slot of workers) {
      dispatch(slot);
    }
  });

  const abortHandler = () => {
    for (const slot of workers) {
      slot.worker.send?.({
        type: "cancel",
      });
    }
  };

  params.signal?.addEventListener("abort", abortHandler);

  try {
    await runPromise;
    return {
      succeededTileIds,
      skippedTileIds,
      failedTileIds,
      completedTiles,
    };
  } finally {
    params.signal?.removeEventListener("abort", abortHandler);
    await terminateWorkers();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Precompute aborted.");
  }
}

function dateInRange(date: string, startDate?: string, endDate?: string): boolean {
  if (startDate && date < startDate) {
    return false;
  }
  if (endDate && date > endDate) {
    return false;
  }
  return true;
}

function addDays(dateInput: string, days: number): string {
  const date = new Date(`${dateInput}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date input: ${dateInput}`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function manifestMatches(
  manifest: PrecomputedSunlightManifest,
  filters: CacheAdminFilters,
): boolean {
  if (filters.region && manifest.region !== filters.region) {
    return false;
  }
  if (
    filters.modelVersionHash &&
    manifest.modelVersionHash !== filters.modelVersionHash
  ) {
    return false;
  }
  return dateInRange(manifest.date, filters.startDate, filters.endDate);
}

async function findManifestFiles(rootPath: string): Promise<string[]> {
  const storage = getSunlightCacheStorage();
  const files = await storage.listFiles(rootPath);
  return files.filter((filePath) => path.basename(filePath) === "manifest.json");
}

async function loadManifestFromPath(
  filePath: string,
): Promise<PrecomputedSunlightManifest | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as PrecomputedSunlightManifest;
  } catch {
    return null;
  }
}

function getRunDir(manifest: PrecomputedSunlightManifest): string {
  return path.dirname(
    path.join(
      CACHE_SUNLIGHT_DIR,
      manifest.region,
      manifest.modelVersionHash,
      `g${manifest.gridStepMeters}`,
      `m${manifest.sampleEveryMinutes}`,
      manifest.date,
      `t${manifest.startLocalTime.replace(":", "")}-${manifest.endLocalTime.replace(":", "")}`,
      "manifest.json",
    ),
  );
}

async function computeRunStorageStats(
  runDir: string,
): Promise<{ sizeBytes: number; fileCount: number }> {
  const storage = getSunlightCacheStorage();
  const files = await storage.listFiles(runDir);
  if (files.length === 0) {
    return {
      sizeBytes: 0,
      fileCount: 0,
    };
  }

  const stats = await Promise.all(
    files.map(async (filePath) => {
      const fileStat = await fs.stat(filePath);
      return fileStat.size;
    }),
  );

  return {
    sizeBytes: stats.reduce((total, size) => total + size, 0),
    fileCount: files.length,
  };
}

function compareRuns(
  left: CacheRunSummary,
  right: CacheRunSummary,
  sortBy: CacheRunSortField,
): number {
  if (sortBy === "date") {
    return `${left.date}|${left.region}|${left.modelVersionHash}`.localeCompare(
      `${right.date}|${right.region}|${right.modelVersionHash}`,
    );
  }
  if (sortBy === "generatedAt") {
    return left.generatedAt.localeCompare(right.generatedAt);
  }
  if (sortBy === "sizeBytes") {
    return (left.sizeBytes ?? -1) - (right.sizeBytes ?? -1);
  }
  if (sortBy === "tileCount") {
    return left.tileCount - right.tileCount;
  }
  if (sortBy === "failedTileCount") {
    return left.failedTileCount - right.failedTileCount;
  }
  if (sortBy === "gridStepMeters") {
    return left.gridStepMeters - right.gridStepMeters;
  }
  return left.sampleEveryMinutes - right.sampleEveryMinutes;
}

async function listMatchingManifests(
  filters: CacheAdminFilters,
): Promise<PrecomputedSunlightManifest[]> {
  const manifestFiles = await findManifestFiles(CACHE_SUNLIGHT_DIR);
  const manifests = (
    await Promise.all(manifestFiles.map((filePath) => loadManifestFromPath(filePath)))
  ).filter((manifest): manifest is PrecomputedSunlightManifest => manifest !== null);

  return manifests
    .filter((manifest) => manifestMatches(manifest, filters))
    .sort((left, right) =>
      [
        left.region,
        left.date,
        left.startLocalTime,
        left.endLocalTime,
        left.gridStepMeters,
        left.sampleEveryMinutes,
        left.modelVersionHash,
      ]
        .join("|")
        .localeCompare(
          [
            right.region,
            right.date,
            right.startLocalTime,
            right.endLocalTime,
            right.gridStepMeters,
            right.sampleEveryMinutes,
            right.modelVersionHash,
          ].join("|"),
        ),
    );
}

function toRunSummary(
  manifest: PrecomputedSunlightManifest,
): CacheRunSummary {
  const runDir = getRunDir(manifest);

  return {
    region: manifest.region,
    modelVersionHash: manifest.modelVersionHash,
    date: manifest.date,
    timezone: manifest.timezone,
    gridStepMeters: manifest.gridStepMeters,
    sampleEveryMinutes: manifest.sampleEveryMinutes,
    startLocalTime: manifest.startLocalTime,
    endLocalTime: manifest.endLocalTime,
    tileSizeMeters: manifest.tileSizeMeters,
    tileCount: manifest.tileIds.length,
    failedTileCount: manifest.failedTileIds.length,
    complete: manifest.complete,
    generatedAt: manifest.generatedAt,
    runDir,
    sizeBytes: null,
    fileCount: null,
    bbox: manifest.bbox,
  };
}

export async function getCacheRunDetail(
  request: CacheRunDetailRequest,
): Promise<CacheRunDetailResponse | null> {
  const manifest = await loadPrecomputedSunlightManifest({
    region: request.region,
    modelVersionHash: request.modelVersionHash,
    date: request.date,
    gridStepMeters: request.gridStepMeters,
    sampleEveryMinutes: request.sampleEveryMinutes,
    startLocalTime: request.startLocalTime,
    endLocalTime: request.endLocalTime,
  });
  if (!manifest) {
    return null;
  }

  const run = toRunSummary(manifest);
  const outlineRings = buildOutlineRingsFromTileIds(manifest.tileIds);
  const fallbackBboxRing: Array<[number, number]> = [
    [manifest.bbox.minLat, manifest.bbox.minLon],
    [manifest.bbox.minLat, manifest.bbox.maxLon],
    [manifest.bbox.maxLat, manifest.bbox.maxLon],
    [manifest.bbox.maxLat, manifest.bbox.minLon],
    [manifest.bbox.minLat, manifest.bbox.minLon],
  ];

  return {
    run: {
      region: run.region,
      modelVersionHash: run.modelVersionHash,
      date: run.date,
      timezone: run.timezone,
      gridStepMeters: run.gridStepMeters,
      sampleEveryMinutes: run.sampleEveryMinutes,
      startLocalTime: run.startLocalTime,
      endLocalTime: run.endLocalTime,
      tileSizeMeters: run.tileSizeMeters,
      tileCount: run.tileCount,
      failedTileCount: run.failedTileCount,
      complete: run.complete,
      generatedAt: run.generatedAt,
    },
    bbox: manifest.bbox,
    outlineRings: outlineRings.length > 0 ? outlineRings : [fallbackBboxRing],
  };
}

async function withStorageStats(run: CacheRunSummary): Promise<CacheRunSummary> {
  const storageStats = await computeRunStorageStats(run.runDir);
  return {
    ...run,
    sizeBytes: storageStats.sizeBytes,
    fileCount: storageStats.fileCount,
  };
}

export async function listCacheRuns(
  filters: CacheAdminFilters = {},
  options: CacheListOptions = {},
): Promise<CacheRunsOverview> {
  const manifests = await listMatchingManifests(filters);
  const allRuns = manifests.map((manifest) => toRunSummary(manifest));

  const sortBy = options.sortBy ?? "date";
  const sortOrder = options.sortOrder ?? "desc";
  const pageSize = Math.min(Math.max(options.pageSize ?? 25, 1), 200);
  const page = Math.max(options.page ?? 1, 1);
  const totalRuns = allRuns.length;
  const totalPages = Math.max(1, Math.ceil(totalRuns / pageSize));
  const boundedPage = Math.min(page, totalPages);

  const sortedRuns = [...allRuns].sort((left, right) => {
    const result = compareRuns(left, right, sortBy);
    return sortOrder === "asc" ? result : -result;
  });
  const startIndex = (boundedPage - 1) * pageSize;
  const runs = await Promise.all(
    sortedRuns.slice(startIndex, startIndex + pageSize).map(withStorageStats),
  );

  return {
    generatedAt: new Date().toISOString(),
    root: CACHE_SUNLIGHT_DIR,
    filters,
    pagination: {
      page: boundedPage,
      pageSize,
      totalRuns,
      totalPages,
      sortBy,
      sortOrder,
    },
    summary: {
      runCount: allRuns.length,
      totalTiles: allRuns.reduce((total, run) => total + run.tileCount, 0),
      totalFailedTiles: allRuns.reduce(
        (total, run) => total + run.failedTileCount,
        0,
      ),
      completeRuns: allRuns.filter((run) => run.complete).length,
      totalSizeBytes: null,
      totalFiles: null,
    },
    runs,
  };
}

function expectedMaskByteLength(pointCount: number): number {
  return Math.ceil(pointCount / 8);
}

export async function verifyCacheRuns(
  filters: CacheAdminFilters = {},
): Promise<CacheVerifyResult> {
  const manifests = await listMatchingManifests(filters);
  const problems: string[] = [];
  let tilesVerified = 0;
  let expectedFrameCountChecks = 0;
  let expectedMaskSizeChecks = 0;
  let pointIndexChecks = 0;

  for (const manifest of manifests) {
    if (manifest.artifactFormatVersion !== SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION) {
      problems.push(
        `Manifest ${manifest.region}/${manifest.date} uses format ${manifest.artifactFormatVersion}, expected ${SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION}.`,
      );
      continue;
    }

    for (const tileId of manifest.tileIds) {
      const tile = await loadPrecomputedSunlightTile({
        region: manifest.region,
        modelVersionHash: manifest.modelVersionHash,
        date: manifest.date,
        gridStepMeters: manifest.gridStepMeters,
        sampleEveryMinutes: manifest.sampleEveryMinutes,
        startLocalTime: manifest.startLocalTime,
        endLocalTime: manifest.endLocalTime,
        tileId,
      });
      if (!tile) {
        problems.push(
          `Missing or incompatible tile ${tileId} for ${manifest.region}/${manifest.date}/${manifest.modelVersionHash}.`,
        );
        continue;
      }
      if (tile.tile.tileId !== tileId) {
        problems.push(
          `Tile id mismatch: manifest expected ${tileId}, artifact contains ${tile.tile.tileId}.`,
        );
      }
      if (tile.modelVersionHash !== manifest.modelVersionHash) {
        problems.push(
          `Tile ${tileId} has model version ${tile.modelVersionHash}, expected ${manifest.modelVersionHash}.`,
        );
      }
      if (tile.artifactFormatVersion !== manifest.artifactFormatVersion) {
        problems.push(
          `Tile ${tileId} has format ${tile.artifactFormatVersion}, expected ${manifest.artifactFormatVersion}.`,
        );
      }
      if (tile.frames.length === 0) {
        problems.push(`Tile ${tileId} has no frames.`);
      }

      const expectedFrames = tile.frames.length;
      expectedFrameCountChecks += 1;
      const outdoorPointCount = tile.points.filter((point) => point.outdoorIndex !== null).length;

      for (const frame of tile.frames) {
        if (frame.index < 0 || frame.index >= expectedFrames) {
          problems.push(
            `Tile ${tileId} frame index ${frame.index} is out of range [0, ${expectedFrames - 1}].`,
          );
        }

        const expectedMaskSize = expectedMaskByteLength(outdoorPointCount);
        const maskEntries: Array<{ name: string; base64: string }> = [
          { name: "sunMaskBase64", base64: frame.sunMaskBase64 },
          { name: "sunMaskNoVegetationBase64", base64: frame.sunMaskNoVegetationBase64 },
          { name: "terrainBlockedMaskBase64", base64: frame.terrainBlockedMaskBase64 },
          { name: "buildingsBlockedMaskBase64", base64: frame.buildingsBlockedMaskBase64 },
          { name: "vegetationBlockedMaskBase64", base64: frame.vegetationBlockedMaskBase64 },
        ];

        for (const maskEntry of maskEntries) {
          expectedMaskSizeChecks += 1;
          const byteLength = Buffer.from(maskEntry.base64, "base64").length;
          if (byteLength !== expectedMaskSize) {
            problems.push(
              `Tile ${tileId} frame ${frame.index} ${maskEntry.name} byteLength=${byteLength}, expected=${expectedMaskSize}.`,
            );
          }
        }

        if (frame.diagnostics.horizonAngleDegByPoint.length !== outdoorPointCount) {
          problems.push(
            `Tile ${tileId} frame ${frame.index} horizon diagnostics length mismatch (${frame.diagnostics.horizonAngleDegByPoint.length} vs ${outdoorPointCount}).`,
          );
        }
        if (frame.diagnostics.buildingBlockerIdByPoint.length !== outdoorPointCount) {
          problems.push(
            `Tile ${tileId} frame ${frame.index} building blocker id length mismatch (${frame.diagnostics.buildingBlockerIdByPoint.length} vs ${outdoorPointCount}).`,
          );
        }
      }

      const seenOutdoorIndexes = new Set<number>();
      for (const point of tile.points) {
        if (point.outdoorIndex === null) {
          continue;
        }
        pointIndexChecks += 1;
        if (point.outdoorIndex < 0 || point.outdoorIndex >= outdoorPointCount) {
          problems.push(
            `Tile ${tileId} has outdoorIndex ${point.outdoorIndex} outside [0, ${outdoorPointCount - 1}].`,
          );
        }
        if (seenOutdoorIndexes.has(point.outdoorIndex)) {
          problems.push(
            `Tile ${tileId} has duplicated outdoorIndex ${point.outdoorIndex}.`,
          );
        }
        seenOutdoorIndexes.add(point.outdoorIndex);
      }
      if (seenOutdoorIndexes.size !== outdoorPointCount) {
        problems.push(
          `Tile ${tileId} outdoor index cardinality mismatch (${seenOutdoorIndexes.size} vs ${outdoorPointCount}).`,
        );
      }

      tilesVerified += 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    root: CACHE_SUNLIGHT_DIR,
    filters,
    manifestsMatched: manifests.length,
    tilesVerified,
    strictChecks: {
      expectedFrameCountChecks,
      expectedMaskSizeChecks,
      pointIndexChecks,
    },
    problems,
  };
}

export async function purgeCacheRuns(
  filters: CacheAdminFilters = {},
  options: { dryRun?: boolean } = {},
): Promise<CachePurgeResult> {
  const manifests = await listMatchingManifests(filters);
  const runs = manifests.map((manifest) => toRunSummary(manifest));
  const removedRunDirs: string[] = [];

  if (!options.dryRun) {
    const storage = getSunlightCacheStorage();
    for (const run of runs) {
      await storage.removePrefix(run.runDir);
      removedRunDirs.push(run.runDir);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    root: CACHE_SUNLIGHT_DIR,
    filters,
    dryRun: options.dryRun ?? false,
    runsMatched: runs.length,
    removedRunDirs,
    runs,
  };
}

export async function precomputeCacheRuns(
  request: CachePrecomputeRequest,
  options: {
    onProgress?: (progress: CachePrecomputeProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<CachePrecomputeResult> {
  const tileSizeMeters = CANONICAL_PRECOMPUTE_TILE_SIZE_METERS;
  const shadowCalibration = normalizeShadowCalibration({
    buildingHeightBiasMeters: request.buildingHeightBiasMeters,
  });
  const modelVersion = await getSunlightModelVersion(request.region, shadowCalibration);
  const skipExisting = request.skipExisting ?? true;
  const allRegionTiles = buildRegionTiles(request.region, tileSizeMeters);
  const tiles = (() => {
    const selected = request.tileIds;
    if (!selected || selected.length === 0) {
      return allRegionTiles;
    }
    const selectedSet = new Set(selected);
    const tileById = new Map(allRegionTiles.map((tile) => [tile.tileId, tile]));
    const unknownTileIds = selected.filter((tileId) => !tileById.has(tileId));
    if (unknownTileIds.length > 0) {
      throw new Error(
        `Unknown tile ids for region ${request.region}: ${unknownTileIds.slice(0, 10).join(", ")}${unknownTileIds.length > 10 ? "..." : ""}`,
      );
    }
    return allRegionTiles.filter((tile) => selectedSet.has(tile.tileId));
  })();
  if (tiles.length === 0) {
    throw new Error("No tiles selected for precompute.");
  }
  const dates: CachePrecomputeResult["dates"] = [];
  const totalTiles = tiles.length * request.days;
  let completedTiles = 0;
  const workerCount = resolvePrecomputeWorkerCount(tiles.length);
  const strictMultithread = process.env.MAPPY_PRECOMPUTE_WORKERS_STRICT === "1";

  for (let dayOffset = 0; dayOffset < request.days; dayOffset += 1) {
    throwIfAborted(options.signal);
    const date = addDays(request.startDate, dayOffset);
    const startedAt = performance.now();
    const succeededTileIds: string[] = [];
    const failedTileIds: string[] = [];
    const skippedTileIds: string[] = [];
    const runSequentialTiles = async () => {
      for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
        throwIfAborted(options.signal);
        const tile = tiles[tileIndex];
        options.onProgress?.({
          stage: "running",
          date,
          dayIndex: dayOffset + 1,
          daysTotal: request.days,
          tileIndex: tileIndex + 1,
          tilesTotal: tiles.length,
          completedTiles,
          totalTiles,
          percent:
            totalTiles === 0
              ? 100
              : Math.round((completedTiles / totalTiles) * 10000) / 100,
          currentTileState: "running",
          currentTilePhase: "prepare-context",
          currentTileProgressPercent: 0,
          currentTilePointCountTotal: null,
          currentTilePointCountOutdoor: null,
          currentTileFrameCountTotal: null,
          currentTileFrameIndex: null,
        });

        if (skipExisting) {
          throwIfAborted(options.signal);
          const existing = await loadPrecomputedSunlightTile({
            region: request.region,
            modelVersionHash: modelVersion.modelVersionHash,
            date,
            gridStepMeters: request.gridStepMeters,
            sampleEveryMinutes: request.sampleEveryMinutes,
            startLocalTime: request.startLocalTime,
            endLocalTime: request.endLocalTime,
            tileId: tile.tileId,
          });
          if (existing) {
            skippedTileIds.push(tile.tileId);
            succeededTileIds.push(tile.tileId);
            completedTiles += 1;
            options.onProgress?.({
              stage: "running",
              date,
              dayIndex: dayOffset + 1,
              daysTotal: request.days,
              tileIndex: tileIndex + 1,
              tilesTotal: tiles.length,
              completedTiles,
              totalTiles,
              percent:
                totalTiles === 0
                  ? 100
                  : Math.round((completedTiles / totalTiles) * 1000) / 10,
              currentTileState: "skipped",
              currentTilePhase: null,
              currentTileProgressPercent: 100,
              currentTilePointCountTotal: existing.stats.gridPointCount,
              currentTilePointCountOutdoor: existing.stats.pointCount,
              currentTileFrameCountTotal: existing.frames.length,
              currentTileFrameIndex: existing.frames.length,
            });
            continue;
          }
        }
        try {
          const artifact = await computeSunlightTileArtifact({
            region: request.region,
            modelVersionHash: modelVersion.modelVersionHash,
            algorithmVersion: modelVersion.algorithmVersion,
            date,
            timezone: request.timezone,
            sampleEveryMinutes: request.sampleEveryMinutes,
            gridStepMeters: request.gridStepMeters,
            startLocalTime: request.startLocalTime,
            endLocalTime: request.endLocalTime,
            tile,
            shadowCalibration,
            cooperativeYieldEveryPoints: 50,
            signal: options.signal,
            onProgress: (tileProgress) => {
              const tileFraction =
                tileProgress.total <= 0
                  ? 0
                  : Math.max(
                      0,
                      Math.min(1, tileProgress.completed / tileProgress.total),
                    );
              const totalProgress = completedTiles + tileFraction;
              options.onProgress?.({
                stage: "running",
                date,
                dayIndex: dayOffset + 1,
                daysTotal: request.days,
                tileIndex: tileIndex + 1,
                tilesTotal: tiles.length,
                completedTiles,
                totalTiles,
                percent:
                  totalTiles === 0
                    ? 100
                    : Math.round((totalProgress / totalTiles) * 1000) / 10,
                currentTileState: "running",
                currentTilePhase: tileProgress.stage,
                currentTileProgressPercent: Math.round(tileFraction * 1000) / 10,
                currentTilePointCountTotal: tileProgress.pointCountTotal,
                currentTilePointCountOutdoor: tileProgress.pointCountOutdoor,
                currentTileFrameCountTotal: tileProgress.frameCountTotal,
                currentTileFrameIndex: tileProgress.frameIndex,
              });
            },
          });
          await writePrecomputedSunlightTile(artifact);
          succeededTileIds.push(tile.tileId);
          completedTiles += 1;
          options.onProgress?.({
            stage: "running",
            date,
            dayIndex: dayOffset + 1,
            daysTotal: request.days,
            tileIndex: tileIndex + 1,
            tilesTotal: tiles.length,
            completedTiles,
            totalTiles,
            percent:
              totalTiles === 0
                ? 100
                : Math.round((completedTiles / totalTiles) * 1000) / 10,
            currentTileState: "computed",
            currentTilePhase: null,
            currentTileProgressPercent: 100,
            currentTilePointCountTotal: artifact.stats.gridPointCount,
            currentTilePointCountOutdoor: artifact.stats.pointCount,
            currentTileFrameCountTotal: artifact.frames.length,
            currentTileFrameIndex: artifact.frames.length,
          });
        } catch (error) {
          if (options.signal?.aborted) {
            throw error;
          }
          failedTileIds.push(tile.tileId);
          completedTiles += 1;
          options.onProgress?.({
            stage: "running",
            date,
            dayIndex: dayOffset + 1,
            daysTotal: request.days,
            tileIndex: tileIndex + 1,
            tilesTotal: tiles.length,
            completedTiles,
            totalTiles,
            percent:
              totalTiles === 0
                ? 100
                : Math.round((completedTiles / totalTiles) * 1000) / 10,
            currentTileState: "failed",
            currentTilePhase: null,
            currentTileProgressPercent: 100,
            currentTilePointCountTotal: null,
            currentTilePointCountOutdoor: null,
            currentTileFrameCountTotal: null,
            currentTileFrameIndex: null,
          });
        }
      }
    };

    let usedWorkerPool = false;
    if (workerCount > 1) {
      try {
        const workerResult = await runDateTilesWithWorkerPool({
          workerCount,
          region: request.region,
          modelVersionHash: modelVersion.modelVersionHash,
          algorithmVersion: modelVersion.algorithmVersion,
          date,
          timezone: request.timezone,
          sampleEveryMinutes: request.sampleEveryMinutes,
          gridStepMeters: request.gridStepMeters,
          startLocalTime: request.startLocalTime,
          endLocalTime: request.endLocalTime,
          tiles,
          skipExisting,
          shadowCalibration: {
            buildingHeightBiasMeters: shadowCalibration.buildingHeightBiasMeters,
          },
          dayIndex: dayOffset + 1,
          daysTotal: request.days,
          totalTiles,
          completedTiles,
          onProgress: options.onProgress,
          signal: options.signal,
        });
        succeededTileIds.push(...workerResult.succeededTileIds);
        skippedTileIds.push(...workerResult.skippedTileIds);
        failedTileIds.push(...workerResult.failedTileIds);
        completedTiles = workerResult.completedTiles;
        usedWorkerPool = true;
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        if (strictMultithread) {
          throw error;
        }
        console.warn("[cache-admin] worker pool unavailable, falling back to sequential mode", {
          date,
          workerCount,
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
    }

    if (!usedWorkerPool) {
      await runSequentialTiles();
    }

    const manifest: PrecomputedSunlightManifest = {
      artifactFormatVersion: modelVersion.artifactFormatVersion,
      region: request.region,
      modelVersionHash: modelVersion.modelVersionHash,
      date,
      timezone: request.timezone,
      gridStepMeters: request.gridStepMeters,
      sampleEveryMinutes: request.sampleEveryMinutes,
      startLocalTime: request.startLocalTime,
      endLocalTime: request.endLocalTime,
      tileSizeMeters,
      tileIds: succeededTileIds.sort(),
      failedTileIds: failedTileIds.sort(),
      bbox: {
        minLon: Math.min(...tiles.map((tile) => tile.bbox.minLon)),
        minLat: Math.min(...tiles.map((tile) => tile.bbox.minLat)),
        maxLon: Math.max(...tiles.map((tile) => tile.bbox.maxLon)),
        maxLat: Math.max(...tiles.map((tile) => tile.bbox.maxLat)),
      },
      generatedAt: new Date().toISOString(),
      complete: failedTileIds.length === 0 && succeededTileIds.length === tiles.length,
    };

    await writePrecomputedSunlightManifest(manifest);
    options.onProgress?.({
      stage: "finalizing",
      date,
      dayIndex: dayOffset + 1,
      daysTotal: request.days,
      tileIndex: tiles.length,
      tilesTotal: tiles.length,
      completedTiles,
      totalTiles,
      percent:
        totalTiles === 0 ? 100 : Math.round((completedTiles / totalTiles) * 1000) / 10,
      currentTileState: "computed",
      currentTilePhase: null,
      currentTileProgressPercent: 100,
      currentTilePointCountTotal: null,
      currentTilePointCountOutdoor: null,
      currentTileFrameCountTotal: null,
      currentTileFrameIndex: null,
    });
    dates.push({
        date,
        succeededTiles: succeededTileIds.length,
        skippedTiles: skippedTileIds.length,
        failedTiles: failedTileIds.length,
        complete: manifest.complete,
        elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    region: request.region,
    modelVersionHash: modelVersion.modelVersionHash,
    algorithmVersion: modelVersion.algorithmVersion,
    totalTiles: tiles.length,
    totalDates: request.days,
    params: {
      region: request.region,
      startDate: request.startDate,
      days: request.days,
      timezone: request.timezone,
      sampleEveryMinutes: request.sampleEveryMinutes,
      gridStepMeters: request.gridStepMeters,
      tileSizeMeters,
      startLocalTime: request.startLocalTime,
      endLocalTime: request.endLocalTime,
      skipExisting,
      buildingHeightBiasMeters: shadowCalibration.buildingHeightBiasMeters,
    },
    dates,
  };
}
