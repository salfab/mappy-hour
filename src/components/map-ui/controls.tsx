"use client";

import type { ComponentType } from "react";

import {
  ChevronDownIcon,
  HeatmapIcon,
  LeafOffIcon,
  MountainIcon,
  SunIcon,
  TerraceIcon,
} from "./icons";

export type AreaMode = "instant" | "daily";
export type MapPanelTab = "map" | "terraces";
export type OverlayMode = "sunlight" | "heatmap";

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
  overlayMode: OverlayMode;
  showTerrain: boolean;
  showPlaces: boolean;
  ignoreVegetationShadow: boolean;
  canShowHeatmap: boolean;
  cacheOnly: boolean;
  forceCacheOnly: boolean;
  onOverlayModeChange: (value: OverlayMode) => void;
  onShowTerrainChange: (value: boolean) => void;
  onShowPlacesChange: (value: boolean) => void;
  onIgnoreVegetationShadowChange: (value: boolean) => void;
  onCacheOnlyChange: (value: boolean) => void;
}

interface TimeSliderProps {
  mode: AreaMode;
  activeFrameTime: string | null;
  frameCount: number;
  frameIndex: number;
  disabled: boolean;
  onFrameIndexChange: (value: number) => void;
  /**
   * Compute progress in [0, 100], or null when indeterminate (loading-cache /
   * loading-scene / reconnecting phases where no tile count is known yet).
   * Pass `undefined` to render the slider track in its default solid color
   * (idle state, no run in flight).
   */
  computeProgress?: number | null;
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

interface ToggleIconButtonProps {
  label: string;
  shortLabel?: string;
  pressed: boolean;
  disabled?: boolean;
  desktopOnly?: boolean;
  icon: ComponentType<{ className?: string }>;
  onPressedChange: (pressed: boolean) => void;
}

function ToggleIconButton(props: ToggleIconButtonProps) {
  const Icon = props.icon;

  // Variant A palette: amber pastel for pressed, soft cream surface for idle,
  // ring instead of border. Shape unchanged so the icon + tiny label still
  // fit the existing grid template.
  return (
    <button
      type="button"
      className={`group w-[5.5rem] place-items-center gap-1 rounded-2xl px-2 py-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:cursor-not-allowed disabled:opacity-45 ${
        props.desktopOnly ? "hidden lg:grid" : "grid"
      } ${
        props.pressed
          ? "bg-amber-100/80 text-amber-900 ring-1 ring-amber-200/70"
          : "bg-white/60 text-stone-700 ring-1 ring-amber-100/60 hover:bg-amber-50/80"
      }`}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.label}
      disabled={props.disabled}
      onClick={() => props.onPressedChange(!props.pressed)}
    >
      <Icon className="h-5 w-5 transition group-hover:scale-105" />
      <span className="max-w-full whitespace-nowrap text-[10px] font-semibold leading-none">
        {props.shortLabel ?? props.label}
      </span>
    </button>
  );
}

interface OverlaySelectorProps {
  mode: OverlayMode;
  canShowHeatmap: boolean;
  onModeChange: (mode: OverlayMode) => void;
}

