import crypto from "node:crypto";

import {
  precomputeCacheRuns,
  type CachePrecomputeProgress,
  type CachePrecomputeRequest,
  type CachePrecomputeResult,
} from "@/lib/admin/cache-admin";

export type CachePrecomputeJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface CachePrecomputeJob {
  jobId: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  status: CachePrecomputeJobStatus;
  request: CachePrecomputeRequest;
  progress: CachePrecomputeProgress | null;
  result: CachePrecomputeResult | null;
  error: string | null;
}

const jobs = new Map<string, CachePrecomputeJob>();
const MAX_JOBS_IN_MEMORY = 40;

function evictFinishedJobs(): void {
  if (jobs.size <= MAX_JOBS_IN_MEMORY) {
    return;
  }
  const finished = [...jobs.values()]
    .filter((job) => job.status === "completed" || job.status === "failed")
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
  return jobs.get(jobId) ?? null;
}

export function startCachePrecomputeJob(
  request: CachePrecomputeRequest,
): CachePrecomputeJob {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job: CachePrecomputeJob = {
    jobId,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    status: "queued",
    request,
    progress: null,
    result: null,
    error: null,
  };
  jobs.set(jobId, job);

  void (async () => {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    try {
      const result = await precomputeCacheRuns(request, {
        onProgress: (progress) => {
          job.progress = progress;
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
      };
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "Unknown error";
      job.endedAt = new Date().toISOString();
    } finally {
      evictFinishedJobs();
    }
  })();

  evictFinishedJobs();
  return job;
}
