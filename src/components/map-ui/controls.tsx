"use client";

export type AreaMode = "instant" | "daily";
export type BaseMapStyle = "map" | "satellite";

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
  localTime: string;
  dailyStartLocalTime: string;
  dailyEndLocalTime: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  buildingHeightBiasMeters: number;
  baseMapStyle: BaseMapStyle;
  isLoading: boolean;
  isDailyRangeInvalid: boolean;
  onModeChange: (mode: AreaMode) => void;
  onDateChange: (date: string) => void;
  onLocalTimeChange: (time: string) => void;
  onDailyStartChange: (time: string) => void;
  onDailyEndChange: (time: string) => void;
  onSampleEveryMinutesChange: (minutes: number) => void;
  onGridStepMetersChange: (meters: number) => void;
  onBuildingHeightBiasMetersChange: (meters: number) => void;
  onBaseMapStyleChange: (style: BaseMapStyle) => void;
  onRunCalculation: () => void;
  onCancelDailyCalculation: () => void;
}

interface LayerFiltersProps {
  showSunny: boolean;
  showShadow: boolean;
  showTerrain: boolean;
  showBuildings: boolean;
  showVegetation: boolean;
  showHeatmap: boolean;
  showPlaces: boolean;
  ignoreVegetationShadow: boolean;
  canShowHeatmap: boolean;
  cacheOnly: boolean;
  forceCacheOnly: boolean;
  onShowSunnyChange: (value: boolean) => void;
  onShowShadowChange: (value: boolean) => void;
  onShowTerrainChange: (value: boolean) => void;
  onShowBuildingsChange: (value: boolean) => void;
  onShowVegetationChange: (value: boolean) => void;
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

interface DailyCoverageProps {
  helperText: string;
  focusRunMessage: string | null;
  focusRunMessageIsError: boolean;
  error: string | null;
  warnings: string[];
  placesError: string | null;
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-300">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

const inputClass = "rounded border border-white/20 bg-black/45 px-2 py-1 text-white";
const chipClass = "inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/35 px-3 py-1.5";

export function CalculationControls(props: CalculationControlsProps) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Mode">
        <select
          className={inputClass}
          value={props.mode}
          onChange={(event) => props.onModeChange(event.target.value as AreaMode)}
        >
          <option value="instant">instant</option>
          <option value="daily">daily</option>
        </select>
      </Field>
      <Field label="Date">
        <input
          type="date"
          value={props.date}
          className={inputClass}
          onChange={(event) => props.onDateChange(event.target.value)}
        />
      </Field>
      <Field label="Heure">
        <input
          type="time"
          value={props.localTime}
          className={inputClass}
          onChange={(event) => props.onLocalTimeChange(event.target.value)}
          disabled={props.mode !== "instant"}
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
      <Field label="Grille">
        <input
          type="number"
          min={1}
          max={2000}
          step={1}
          value={props.gridStepMeters}
          className={`${inputClass} w-24`}
          onChange={(event) => props.onGridStepMetersChange(Number(event.target.value))}
        />
      </Field>
      <Field label="Toit bias">
        <input
          type="number"
          min={-20}
          max={20}
          step={0.1}
          value={props.buildingHeightBiasMeters}
          className={`${inputClass} w-24`}
          onChange={(event) => props.onBuildingHeightBiasMetersChange(Number(event.target.value))}
        />
      </Field>
      {props.mode === "daily" ? (
        <>
          <Field label="Debut">
            <input
              type="time"
              value={props.dailyStartLocalTime}
              className={`${inputClass} w-28`}
              onChange={(event) => props.onDailyStartChange(event.target.value)}
            />
          </Field>
          <Field label="Fin">
            <input
              type="time"
              value={props.dailyEndLocalTime}
              className={`${inputClass} w-28`}
              onChange={(event) => props.onDailyEndChange(event.target.value)}
            />
          </Field>
          <Field label="Sample">
            <input
              type="number"
              min={1}
              max={60}
              value={props.sampleEveryMinutes}
              className={`${inputClass} w-24`}
              onChange={(event) => props.onSampleEveryMinutesChange(Number(event.target.value))}
            />
          </Field>
        </>
      ) : null}
      <button
        type="button"
        className="rounded bg-yellow-300 px-4 py-2 font-semibold text-black transition hover:bg-yellow-200 disabled:cursor-not-allowed disabled:bg-slate-500"
        onClick={props.onRunCalculation}
        disabled={props.isLoading || (props.mode === "daily" && props.isDailyRangeInvalid)}
      >
        {props.isLoading ? "Calcul..." : props.mode === "daily" ? "Calculer timeline" : "Calculer zone visible"}
      </button>
      {props.mode === "daily" && props.isLoading ? (
        <button
          type="button"
          className="rounded bg-rose-500 px-4 py-2 font-semibold text-white transition hover:bg-rose-400"
          onClick={props.onCancelDailyCalculation}
        >
          Interrompre
        </button>
      ) : null}
    </div>
  );
}

export function LayerFilters(props: LayerFiltersProps) {
  const filters = [
    ["Soleil", props.showSunny, props.onShowSunnyChange],
    ["Ombre", props.showShadow, props.onShowShadowChange],
    ["Relief", props.showTerrain, props.onShowTerrainChange],
    ["Batiments", props.showBuildings, props.onShowBuildingsChange],
    ["Vegetation", props.showVegetation, props.onShowVegetationChange],
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
          checked={props.showPlaces}
          onChange={(event) => props.onShowPlacesChange(event.target.checked)}
        />
        <span>Terrasses</span>
      </label>
      <label className={chipClass}>
        <input
          type="checkbox"
          checked={props.ignoreVegetationShadow}
          onChange={(event) => props.onIgnoreVegetationShadowChange(event.target.checked)}
        />
        <span>Ignorer vegetation</span>
      </label>
      {!props.forceCacheOnly ? (
        <label className={chipClass}>
          <input
            type="checkbox"
            checked={props.cacheOnly}
            onChange={(event) => props.onCacheOnlyChange(event.target.checked)}
          />
          <span>Cache uniquement</span>
        </label>
      ) : null}
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
      <div className="flex items-center justify-between">
        <span>Timeline quotidienne</span>
        <span>{props.activeFrameTime ?? "--:--:--"}</span>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(props.frameIndex, max)}
        onChange={(event) => props.onFrameIndexChange(Number(event.target.value))}
        disabled={props.disabled}
      />
      <p className="text-xs text-slate-300">
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
        className="h-2 w-full overflow-hidden rounded accent-yellow-300"
        max={100}
        value={isIndeterminate ? undefined : Math.min(100, Math.max(0, progress.percent))}
      />
      <p className="text-xs text-slate-300">
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
  return (
    <div className="grid gap-2 text-sm">
      <p className="text-slate-200">{props.helperText}</p>
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
