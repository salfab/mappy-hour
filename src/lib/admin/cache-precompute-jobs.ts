import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  precomputeCacheRuns,
  type CachePrecomputeProgress,
  type CachePrecomputeRequest,
  type CachePrecomputeResult,
} from "@/lib/admin/cache-admin";
import { getSunlightModelVersion } from "@/lib/precompute/model-version";
import { getSunlightCacheStorage } from "@/lib/precompute/sunlight-cache-storage";
import { CACHE_SUNLIGHT_DIR } from "@/lib/storage/data-paths";
import { normalizeShadowCalibration } from "@/lib/sun/shadow-calibration";

export type CachePrecomputeJobStatus =
  | "queued"
  | "running"
  | "cancelled"
  | "interrupted"
  | "completed"
  | "failed";

export interface CachePrecomputeJob {
  jobId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  startedAt: string | null;
  endedAt: string | null;
  status: CachePrecomputeJobStatus;
  request: CachePrecomputeRequest;
  progress: (CachePrecomputeProgress & { elapsedMs: number; etaSeconds: number | null }) | null;
  result: CachePrecomputeResult | null;
  error: string | null;
}

export interface RejectCachePrecomputeJobResult {
  jobId: string;
  modelVersionHash: string;
  removedModelVersionHashes: string[];
  removedRunDirs: string[];
  removedSnapshot: boolean;
}

const jobs = new Map<string, CachePrecomputeJob>();
const jobAbortControllers = new Map<string, AbortController>();
const MAX_JOBS_IN_MEMORY = 40;
const JOBS_SNAPSHOT_DIR = path.join(CACHE_SUNLIGHT_DIR, "_admin-jobs");
const DISK_PERSIST_INTERVAL_MS = 1000;
const lastPersistedAtMs = new Map<string, number>();
const PROGRESS_LOG_INTERVAL_MS = 15_000;
const JOB_LIVENESS_GRACE_MS = 12_000;
const JOB_CANCEL_POLL_INTERVAL_MS = 1000;