function OverlaySelector(props: OverlaySelectorProps) {
  // Variant A pattern: segmented mutex on amber-tinted background. Active
  // radio gets the warm cream surface (#fffdf7) with shadow-sm; inactive
  // radio is transparent. Stretches to fill its parent (flex-1) so the two
  // radios share width equally.
  const pillBase =
    "group flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:cursor-not-allowed disabled:opacity-45";
  const pillActive = "bg-[#fffdf7] text-stone-900 shadow-sm";
  const pillInactive = "text-stone-600 hover:text-stone-900";

  return (
    <div
      role="radiogroup"
      aria-label="Type de surcouche"
      className="flex flex-1 gap-1 rounded-2xl bg-amber-900/[0.04] p-1"
    >
      <button
        type="button"
        role="radio"
        aria-checked={props.mode === "sunlight"}
        title="Ensoleillement"
        aria-label="Ensoleillement"
        className={`${pillBase} ${props.mode === "sunlight" ? pillActive : pillInactive}`}
        onClick={() => props.onModeChange("sunlight")}
      >
        <SunIcon className="h-4 w-4 transition group-hover:scale-105" />
        <span className="leading-none">Ensoleillement</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={props.mode === "heatmap"}
        title="Heatmap d'ensoleillement journalier"
        aria-label="Heatmap"
        disabled={!props.canShowHeatmap}
        className={`${pillBase} ${props.mode === "heatmap" ? pillActive : pillInactive}`}
        onClick={() => props.onModeChange("heatmap")}
      >
        <HeatmapIcon className="h-4 w-4 transition group-hover:scale-105" />
        <span className="leading-none">Heatmap</span>
      </button>
    </div>
  );
}

function formatDisplayDate(date: string): { weekday: string; dayMonth: string } | null {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) {
    return null;
  }

  const local = new Date(year, month - 1, day);
  const weekday = new Intl.DateTimeFormat("fr-CH", { weekday: "long" }).format(local);
  const dayMonth = new Intl.DateTimeFormat("fr-CH", { day: "numeric", month: "long" }).format(local);

  return {
    weekday: weekday.charAt(0).toUpperCase() + weekday.slice(1),
    dayMonth,
  };
}

