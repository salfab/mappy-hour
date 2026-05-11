"use client";

import { ChevronDownIcon, SunIcon } from "./icons";

export type AreaMode = "instant" | "daily";
export type MapPanelTab = "map" | "terraces";

export interface TimelineProgressView {
  phase: string;
  percent: number;
  etaSeconds: number | null;
  elapsedMs?: number;
  tileIndex?: number;
  totalTiles?: number;
}

interface CalculationControlsProps {
  mode: AreaMode;
  date: string;
  isLoading: boolean;
  isDailyRangeInvalid: boolean;
  onDateChange: (date: string) => void;
  onRunCalculation: () => void;
  onCancelDailyCalculation: () => void;
}

interface LayerFiltersProps {
  showSunny: boolean;
  showShadow: boolean;
  showTerrain: boolean;
  showHeatmap: boolean;
  showPlaces: boolean;
  ignoreVegetationShadow: boolean;
  canShowHeatmap: boolean;
  cacheOnly: boolean;
  forceCacheOnly: boolean;
  onShowSunShadowChange: (value: boolean) => void;
  onShowTerrainChange: (value: boolean) => void;
  onShowHeatmapChange: (value: boolean) => void;
  onShowPlacesChange: (value: boolean) => void;
  onIgnoreVegetationShadowChange: (value: boolean) => void;
  onCacheOnlyChange: (value: boolean) => void;
}

interface TimeSliderProps {
  mode: AreaMode;
  activeFrameTime: string | null;
  frameCount: number;
  tileCount: number;
  pointCount: number;
  frameIndex: number;
  disabled: boolean;
  onFrameIndexChange: (value: number) => void;
}

interface ProgressStatusProps {
  mode: AreaMode;
  dailyProgress: TimelineProgressView | null;
  instantProgress: TimelineProgressView | null;
  formatDuration: (seconds: number) => string;
}

interface ViewTabsProps {
  activeTab: MapPanelTab;
  venueCount: number;
  onTabChange: (tab: MapPanelTab) => void;
}

interface DailyCoverageProps {
  focusRunMessage: string | null;
  focusRunMessageIsError: boolean;
  error: string | null;
  warnings: string[];
  placesError: string | null;
}

const chipClass =
  "inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-slate-700 shadow-sm transition hover:border-amber-200 hover:bg-amber-50";

function formatDisplayDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) {
    return "Choisir un jour";
  }

  const formatted = new Intl.DateTimeFormat("fr-CH", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(year, month - 1, day));

  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function DaySelector(props: {
  date: string;
  onDateChange: (date: string) => void;
}) {
  return (
    <label className="relative flex min-w-[190px] flex-1 cursor-pointer items-center gap-3 rounded-[1.75rem] border border-amber-100 bg-white/80 px-3 py-3 shadow-sm transition focus-within:ring-2 focus-within:ring-amber-300 hover:bg-amber-50/80">
      <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-500">
        <SunIcon className="h-8 w-8" />
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="text-sm font-medium text-slate-500">Jour</span>
        <span className="flex min-w-0 items-center gap-2 text-lg font-semibold text-slate-900">
          <span className="truncate">{formatDisplayDate(props.date)}</span>
          <ChevronDownIcon className="h-5 w-5 shrink-0 text-slate-500" />
        </span>
      </span>
      <input
        type="date"
        value={props.date}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Choisir le jour"
        onChange={(event) => props.onDateChange(event.target.value)}
      />
    </label>
  );
}

export function CalculationControls(props: CalculationControlsProps) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <DaySelector date={props.date} onDateChange={props.onDateChange} />
        <button
          type="button"
          className="min-h-14 rounded-[1.35rem] bg-amber-400 px-5 py-3 text-base font-semibold text-white shadow-sm shadow-amber-300/40 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
          onClick={props.onRunCalculation}
          disabled={props.isLoading || (props.mode === "daily" && props.isDailyRangeInvalid)}
        >
          {props.isLoading ? "Calcul..." : "Calculer"}
        </button>
      </div>
      {props.mode === "daily" && props.isLoading ? (
        <button
          type="button"
          className="rounded-xl bg-rose-500 px-4 py-2 font-semibold text-white shadow-sm transition hover:bg-rose-400"
          onClick={props.onCancelDailyCalculation}
        >
          Interrompre
        </button>
      ) : null}
    </div>
  );
}

