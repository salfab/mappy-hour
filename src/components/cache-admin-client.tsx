"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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
  fileCount: number;
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
    totalSizeBytes: number;
    totalFiles: number;
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
    failedTiles: number;
    complete: boolean;
    elapsedMs: number;
  }>;
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<ActionState>("idle");
  const [verifyState, setVerifyState] = useState<ActionState>("idle");
  const [purgeState, setPurgeState] = useState<ActionState>("idle");
  const [precomputeState, setPrecomputeState] = useState<ActionState>("idle");

  const [preRegion, setPreRegion] = useState<"lausanne" | "nyon">("lausanne");
  const [preStartDate, setPreStartDate] = useState("2026-03-08");
  const [preDays, setPreDays] = useState(1);
  const [preGridStep, setPreGridStep] = useState(5);
  const [preSampleEvery, setPreSampleEvery] = useState(15);
  const [preTileSize, setPreTileSize] = useState(250);
  const [preStartLocalTime, setPreStartLocalTime] = useState("00:00");
  const [preEndLocalTime, setPreEndLocalTime] = useState("23:59");

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
        throw new Error(payload?.details ?? payload?.error ?? "Unknown error");
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
            tileSizeMeters: preTileSize,
            startLocalTime: preStartLocalTime,
            endLocalTime: preEndLocalTime,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.details ?? payload?.error ?? "Unknown error");
      }
      setPrecomputeResult(payload as CachePrecomputeResult);
      await refreshRuns();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setPrecomputeState("idle");
    }
  }, [
    preDays,
    preEndLocalTime,
    preGridStep,
    preRegion,
    preSampleEvery,
    preStartDate,
    preStartLocalTime,
    preTileSize,
    refreshRuns,
  ]);

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
            {verifyState === "loading" ? "Verification..." : "Verifier"}
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
            <span className="text-slate-300">Region</span>
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
            <span className="text-slate-300">Date debut</span>
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
              <option value="generatedAt">Genere</option>
              <option value="sizeBytes">Taille</option>
              <option value="tileCount">Tuiles</option>
              <option value="failedTileCount">Echecs</option>
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
          <p className="text-xs text-slate-400">Echecs</p>
          <p className="mt-2 text-3xl font-semibold">
            {overview?.summary.totalFailedTiles ?? 0}
          </p>
        </article>
        <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
          <p className="text-xs text-slate-400">Taille</p>
          <p className="mt-2 text-3xl font-semibold">
            {formatBytes(overview?.summary.totalSizeBytes ?? 0)}
          </p>
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <article className="overflow-hidden rounded-3xl border border-white/12 bg-black/20">
          <div className="border-b border-white/10 px-5 py-4">
            <h2 className="text-lg font-semibold">Runs detectes</h2>
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
                  <th className="px-5 py-3">Parametres</th>
                  <th className="px-5 py-3">Etat</th>
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
                        <p>{run.failedTileCount} echecs</p>
                      </td>
                      <td className="px-5 py-4">
                        <p>{formatBytes(run.sizeBytes)}</p>
                        <p>{run.fileCount} fichiers</p>
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
              Page precedente
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
            <h2 className="text-lg font-semibold">Verification</h2>
            {verifyResult ? (
              <div className="mt-3 grid gap-2 text-sm">
                <p>{verifyResult.manifestsMatched} manifests</p>
                <p>{verifyResult.tilesVerified} tuiles verifiees</p>
                <p className="text-xs text-slate-400">
                  checks frames={verifyResult.strictChecks.expectedFrameCountChecks} masks=
                  {verifyResult.strictChecks.expectedMaskSizeChecks} indexes=
                  {verifyResult.strictChecks.pointIndexChecks}
                </p>
                <p className="text-xs text-slate-400">{formatDateTime(verifyResult.generatedAt)}</p>
                <p>{verifyResult.problems.length} problemes</p>
              </div>
            ) : null}
          </article>

          <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
            <h2 className="text-lg font-semibold">Precompute</h2>
            <div className="mt-3 grid gap-2 text-sm">
              <select
                value={preRegion}
                onChange={(event) => setPreRegion(event.target.value as "lausanne" | "nyon")}
                className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
              >
                <option value="lausanne">Lausanne</option>
                <option value="nyon">Nyon</option>
              </select>
              <input
                type="date"
                value={preStartDate}
                onChange={(event) => setPreStartDate(event.target.value)}
                className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
              />
              <input
                type="number"
                min={1}
                max={31}
                value={preDays}
                onChange={(event) => setPreDays(Math.max(1, Math.min(31, Number(event.target.value) || 1)))}
                className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
              />
              <input
                type="number"
                min={1}
                max={2000}
                value={preGridStep}
                onChange={(event) => setPreGridStep(Math.max(1, Number(event.target.value) || 1))}
                className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
              />
              <input
                type="number"
                min={1}
                max={60}
                value={preSampleEvery}
                onChange={(event) => setPreSampleEvery(Math.max(1, Math.min(60, Number(event.target.value) || 1)))}
                className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
              />
              <input
                type="number"
                min={10}
                max={5000}
                value={preTileSize}
                onChange={(event) => setPreTileSize(Math.max(10, Number(event.target.value) || 10))}
                className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="time"
                  value={preStartLocalTime}
                  onChange={(event) => setPreStartLocalTime(event.target.value)}
                  className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
                />
                <input
                  type="time"
                  value={preEndLocalTime}
                  onChange={(event) => setPreEndLocalTime(event.target.value)}
                  className="rounded-xl border border-white/12 bg-slate-950/70 px-3 py-2"
                />
              </div>
              <button
                type="button"
                onClick={() => void runPrecompute()}
                disabled={precomputeState === "loading"}
                className="rounded-full bg-cyan-300 px-4 py-2 text-sm font-medium text-slate-950"
              >
                {precomputeState === "loading" ? "Precompute en cours..." : "Lancer precompute"}
              </button>
              {precomputeResult ? (
                <p className="text-xs text-cyan-100">
                  Termine: {precomputeResult.totalDates} jour(s), {precomputeResult.totalTiles} tuiles,
                  model {precomputeResult.modelVersionHash}
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