export function DaySelector(props: {
  date: string;
  onDateChange: (date: string) => void;
}) {
  // Without an explicit showPicker(), clicking an opacity-0 date input on Chrome
  // doesn't reliably open the native calendar popup — it focuses the day/month
  // spinbuttons but the dropdown stays hidden. Calling showPicker() during the
  // user-gesture handler forces the popup to appear.
  const openPicker = (e: React.MouseEvent<HTMLElement>) => {
    const target = e.currentTarget;
    const input = target.querySelector<HTMLInputElement>('input[type="date"]');
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.focus();
    }
  };
  return (
    <label
      className="relative flex min-w-[190px] flex-1 cursor-pointer items-center gap-3 rounded-[1.75rem] border border-amber-200/50 bg-[rgba(255,251,240,0.65)] px-3 py-3 shadow-sm transition focus-within:ring-2 focus-within:ring-amber-300 hover:bg-amber-50/80"
      onClick={openPicker}
    >
      <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-500">
        <SunIcon className="h-8 w-8" />
      </span>
      {/* Weekday acts as a small caption *replacing* a generic "Jour" label,
          with day+month as the line that carries weight. Stacking them keeps
          the pastille short enough not to wrap awkwardly on either breakpoint
          (mobile bottom-sheet ~160 px, desktop 280 px side panel).
          Variant A typography: weekday in uppercase wide tracking, day+month
          in Fraunces display light to give the date editorial weight. */}
      {(() => {
        const parts = formatDisplayDate(props.date);
        if (!parts) {
          return (
            <span className="flex min-w-0 flex-1 items-center gap-2 font-[var(--font-display)] text-2xl font-light leading-tight tracking-tight text-stone-900">
              <span className="min-w-0 whitespace-normal break-words">Choisir un jour</span>
              <ChevronDownIcon className="h-5 w-5 shrink-0 text-stone-500" />
            </span>
          );
        }
        return (
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-xs font-medium uppercase tracking-[0.18em] text-stone-500">
              {parts.weekday}
            </span>
            <span className="flex min-w-0 items-center gap-2 font-[var(--font-display)] text-2xl font-light leading-tight tracking-tight text-stone-900">
              <span className="min-w-0 whitespace-normal break-words">{parts.dayMonth}</span>
              <ChevronDownIcon className="h-5 w-5 shrink-0 text-stone-500" />
            </span>
          </span>
        );
      })()}
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
  // Single morphing button : `Calculer` while idle, `Interrompre` while a daily
  // run is in flight. Same DOM slot → zero layout shift when the run starts.
  // (Previously a secondary rose button appeared underneath, pushing every
  // other panel row down by ~52 px on the precise moment the user wanted
  // to focus on the slider that was about to appear.)
  // Variant A layout: the day selector stacks on its own row and the
  // "Calculer" pill sits below, right-aligned, auto-width. The verb alone is
  // enough once the day picker carries the noun ("...l'ensoleillement de
  // dimanche 16 décembre"). Smaller footprint frees vertical rhythm.
  const isCancelMode = props.mode === "daily" && props.isLoading;
  const disabled = !isCancelMode && (props.isLoading || (props.mode === "daily" && props.isDailyRangeInvalid));

  return (
    <div className="grid gap-3">
      <DaySelector date={props.date} onDateChange={props.onDateChange} />
      <div className="flex justify-end">
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 ${
            isCancelMode
              ? "bg-rose-500 text-white shadow-rose-400/40 hover:bg-rose-400"
              : "bg-gradient-to-b from-amber-400 to-amber-500 text-amber-950 shadow-amber-900/20 hover:from-amber-300 hover:to-amber-400"
          }`}
          onClick={isCancelMode ? props.onCancelDailyCalculation : props.onRunCalculation}
          disabled={disabled}
          aria-label={isCancelMode ? "Interrompre le calcul" : "Calculer l'ensoleillement"}
        >
          {!isCancelMode ? <span aria-hidden>↻</span> : null}
          <span>{isCancelMode ? "Interrompre" : props.isLoading ? "Calcul..." : "Calculer"}</span>
        </button>
      </div>
    </div>
  );
}

export function LayerFilters(props: LayerFiltersProps) {
  // Variant A layout: mode selector (segmented mutex) shares its row with a
  // standalone Relief button — same visual weight, but Relief is an
  // independent layer toggle, not a mutex peer. Below, Sans arbres and
  // Terrasses sit in their own row using the pastel toggle treatment.
  return (
    <div className="flex flex-col gap-2 text-sm" aria-label="Couches de carte">
      <div className="flex items-stretch gap-2">
        <OverlaySelector
          mode={props.overlayMode}
          canShowHeatmap={props.canShowHeatmap}
          onModeChange={props.onOverlayModeChange}
        />
        <ReliefToggle pressed={props.showTerrain} onPressedChange={props.onShowTerrainChange} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleIconButton
          label="Ignorer végétation"
          shortLabel="Sans arbres"
          pressed={props.ignoreVegetationShadow}
          icon={LeafOffIcon}
          onPressedChange={props.onIgnoreVegetationShadowChange}
        />
        <ToggleIconButton
          label="Terrasses"
          pressed={props.showPlaces}
          icon={TerraceIcon}
          onPressedChange={props.onShowPlacesChange}
        />
      </div>
      <span className="sr-only">
        {props.cacheOnly || props.forceCacheOnly ? "Cache only actif." : "Cache only inactif."}
      </span>
    </div>
  );
}

interface ReliefToggleProps {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
}

// Standalone Relief layer toggle, designed to sit next to the segmented
// Ensoleillement/Heatmap mutex. Visual weight matches the inactive segment so
// the row reads as one cohesive control band, but the semantics are different
// — Relief is an independent on/off layer (aria-pressed), not a radio peer.
function ReliefToggle(props: ReliefToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      aria-label="Relief"
      title="Afficher le relief"
      onClick={() => props.onPressedChange(!props.pressed)}
      className={`hidden items-center gap-1.5 rounded-2xl px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 lg:flex ${
        props.pressed
          ? "bg-amber-100/80 text-amber-900 ring-1 ring-amber-200/70"
          : "bg-white/60 text-stone-700 ring-1 ring-amber-100/60 hover:bg-amber-50/80"
      }`}
    >
      <MountainIcon className="h-4 w-4" />
      <span className="leading-none">Relief</span>
    </button>
  );
}

export function ViewTabs(props: ViewTabsProps) {
  // Variant A tabs: amber-tinted background with the active tab raised on a
  // warm cream surface (#fffdf7). Same shape as the segmented mutex below so
  // the panel reads as one consistent vocabulary of "compartments".
  return (
    <div className="grid grid-cols-2 gap-1 rounded-2xl bg-amber-900/[0.04] p-1 text-sm font-medium">
      <button
        type="button"
        className={`rounded-xl px-3 py-2 transition ${
          props.activeTab === "map"
            ? "bg-[#fffdf7] text-stone-900 shadow-sm"
            : "text-stone-600 hover:text-stone-900"
        }`}
        onClick={() => props.onTabChange("map")}
      >
        Carte
      </button>
      <button
        type="button"
        className={`rounded-xl px-3 py-2 transition ${
          props.activeTab === "terraces"
            ? "bg-[#fffdf7] text-stone-900 shadow-sm"
            : "text-stone-600 hover:text-stone-900"
        }`}
        onClick={() => props.onTabChange("terraces")}
      >
        Terrasses
        <span className="ml-2 rounded-full bg-amber-100/70 px-2 py-0.5 text-xs text-amber-900">
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
  const { computeProgress } = props;

  // Compute progress is rendered as a colored fill UNDER the slider track.
  // Indeterminate (null) → striped + animated. Determinate → static amber fill
  // matching `computeProgress` %. No more "Tuiles reçues: X, Y points" line —
  // it caused layout shift every tile flush and the slider fill now carries the
  // same info more cleanly (Phase 2 UX 2026-05-12).
  const showProgress = computeProgress !== undefined;
  const fillStyle: React.CSSProperties = {};
  // Variant A: amber gradient fill on a soft amber track. The gradient gives
  // the slider a slight 3D warmth that matches the kraft-paper card backdrop.
  let fillClass = "h-full bg-gradient-to-r from-amber-300 to-amber-500";
  if (showProgress) {
    if (computeProgress === null) {
      // Indeterminate — animated pulse of the same gradient stripe
      fillClass = "h-full w-full animate-pulse bg-gradient-to-r from-amber-200 to-amber-400";
    } else {
      fillStyle.width = `${Math.max(0, Math.min(100, computeProgress))}%`;
    }
  } else {
    // Idle / no run in flight — solid full amber so the slider doesn't look broken
    fillStyle.width = "100%";
  }

  return (
    <div className="grid gap-2 text-sm">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
          Timeline
        </span>
        <span className="rounded-full bg-amber-100/80 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-900">
          {props.activeFrameTime ?? "--:--:--"}
        </span>
      </div>
      <div className="relative h-6 w-full">
        {/* Backing track + progress fill. Sits behind the slider; the slider's
            own track is made invisible via appearance-none + bg-transparent. */}
        <div className="absolute inset-y-[10px] left-0 right-0 overflow-hidden rounded-full bg-amber-100/70">
          <div className={fillClass} style={fillStyle} />
        </div>
        <input
          className="absolute inset-0 h-full w-full appearance-none bg-transparent accent-amber-500 disabled:opacity-60"
          type="range"
          min={0}
          max={max}
          step={1}
          value={Math.min(props.frameIndex, max)}
          onChange={(event) => props.onFrameIndexChange(Number(event.target.value))}
          disabled={props.disabled}
        />
      </div>
    </div>
  );
}

export function ProgressStatus(props: ProgressStatusProps) {
  // For daily mode, the slider track now carries the progress (cf. TimeSlider's
  // `computeProgress` prop, 2026-05-12). Rendering the status here too would
  // duplicate info AND re-introduce the layout shift this refactor is meant
  // to eliminate. Daily → nothing emitted here; the slider does the job.
  if (props.mode === "daily") {
    return null;
  }
  const progress = props.instantProgress;
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
          ? ` - ${props.formatDuration(Math.round(progress.elapsedMs / 1000))} écoulé`
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
