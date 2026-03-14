"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type RegionFilter = "all" | "lausanne" | "nyon";
type ActionState = "idle" | "loading";

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
  problems: string[];
}

interface CachePurgeResult {
  generatedAt: string;
  dryRun: boolean;
  runsMatched: number;
  removedRunDirs: string[];
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
  const query = params.toString();
  return query
    ? `/api/admin/cache/runs?${query}`
    : "/api/admin/cache/runs";
}

export function CacheAdminClient() {
  const [region, setRegion] = useState<RegionFilter>("all");
  const [modelVersionHash, setModelVersionHash] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [overview, setOverview] = useState<CacheRunsOverview | null>(null);
  const [verifyResult, setVerifyResult] = useState<CacheVerifyResult | null>(null);
  const [purgeResult, setPurgeResult] = useState<CachePurgeResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<ActionState>("idle");
  const [verifyState, setVerifyState] = useState<ActionState>("idle");
  const [purgeState, setPurgeState] = useState<ActionState>("idle");

  const filters = useMemo(
    () => ({
      region,
      modelVersionHash,
      startDate,
      endDate,
    }),
    [endDate, modelVersionHash, region, startDate],
  );

  const refreshRuns = useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);

    try {
      const response = await fetch(buildRunsUrl(filters), {
        cache: "no-store",
      });
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
    async (action: "verify" | "purge", options?: { dryRun?: boolean }) => {
      setActionError(null);
      if (action === "verify") {
        setVerifyState("loading");
      } else {
        setPurgeState("loading");
      }

      try {
        const response = await fetch("/api/admin/cache/actions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action,
            filters: {
              region: region === "all" ? undefined : region,
              modelVersionHash: modelVersionHash.trim() || undefined,
              startDate: startDate || undefined,
              endDate: endDate || undefined,
            },
            dryRun: options?.dryRun,
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
          setVerifyResult(null);
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

  const handlePurge = useCallback(
    async (dryRun: boolean) => {
      if (!dryRun) {
        const confirmed = window.confirm(
          "Supprimer les runs de cache filtres actuellement affiches ?",
        );
        if (!confirmed) {
          return;
        }
      }
      await runAction("purge", { dryRun });
    },
    [runAction],
  );

  return (
    <div className="grid gap-6">
      <section className="grid gap-4 rounded-3xl border border-white/12 bg-black/20 p-5 shadow-[0_20px_80px_rgba(0,0,0,0.25)]">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.25em] text-sky-200/80">
              Dashboard cache
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Etat du cache precalcule
            </h1>
            <p className="max-w-3xl text-sm text-slate-300">
              Visualise les runs precalcules, verifie leur integrite et purge
              les lots obsoletes sans quitter l&apos;application.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void refreshRuns()}
              disabled={loadState === "loading"}
              className="rounded-full border border-white/15 px-4 py-2 text-sm text-slate-100 transition hover:border-sky-300/50 hover:bg-sky-400/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loadState === "loading" ? "Actualisation..." : "Actualiser"}
            </button>
            <button
              type="button"
              onClick={() => void runAction("verify")}
              disabled={verifyState === "loading"}
              className="rounded-full bg-sky-300 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {verifyState === "loading" ? "Verification..." : "Verifier"}
            </button>
            <button
              type="button"
              onClick={() => void handlePurge(true)}
              disabled={purgeState === "loading"}
              className="rounded-full border border-amber-300/40 px-4 py-2 text-sm text-amber-100 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Dry run purge
            </button>
            <button
              type="button"
              onClick={() => void handlePurge(false)}
              disabled={purgeState === "loading"}
              className="rounded-full border border-rose-400/40 px-4 py-2 text-sm text-rose-100 transition hover:bg-rose-400/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {purgeState === "loading" ? "Purge..." : "Purger"}
            </button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="grid gap-2 text-sm">
            <span className="text-slate-300">Region</span>
            <select
              value={region}
              onChange={(event) => setRegion(event.target.value as RegionFilter)}
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2 text-slate-100 outline-none"
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
              onChange={(event) => setModelVersionHash(event.target.value)}
              placeholder="ex: 1aead7ba2238b854"
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2 text-slate-100 outline-none placeholder:text-slate-500"
            />
          </label>
          <label className="grid gap-2 text-sm">
            <span className="text-slate-300">Date debut</span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2 text-slate-100 outline-none"
            />
          </label>
          <label className="grid gap-2 text-sm">
            <span className="text-slate-300">Date fin</span>
            <input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              className="rounded-2xl border border-white/12 bg-slate-950/70 px-3 py-2 text-slate-100 outline-none"
            />
          </label>
        </div>

        {loadError ? (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
            {loadError}
          </div>
        ) : null}
        {actionError ? (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
            {actionError}
          </div>
        ) : null}
      </section>

      <section className="grid gap-4 md:grid-cols-5">
        <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Runs</p>
          <p className="mt-3 text-3xl font-semibold">
            {overview?.summary.runCount ?? 0}
          </p>
        </article>
        <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Tuiles</p>
          <p className="mt-3 text-3xl font-semibold">
            {overview?.summary.totalTiles ?? 0}
          </p>
        </article>
        <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Complets</p>
          <p className="mt-3 text-3xl font-semibold">
            {overview?.summary.completeRuns ?? 0}
          </p>
        </article>
        <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Echecs</p>
          <p className="mt-3 text-3xl font-semibold">
            {overview?.summary.totalFailedTiles ?? 0}
          </p>
        </article>
        <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Taille</p>
          <p className="mt-3 text-3xl font-semibold">
            {formatBytes(overview?.summary.totalSizeBytes ?? 0)}
          </p>
          <p className="mt-2 text-xs text-slate-400">
            {overview?.summary.totalFiles ?? 0} fichiers
          </p>
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <article className="overflow-hidden rounded-3xl border border-white/12 bg-black/20">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
            <div>
              <h2 className="text-lg font-semibold">Runs detectes</h2>
              <p className="text-sm text-slate-400">
                {overview?.root ?? "Chargement..."}
              </p>
            </div>
            <p className="text-xs text-slate-400">
              {overview ? `Maj ${formatDateTime(overview.generatedAt)}` : ""}
            </p>
          </div>

          <div className="max-h-[60vh] overflow-auto">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead className="sticky top-0 bg-slate-950/95 text-slate-400">
                <tr>
                  <th className="px-5 py-3 font-medium">Run</th>
                  <th className="px-5 py-3 font-medium">Parametres</th>
                  <th className="px-5 py-3 font-medium">Etat</th>
                  <th className="px-5 py-3 font-medium">Stockage</th>
                </tr>
              </thead>
              <tbody>
                {overview?.runs.length ? (
                  overview.runs.map((run) => (
                    <tr key={run.runDir} className="border-t border-white/8 align-top">
                      <td className="px-5 py-4">
                        <div className="grid gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-white/12 px-2 py-1 text-xs uppercase tracking-[0.2em] text-sky-200">
                              {run.region}
                            </span>
                            <span className="text-sm font-medium">{run.date}</span>
                          </div>
                          <p className="font-mono text-xs text-slate-400">
                            {run.modelVersionHash}
                          </p>
                          <p className="font-mono text-xs text-slate-500">
                            {run.runDir}
                          </p>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-slate-300">
                        <div className="grid gap-1">
                          <p>{run.startLocalTime} - {run.endLocalTime}</p>
                          <p>grille {run.gridStepMeters} m</p>
                          <p>pas temps {run.sampleEveryMinutes} min</p>
                          <p>tuile {run.tileSizeMeters} m</p>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="grid gap-2">
                          <span
                            className={`inline-flex w-fit rounded-full px-2 py-1 text-xs ${
                              run.complete
                                ? "bg-emerald-400/15 text-emerald-200"
                                : "bg-amber-400/15 text-amber-100"
                            }`}
                          >
                            {run.complete ? "complet" : "incomplet"}
                          </span>
                          <p className="text-slate-300">{run.tileCount} tuiles</p>
                          <p className="text-slate-400">
                            {run.failedTileCount} echecs
                          </p>
                          <p className="text-xs text-slate-500">
                            genere {formatDateTime(run.generatedAt)}
                          </p>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-slate-300">
                        <div className="grid gap-1">
                          <p>{formatBytes(run.sizeBytes)}</p>
                          <p className="text-slate-400">{run.fileCount} fichiers</p>
                          <p className="text-slate-400">{run.timezone}</p>
                        </div>
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
        </article>

        <div className="grid gap-4">
          <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
            <h2 className="text-lg font-semibold">Verification</h2>
            {verifyResult ? (
              <div className="mt-4 grid gap-3 text-sm">
                <p className="text-slate-300">
                  {verifyResult.manifestsMatched} manifests,{" "}
                  {verifyResult.tilesVerified} tuiles verifiees
                </p>
                <p className="text-xs text-slate-400">
                  {formatDateTime(verifyResult.generatedAt)}
                </p>
                {verifyResult.problems.length > 0 ? (
                  <ul className="grid gap-2 text-rose-100">
                    {verifyResult.problems.map((problem) => (
                      <li
                        key={problem}
                        className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-3 py-2"
                      >
                        {problem}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-emerald-100">
                    Aucun probleme detecte.
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-400">
                Lance une verification pour controler manifests, versions et
                presence des tuiles.
              </p>
            )}
          </article>

          <article className="rounded-3xl border border-white/12 bg-white/6 p-5">
            <h2 className="text-lg font-semibold">Purge</h2>
            {purgeResult ? (
              <div className="mt-4 grid gap-3 text-sm">
                <p className="text-slate-300">
                  {purgeResult.runsMatched} runs matches
                </p>
                <p className="text-xs text-slate-400">
                  {formatDateTime(purgeResult.generatedAt)}
                </p>
                <div
                  className={`rounded-2xl px-3 py-2 ${
                    purgeResult.dryRun
                      ? "border border-amber-400/20 bg-amber-400/10 text-amber-100"
                      : "border border-rose-400/20 bg-rose-400/10 text-rose-100"
                  }`}
                >
                  {purgeResult.dryRun
                    ? "Dry run uniquement, aucun fichier supprime."
                    : `${purgeResult.removedRunDirs.length} dossiers supprimes.`}
                </div>
                {purgeResult.removedRunDirs.length > 0 ? (
                  <ul className="grid gap-2 text-xs text-slate-300">
                    {purgeResult.removedRunDirs.map((runDir) => (
                      <li
                        key={runDir}
                        className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2 font-mono"
                      >
                        {runDir}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-400">
                Utilise d&apos;abord le dry run pour verifier la selection avant
                suppression.
              </p>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}