export function LayerFilters(props: LayerFiltersProps) {
  const showLight = props.showSunny || props.showShadow;
  const filters = [
    ["Lumiere", showLight, props.onShowSunShadowChange],
    ["Relief", props.showTerrain, props.onShowTerrainChange],
  ] as const;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {filters.map(([label, checked, onChange]) => (
        <label key={label} className={chipClass}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{label}</span>
        </label>
      ))}
      <label className={chipClass}>
        <input
          type="checkbox"
          checked={props.showHeatmap}
          disabled={!props.canShowHeatmap}
          onChange={(event) => props.onShowHeatmapChange(event.target.checked)}
        />
        <span>Heatmap</span>
      </label>
      <label className={chipClass}>
        <input
          type="checkbox"
          checked={props.ignoreVegetationShadow}
          onChange={(event) => props.onIgnoreVegetationShadowChange(event.target.checked)}
        />
        <span>Ignorer vegetation</span>
      </label>
      <label className={chipClass}>
        <input
          type="checkbox"
          checked={props.showPlaces}
          onChange={(event) => props.onShowPlacesChange(event.target.checked)}
        />
        <span>Terrasses</span>
      </label>
    </div>
  );
}

export function ViewTabs(props: ViewTabsProps) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-2xl border border-slate-200 bg-white p-1 text-sm font-semibold shadow-sm">
      <button
        type="button"
        className={`rounded-xl px-3 py-2 transition ${
          props.activeTab === "map"
            ? "bg-amber-200 text-slate-950"
            : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
        }`}
        onClick={() => props.onTabChange("map")}
      >
        Carte
      </button>
      <button
        type="button"
        className={`rounded-xl px-3 py-2 transition ${
          props.activeTab === "terraces"
            ? "bg-amber-200 text-slate-950"
            : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
        }`}
        onClick={() => props.onTabChange("terraces")}
      >
        Terrasses
        <span className="ml-2 rounded-full bg-white/70 px-2 py-0.5 text-xs">
          {props.venueCount}
        </span>
      </button>
    </div>
  );
}

export function TimeSlider(props: TimeSliderProps) {
  if (props.mode !== "daily") {
    return null;
  }

  const max = Math.max(0, props.frameCount - 1);

  return (
    <div className="grid gap-2 text-sm">
      <div className="flex items-center justify-between text-slate-700">
        <span className="font-medium">Timeline</span>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
          {props.activeFrameTime ?? "--:--:--"}
        </span>
      </div>
      <input
        className="accent-amber-300"
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(props.frameIndex, max)}
        onChange={(event) => props.onFrameIndexChange(Number(event.target.value))}
        disabled={props.disabled}
      />
      <p className="text-xs text-slate-500">
        Tuiles recues: {props.tileCount}, {props.pointCount} points
      </p>
    </div>
  );
}

export function ProgressStatus(props: ProgressStatusProps) {
  const progress = props.mode === "daily" ? props.dailyProgress : props.instantProgress;
  if (!progress) {
    return null;
  }

  const isIndeterminate =
    progress.phase === "loading-scene" ||
    progress.phase === "loading-cache" ||
    progress.phase === "reconnecting";

  return (
    <div className="grid gap-1 text-sm">
      <progress
        className="h-2 w-full overflow-hidden rounded accent-amber-300"
        max={100}
        value={isIndeterminate ? undefined : Math.min(100, Math.max(0, progress.percent))}
      />
      <p className="text-xs text-slate-500">
        {progress.phase}
        {progress.tileIndex && progress.totalTiles ? ` (tuile ${progress.tileIndex}/${progress.totalTiles})` : ""}
        {!isIndeterminate ? ` - ${progress.percent.toFixed(1)}%` : ""}
        {!isIndeterminate
          ? ` - ETA: ${progress.etaSeconds === null ? "-" : props.formatDuration(progress.etaSeconds)}`
          : ""}
        {progress.elapsedMs != null
          ? ` - ${props.formatDuration(Math.round(progress.elapsedMs / 1000))} ecoule`
          : ""}
      </p>
    </div>
  );
}

export function DailyCoverage(props: DailyCoverageProps) {
  if (
    !props.focusRunMessage &&
    !props.error &&
    !props.placesError &&
    props.warnings.length === 0
  ) {
    return null;
  }

  return (
    <div className="grid gap-2 text-sm">
      {props.focusRunMessage ? (
        <p
          className={`rounded px-3 py-2 ${
            props.focusRunMessageIsError
              ? "border border-rose-300/40 bg-rose-500/20 text-rose-100"
              : "border border-cyan-300/35 bg-cyan-500/10 text-cyan-100"
          }`}
        >
          {props.focusRunMessage}
        </p>
      ) : null}
      {props.error ? (
        <p className="rounded border border-red-300/40 bg-red-500/20 px-3 py-2 text-red-100">
          {props.error}
        </p>
      ) : null}
      {props.placesError ? (
        <p className="rounded border border-red-300/40 bg-red-500/20 px-3 py-2 text-red-100">
          Terrasses: {props.placesError}
        </p>
      ) : null}
      {props.warnings.length ? (
        <details className="rounded border border-amber-300/40 bg-amber-200/10 px-3 py-2 text-amber-100">
          <summary className="cursor-pointer font-semibold">Warnings ({props.warnings.length})</summary>
          <ul className="mt-2 list-disc pl-5">
            {props.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