function isJobTerminal(status: CachePrecomputeJobStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function normalizeRecoveredSnapshot(job: CachePrecomputeJob): CachePrecomputeJob {
  if (!jobs.has(job.jobId) && (job.status === "queued" || job.status === "running")) {
    const updatedAtMs = Date.parse(job.updatedAt);
    const looksAlive =
      Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= JOB_LIVENESS_GRACE_MS;
    if (looksAlive) {
      return job;
    }
    const recovered: CachePrecomputeJob = {
      ...job,
      revision: (job.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      status: "interrupted",
      endedAt: job.endedAt ?? new Date().toISOString(),
      error:
        job.error ??
        "Job interrompu (redémarrage serveur ou process stoppé). Reprendre pour continuer avec le cache existant.",
    };
    persistJobSnapshot(recovered, { force: true });
    return recovered;
  }
  return job;
}

function touchJob(job: CachePrecomputeJob): void {
  job.revision += 1;
  job.updatedAt = new Date().toISOString();
  persistJobSnapshot(job, { force: false });
}

function ensureSnapshotDir(): void {
  fs.mkdirSync(JOBS_SNAPSHOT_DIR, { recursive: true });
}

function jobSnapshotPath(jobId: string): string {
  return path.join(JOBS_SNAPSHOT_DIR, `${jobId}.json`);
}

function addDays(dateInput: string, days: number): string {
  const date = new Date(`${dateInput}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date input: ${dateInput}`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getRunDirForRequest(params: {
  region: CachePrecomputeRequest["region"];
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}): string {
  return path.join(
    CACHE_SUNLIGHT_DIR,
    params.region,
    params.modelVersionHash,
    `g${params.gridStepMeters}`,
    `m${params.sampleEveryMinutes}`,
    params.date,
    `t${params.startLocalTime.replace(":", "")}-${params.endLocalTime.replace(":", "")}`,
  );
}

function jobCancelMarkerPath(jobId: string): string {
  return path.join(JOBS_SNAPSHOT_DIR, `${jobId}.cancel`);
}

function hasCancelMarker(jobId: string): boolean {
  try {
    return fs.existsSync(jobCancelMarkerPath(jobId));
  } catch {
    return false;
  }
}

function writeCancelMarker(jobId: string): void {
  try {
    ensureSnapshotDir();
    fs.writeFileSync(jobCancelMarkerPath(jobId), new Date().toISOString(), "utf8");
  } catch {
    // Best effort.
  }
}

function clearCancelMarker(jobId: string): void {
  try {
    fs.unlinkSync(jobCancelMarkerPath(jobId));
  } catch {
    // Already removed.
  }
}

function persistJobSnapshot(
  job: CachePrecomputeJob,
  options: { force: boolean },
): void {
  const now = Date.now();
  const last = lastPersistedAtMs.get(job.jobId) ?? 0;
  if (!options.force && now - last < DISK_PERSIST_INTERVAL_MS) {
    return;
  }

  try {
    ensureSnapshotDir();
    fs.writeFileSync(jobSnapshotPath(job.jobId), JSON.stringify(job), "utf8");
    lastPersistedAtMs.set(job.jobId, now);
  } catch {
    // Best effort only; in-memory state remains source of truth.
  }
}

function loadJobSnapshot(jobId: string): CachePrecomputeJob | null {
  try {
    const raw = fs.readFileSync(jobSnapshotPath(jobId), "utf8");
    const parsed = JSON.parse(raw) as CachePrecomputeJob;
    return parsed;
  } catch {
    return null;
  }
}

function listJobSnapshots(): CachePrecomputeJob[] {
  try {
    const entries = fs.readdirSync(JOBS_SNAPSHOT_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => loadJobSnapshot(entry.name.replace(/\.json$/i, "")))
      .filter((job): job is CachePrecomputeJob => job !== null);
  } catch {
    return [];
  }
}

function evictFinishedJobs(): void {
  if (jobs.size <= MAX_JOBS_IN_MEMORY) {
    return;
  }
  const finished = [...jobs.values()]
    .filter((job) => isJobTerminal(job.status))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  while (jobs.size > MAX_JOBS_IN_MEMORY && finished.length > 0) {
    const next = finished.shift();
    if (!next) {
      break;
    }
    jobs.delete(next.jobId);
  }
}

export function getCachePrecomputeJob(jobId: string): CachePrecomputeJob | null {
  const inMemory = jobs.get(jobId);
  if (inMemory) {
    return inMemory;
  }
  const snapshot = loadJobSnapshot(jobId);
  if (!snapshot) {
    return null;
  }
  return normalizeRecoveredSnapshot(snapshot);
}

export function listCachePrecomputeJobs(): CachePrecomputeJob[] {
  const merged = new Map<string, CachePrecomputeJob>();
  for (const job of listJobSnapshots()) {
    merged.set(job.jobId, normalizeRecoveredSnapshot(job));
  }
  for (const job of jobs.values()) {
    merged.set(job.jobId, job);
  }
  return [...merged.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export function isCachePrecomputeJobExecuting(jobId: string): boolean {
  return jobAbortControllers.has(jobId);
}

function updateSnapshotOnlyJob(job: CachePrecomputeJob): CachePrecomputeJob {
  const snapshot = {
    ...job,
    revision: (job.revision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  persistJobSnapshot(snapshot, { force: true });
  return snapshot;
}

export function cancelCachePrecomputeJob(jobId: string): CachePrecomputeJob | null {
  const inMemory = jobs.get(jobId);
  if (inMemory) {
    if (isJobTerminal(inMemory.status)) {
      return inMemory;
    }
    writeCancelMarker(jobId);
    const abortController = jobAbortControllers.get(jobId);
    if (abortController && !abortController.signal.aborted) {
      abortController.abort();
    }
    inMemory.status = "cancelled";
    inMemory.endedAt = new Date().toISOString();
    inMemory.error = "Annulation demandée par l'utilisateur.";
    touchJob(inMemory);
    persistJobSnapshot(inMemory, { force: true });
    console.info("[cache-precompute-job] cancel requested (local owner)", { jobId });
    return inMemory;
  }

  const snapshot = loadJobSnapshot(jobId);
  if (!snapshot) {
    return null;
  }
  const recovered = normalizeRecoveredSnapshot(snapshot);
  if (isJobTerminal(recovered.status)) {
    return recovered;
  }
  writeCancelMarker(jobId);
  const marked = updateSnapshotOnlyJob({
    ...recovered,
    error:
      recovered.error ??
      "Annulation demandée par l'utilisateur. En attente d'arrêt du worker exécuteur.",
  });
  console.info("[cache-precompute-job] cancel marker written", { jobId });
  return marked;
}

export function resumeCachePrecomputeJob(jobId: string): CachePrecomputeJob | null {
  const existing = getCachePrecomputeJob(jobId);
  if (!existing) {
    return null;
  }
  if (existing.status === "queued" || existing.status === "running") {
    throw new Error(
      `Le job ${jobId} est déjà actif (${existing.status}) et ne peut pas être repris.`,
    );
  }
  if (existing.status === "completed") {
    throw new Error(`Le job ${jobId} est déjà terminé.`);
  }

  const targetJob: CachePrecomputeJob = jobs.get(jobId) ?? {
    ...existing,
  };
  if (!jobs.has(jobId)) {
    jobs.set(jobId, targetJob);
  }

  targetJob.request = {
    ...targetJob.request,
    skipExisting: true,
  };
  targetJob.status = "queued";
  targetJob.startedAt = null;
  targetJob.endedAt = null;
  targetJob.progress = null;
  targetJob.result = null;
  targetJob.error = null;
  touchJob(targetJob);
  persistJobSnapshot(targetJob, { force: true });

  launchCachePrecomputeJobWorker(targetJob, { source: "resumed" });
  evictFinishedJobs();
  return targetJob;
}

export async function rejectCachePrecomputeJob(
  jobId: string,
): Promise<RejectCachePrecomputeJobResult | null> {
  const existing = getCachePrecomputeJob(jobId);
  if (!existing) {
    return null;
  }
  if (existing.status === "queued" || existing.status === "running") {
    throw new Error(
      `Le job ${jobId} est actif (${existing.status}) et ne peut pas être rejeté.`,
    );
  }
  if (existing.status === "completed") {
    throw new Error(
      `Le job ${jobId} est terminé. Utilise la purge cache si tu veux supprimer ces données.`,
    );
  }

  const shadowCalibration = normalizeShadowCalibration({
    observerHeightMeters: existing.request.observerHeightMeters,
    buildingHeightBiasMeters: existing.request.buildingHeightBiasMeters,
  });
  const modelVersion = await getSunlightModelVersion(
    existing.request.region,
    shadowCalibration,
  );
  const storage = getSunlightCacheStorage();
  const removedRunDirs: string[] = [];
  const regionRoot = path.join(CACHE_SUNLIGHT_DIR, existing.request.region);
  const candidateModelVersionHashes = new Set<string>([modelVersion.modelVersionHash]);
  const jobCreatedAtMs = Date.parse(existing.createdAt);

  try {
    const entries = fs.readdirSync(regionRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        candidateModelVersionHashes.add(entry.name);
      }
    }
  } catch {
    // Region root may not exist yet.
  }

  for (const candidateModelVersionHash of candidateModelVersionHashes) {
    for (let dayOffset = 0; dayOffset < existing.request.days; dayOffset += 1) {
      const date = addDays(existing.request.startDate, dayOffset);
      const runDir = getRunDirForRequest({
        region: existing.request.region,
        modelVersionHash: candidateModelVersionHash,
        date,
        gridStepMeters: existing.request.gridStepMeters,
        sampleEveryMinutes: existing.request.sampleEveryMinutes,
        startLocalTime: existing.request.startLocalTime,
        endLocalTime: existing.request.endLocalTime,
      });
      const manifestPath = path.join(runDir, "manifest.json");
      let shouldRemoveRunDir = true;
      try {
        const hasManifest = await storage.exists(manifestPath);
        if (hasManifest) {
          const rawManifest = await storage.readText(manifestPath);
          const manifest = JSON.parse(rawManifest) as {
            complete?: boolean;
            generatedAt?: string;
          };
          const generatedAtMs = Date.parse(manifest.generatedAt ?? "");
          if (
            manifest.complete === true &&
            Number.isFinite(generatedAtMs) &&
            Number.isFinite(jobCreatedAtMs) &&
            generatedAtMs < jobCreatedAtMs
          ) {
            shouldRemoveRunDir = false;
          }
        }
      } catch {
        // If manifest cannot be read/parsed, default to removal.
      }

      if (shouldRemoveRunDir) {
        await storage.removePrefix(runDir);
        removedRunDirs.push(runDir);
      }
    }
  }

  const snapshotPath = jobSnapshotPath(jobId);
  let removedSnapshot = false;
  try {
    fs.rmSync(snapshotPath, { force: true });
    removedSnapshot = true;
  } catch {
    removedSnapshot = false;
  }

  jobs.delete(jobId);
  const abortController = jobAbortControllers.get(jobId);
  if (abortController && !abortController.signal.aborted) {
    abortController.abort();
  }
  jobAbortControllers.delete(jobId);
  lastPersistedAtMs.delete(jobId);
  clearCancelMarker(jobId);

  console.info("[cache-precompute-job] rejected", {
    jobId,
    modelVersionHash: modelVersion.modelVersionHash,
    removedModelVersionHashes: candidateModelVersionHashes.size,
    removedRunDirs: removedRunDirs.length,
    removedSnapshot,
  });

  return {
    jobId,
    modelVersionHash: modelVersion.modelVersionHash,
    removedModelVersionHashes: Array.from(candidateModelVersionHashes),
    removedRunDirs,
    removedSnapshot,
  };
}

function launchCachePrecomputeJobWorker(
  job: CachePrecomputeJob,
  options: { source: "queued" | "resumed" },
): void {
  const jobId = job.jobId;
  const request = job.request;
  clearCancelMarker(jobId);
  const abortController = new AbortController();
  jobAbortControllers.set(jobId, abortController);
  persistJobSnapshot(job, { force: true });
  if (options.source === "queued") {
    console.info("[cache-precompute-job] queued", {
      jobId,
      region: request.region,
      startDate: request.startDate,
      days: request.days,
      gridStepMeters: request.gridStepMeters,
      sampleEveryMinutes: request.sampleEveryMinutes,
      startLocalTime: request.startLocalTime,
      endLocalTime: request.endLocalTime,
      skipExisting: request.skipExisting ?? true,
    });
  } else {
    console.info("[cache-precompute-job] resumed", {
      jobId,
      region: request.region,
      startDate: request.startDate,
      days: request.days,
      gridStepMeters: request.gridStepMeters,
      sampleEveryMinutes: request.sampleEveryMinutes,
      startLocalTime: request.startLocalTime,
      endLocalTime: request.endLocalTime,
      skipExisting: request.skipExisting ?? true,
    });
  }

  void (async () => {
    let cancelPollTriggered = false;
    const cancelWatcher = setInterval(() => {
      if (abortController.signal.aborted) {
        return;
      }
      if (hasCancelMarker(jobId)) {
        if (!cancelPollTriggered) {
          console.info("[cache-precompute-job] cancel marker detected", { jobId });
          cancelPollTriggered = true;
        }
        abortController.abort();
      }
    }, JOB_CANCEL_POLL_INTERVAL_MS);
    if (hasCancelMarker(jobId)) {
      abortController.abort();
    }
    if (abortController.signal.aborted) {
      job.status = "cancelled";
      job.error = "Annulation demandée par l'utilisateur.";
      job.endedAt = new Date().toISOString();
      touchJob(job);
      persistJobSnapshot(job, { force: true });
      console.info("[cache-precompute-job] cancelled-before-start", { jobId });
      jobAbortControllers.delete(jobId);
      clearInterval(cancelWatcher);
      clearCancelMarker(jobId);
      evictFinishedJobs();
      return;
    }
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.progress = {
      stage: "running",
      date: request.startDate,
      dayIndex: 1,
      daysTotal: request.days,
      tileIndex: 0,
      tilesTotal: 0,
      completedTiles: 0,
      totalTiles: 0,
      percent: 0,
      currentTileState: "running",
      currentTilePhase: "prepare-context",
      currentTileProgressPercent: 0,
      elapsedMs: 0,
      etaSeconds: null,
    };
    touchJob(job);
    persistJobSnapshot(job, { force: true });
    console.info("[cache-precompute-job] started", { jobId });
    const startedAtPerf = performance.now();
    let lastProgressLogAt = 0;
    let lastLoggedPhase: string | null = null;
    let lastLoggedTile = -1;
    const heartbeat = setInterval(() => {
      if (job.status !== "running") {
        return;
      }
      if (job.progress) {
        job.progress.elapsedMs = Math.round(performance.now() - startedAtPerf);
      }
      touchJob(job);
    }, 1000);
    try {
      const result = await precomputeCacheRuns(request, {
        signal: abortController.signal,
        onProgress: (progress) => {
          const elapsedMs = performance.now() - startedAtPerf;
          // Include in-flight tile progress so ETA appears before the first tile is fully done.
          const runningTileFractionRaw =
            progress.currentTileState === "running" &&
            typeof progress.currentTileProgressPercent === "number"
              ? progress.currentTileProgressPercent / 100
              : 0;
          const runningTileFraction = Math.max(0, Math.min(1, runningTileFractionRaw));
          const completedFromPercent =
            progress.totalTiles > 0
              ? (Math.max(0, Math.min(100, progress.percent)) / 100) * progress.totalTiles
              : 0;
          const completedTilesEquivalent = Math.max(
            progress.completedTiles + runningTileFraction,
            completedFromPercent,
          );
          const remainingTiles = Math.max(progress.totalTiles - completedTilesEquivalent, 0);
          const tilesPerMs =
            completedTilesEquivalent > 0 && elapsedMs > 0
              ? completedTilesEquivalent / elapsedMs
              : 0;
          const etaMs = tilesPerMs > 0 ? remainingTiles / tilesPerMs : null;
          job.progress = {
            ...progress,
            elapsedMs: Math.round(elapsedMs),
            etaSeconds: etaMs === null ? null : Math.max(0, Math.round(etaMs / 1000)),
          };
          touchJob(job);

          const now = Date.now();
          const phase = progress.currentTilePhase ?? "none";
          const tileChanged = progress.tileIndex !== lastLoggedTile;
          const shouldLogPeriodic = now - lastProgressLogAt >= PROGRESS_LOG_INTERVAL_MS;
          const shouldLogPhaseChange = phase !== lastLoggedPhase;
          const shouldLogTileMilestone =
            tileChanged &&
            (progress.tileIndex <= 3 ||
              progress.tileIndex === progress.tilesTotal ||
              progress.tileIndex % 100 === 0);

          if (shouldLogPeriodic || shouldLogPhaseChange || shouldLogTileMilestone) {
            console.info("[cache-precompute-job] progress", {
              jobId,
              date: progress.date,
              day: `${progress.dayIndex}/${progress.daysTotal}`,
              tile: `${progress.tileIndex}/${progress.tilesTotal}`,
              completedTiles: progress.completedTiles,
              totalTiles: progress.totalTiles,
              percent: progress.percent,
              state: progress.currentTileState,
              phase: progress.currentTilePhase ?? null,
              tileProgressPercent: progress.currentTileProgressPercent ?? null,
              elapsedMs: Math.round(elapsedMs),
              etaSeconds: etaMs === null ? null : Math.max(0, Math.round(etaMs / 1000)),
            });
            lastProgressLogAt = now;
            lastLoggedPhase = phase;
            lastLoggedTile = progress.tileIndex;
          }
        },
      });
      job.status = "completed";
      job.result = result;
      job.endedAt = new Date().toISOString();
      job.progress = {
        stage: "finalizing",
        date: result.dates.at(-1)?.date ?? request.startDate,
        dayIndex: request.days,
        daysTotal: request.days,
        tileIndex: result.totalTiles,
        tilesTotal: result.totalTiles,
        completedTiles: result.totalTiles * request.days,
        totalTiles: result.totalTiles * request.days,
        percent: 100,
        currentTileState: "computed",
        elapsedMs: Math.round(performance.now() - startedAtPerf),
        etaSeconds: 0,
      };
      touchJob(job);
      persistJobSnapshot(job, { force: true });
      console.info("[cache-precompute-job] completed", {
        jobId,
        totalDates: result.totalDates,
        totalTiles: result.totalTiles,
        modelVersionHash: result.modelVersionHash,
        elapsedMs: Math.round(performance.now() - startedAtPerf),
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        job.status = "cancelled";
        job.error = job.error ?? "Annulation demandée par l'utilisateur.";
        job.endedAt = new Date().toISOString();
        touchJob(job);
        persistJobSnapshot(job, { force: true });
        console.info("[cache-precompute-job] cancelled", { jobId });
      } else {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : "Unknown error";
        job.endedAt = new Date().toISOString();
        touchJob(job);
        persistJobSnapshot(job, { force: true });
        console.error("[cache-precompute-job] failed", {
          jobId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancelWatcher);
      clearCancelMarker(jobId);
      jobAbortControllers.delete(jobId);
      evictFinishedJobs();
    }
  })();
}

export function startCachePrecomputeJob(
  request: CachePrecomputeRequest,
): CachePrecomputeJob {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job: CachePrecomputeJob = {
    jobId,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    startedAt: null,
    endedAt: null,
    status: "queued",
    request,
    progress: null,
    result: null,
    error: null,
  };
  jobs.set(jobId, job);
  launchCachePrecomputeJobWorker(job, { source: "queued" });
  evictFinishedJobs();
  return job;
}

