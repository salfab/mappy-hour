"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CANONICAL_PRECOMPUTE_TILE_SIZE_METERS } from "@/lib/precompute/constants";

const JOBS_SSE_STALE_AFTER_MS = 12_000;
const JOBS_SSE_WATCHDOG_INTERVAL_MS = 4_000;

type RegionFilter = "all" | "lausanne" | "nyon";
type ActionState = "idle" | "loading";
type SortBy =
  | "date"
  | "generatedAt"
  | "sizeBytes"
  | "tileCount"
  | "failedTileCount"
  | "gridStepMeters"
  | "sampleEveryMinutes";
type SortOrder = "asc" | "desc";

interface CacheRunSummary {
  region: "lausanne" | "nyon";
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
  sizeBytes: number;
  fileCount: number | null;
}

interface CacheRunsOverview {
  generatedAt: string;
  root: string;
  pagination: {
    page: number;
    pageSize: number;
    totalRuns: number;
    totalPages: number;
    sortBy: SortBy;
    sortOrder: SortOrder;
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

interface CacheVerifyResult {
  generatedAt: string;
  manifestsMatched: number;
  tilesVerified: number;
  strictChecks: {
    expectedFrameCountChecks: number;
    expectedMaskSizeChecks: number;
    pointIndexChecks: number;
  };
  problems: string[];
}

interface CachePurgeResult {
  generatedAt: string;
  dryRun: boolean;
  runsMatched: number;
  removedRunDirs: string[];
}

interface CachePrecomputeResult {
  generatedAt: string;
  region: "lausanne" | "nyon";
  modelVersionHash: string;
  totalTiles: number;
  totalDates: number;
  dates: Array<{
    date: string;
    succeededTiles: number;
    skippedTiles: number;
    failedTiles: number;
    complete: boolean;
    elapsedMs: number;
  }>;
}

interface CachePrecomputeJob {
  jobId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  startedAt: string | null;
  endedAt: string | null;
  status: "queued" | "running" | "cancelled" | "interrupted" | "completed" | "failed";
  request: {
    region: "lausanne" | "nyon";
    startDate: string;
    days: number;
    timezone: string;
    sampleEveryMinutes: number;
    gridStepMeters: number;
    startLocalTime: string;
    endLocalTime: string;
    skipExisting: boolean;
  };
  progress: {
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
    elapsedMs: number;
    etaSeconds: number | null;
  } | null;
  result: CachePrecomputeResult | null;
  error: string | null;
}

interface CacheJobsListResponse {
  generatedAt: string;
  jobs: CachePrecomputeJob[];
}

function formatBytes(value: number): string {
  if (value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("fr-CH", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function isActiveJobStatus(status: CachePrecomputeJob["status"]): boolean {
  return status === "queued" || status === "running";
}

function isActiveJob(job: CachePrecomputeJob): boolean {
  return isActiveJobStatus(job.status);
}

function isResumableJob(job: CachePrecomputeJob): boolean {
  return (
    job.status === "failed" ||
    job.status === "cancelled" ||
    job.status === "interrupted"
  );
}

function canCancelJob(job: CachePrecomputeJob): boolean {
  return job.status !== "completed";
}

function formatJobStatus(status: CachePrecomputeJob["status"]): string {
  if (status === "queued") {
    return "en attente";
  }
  if (status === "running") {
    return "en cours";
  }
  if (status === "cancelled") {
    return "annulé";
  }
  if (status === "interrupted") {
    return "interrompu";
  }
  if (status === "completed") {
    return "terminé";
  }
  return "en erreur";
}

function formatTileState(state: NonNullable<CachePrecomputeJob["progress"]>["currentTileState"]): string {
  if (state === "running") {
    return "calcul";
  }
  if (state === "computed") {
    return "calculée";
  }
  if (state === "skipped") {
    return "ignorée (cache)";
  }
  return "échec";
}

function formatTilePhase(
  phase: NonNullable<CachePrecomputeJob["progress"]>["currentTilePhase"],
): string {
  if (phase === "prepare-context") {
    return "préparation du contexte";
  }
  if (phase === "prepare-points") {
    return "préparation des points";
  }
  if (phase === "evaluate-frames") {
    return "évaluation du soleil";
  }
  return "n/a";
}

function computeJobElapsedSeconds(job: CachePrecomputeJob): number | null {
  if (job.progress && Number.isFinite(job.progress.elapsedMs)) {
    return Math.max(0, Math.round(job.progress.elapsedMs / 1000));
  }
  if (!job.startedAt) {
    return null;
  }
  const startedAtMs = Date.parse(job.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return null;
  }
  const endedAtMs = job.endedAt ? Date.parse(job.endedAt) : Date.now();
  if (!Number.isFinite(endedAtMs)) {
    return null;
  }
  return Math.max(0, Math.round((endedAtMs - startedAtMs) / 1000));
}

function formatElapsed(seconds: number | null): string {
  if (seconds === null) {
    return "n/a";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function parseLocalTimeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

function computeFrameCountPerDay(
  startLocalTime: string,
  endLocalTime: string,
  sampleEveryMinutes: number,
): number | null {
  const startMinutes = parseLocalTimeToMinutes(startLocalTime);
  const endMinutes = parseLocalTimeToMinutes(endLocalTime);
  if (startMinutes === null || endMinutes === null) {
    return null;
  }
  if (!Number.isFinite(sampleEveryMinutes) || sampleEveryMinutes <= 0) {
    return null;
  }
  if (endMinutes < startMinutes) {
    return null;
  }
  return Math.floor((endMinutes - startMinutes) / sampleEveryMinutes) + 1;
}

function buildRunsUrl(filters: {
  region: RegionFilter;
  modelVersionHash: string;
  startDate: string;
  endDate: string;
  sortBy: SortBy;
  sortOrder: SortOrder;
  page: number;
  pageSize: number;
}): string {
  const params = new URLSearchParams();
  if (filters.region !== "all") {
    params.set("region", filters.region);
  }
  if (filters.modelVersionHash.trim()) {
    params.set("modelVersionHash", filters.modelVersionHash.trim());
  }
  if (filters.startDate) {
    params.set("startDate", filters.startDate);
  }
  if (filters.endDate) {
    params.set("endDate", filters.endDate);
  }
  params.set("sortBy", filters.sortBy);
  params.set("sortOrder", filters.sortOrder);
  params.set("page", String(filters.page));
  params.set("pageSize", String(filters.pageSize));
  return `/api/admin/cache/runs?${params.toString()}`;
}

export function CacheAdminClient() {
  const lastJobStreamSignalAtRef = useRef<number>(0);
  const [region, setRegion] = useState<RegionFilter>("all");
  const [modelVersionHash, setModelVersionHash] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("date");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [overview, setOverview] = useState<CacheRunsOverview | null>(null);
  const [verifyResult, setVerifyResult] = useState<CacheVerifyResult | null>(null);
  const [purgeResult, setPurgeResult] = useState<CachePurgeResult | null>(null);
  const [precomputeResult, setPrecomputeResult] =
    useState<CachePrecomputeResult | null>(null);
  const [precomputeJob, setPrecomputeJob] = useState<CachePrecomputeJob | null>(null);
  const [activeJobs, setActiveJobs] = useState<CachePrecomputeJob[]>([]);
  const [recentJobs, setRecentJobs] = useState<CachePrecomputeJob[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [jobsLoadError, setJobsLoadError] = useState<string | null>(null);
  const [jobActionPending, setJobActionPending] = useState<{
    jobId: string;
    action: "cancel" | "resume";
  } | null>(null);
  const [loadState, setLoadState] = useState<ActionState>("idle");
  const [verifyState, setVerifyState] = useState<ActionState>("idle");
  const [purgeState, setPurgeState] = useState<ActionState>("idle");
  const [precomputeState, setPrecomputeState] = useState<ActionState>("idle");

  const [preRegion, setPreRegion] = useState<"lausanne" | "nyon">("lausanne");
  const [preStartDate, setPreStartDate] = useState("2026-03-08");
  const [preDays, setPreDays] = useState(1);
  const [preGridStep, setPreGridStep] = useState(1);
  const [preSampleEvery, setPreSampleEvery] = useState(15);
  const [preStartLocalTime, setPreStartLocalTime] = useState("00:00");
  const [preEndLocalTime, setPreEndLocalTime] = useState("23:59");
  const [preSkipExisting, setPreSkipExisting] = useState(true);
  const hasActivePrecompute = activeJobs.length > 0;
  const precomputeButtonDisabled =
    precomputeState === "loading" || hasActivePrecompute;
  const precomputeFrameCountPerDay = useMemo(() => {
    if (!precomputeJob) {
      return null;
    }
    return computeFrameCountPerDay(
      precomputeJob.request.startLocalTime,
      precomputeJob.request.endLocalTime,
      precomputeJob.request.sampleEveryMinutes,
    );
  }, [precomputeJob]);

  const filters = useMemo(
    () => ({
      region,
      modelVersionHash,
      startDate,
      endDate,
      sortBy,
      sortOrder,
      page,
      pageSize,
    }),
    [
      endDate,
      modelVersionHash,
      page,
      pageSize,
      region,
      sortBy,
      sortOrder,
      startDate,
    ],
  );

  const refreshRuns = useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    try {
      const response = await fetch(buildRunsUrl(filters), { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        const errorPayload = payload as { details?: string; error?: string };
        throw new Error(errorPayload.details ?? errorPayload.error ?? "Unknown error");
      }
      setOverview(payload as CacheRunsOverview);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setLoadState("idle");
    }
  }, [filters]);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  const refreshActiveJobs = useCallback(async () => {
    try {
      setJobsLoadError(null);
      const response = await fetch("/api/admin/cache/jobs", { cache: "no-store" });
      const payload = (await response.json()) as
        | CacheJobsListResponse
        | { error?: string; details?: string };
      if (!response.ok) {
        const errorPayload = payload as { error?: string; details?: string };
        throw new Error(errorPayload.details ?? errorPayload.error ?? "Unknown error");
      }

      const jobs = (payload as CacheJobsListResponse).jobs ?? [];
      const active = jobs.filter(isActiveJob);
      setRecentJobs(jobs.slice(0, 10));
      setActiveJobs(active);
      setPrecomputeJob((current) => {
        if (!current) {
          return active[0] ?? null;
        }
        const sameJob = jobs.find((job) => job.jobId === current.jobId) ?? null;
        if (sameJob) {
          return sameJob;
        }
        if (isActiveJob(current)) {
          return active[0] ?? current;
        }
        return current;
      });
    } catch (error) {
      setJobsLoadError(error instanceof Error ? error.message : "Unknown error");
    }
  }, []);

  useEffect(() => {
    void refreshActiveJobs();
  }, [refreshActiveJobs]);

  useEffect(() => {
    const timer = setInterval(() => {
      const trackedJob = precomputeJob;
      const expectsSse = trackedJob ? isActiveJobStatus(trackedJob.status) : false;
      if (!expectsSse) {
        return;
      }
      const now = Date.now();
      const lastSignalAt = lastJobStreamSignalAtRef.current;
      const staleForMs =
        lastSignalAt > 0 ? now - lastSignalAt : JOBS_SSE_STALE_AFTER_MS + 1;
      if (staleForMs >= JOBS_SSE_STALE_AFTER_MS) {
        void refreshActiveJobs();
      }
    }, JOBS_SSE_WATCHDOG_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [precomputeJob?.jobId, precomputeJob?.status, refreshActiveJobs]);

  const runAction = useCallback(
    async (action: "verify" | "purge", dryRun?: boolean) => {
      setActionError(null);
      if (action === "verify") {
        setVerifyState("loading");
      } else {
        setPurgeState("loading");
      }
      try {
        const response = await fetch("/api/admin/cache/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            filters: {
              region: region === "all" ? undefined : region,
              modelVersionHash: modelVersionHash.trim() || undefined,
              startDate: startDate || undefined,
              endDate: endDate || undefined,
            },
            dryRun,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.details ?? payload?.error ?? "Unknown error");
        }
        if (action === "verify") {
          setVerifyResult(payload as CacheVerifyResult);
        } else {
          setPurgeResult(payload as CachePurgeResult);
          await refreshRuns();
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Unknown error");
      } finally {
        if (action === "verify") {
          setVerifyState("idle");
        } else {
          setPurgeState("idle");
        }
      }
    },
    [endDate, modelVersionHash, refreshRuns, region, startDate],
  );

  const runPrecompute = useCallback(async () => {
    if (hasActivePrecompute) {
      setActionError(
        "Un job precompute est déjà en cours. Annule-le ou attends sa fin avant d'en lancer un nouveau.",
      );
      return;
    }
    const confirmed = window.confirm(
      "Lancer un precompute maintenant ? Cette action peut prendre du temps.",
    );
    if (!confirmed) {
      return;
    }
    setPrecomputeState("loading");
    setActionError(null);
    try {
      const response = await fetch("/api/admin/cache/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "precompute",
          precompute: {
            region: preRegion,
            startDate: preStartDate,
            days: preDays,
            timezone: "Europe/Zurich",
            sampleEveryMinutes: preSampleEvery,
            gridStepMeters: preGridStep,
            startLocalTime: preStartLocalTime,
            endLocalTime: preEndLocalTime,
            skipExisting: preSkipExisting,
          },
        }),
      });
      const payload = (await response.json()) as
        | { jobId: string; status: string; createdAt: string }
        | { details?: string; error?: string };
      if (!response.ok) {
        const errorPayload = payload as { details?: string; error?: string };
        throw new Error(errorPayload.details ?? errorPayload.error ?? "Unknown error");
      }
      if (!("jobId" in payload)) {
        throw new Error("Invalid precompute job response.");
      }
      setPrecomputeResult(null);
      const queuedJob: CachePrecomputeJob = {
        jobId: payload.jobId,
        createdAt: payload.createdAt,
        updatedAt: payload.createdAt,
        revision: 0,
        startedAt: null,
        endedAt: null,
        status: "queued",
        request: {
          region: preRegion,
          startDate: preStartDate,
          days: preDays,
          timezone: "Europe/Zurich",
          sampleEveryMinutes: preSampleEvery,
          gridStepMeters: preGridStep,
          startLocalTime: preStartLocalTime,
          endLocalTime: preEndLocalTime,
          skipExisting: preSkipExisting,
        },
        progress: null,
        result: null,
        error: null,
      };
      setPrecomputeJob(queuedJob);
      setActiveJobs((current) => [queuedJob, ...current.filter((job) => job.jobId !== queuedJob.jobId)]);
      setRecentJobs((current) => [queuedJob, ...current.filter((job) => job.jobId !== queuedJob.jobId)].slice(0, 10));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setPrecomputeState("idle");
    }
  }, [
    hasActivePrecompute,
    preDays,
    preEndLocalTime,
    preGridStep,
    preRegion,
    preSampleEvery,
    preStartDate,
    preStartLocalTime,
    preSkipExisting,
    refreshRuns,
  ]);

  const runJobAction = useCallback(
    async (job: CachePrecomputeJob, action: "cancel" | "resume") => {
      if (action === "cancel") {
        const confirmed = window.confirm(
          `Annuler le job ${job.jobId.slice(0, 8)} ?`,
        );
        if (!confirmed) {
          return;
        }
      }

      setJobActionPending({ jobId: job.jobId, action });
      setActionError(null);
      try {
        const response = await fetch(
          `/api/admin/cache/jobs/${encodeURIComponent(job.jobId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          },
        );
        const payload = (await response.json()) as
          | CachePrecomputeJob
          | {
              jobId: string;
              status: "cancelled";
              rejected: boolean;
              removedRunDirs: number;
              removedSnapshot: boolean;
            }
          | { error?: string; details?: string };
        if (!response.ok) {
          const errorPayload = payload as { error?: string; details?: string };
          throw new Error(
            errorPayload.details ?? errorPayload.error ?? "Unknown error",
          );
        }
        if (action === "cancel") {
          const cancelPayload = payload as
            | CachePrecomputeJob
            | {
                jobId: string;
                status: "cancelled";
                rejected: boolean;
                removedRunDirs: number;
                removedSnapshot: boolean;
              };
          const cancelledJobId = cancelPayload.jobId;
          setActiveJobs((current) =>
            current.filter((entry) => entry.jobId !== cancelledJobId),
          );
          setRecentJobs((current) =>
            current.filter((entry) => entry.jobId !== cancelledJobId),
          );
          setPrecomputeJob((current) =>
            current?.jobId === cancelledJobId ? null : current,
          );
          await refreshRuns();
        } else {
          const jobPayload = payload as CachePrecomputeJob;
          setPrecomputeResult(null);
          setPrecomputeJob(jobPayload);
          setActiveJobs((current) =>
            [jobPayload, ...current.filter((entry) => entry.jobId !== jobPayload.jobId)]
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
          );
          setRecentJobs((current) =>
            [jobPayload, ...current.filter((entry) => entry.jobId !== jobPayload.jobId)]
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
              .slice(0, 10),
          );
        }
        await refreshActiveJobs();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Unknown error");
      } finally {
        setJobActionPending(null);
      }
    },
    [refreshActiveJobs, refreshRuns],
  );

  useEffect(() => {
    const jobId = precomputeJob?.jobId;
    const status = precomputeJob?.status;
    if (!jobId) {
      return;
    }
    if (!status || !isActiveJobStatus(status)) {
      return;
    }
    lastJobStreamSignalAtRef.current = Date.now();

    let cancelled = false;
    let pollingInFlight = false;
    let pollingTimer: ReturnType<typeof setTimeout> | null = null;
    let eventSource: EventSource | null = null;
    let fallbackStarted = false;

    const applyJobUpdate = (job: CachePrecomputeJob) => {
      lastJobStreamSignalAtRef.current = Date.now();
      setPrecomputeJob(job);
      setActiveJobs((current) => {
        const remaining = current.filter((entry) => entry.jobId !== job.jobId);
        if (isActiveJob(job)) {
          return [job, ...remaining].sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt),
          );
        }
        return remaining;
      });
      setRecentJobs((current) =>
        [job, ...current.filter((entry) => entry.jobId !== job.jobId)]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, 10),
      );
      if (job.status === "completed") {
        setPrecomputeResult(job.result ?? null);
        void refreshRuns();
      }
    };

    const startPollingFallback = () => {
      if (fallbackStarted || cancelled) {
        return;
      }
      fallbackStarted = true;
      void pollJob();
    };

    const scheduleNextPoll = () => {
      if (cancelled) {
        return;
      }
      pollingTimer = setTimeout(() => {
        void pollJob();
      }, 1000);
    };

    const pollJob = async () => {
      if (cancelled || pollingInFlight) {
        return;
      }
      pollingInFlight = true;
      try {
        const response = await fetch(`/api/admin/cache/jobs/${encodeURIComponent(jobId)}`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as CachePrecomputeJob | { error?: string };
        if (!response.ok) {
          if (response.status === 404) {
            setPrecomputeJob((current) =>
              current && current.jobId === jobId
                ? {
                    ...current,
                    updatedAt: new Date().toISOString(),
                    revision: (current.revision ?? 0) + 1,
                    status: "failed",
                    endedAt: new Date().toISOString(),
                    error:
                      "Job introuvable (probable redémarrage serveur). Relance un nouveau precompute.",
                  }
                : current,
            );
            setActiveJobs((current) => current.filter((job) => job.jobId !== jobId));
            return;
          }
          throw new Error((payload as { error?: string }).error ?? "Unknown error");
        }
        if (cancelled) {
          return;
        }
        lastJobStreamSignalAtRef.current = Date.now();
        applyJobUpdate(payload as CachePrecomputeJob);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setActionError(error instanceof Error ? error.message : "Unknown error");
      } finally {
        pollingInFlight = false;
        scheduleNextPoll();
      }
    };

    if (typeof EventSource !== "undefined") {
      eventSource = new EventSource(
        `/api/admin/cache/jobs/${encodeURIComponent(jobId)}/stream`,
      );
      eventSource.addEventListener("job", (event) => {
        if (cancelled) {
          return;
        }
        try {
          const job = JSON.parse((event as MessageEvent<string>).data) as CachePrecomputeJob;
          applyJobUpdate(job);
        } catch {
          startPollingFallback();
        }
      });
      eventSource.addEventListener("heartbeat", () => {
        if (cancelled) {
          return;
        }
        lastJobStreamSignalAtRef.current = Date.now();
      });
      eventSource.addEventListener("done", () => {
        if (cancelled) {
          return;
        }
        lastJobStreamSignalAtRef.current = Date.now();
        void refreshActiveJobs();
      });
      eventSource.addEventListener("error", () => {
        if (cancelled) {
          return;
        }
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        startPollingFallback();
      });
    } else {
      startPollingFallback();
    }

    return () => {
      cancelled = true;
      lastJobStreamSignalAtRef.current = 0;
      if (eventSource) {
        eventSource.close();
      }
      if (pollingTimer) {
        clearTimeout(pollingTimer);
      }
    };
  }, [precomputeJob?.jobId, precomputeJob?.status, refreshActiveJobs, refreshRuns]);

  return (
    <div className="grid gap-6">
      <section className="grid gap-4 rounded-3xl border border-white/12 bg-black/20 p-5">
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void refreshRuns()}
            disabled={loadState === "loading"}
            className="rounded-full border border-white/15 px-4 py-2 text-sm"
          >
            {loadState === "loading" ? "Actualisation..." : "Actualiser"}
          </button>
          <button
            type="button"
            onClick={() => void runAction("verify")}
            disabled={verifyState === "loading"}
            className="rounded-full bg-sky-300 px-4 py-2 text-sm font-medium text-slate-950"
          >
            {verifyState === "loading" ? "Vérification..." : "Vérifier"}
          </button>
          <button
            type="button"
            onClick={() => void runAction("purge", true)}
            disabled={purgeState === "loading"}
            className="rounded-full border border-amber-300/40 px-4 py-2 text-sm"
          >
            Dry run purge
          </button>
          <button
            type="button"
            onClick={() => void runAction("purge", false)}
            disabled={purgeState === "loading"}
            className="rounded-full border border-rose-400/40 px-4 py-2 text-sm"
          >
            {purgeState === "loading" ? "Purge..." : "Purger"}
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="grid gap-2 text-sm">
            <span className="text-slate-300">Région</span>
            <select
              value={region}
              onChange={(event) => {
                setPage(1);
                setRegion(event.target.value as RegionFilter);
              }}
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2"
            >
              <option value="all">Toutes</option>
              <option value="lausanne">Lausanne</option>
              <option value="nyon">Nyon</option>
            </select>
          </label>
          <label className="grid gap-2 text-sm">
            <span className="text-slate-300">Model version hash</span>
            <input
              value={modelVersionHash}
              onChange={(event) => {
                setPage(1);
                setModelVersionHash(event.target.value);
              }}
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2"
            />
          </label>
          <label className="grid gap-2 text-sm">
            <span className="text-slate-300">Date début</span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => {
                setPage(1);
                setStartDate(event.target.value);
              }}
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2"
            />
          </label>
          <label className="grid gap-2 text-sm">
            <span className="text-slate-300">Date fin</span>
            <input
              type="date"
              value={endDate}
              onChange={(event) => {
                setPage(1);
                setEndDate(event.target.value);
              }}
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2"
            />
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="grid gap-2 text-sm">
            <span className="text-slate-300">Tri</span>
            <select
              value={sortBy}
              onChange={(event) => {
                setPage(1);
                setSortBy(event.target.value as SortBy);
              }}
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2"
            >
              <option value="date">Date</option>
              <option value="generatedAt">Généré</option>
              <option value="sizeBytes">Taille</option>
              <option value="tileCount">Tuiles</option>
              <option value="failedTileCount">Échecs</option>
              <option value="gridStepMeters">Pas grille</option>
              <option value="sampleEveryMinutes">Pas temps</option>
            </select>
          </label>
          <label className="grid gap-2 text-sm">
            <span className="text-slate-300">Ordre</span>
            <select
              value={sortOrder}
              onChange={(event) => {
                setPage(1);
                setSortOrder(event.target.value as SortOrder);
              }}
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2"
            >
              <option value="desc">Descendant</option>
              <option value="asc">Ascendant</option>
            </select>
          </label>
          <label className="grid gap-2 text-sm">
            <span className="text-slate-300">Page</span>
            <input
              type="number"
              min={1}
              value={page}
              onChange={(event) => setPage(Math.max(1, Number(event.target.value) || 1))}
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2"
            />
          </label>
          <label className="grid gap-2 text-sm">
            <span className="text-slate-300">Lignes</span>
            <select
              value={String(pageSize)}
              onChange={(event) => {
                setPage(1);
                setPageSize(Number(event.target.value));
              }}
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2"
            >
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </label>
        </div>

        {loadError ? <p className="text-sm text-rose-200">{loadError}</p> : null}
        {actionError ? <p className="text-sm text-rose-200">{actionError}</p> : null}
      </section>

      <section className="grid gap-4 md:grid-cols-5">
        <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
          <p className="text-xs text-slate-400">Runs</p>
          <p className="mt-2 text-3xl font-semibold">{overview?.summary.runCount ?? 0}</p>
        </article>
        <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
          <p className="text-xs text-slate-400">Tuiles</p>
          <p className="mt-2 text-3xl font-semibold">
            {overview?.summary.totalTiles ?? 0}
          </p>
        </article>
        <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
          <p className="text-xs text-slate-400">Complets</p>
          <p className="mt-2 text-3xl font-semibold">
            {overview?.summary.completeRuns ?? 0}
          </p>
        </article>
        <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
          <p className="text-xs text-slate-400">Échecs</p>
          <p className="mt-2 text-3xl font-semibold">
            {overview?.summary.totalFailedTiles ?? 0}
          </p>
        </article>
        <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
          <p className="text-xs text-slate-400">Taille</p>
          <p className="mt-2 text-3xl font-semibold">
            {overview?.summary.totalSizeBytes == null
              ? "n/a"
              : formatBytes(overview?.summary.totalSizeBytes ?? 0)}
          </p>
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <article className="overflow-hidden rounded-3xl border border-white/12 bg-black/20">
          <div className="border-b border-white/10 px-5 py-4">
            <h2 className="text-lg font-semibold">Runs détectés</h2>
            <p className="text-sm text-slate-400">{overview?.root ?? "Chargement..."}</p>
            {overview ? (
              <p className="text-xs text-slate-500">
                Page {overview.pagination.page}/{overview.pagination.totalPages} (
                {overview.pagination.totalRuns} runs)
              </p>
            ) : null}
          </div>
          <div className="max-h-[60vh] overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-950/95 text-slate-400">
                <tr>
                  <th className="px-5 py-3">Run</th>
                  <th className="px-5 py-3">Paramètres</th>
                  <th className="px-5 py-3">État</th>
                  <th className="px-5 py-3">Stockage</th>
                </tr>
              </thead>
              <tbody>
                {overview?.runs.length ? (
                  overview.runs.map((run) => (
                    <tr key={run.runDir} className="border-t border-white/8 align-top">
                      <td className="px-5 py-4">
                        <p className="text-xs uppercase tracking-[0.2em] text-sky-200">
                          {run.region}
                        </p>
                        <p className="font-medium">{run.date}</p>
                        <p className="font-mono text-xs text-slate-400">{run.modelVersionHash}</p>
                      </td>
                      <td className="px-5 py-4">
                        <p>{run.startLocalTime} - {run.endLocalTime}</p>
                        <p>grille {run.gridStepMeters} m</p>
                        <p>pas temps {run.sampleEveryMinutes} min</p>
                      </td>
                      <td className="px-5 py-4">
                        <p>{run.complete ? "complet" : "incomplet"}</p>
                        <p>{run.tileCount} tuiles</p>
                        <p>{run.failedTileCount} échecs</p>
                      </td>
                      <td className="px-5 py-4">
                        <p>{run.sizeBytes === null ? "n/a" : formatBytes(run.sizeBytes)}</p>
                        <p>
                          {run.fileCount === null ? "n/a" : `${run.fileCount} fichiers`}
                        </p>
                        <p className="text-xs text-slate-500">{formatDateTime(run.generatedAt)}</p>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="px-5 py-8 text-center text-slate-400">
                      Aucun run de cache ne correspond aux filtres actuels.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-white/10 px-5 py-3 text-sm">
            <button
              type="button"
              disabled={!overview || overview.pagination.page <= 1}
              onClick={() => setPage((previous) => Math.max(1, previous - 1))}
              className="rounded-full border border-white/15 px-3 py-1 disabled:opacity-50"
            >
              Page précédente
            </button>
            <button
              type="button"
              disabled={!overview || overview.pagination.page >= overview.pagination.totalPages}
              onClick={() =>
                setPage((previous) =>
                  overview ? Math.min(overview.pagination.totalPages, previous + 1) : previous,
                )
              }
              className="rounded-full border border-white/15 px-3 py-1 disabled:opacity-50"
            >
              Page suivante
            </button>
          </div>
        </article>

        <div className="grid gap-4">
          <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
            <h2 className="text-lg font-semibold">Vérification</h2>
            {verifyResult ? (
              <div className="mt-3 grid gap-2 text-sm">
                <p>{verifyResult.manifestsMatched} manifests</p>
                <p>{verifyResult.tilesVerified} tuiles vérifiées</p>
                <p className="text-xs text-slate-400">
                  checks frames={verifyResult.strictChecks.expectedFrameCountChecks} masks=
                  {verifyResult.strictChecks.expectedMaskSizeChecks} indexes=
                  {verifyResult.strictChecks.pointIndexChecks}
                </p>
                <p className="text-xs text-slate-400">{formatDateTime(verifyResult.generatedAt)}</p>
                <p>{verifyResult.problems.length} problèmes</p>
              </div>
            ) : null}
          </article>

          <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
            <h2 className="text-lg font-semibold">Precompute</h2>
            <div className="mt-3 grid gap-2 text-sm">
              {activeJobs.length > 0 ? (
                <div className="grid gap-2 rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-3 py-2">
                  <p className="text-cyan-100">
                    {activeJobs.length} job(s) en cours détecté(s) après rafraîchissement.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {activeJobs.slice(0, 4).map((job) => (
                      <button
                        key={job.jobId}
                        type="button"
                        onClick={() => setPrecomputeJob(job)}
                        className="rounded-full border border-cyan-300/60 px-3 py-1 text-xs text-cyan-100"
                      >
                        Suivre {job.jobId.slice(0, 8)} ({formatJobStatus(job.status)})
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {jobsLoadError ? (
                <p className="text-xs text-amber-200">
                  Impossible de charger la liste des jobs en cours: {jobsLoadError}
                </p>
              ) : null}
              {recentJobs.length > 0 ? (
                <div className="grid gap-2 rounded-xl border border-white/12 bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-300">Jobs récents</p>
                  <div className="grid max-h-72 gap-2 overflow-auto">
                    {recentJobs.map((job) => (
                      <article
                        key={job.jobId}
                        className="grid gap-2 rounded-lg border border-white/10 bg-slate-900/50 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-mono text-xs text-slate-200">
                            {job.jobId.slice(0, 8)}
                          </p>
                          <p className="text-xs text-slate-300">
                            {formatJobStatus(job.status)}
                          </p>
                        </div>
                        <p className="text-[11px] text-slate-300">
                          Région {job.request.region} · {job.request.days} jour(s) depuis {job.request.startDate}
                        </p>
                        <p className="text-[11px] text-slate-300">
                          Fenêtre {job.request.startLocalTime}-{job.request.endLocalTime} · grille {job.request.gridStepMeters}m · pas {job.request.sampleEveryMinutes}min
                        </p>
                        <p className="text-[11px] text-slate-400">
                          elapsed {formatElapsed(computeJobElapsedSeconds(job))} · maj {formatDateTime(job.updatedAt)}
                        </p>
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            onClick={() => setPrecomputeJob(job)}
                            disabled={precomputeJob?.jobId === job.jobId}
                            className="rounded-full border border-white/20 px-2 py-1 text-[11px] disabled:opacity-50"
                          >
                            Suivre
                          </button>
                          {canCancelJob(job) ? (
                            <button
                              type="button"
                              onClick={() => void runJobAction(job, "cancel")}
                              disabled={
                                jobActionPending?.jobId === job.jobId &&
                                jobActionPending.action === "cancel"
                              }
                              className="rounded-full border border-rose-300/50 px-2 py-1 text-[11px] text-rose-100 disabled:opacity-50"
                            >
                              {jobActionPending?.jobId === job.jobId &&
                              jobActionPending.action === "cancel"
                                ? "Annulation..."
                                : "Annuler"}
                            </button>
                          ) : null}
                          {isResumableJob(job) ? (
                            <button
                              type="button"
                              onClick={() => void runJobAction(job, "resume")}
                              disabled={
                                jobActionPending?.jobId === job.jobId &&
                                jobActionPending.action === "resume"
                              }
                              className="rounded-full border border-emerald-300/50 px-2 py-1 text-[11px] text-emerald-100 disabled:opacity-50"
                            >
                              {jobActionPending?.jobId === job.jobId &&
                              jobActionPending.action === "resume"
                                ? "Relance..."
                                : "Reprendre"}
                            </button>
                          ) : null}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
              <label className="grid gap-1">
                <span className="text-slate-300">Région</span>
                <select
                  value={preRegion}
                  onChange={(event) =>
                    setPreRegion(event.target.value as "lausanne" | "nyon")
                  }
                  className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
                >
                  <option value="lausanne">Lausanne</option>
                  <option value="nyon">Nyon</option>
                </select>
              </label>
              <label className="grid gap-1">
                <span className="text-slate-300">Date de début</span>
                <input
                  type="date"
                  value={preStartDate}
                  onChange={(event) => setPreStartDate(event.target.value)}
                  className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-slate-300">Nombre de jours</span>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={preDays}
                  onChange={(event) =>
                    setPreDays(Math.max(1, Math.min(31, Number(event.target.value) || 1)))
                  }
                  className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-slate-300">Pas de grille (mètres)</span>
                <input
                  type="number"
                  min={1}
                  max={2000}
                  value={preGridStep}
                  onChange={(event) =>
                    setPreGridStep(Math.max(1, Number(event.target.value) || 1))
                  }
                  className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-slate-300">Pas temporel (minutes)</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={preSampleEvery}
                  onChange={(event) =>
                    setPreSampleEvery(
                      Math.max(1, Math.min(60, Number(event.target.value) || 1)),
                    )
                  }
                  className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
                />
              </label>
              <p className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
                Taille des tuiles fixée à {CANONICAL_PRECOMPUTE_TILE_SIZE_METERS} m (canonique)
                pour maximiser la réutilisation du cache entre zones.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1">
                  <span className="text-slate-300">Heure de début</span>
                  <input
                    type="time"
                    value={preStartLocalTime}
                    onChange={(event) => setPreStartLocalTime(event.target.value)}
                    className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-slate-300">Heure fin</span>
                  <input
                    type="time"
                    value={preEndLocalTime}
                    onChange={(event) => setPreEndLocalTime(event.target.value)}
                    className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
                  />
                </label>
              </div>
              <label className="flex items-center gap-2 rounded-xl border border-white/12 bg-slate-950/50 px-3 py-2 text-slate-200">
                <input
                  type="checkbox"
                  checked={preSkipExisting}
                  onChange={(event) => setPreSkipExisting(event.target.checked)}
                />
                Ignorer les tuiles déjà calculées (mode reprise)
              </label>
              <p className="rounded-xl border border-white/12 bg-slate-900/50 px-3 py-2 text-xs text-slate-300">
                Portée d&apos;un run: région complète ({preRegion}), {preDays} jour(s) à partir du {preStartDate},
                fenêtre {preStartLocalTime}-{preEndLocalTime}. La progression totale compte les tuiles sur
                toute la plage de jours (tuile-jour).
              </p>
              <button
                type="button"
                onClick={() => void runPrecompute()}
                disabled={precomputeButtonDisabled}
                className="rounded-full bg-cyan-300 px-4 py-2 text-sm font-medium text-slate-950"
              >
                {precomputeState === "loading"
                  ? "Precompute en cours..."
                  : hasActivePrecompute
                    ? "Job en cours (bloqué)"
                    : "Lancer precompute"}
              </button>
              {hasActivePrecompute ? (
                <p className="text-xs text-amber-100">
                  Un job est déjà en cours. Le lancement d’un nouveau precompute est bloqué.
                </p>
              ) : null}
              {precomputeJob ? (
                <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-100">
                  <p>
                    Job {precomputeJob.jobId.slice(0, 8)} - {formatJobStatus(precomputeJob.status)}
                  </p>
                  <p className="mt-1 text-[11px] text-cyan-50">
                    Portée: région {precomputeJob.request.region}, {precomputeJob.request.days} jour(s)
                    depuis {precomputeJob.request.startDate}, fenêtre {precomputeJob.request.startLocalTime}-
                    {precomputeJob.request.endLocalTime}, grille {precomputeJob.request.gridStepMeters}m,
                    pas {precomputeJob.request.sampleEveryMinutes}min.
                  </p>
                  <p className="text-[11px] text-cyan-100/90">
                    Unité totale: <span className="font-semibold">tuile-jour</span> = 1 tuile spatiale
                    ({CANONICAL_PRECOMPUTE_TILE_SIZE_METERS}m) calculée pour toute la fenêtre d’un jour.
                  </p>
                  <p className="text-[11px] text-cyan-100/90">
                    Slots temporels par tuile-jour:{" "}
                    {precomputeFrameCountPerDay === null
                      ? "n/a"
                      : `${precomputeFrameCountPerDay} frames`}{" "}
                    ({precomputeJob.request.startLocalTime}-{precomputeJob.request.endLocalTime}, pas{" "}
                    {precomputeJob.request.sampleEveryMinutes} min).
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {canCancelJob(precomputeJob) ? (
                      <button
                        type="button"
                        onClick={() => void runJobAction(precomputeJob, "cancel")}
                        disabled={
                          jobActionPending?.jobId === precomputeJob.jobId &&
                          jobActionPending.action === "cancel"
                        }
                        className="rounded-full border border-rose-300/50 px-2 py-1 text-[11px] text-rose-100 disabled:opacity-50"
                      >
                        {jobActionPending?.jobId === precomputeJob.jobId &&
                        jobActionPending.action === "cancel"
                          ? "Annulation..."
                          : "Annuler ce job"}
                      </button>
                    ) : null}
                    {isResumableJob(precomputeJob) ? (
                      <button
                        type="button"
                        onClick={() => void runJobAction(precomputeJob, "resume")}
                        disabled={
                          jobActionPending?.jobId === precomputeJob.jobId &&
                          jobActionPending.action === "resume"
                        }
                        className="rounded-full border border-emerald-300/50 px-2 py-1 text-[11px] text-emerald-100 disabled:opacity-50"
                      >
                        {jobActionPending?.jobId === precomputeJob.jobId &&
                        jobActionPending.action === "resume"
                          ? "Relance..."
                          : "Reprendre depuis cache"}
                      </button>
                    ) : null}
                  </div>
                  {precomputeJob.progress ? (
                    <>
                      {precomputeJob.progress.totalTiles > 0 ? (
                        <p>
                          {precomputeJob.progress.percent}% ({precomputeJob.progress.completedTiles}/
                          {precomputeJob.progress.totalTiles} tuiles-jour) - jour{" "}
                          {precomputeJob.progress.dayIndex}/{precomputeJob.progress.daysTotal} (
                          {precomputeJob.progress.date})
                        </p>
                      ) : (
                        <p>
                          Démarrage du calcul - {precomputeJob.progress.date}
                        </p>
                      )}
                      <div className="grid gap-1">
                        <p className="text-cyan-50">
                          Progression totale (tuiles-jour)
                        </p>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-cyan-950/60">
                          <div
                            className="h-full rounded-full bg-cyan-300 transition-all duration-500"
                            style={{ width: `${clampPercent(precomputeJob.progress.percent)}%` }}
                          />
                        </div>
                      </div>
                      <div className="grid gap-1">
                        <p className="text-cyan-50">
                          Progression tuile spatiale en cours ({Math.round(
                            precomputeJob.progress.currentTileProgressPercent ??
                              ((precomputeJob.progress.tileIndex /
                                Math.max(precomputeJob.progress.tilesTotal, 1)) *
                                100),
                          )}
                          %)
                        </p>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-cyan-950/60">
                          <div
                            className="h-full rounded-full bg-sky-200 transition-all duration-500"
                            style={{
                              width: `${clampPercent(
                                precomputeJob.progress.currentTileProgressPercent ??
                                  ((precomputeJob.progress.tileIndex /
                                    Math.max(precomputeJob.progress.tilesTotal, 1)) *
                                    100),
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                      <p className="text-[11px] text-cyan-100/90">
                        La tuile en cours couvre tous les slots temporels de la fenêtre du jour.
                      </p>
                      <p className="text-[11px] text-cyan-100/90">
                        points tuile={precomputeJob.progress.currentTilePointCountTotal ?? "n/a"} (outdoor=
                        {precomputeJob.progress.currentTilePointCountOutdoor ?? "n/a"}) |
                        frame={precomputeJob.progress.currentTileFrameIndex ?? "n/a"}/
                        {precomputeJob.progress.currentTileFrameCountTotal ?? "n/a"}
                      </p>
                      <p>
                        jour={precomputeJob.progress.dayIndex}/{precomputeJob.progress.daysTotal} |
                        tuile spatiale={precomputeJob.progress.tileIndex}/{precomputeJob.progress.tilesTotal} |
                        étape={formatTileState(precomputeJob.progress.currentTileState)}
                        {precomputeJob.progress.currentTilePhase
                          ? ` (${formatTilePhase(precomputeJob.progress.currentTilePhase)})`
                          : ""}
                        {" "} | elapsed=
                        {Math.round(precomputeJob.progress.elapsedMs / 1000)}s | eta=
                        {precomputeJob.progress.etaSeconds === null
                          ? "n/a"
                          : `${precomputeJob.progress.etaSeconds}s`}
                      </p>
                    </>
                  ) : (
                    <p>Initialisation de la première tuile...</p>
                  )}
                  {precomputeJob.error ? <p>{precomputeJob.error}</p> : null}
                </div>
              ) : null}
              {precomputeResult ? (
                <p className="text-xs text-cyan-100">
                  Terminé: {precomputeResult.totalDates} jour(s), {precomputeResult.totalTiles} tuiles,
                  modèle {precomputeResult.modelVersionHash}
                </p>
              ) : null}
            </div>
          </article>

          <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
            <h2 className="text-lg font-semibold">Purge</h2>
            {purgeResult ? (
              <p className="mt-3 text-sm">
                {purgeResult.runsMatched} runs matches, dryRun={String(purgeResult.dryRun)}
              </p>
            ) : null}
          </article>
        </div>
      </section>
    </div>
  );
}



