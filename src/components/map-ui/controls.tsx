"use client";

export type AreaMode = "instant" | "daily";
export type BaseMapStyle = "map" | "satellite";
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
  baseMapStyle: BaseMapStyle;
  isLoading: boolean;
  isDailyRangeInvalid: boolean;
  onDateChange: (date: string) => void;
  onBaseMapStyleChange: (style: BaseMapStyle) => void;
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

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-xs font-semibold uppercase text-slate-500">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

const inputClass =
  "rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-900 shadow-sm outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-200";
const chipClass =
  "inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-slate-700 shadow-sm transition hover:border-amber-200 hover:bg-amber-50";

export function CalculationControls(props: CalculationControlsProps) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Date">
        <input
          type="date"
          value={props.date}
          className={inputClass}
          onChange={(event) => props.onDateChange(event.target.value)}
        />
      </Field>
      <Field label="Fond">
        <select
          className={inputClass}
          value={props.baseMapStyle}
          onChange={(event) => props.onBaseMapStyleChange(event.target.value as BaseMapStyle)}
        >
          <option value="map">carte</option>
          <option value="satellite">satellite</option>
        </select>
      </Field>
      <button
        type="button"
        className="rounded-xl bg-amber-300 px-4 py-2 font-semibold text-slate-950 shadow-sm transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
        onClick={props.onRunCalculation}
        disabled={props.isLoading || (props.mode === "daily" && props.isDailyRangeInvalid)}
      >
        {props.isLoading ? "Calcul..." : props.mode === "daily" ? "Calculer timeline" : "Calculer zone visible"}
      </button>
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
