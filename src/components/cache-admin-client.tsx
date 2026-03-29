"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CANONICAL_PRECOMPUTE_TILE_SIZE_METERS } from "@/lib/precompute/constants";
import { PrecomputeTileSelectorMap, type TileSelectorBbox, type TileSelectorEntry } from "@/components/precompute-tile-selector-map";

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
  bbox?: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
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
    tileIds?: string[];
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

interface CachePrecomputeTilesResponse {
  generatedAt: string;
  region: "lausanne" | "nyon";
  tileSizeMeters: number;
  bbox: TileSelectorBbox;
  tileCount: number;
  tiles: TileSelectorEntry[];
}

interface CacheRunDetailResponse {
  bbox: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
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
  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
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

function buildRunFocusHref(run: CacheRunSummary): string {
  const params = new URLSearchParams({
    focusRunRegion: run.region,
    focusRunModel: run.modelVersionHash,
    focusRunDate: run.date,
    focusRunGrid: String(run.gridStepMeters),
    focusRunSample: String(run.sampleEveryMinutes),
    focusRunStart: run.startLocalTime,
    focusRunEnd: run.endLocalTime,
  });
  return `/?${params.toString()}`;
}

function formatCoordinate(value: number): string {
  return value.toFixed(6);
}

function formatDistanceMeters(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} km`;
  }
  return `${Math.round(value)} m`;
}

function computeBboxMetrics(bbox: CacheRunSummary["bbox"]) {
  if (!bbox) {
    return null;
  }
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const latSpanDeg = Math.max(0, bbox.maxLat - bbox.minLat);
  const lonSpanDeg = Math.max(0, bbox.maxLon - bbox.minLon);
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon =
    metersPerDegreeLat * Math.max(Math.cos((centerLat * Math.PI) / 180), 0.01);
  const heightMeters = latSpanDeg * metersPerDegreeLat;
  const widthMeters = lonSpanDeg * metersPerDegreeLon;
  const areaKm2 = (Math.max(0, widthMeters) * Math.max(0, heightMeters)) / 1_000_000;

  return {
    centerLat,
    centerLon,
    widthMeters,
    heightMeters,
    areaKm2,
  };
}

function buildRunDeepLinkHref(
  run: CacheRunSummary,
  bboxOverride?: CacheRunSummary["bbox"],
): string {
  const bbox = bboxOverride ?? run.bbox;
  if (!bbox) {
    return buildRunFocusHref(run);
  }
  const params = new URLSearchParams({
    mode: "daily",
    date: run.date,
    dailyStart: run.startLocalTime,
    dailyEnd: run.endLocalTime,
    grid: String(run.gridStepMeters),
    sample: String(run.sampleEveryMinutes),
    bias: "0",
    basemap: "satellite",
    ignoreVegetation: "0",
    showSunny: "1",
    showShadow: "1",
    showBuildings: "1",
    showTerrain: "1",
    showVegetation: "1",
    showHeatmap: "1",
    showPlaces: "1",
    autoRun: "1",
    bbox: `${formatCoordinate(bbox.minLon)},${formatCoordinate(bbox.minLat)},${formatCoordinate(bbox.maxLon)},${formatCoordinate(bbox.maxLat)}`,
  });
  return `/?${params.toString()}`;
}

export function CacheAdminClient() {
  const lastJobStreamSignalAtRef = useRef<number>(0);
  const precomputeTilesRequestIdRef = useRef(0);
  const loadingRunBboxDirsRef = useRef(new Set<string>());
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
  const [copiedLinkRunDir, setCopiedLinkRunDir] = useState<string | null>(null);
  const [runBboxByDir, setRunBboxByDir] = useState<
    Record<string, NonNullable<CacheRunSummary["bbox"]>>
  >({});
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
  const [showPrecomputeTileSelector, setShowPrecomputeTileSelector] = useState(false);
  const [precomputeTilesState, setPrecomputeTilesState] = useState<ActionState>("idle");
  const [precomputeTilesError, setPrecomputeTilesError] = useState<string | null>(null);
  const [precomputeTilesCatalog, setPrecomputeTilesCatalog] =
    useState<CachePrecomputeTilesResponse | null>(null);
  const [precomputeTileSelectionByRegion, setPrecomputeTileSelectionByRegion] = useState<{
    lausanne: string[] | null;
    nyon: string[] | null;
  }>({
    lausanne: null,
    nyon: null,
  });
  const hasActivePrecompute = activeJobs.length > 0;
  const selectedPrecomputeTileIds = useMemo(
    () => precomputeTileSelectionByRegion[preRegion] ?? [],
    [preRegion, precomputeTileSelectionByRegion],
  );
  const precomputeTileCountTotal = precomputeTilesCatalog?.tiles.length ?? 0;
  const noTileSelected =
    precomputeTilesCatalog !== null && selectedPrecomputeTileIds.length === 0;
  const precomputeButtonDisabled =
    precomputeState === "loading" ||
    precomputeTilesState === "loading" ||
    hasActivePrecompute ||
    noTileSelected;
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
  const precomputeTileSelectionSummary = useMemo(() => {
    if (!precomputeTilesCatalog) {
      return "Chargement des tuiles...";
    }
    const selectedCount = selectedPrecomputeTileIds.length;
    return `${selectedCount}/${precomputeTileCountTotal} tuiles sélectionnées`;
  }, [precomputeTileCountTotal, precomputeTilesCatalog, selectedPrecomputeTileIds.length]);
  const precomputeScopeLabel = useMemo(() => {
    if (!precomputeTilesCatalog) {
      return "en attente du catalogue des tuiles";
    }
    if (selectedPrecomputeTileIds.length >= precomputeTilesCatalog.tiles.length) {
      return "toutes les tuiles de la région";
    }
    return `${selectedPrecomputeTileIds.length} tuiles sélectionnées`;
  }, [precomputeTilesCatalog, selectedPrecomputeTileIds.length]);

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

  useEffect(() => {
    if (!overview?.runs?.length) {
      return;
    }

    const missingRuns = overview.runs.filter(
      (run) =>
        !run.bbox &&
        !runBboxByDir[run.runDir] &&
        !loadingRunBboxDirsRef.current.has(run.runDir),
    );
    if (missingRuns.length === 0) {
      return;
    }

    let cancelled = false;
    const loadMissingRunBboxes = async () => {
      const fetchedEntries: Array<{
        runDir: string;
        bbox: NonNullable<CacheRunSummary["bbox"]>;
      }> = [];

      await Promise.all(
        missingRuns.map(async (run) => {
          loadingRunBboxDirsRef.current.add(run.runDir);
          try {
            const params = new URLSearchParams({
              region: run.region,
              modelVersionHash: run.modelVersionHash,
              date: run.date,
              gridStepMeters: String(run.gridStepMeters),
              sampleEveryMinutes: String(run.sampleEveryMinutes),
              startLocalTime: run.startLocalTime,
              endLocalTime: run.endLocalTime,
            });
            const response = await fetch(
              `/api/admin/cache/runs/detail?${params.toString()}`,
              { cache: "no-store" },
            );
            if (!response.ok) {
              return;
            }
            const payload = (await response.json()) as CacheRunDetailResponse;
            if (!payload?.bbox) {
              return;
            }
            fetchedEntries.push({
              runDir: run.runDir,
              bbox: payload.bbox,
            });
          } catch {
            // Ignore bbox fallback errors; the row still has focus-run link.
          } finally {
            loadingRunBboxDirsRef.current.delete(run.runDir);
          }
        }),
      );

      if (cancelled || fetchedEntries.length === 0) {
        return;
      }
      setRunBboxByDir((current) => {
        const next = { ...current };
        for (const entry of fetchedEntries) {
          next[entry.runDir] = entry.bbox;
        }
        return next;
      });
    };

    void loadMissingRunBboxes();
    return () => {
      cancelled = true;
    };
  }, [overview?.runs, runBboxByDir]);

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

  const refreshPrecomputeTiles = useCallback(async (regionValue: "lausanne" | "nyon") => {
    const requestId = ++precomputeTilesRequestIdRef.current;
    setPrecomputeTilesState("loading");
    setPrecomputeTilesError(null);
    try {
      const response = await fetch(
        `/api/admin/cache/tiles?region=${encodeURIComponent(regionValue)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as
        | CachePrecomputeTilesResponse
        | { error?: string; details?: string };
      if (!response.ok) {
        const errorPayload = payload as { error?: string; details?: string };
        throw new Error(errorPayload.details ?? errorPayload.error ?? "Unknown error");
      }
      if (requestId !== precomputeTilesRequestIdRef.current) {
        return;
      }
      const catalog = payload as CachePrecomputeTilesResponse;
      const availableTileIds = catalog.tiles.map((tile) => tile.tileId);
      setPrecomputeTilesCatalog(catalog);
      setPrecomputeTileSelectionByRegion((current) => {
        const currentSelection = current[regionValue];
        if (currentSelection === null) {
          return {
            ...current,
            [regionValue]: availableTileIds,
          };
        }
        const currentSet = new Set(currentSelection);
        const filtered = availableTileIds.filter((tileId) => currentSet.has(tileId));
        return {
          ...current,
          [regionValue]: filtered,
        };
      });
    } catch (error) {
      if (requestId !== precomputeTilesRequestIdRef.current) {
        return;
      }
      setPrecomputeTilesCatalog(null);
      setPrecomputeTilesError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      if (requestId === precomputeTilesRequestIdRef.current) {
        setPrecomputeTilesState("idle");
      }
    }
  }, []);

  useEffect(() => {
    if (!showPrecomputeTileSelector) {
      return;
    }
    void refreshPrecomputeTiles(preRegion);
  }, [preRegion, refreshPrecomputeTiles, showPrecomputeTileSelector]);

  useEffect(() => {
    if (!showPrecomputeTileSelector) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowPrecomputeTileSelector(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showPrecomputeTileSelector]);

  const setSelectedPrecomputeTiles = useCallback(
    (tileIds: string[]) => {
      setPrecomputeTileSelectionByRegion((current) => ({
        ...current,
        [preRegion]: tileIds,
      }));
    },
    [preRegion],
  );

  const selectAllPrecomputeTiles = useCallback(() => {
    if (!precomputeTilesCatalog) {
      return;
    }
    setSelectedPrecomputeTiles(precomputeTilesCatalog.tiles.map((tile) => tile.tileId));
  }, [precomputeTilesCatalog, setSelectedPrecomputeTiles]);

  const clearPrecomputeTiles = useCallback(() => {
    setSelectedPrecomputeTiles([]);
  }, [setSelectedPrecomputeTiles]);

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
    if (precomputeTilesCatalog && selectedPrecomputeTileIds.length === 0) {
      setActionError("Sélectionne au moins une tuile avant de lancer le précompute.");
      return;
    }
    const tileIdsForRequest =
      precomputeTilesCatalog &&
      selectedPrecomputeTileIds.length > 0 &&
      selectedPrecomputeTileIds.length < precomputeTilesCatalog.tiles.length
        ? selectedPrecomputeTileIds
        : undefined;
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
            tileIds: tileIdsForRequest,
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
          tileIds: tileIdsForRequest,
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
    precomputeTilesCatalog,
    selectedPrecomputeTileIds,
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

  const copyRunDeepLink = useCallback(
    async (
      run: CacheRunSummary,
      bboxOverride?: CacheRunSummary["bbox"],
    ) => {
    const bbox = bboxOverride ?? run.bbox;
    if (!bbox) {
      setActionError(
        "La bbox de ce run n'est pas disponible dans la réponse courante. Utilise le lien contour run.",
      );
      return;
    }
    try {
      const href = buildRunDeepLinkHref(run, bbox);
      const absoluteHref =
        typeof window === "undefined" ? href : `${window.location.origin}${href}`;
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(absoluteHref);
      } else {
        throw new Error("Clipboard API indisponible.");
      }
      setCopiedLinkRunDir(run.runDir);
      setActionError(null);
      window.setTimeout(() => {
        setCopiedLinkRunDir((current) => (current === run.runDir ? null : current));
      }, 1800);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? `Impossible de copier le lien: ${error.message}`
          : "Impossible de copier le lien.",
      );
    }
  }, []);

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
                  <th className="px-5 py-3">Zone &amp; liens</th>
                  <th className="px-5 py-3">État</th>
                  <th className="px-5 py-3">Stockage</th>
                </tr>
              </thead>
              <tbody>
                {overview?.runs.length ? (
                  overview.runs.map((run) => {
                    const effectiveBbox = run.bbox ?? runBboxByDir[run.runDir];
                    const bboxMetrics = computeBboxMetrics(effectiveBbox);
                    const hasBbox = Boolean(effectiveBbox && bboxMetrics);
                    return (
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
                          {hasBbox && effectiveBbox && bboxMetrics ? (
                            <>
                              <p className="text-xs text-slate-300">
                                bbox [{formatCoordinate(effectiveBbox.minLon)}, {formatCoordinate(effectiveBbox.minLat)}] → [{formatCoordinate(effectiveBbox.maxLon)}, {formatCoordinate(effectiveBbox.maxLat)}]
                              </p>
                              <p className="text-xs text-slate-300">
                                centre {formatCoordinate(bboxMetrics.centerLat)}, {formatCoordinate(bboxMetrics.centerLon)}
                              </p>
                              <p className="text-xs text-slate-300">
                                ~{formatDistanceMeters(bboxMetrics.widthMeters)} × {formatDistanceMeters(bboxMetrics.heightMeters)} ({bboxMetrics.areaKm2.toFixed(3)} km²)
                              </p>
                            </>
                          ) : (
                            <p className="text-xs text-amber-100">
                              Zone non fournie par l&apos;API runs (bbox absente).
                            </p>
                          )}
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Link
                              href={buildRunFocusHref(run)}
                              className="inline-flex rounded-full border border-sky-300/30 px-3 py-1 text-xs text-sky-100 transition hover:border-sky-200/70 hover:bg-sky-500/20"
                            >
                              Ouvrir (contour run)
                            </Link>
                            <Link
                              href={buildRunDeepLinkHref(run, effectiveBbox)}
                              className={`inline-flex rounded-full border px-3 py-1 text-xs transition ${
                                hasBbox
                                  ? "border-cyan-300/30 text-cyan-100 hover:border-cyan-200/70 hover:bg-cyan-500/20"
                                  : "pointer-events-none border-slate-600/40 text-slate-400"
                              }`}
                            >
                              Ouvrir (deeplink zone)
                            </Link>
                            <button
                              type="button"
                              onClick={() => void copyRunDeepLink(run, effectiveBbox)}
                              disabled={!hasBbox}
                              className="inline-flex rounded-full border border-white/20 px-3 py-1 text-xs text-slate-100 transition hover:border-white/40 hover:bg-white/10"
                            >
                              {copiedLinkRunDir === run.runDir ? "Lien copié" : "Copier lien"}
                            </button>
                          </div>
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
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-slate-400">
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
              <div className="grid gap-2 rounded-xl border border-white/12 bg-slate-900/50 px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-slate-200">
                    Sélection des tuiles ({precomputeTileSelectionSummary})
                  </p>
                  <button
                    type="button"
                    data-testid="open-precompute-tile-selector"
                    onClick={() => setShowPrecomputeTileSelector(true)}
                    className="rounded-full border border-cyan-300/40 px-3 py-1 text-[11px] text-cyan-100"
                  >
                    Sélectionner zones à précalculer
                  </button>
                </div>
                <p className="text-xs text-slate-300">
                  Clique sur “Sélectionner zones à précalculer” pour ouvrir la carte OSM en plein écran et choisir les tuiles.
                </p>
                {noTileSelected ? (
                  <p className="text-xs text-amber-100">
                    Aucune tuile sélectionnée. Sélectionne au moins une tuile pour lancer le précompute.
                  </p>
                ) : null}
              </div>
              <p className="rounded-xl border border-white/12 bg-slate-900/50 px-3 py-2 text-xs text-slate-300">
                Portée d&apos;un run: {precomputeScopeLabel} ({preRegion}), {preDays} jour(s) à partir du {preStartDate},
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
              {!hasActivePrecompute && noTileSelected ? (
                <p className="text-xs text-amber-100">
                  Le lancement est bloqué tant qu&apos;aucune tuile n&apos;est sélectionnée.
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
                    pas {precomputeJob.request.sampleEveryMinutes}min, tuiles{" "}
                    {precomputeJob.request.tileIds?.length
                      ? `${precomputeJob.request.tileIds.length} sélectionnées`
                      : "toutes"}.
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
                        {formatElapsed(Math.round(precomputeJob.progress.elapsedMs / 1000))} | eta=
                        {formatElapsed(precomputeJob.progress.etaSeconds)}
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

      {showPrecomputeTileSelector ? (
        <div
          data-testid="precompute-tile-selector-modal"
          className="fixed inset-0 z-[1200] bg-black/70"
          onClick={() => setShowPrecomputeTileSelector(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="flex h-screen w-screen flex-col bg-slate-950/95 p-4 text-slate-100 shadow-2xl md:p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">Sélection des zones à précalculer</p>
                <p className="text-xs text-slate-300">
                  Région {preRegion} · {precomputeTileSelectionSummary}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={selectAllPrecomputeTiles}
                  disabled={!precomputeTilesCatalog || precomputeTilesState === "loading"}
                  className="rounded-full border border-white/20 px-3 py-1 text-xs disabled:opacity-50"
                >
                  Tout sélectionner
                </button>
                <button
                  type="button"
                  onClick={clearPrecomputeTiles}
                  disabled={!precomputeTilesCatalog || precomputeTilesState === "loading"}
                  className="rounded-full border border-white/20 px-3 py-1 text-xs disabled:opacity-50"
                >
                  Tout désélectionner
                </button>
                <button
                  type="button"
                  data-testid="close-precompute-tile-selector"
                  onClick={() => setShowPrecomputeTileSelector(false)}
                  className="rounded-full border border-rose-300/40 px-3 py-1 text-xs text-rose-100"
                >
                  Fermer
                </button>
              </div>
            </div>

            {precomputeTilesState === "loading" ? (
              <p className="mb-2 text-xs text-cyan-100">Chargement de la grille des tuiles...</p>
            ) : null}
            {precomputeTilesError ? (
              <p className="mb-2 text-xs text-rose-200">{precomputeTilesError}</p>
            ) : null}
            {precomputeTilesCatalog ? (
              <PrecomputeTileSelectorMap
                regionBbox={precomputeTilesCatalog.bbox}
                tiles={precomputeTilesCatalog.tiles}
                selectedTileIds={selectedPrecomputeTileIds}
                disabled={precomputeTilesState === "loading"}
                fullscreen
                onSelectionChange={setSelectedPrecomputeTiles}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}



