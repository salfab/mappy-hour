"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { MapLibreSunlightCustomLayer } from "@/components/sunlight-overlay/maplibre-sunlight-custom-layer";
import { MapLibreHeatmapCustomLayer } from "@/components/sunlight-overlay/maplibre-heatmap-custom-layer";
import {
  MapLibreSatellitePatchworkLayer,
  isAquarelleTileCovered,
  type LoadedTile as SatelliteLoadedTile,
} from "@/components/sunlight-overlay/maplibre-satellite-patchwork-layer";
import {
  CalculationControls,
  DailyCoverage,
  LayerFilters,
  ProgressStatus,
  TimeSlider,
  ViewTabs,
  type AreaMode,
  type MapPanelTab,
  type OverlayMode,
  type TimelineProgressView,
} from "@/components/map-ui/controls";
import { FloatingSearch } from "@/components/map-ui/floating-search";
import {
  MobileBottomSheet,
  MobileBarsView,
  type BottomSheetState,
} from "@/components/map-ui/layouts";
import {
  PlaceSuggestionsDropdown,
  type PlaceSuggestion,
} from "@/components/map-ui/place-suggestions-dropdown";

import {
  buildBaseMaps,
  buildStyle,
  type BaseMapDef,
  type BaseMapId,
} from "@/components/maplibre-preview/basemaps";
import {
  loadStoredMapView,
  persistMapView,
  MAP_MAX_ZOOM,
} from "@/components/maplibre-preview/map-view-storage";
import {
  loadStoredUiParams,
  persistUiParams,
} from "@/components/sunlight-map/stored-map-view";
import { isBaseMapStyle, type BaseMapStyle } from "@/components/sunlight-map/types";
import {
  addPlacesLayers,
  attachPlacesInteractions,
  placesToFeatureCollection,
  type SunlightWindow,
  type ViewportPlaceLite,
} from "@/components/maplibre-preview/places-source";
import { PlaceDetailCard } from "@/components/maplibre-preview/place-card";
import { BarsList } from "@/components/map-ui/bars-list";
import type { VenueCardPlace, VenueType } from "@/components/map-ui/venue-card";
import { SearchPanel } from "@/components/maplibre-preview/search-panel";
import {
  FilterPanel,
  DEFAULT_FILTERS,
  placeChipKey,
  type CategoryFilters,
} from "@/components/maplibre-preview/filter-panel";
import { fetchTimeline } from "@/components/maplibre-preview/sunlight-timeline";
import { inspectTileCache } from "@/components/maplibre-preview/timeline-tile-cache";
import {
  StylePanel,
  DEFAULT_STYLE_SETTINGS,
  type SunlightStyleSettings,
} from "@/components/maplibre-preview/style-panel";

const DEFAULT_CENTER: [number, number] = [6.6323, 46.5197];
const DEFAULT_ZOOM = 17;

// Source + layer IDs for the instant-mode per-point overlay. One source, one
// layer per category so each can be toggled independently via setLayoutProperty.
const INSTANT_POINTS_SOURCE_ID = "instant-points";
type InstantPointCategory =
  | "sunny"
  | "shadow"
  | "terrain-blocked"
  | "buildings-blocked"
  | "vegetation-blocked";
const INSTANT_POINT_LAYER_IDS: Record<InstantPointCategory, string> = {
  sunny: "instant-points-sunny",
  shadow: "instant-points-shadow",
  "terrain-blocked": "instant-points-terrain",
  "buildings-blocked": "instant-points-buildings",
  "vegetation-blocked": "instant-points-vegetation",
};
// Colors mirror the Leaflet client polygon palette where available, with a
// dedicated brown for terrain (Leaflet does not render terrain-blocked points
// as a distinct layer — see sunlight-map-client.tsx l.3514).
const INSTANT_POINT_COLORS: Record<InstantPointCategory, string> = {
  sunny: "#facc15", // yellow-400 (Leaflet sunny fillColor)
  shadow: "#64748b", // slate-500 (Leaflet shadow fillColor)
  "terrain-blocked": "#92400e", // amber-800 (no Leaflet equivalent)
  "buildings-blocked": "#6b7280", // gray-500
  "vegetation-blocked": "#22c55e", // green-500 (Leaflet vegetation fillColor)
};

// Minimal per-point shape we keep client-side: rendering only needs lat/lon +
// the flags that determine the category.
interface AreaInstantPointLite {
  id: string;
  lat: number;
  lon: number;
  isSunny: boolean;
  terrainBlocked: boolean;
  buildingsBlocked: boolean;
  vegetationBlocked?: boolean;
}

// Bucket a point into a single category. Priority mirrors the Leaflet client's
// `selectPrimaryShadowCause` (terrain > vegetation > buildings) for shadows;
// sunny wins outright.
function categorizeInstantPoint(p: AreaInstantPointLite): InstantPointCategory {
  if (p.isSunny) return "sunny";
  if (p.terrainBlocked) return "terrain-blocked";
  if (p.vegetationBlocked) return "vegetation-blocked";
  if (p.buildingsBlocked) return "buildings-blocked";
  return "shadow";
}

function instantPointsToFeatureCollection(
  points: AreaInstantPointLite[],
): GeoJSON.FeatureCollection<GeoJSON.Point, { category: InstantPointCategory }> {
  return {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: { category: categorizeInstantPoint(p) },
    })),
  };
}

// Deep-link query keys — kept verbatim in sync with sunlight-map-client.tsx so
// the same URL works on both the Leaflet homepage and the MapLibre preview.
const DEEP_LINK_QUERY_KEYS = {
  mode: "mode",
  date: "date",
  baseMapStyle: "basemap",
  ignoreVegetationShadow: "ignoreVegetation",
  showSunny: "showSunny",
  showShadow: "showShadow",
  showBuildings: "showBuildings",
  showTerrain: "showTerrain",
  showVegetation: "showVegetation",
  showHeatmap: "showHeatmap",
  showPlaces: "showPlaces",
} as const;

interface DeepLinkParams {
  mode?: AreaMode;
  date?: string;
  baseMapStyle?: BaseMapStyle;
  ignoreVegetationShadow?: boolean;
  showSunny?: boolean;
  showShadow?: boolean;
  showBuildings?: boolean;
  showTerrain?: boolean;
  showVegetation?: boolean;
  showHeatmap?: boolean;
  showPlaces?: boolean;
}

function parseQueryBoolean(value: string | null): boolean | null {
  if (!value) return null;
  const n = value.trim().toLowerCase();
  if (n === "1" || n === "true" || n === "yes" || n === "on") return true;
  if (n === "0" || n === "false" || n === "no" || n === "off") return false;
  return null;
}

function parseDeepLinkParams(sp: URLSearchParams): DeepLinkParams | null {
  const parsed: DeepLinkParams = {};
  let hasValue = false;

  const mode = sp.get(DEEP_LINK_QUERY_KEYS.mode);
  if (mode === "instant" || mode === "daily") {
    parsed.mode = mode;
    hasValue = true;
  }

  const date = sp.get(DEEP_LINK_QUERY_KEYS.date);
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    parsed.date = date;
    hasValue = true;
  }

  const baseMapStyle = sp.get(DEEP_LINK_QUERY_KEYS.baseMapStyle);
  if (baseMapStyle === "map") {
    parsed.baseMapStyle = "osm";
    hasValue = true;
  } else if (isBaseMapStyle(baseMapStyle)) {
    parsed.baseMapStyle = baseMapStyle;
    hasValue = true;
  }

  const booleanMappings: Array<[keyof DeepLinkParams, string]> = [
    ["ignoreVegetationShadow", DEEP_LINK_QUERY_KEYS.ignoreVegetationShadow],
    ["showSunny", DEEP_LINK_QUERY_KEYS.showSunny],
    ["showShadow", DEEP_LINK_QUERY_KEYS.showShadow],
    ["showBuildings", DEEP_LINK_QUERY_KEYS.showBuildings],
    ["showTerrain", DEEP_LINK_QUERY_KEYS.showTerrain],
    ["showVegetation", DEEP_LINK_QUERY_KEYS.showVegetation],
    ["showHeatmap", DEEP_LINK_QUERY_KEYS.showHeatmap],
    ["showPlaces", DEEP_LINK_QUERY_KEYS.showPlaces],
  ];
  for (const [targetKey, queryKey] of booleanMappings) {
    const b = parseQueryBoolean(sp.get(queryKey));
    if (b !== null) {
      (parsed[targetKey] as boolean | undefined) = b;
      hasValue = true;
    }
  }

  return hasValue ? parsed : null;
}

// DECISION: BaseMapStyle ("stamen-watercolor") is the canonical homepage type
// and what we store in localStorage so the Leaflet client + MapLibre preview
// stay in sync across tabs. The preview internally indexes basemaps by
// BaseMapId, so we map at the I/O boundary.
function baseMapStyleToBaseMapId(style: BaseMapStyle): BaseMapId {
  return style === "stamen-watercolor" ? "aquarelle" : style;
}
function baseMapIdToBaseMapStyle(id: BaseMapId): BaseMapStyle {
  return id === "aquarelle" ? "stamen-watercolor" : id;
}

// Maps an OSM subcategory (cuisine/amenity) to the coarse VenueType bucket
// used by VenueCard for its label + icon. Anything we don't recognise falls
// back to "other" — matches the Leaflet client's tolerant behaviour.
function subcategoryToVenueType(subcategory: string): VenueType {
  switch (subcategory) {
    case "restaurant":
      return "restaurant";
    case "bar":
    case "pub":
      return "bar";
    case "cafe":
    case "fast_food":
      return "snack";
    case "food_court":
    case "ice_cream":
      return "foodtruck";
    default:
      return "other";
  }
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function MapLibrePreviewClient() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const sunlightLayerRef = useRef<MapLibreSunlightCustomLayer | null>(null);
  const satellitePatchworkLayerRef = useRef<MapLibreSatellitePatchworkLayer | null>(null);
  // Mirror of the currently-loaded sunlight tiles, read synchronously by the
  // map's transformRequest to skip metered aquarelle fetches over covered tiles.
  const loadedSunlightTilesRef = useRef<SatelliteLoadedTile[]>([]);
  const heatmapLayerRef = useRef<MapLibreHeatmapCustomLayer | null>(null);
  const [ready, setReady] = useState(false);
  const [basemapId, setBasemapId] = useState<BaseMapId>("aquarelle");

  // ── Sunlight state ────────────────────────────────────────────────────────
  const [sunlightVisible, setSunlightVisible] = useState(true);
  const [frameIndex, setFrameIndex] = useState(0);
  const [timelineFrames, setTimelineFrames] = useState<Array<{ localTime: string }>>([]);
  const [sunlightLoading, setSunlightLoading] = useState(false);
  // Timeline fetch progress, fed by fetchTimeline.onProgress:
  //   number 0..100 → determinate (% tiles received), drives the TimeSlider fill.
  //   null → indeterminate (start seen but no total).
  //   undefined → idle (no fetch in flight, slider full amber).
  const [timelineFetchProgress, setTimelineFetchProgress] =
    useState<number | null | undefined>(undefined);
  const [styleSettings, setStyleSettings] =
    useState<SunlightStyleSettings>(DEFAULT_STYLE_SETTINGS);
  const showSunny = styleSettings.showSunny;
  const showShadow = styleSettings.showShadow;
  // Bumped whenever a fresh sunlight calculation is requested (moveend or
  // explicit ↻ button). The date-watching effect re-runs on every bump.
  const [recalcSignal, setRecalcSignal] = useState(0);
  const sunlightDebounceRef = useRef<number | null>(null);
  const [date, setDate] = useState<string>(() =>
    new Date().toLocaleDateString("sv", { timeZone: "Europe/Zurich" }),
  );

  // ── Place card state ──────────────────────────────────────────────────────
  const [selectedPlace, setSelectedPlace] = useState<ViewportPlaceLite | null>(null);
  const [cardSunlightWindows, setCardSunlightWindows] = useState<SunlightWindow[] | null>(null);
  const [isCardSunlightLoading, setIsCardSunlightLoading] = useState(false);
  const [cardSunlightError, setCardSunlightError] = useState<string | null>(null);
  const cardSunlightRequestRef = useRef(0);
  const viewportPlacesDebounceRef = useRef<number | null>(null);
  const viewportPlacesAbortRef = useRef<AbortController | null>(null);
  const timelineAbortRef = useRef<AbortController | null>(null);
  // Mirror the slider position so the SSE callback can read the latest value
  // without making refreshTimeline depend on frameIndex (which would force the
  // map mount effect to re-run).
  const frameIndexRef = useRef(0);
  useEffect(() => { frameIndexRef.current = frameIndex; }, [frameIndex]);

  // Raw places kept in a ref so filter changes can re-apply without refetching.
  const rawPlacesRef = useRef<ViewportPlaceLite[]>([]);
  // Tick bumped whenever rawPlacesRef is refreshed so memoised derivations
  // (sunlitPlaces) recompute even though the underlying storage is a ref.
  const [rawPlacesTick, setRawPlacesTick] = useState(0);
  const [filters, setFilters] = useState<CategoryFilters>(DEFAULT_FILTERS);
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null);
  // Ref mirror so closures captured in setStyle / moveend handlers always see
  // the latest filter state without re-creating the listeners.
  const filtersRef = useRef(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);

  // ── UI params hydration flag (gates persistUiParams to avoid clobbering
  //    localStorage with default state before load happens). ─────────────────
  const [uiParamsHydrated, setUiParamsHydrated] = useState(false);
  // One-shot basemap swap latch — declared early so the mount-only deep-link
  // effect (below) can lock it before the auto-swap effect runs.
  const autoBasemapDone = useRef(false);

  // ── Calculation state (ported from Leaflet client) ────────────────────────
  // DECISION: instant mode point rendering IS now ported (chunk 3). We accumulate
  // the SSE partial points into `lastResult` and push them into a per-category
  // GeoJSON source. The daily-mode overlay still refreshes via `recalcSignal`
  // once the precompute completes.
  const [mode, setMode] = useState<AreaMode>("daily");
  // Accumulated instant-mode points (lat/lon + blocking flags). Survives mode
  // switches so flipping back to instant keeps the last result visible.
  // DECISION: we don't reuse the full Leaflet `AreaApiResponse` shape here —
  // for rendering only `lat`/`lon`/category matter. The richer fields stay on
  // the wire for the Leaflet client which consumes the same endpoint.
  const [lastResult, setLastResult] = useState<AreaInstantPointLite[] | null>(
    null,
  );
  const [isCalculating, setIsCalculating] = useState(false);
  const [dailyProgress, setDailyProgress] = useState<TimelineProgressView | null>(null);
  const [instantProgress, setInstantProgress] = useState<TimelineProgressView | null>(null);
  // DECISION: hardcode the Leaflet client's defaults — preview has no UI to
  // tweak these and the goal is faithful copy of the SSE call.
  const localTime = "12:00";
  const dailyStartLocalTime = "06:00";
  const dailyEndLocalTime = "21:00";
  const sampleEveryMinutes = 15;
  const gridStepMeters = 1;
  const buildingHeightBiasMeters = 0;
  // DECISION: ported from Leaflet client as state so LayerFilters toggles
  // reflect locally. Wiring to the calc pipeline (re-running with the flag) is
  // already done — the existing `handleRunCalculation` reads this value.
  const [ignoreVegetationShadow, setIgnoreVegetationShadow] = useState(false);
  // DECISION: cacheOnly stays a const (no LayerFilters toggle for it — the
  // checkbox lives behind a different mechanism on Leaflet too). LayerFilters
  // only reads it for the sr-only announcement, so we pass a no-op setter.
  const cacheOnly = false;
  const forceCacheOnly = false;
  // The heatmap reuses the timeline tiles already fetched for the sunlight
  // overlay (daily aggregate computed on the client by
  // MapLibreHeatmapCustomLayer). Enable the pill as soon as we have a daily
  // timeline loaded — matches the Leaflet client's "needs a daily run" guard.
  const canShowHeatmap = timelineFrames.length > 1;

  // ── View tabs + LayerFilters state (ported from Leaflet homepage) ────────
  const [panelTab, setPanelTab] = useState<MapPanelTab>("map");
  // DECISION: showSunny/showShadow already live in `styleSettings` so the
  // OverlayMode derivation reuses them (no duplicate state). showHeatmap is
  // new state because no equivalent exists yet in the preview.
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showTerrain, setShowTerrain] = useState(true);
  // showBuildings / showVegetation gate the per-category visibility of the
  // instant-mode point overlay. LayerFilters does not surface a toggle yet —
  // they're driven by stored UI params + deep-link query for now.
  const [showBuildings, setShowBuildings] = useState(true);
  const [showVegetation, setShowVegetation] = useState(true);
  const [showPlaces, setShowPlaces] = useState(true);
  const overlayMode: OverlayMode =
    showHeatmap && !showSunny && !showShadow ? "heatmap" : "sunlight";
  const isDailyRangeInvalid = false; // defaults are valid; no UI to break them

  // ── Mobile UX state (FloatingSearch + MobileBottomSheet + MobileBarsView) ──
  // DECISION: minimal port of the Leaflet client's mobile stack. The mobile
  // sheet hosts the same Calculation/Progress/LayerFilters that the desktop
  // left panel hosts; we render those nodes once (variables below) and place
  // them in both layouts gated by `hidden lg:flex` / `lg:hidden`. Coverage and
  // a richer timeline control are deliberately not ported yet (see DECISIONs
  // below).
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchLoading, setIsSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Increment to force PlaceSuggestionsDropdown to hide after submit/select.
  const [suggestionsCloseSignal, setSuggestionsCloseSignal] = useState(0);
  // DECISION: mirror Leaflet default ("middle") for the bottom sheet.
  const [bottomSheetState, setBottomSheetState] =
    useState<BottomSheetState>("middle");
  const [isMobileBarsOpen, setIsMobileBarsOpen] = useState(false);

  // ── Restore UI params from localStorage + deep-link URL (mount-only) ──────
  // DECISION: single mount-only effect, mirrors Leaflet client. Order matches
  // the homepage: localStorage first, then deep-link query overrides. Fields
  // hardcoded in preview (localTime, dailyStart/End, gridStepMeters,
  // sampleEveryMinutes, buildingHeightBiasMeters) are intentionally ignored.
  useEffect(() => {
    const stored = loadStoredUiParams();
    if (stored) {
      setMode(stored.mode);
      setDate(stored.date);
      setBasemapId(baseMapStyleToBaseMapId(stored.baseMapStyle));
      setIgnoreVegetationShadow(stored.ignoreVegetationShadow);
      setStyleSettings((s) => ({
        ...s,
        showSunny: stored.showSunny,
        showShadow: stored.showShadow,
      }));
      setShowBuildings(stored.showBuildings);
      setShowTerrain(stored.showTerrain);
      setShowVegetation(stored.showVegetation);
      setShowHeatmap(stored.showHeatmap);
      setShowPlaces(stored.showPlaces);
    }

    const deepLink =
      typeof window !== "undefined"
        ? parseDeepLinkParams(new URLSearchParams(window.location.search))
        : null;
    if (deepLink) {
      if (deepLink.mode) setMode(deepLink.mode);
      if (deepLink.date) setDate(deepLink.date);
      if (deepLink.baseMapStyle) {
        setBasemapId(baseMapStyleToBaseMapId(deepLink.baseMapStyle));
        // Manual selection locks the one-shot auto-swap so the late
        // sunlight-loaded event can't override the deep-link choice.
        autoBasemapDone.current = true;
      }
      if (typeof deepLink.ignoreVegetationShadow === "boolean") {
        setIgnoreVegetationShadow(deepLink.ignoreVegetationShadow);
      }
      if (typeof deepLink.showSunny === "boolean" || typeof deepLink.showShadow === "boolean") {
        setStyleSettings((s) => ({
          ...s,
          ...(typeof deepLink.showSunny === "boolean" ? { showSunny: deepLink.showSunny } : null),
          ...(typeof deepLink.showShadow === "boolean" ? { showShadow: deepLink.showShadow } : null),
        }));
      }
      if (typeof deepLink.showBuildings === "boolean") setShowBuildings(deepLink.showBuildings);
      if (typeof deepLink.showTerrain === "boolean") setShowTerrain(deepLink.showTerrain);
      if (typeof deepLink.showVegetation === "boolean") setShowVegetation(deepLink.showVegetation);
      if (typeof deepLink.showHeatmap === "boolean") setShowHeatmap(deepLink.showHeatmap);
      if (typeof deepLink.showPlaces === "boolean") setShowPlaces(deepLink.showPlaces);
    }

    setUiParamsHydrated(true);
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist UI params on every relevant change (gated by hydration so the
  // first render doesn't wipe stored values with defaults).
  useEffect(() => {
    if (!uiParamsHydrated) return;
    persistUiParams({
      mode,
      date,
      // DECISION: preview has no UI for these — persist the hardcoded values
      // so the schema validation in loadStoredUiParams keeps accepting them.
      // The Leaflet client will read these back unchanged.
      localTime,
      dailyStartLocalTime,
      dailyEndLocalTime,
      gridStepMeters,
      sampleEveryMinutes,
      buildingHeightBiasMeters,
      baseMapStyle: baseMapIdToBaseMapStyle(basemapId),
      ignoreVegetationShadow,
      showSunny,
      showShadow,
      showBuildings,
      showTerrain,
      showVegetation,
      showHeatmap,
      showPlaces,
    });
  }, [
    uiParamsHydrated,
    mode,
    date,
    basemapId,
    ignoreVegetationShadow,
    showSunny,
    showShadow,
    showBuildings,
    showTerrain,
    showVegetation,
    showHeatmap,
    showPlaces,
  ]);

  const timelineCalcAbortRef = useRef<AbortController | null>(null);
  const timelineCancelledRef = useRef(false);
  const instantStreamRef = useRef<EventSource | null>(null);
  const instantCancelledRef = useRef(false);

  const handleCancelDailyCalculation = useCallback(() => {
    if (mode !== "daily") return;
    // The daily SSE now flows through refreshTimeline / timelineAbortRef.
    // We still null timelineCalcAbortRef defensively in case a stale
    // controller from a pre-unification path is still lingering — harmless
    // when it's already null.
    timelineCancelledRef.current = true;
    if (timelineCalcAbortRef.current) {
      timelineCalcAbortRef.current.abort();
      timelineCalcAbortRef.current = null;
    }
    timelineAbortRef.current?.abort();
    timelineAbortRef.current = null;
    timelineCancelledRef.current = false;
    setIsCalculating(false);
    setDailyProgress((previous) => ({
      phase: "cancelled",
      percent: previous?.percent ?? 0,
      etaSeconds: null,
    }));
  }, [mode]);

  const handleRunCalculation = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const bounds = map.getBounds();
    const bbox: [number, number, number, number] = [
      Number(bounds.getWest().toFixed(6)),
      Number(bounds.getSouth().toFixed(6)),
      Number(bounds.getEast().toFixed(6)),
      Number(bounds.getNorth().toFixed(6)),
    ];

    if (timelineCalcAbortRef.current) {
      timelineCancelledRef.current = true;
      timelineCalcAbortRef.current.abort();
      timelineCalcAbortRef.current = null;
    }
    if (instantStreamRef.current) {
      instantCancelledRef.current = true;
      instantStreamRef.current.close();
      instantStreamRef.current = null;
    }

    setIsCalculating(true);

    if (mode === "instant") {
      setInstantProgress({
        phase: "starting",
        percent: 0,
        etaSeconds: null,
      });
      setDailyProgress(null);

      const query = new URLSearchParams({
        minLon: String(bbox[0]),
        minLat: String(bbox[1]),
        maxLon: String(bbox[2]),
        maxLat: String(bbox[3]),
        date,
        timezone: "Europe/Zurich",
        localTime,
        gridStepMeters: String(gridStepMeters),
        maxPoints: "2000000",
        buildingHeightBiasMeters: String(buildingHeightBiasMeters),
      });

      instantCancelledRef.current = false;
      // DECISION: reset accumulated points at the start of every fresh run so
      // a new SSE doesn't blend with the previous result. We keep lastResult
      // alive across mode switches but a new instant calc means a new dataset.
      setLastResult([]);
      const stream = new EventSource(
        `/api/sunlight/instant/stream?${query.toString()}`,
      );
      instantStreamRef.current = stream;

      stream.addEventListener("start", () => {
        if (instantCancelledRef.current) return;
        // start payload carries metadata only; reset to an empty array so the
        // first `partial` event repaints the source from a clean slate.
        setLastResult([]);
      });

      stream.addEventListener("progress", (event) => {
        if (instantCancelledRef.current) return;
        const data = JSON.parse((event as MessageEvent).data) as TimelineProgressView;
        setInstantProgress(data);
      });

      stream.addEventListener("partial", (event) => {
        if (instantCancelledRef.current) return;
        const data = JSON.parse((event as MessageEvent).data) as {
          points: AreaInstantPointLite[];
          pointCount: number;
        };
        setLastResult((previous) => [...(previous ?? []), ...data.points]);
      });
      stream.addEventListener("done", () => {
        if (instantCancelledRef.current) {
          stream.close();
          if (instantStreamRef.current === stream) instantStreamRef.current = null;
          setIsCalculating(false);
          return;
        }
        setInstantProgress((previous) => ({
          phase: "done",
          percent: 100,
          etaSeconds: 0,
          elapsedMs: previous?.elapsedMs,
        }));
        stream.close();
        if (instantStreamRef.current === stream) instantStreamRef.current = null;
        setIsCalculating(false);
        // Refresh the overlay timeline so the new precompute is visible.
        setRecalcSignal((c) => c + 1);
      });
      stream.addEventListener("error", () => {
        if (instantCancelledRef.current) {
          stream.close();
          if (instantStreamRef.current === stream) instantStreamRef.current = null;
          setIsCalculating(false);
          return;
        }
        stream.close();
        if (instantStreamRef.current === stream) instantStreamRef.current = null;
        setIsCalculating(false);
      });
      return;
    }

    // Daily mode — delegate the SSE to `refreshTimeline` (single source of
    // truth, renders tiles, honours every UI toggle). Previously this branch
    // ran its own discard-only SSE just to feed analytics + progress; that
    // duplicate flow ignored the UI params and is what made toggles like
    // "Ignorer végétation" / sampleEveryMinutes appear inert. Analytics +
    // dailyProgress now flow through the `refreshTimeline` callbacks.
    setInstantProgress(null);
    setDailyProgress({
      phase: "starting",
      percent: 0,
      etaSeconds: null,
    });
    // `recalcSignal` is the trigger for the date/ready/recalc effect that
    // invokes refreshTimeline. We don't await here — the effect handles the
    // async lifecycle (loading flag, abort on re-trigger, etc.). We do clear
    // `isCalculating` immediately though: the dedicated `sunlightLoading` +
    // `dailyProgress` states drive the in-flight UI from this point on.
    setIsCalculating(false);
    setRecalcSignal((c) => c + 1);
    // bbox is reserved for the instant-mode path above; not used here.
    void bbox;
  }, [mode, date]);

  const baseMapsRef = useRef<BaseMapDef[] | null>(null);
  if (baseMapsRef.current === null) {
    baseMapsRef.current = buildBaseMaps(process.env.NEXT_PUBLIC_STADIA_API_KEY);
  }

  // Apply current filters to the cached raw places and push to the source.
  // Lives in a ref so callers can grab the latest filters at call time
  // without participating in React state dependency graphs.
  const applyPlacesToSource = useCallback((map: MapLibreMap, current: CategoryFilters) => {
    const filtered = rawPlacesRef.current.filter((p) =>
      current[placeChipKey(p.category, p.subcategory)],
    );
    const source = map.getSource("places") as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(placesToFeatureCollection(filtered));
  }, []);

  // ── Viewport places fetch (POST /api/places/viewport) ─────────────────────
  const fetchViewportPlaces = useCallback(async (map: MapLibreMap) => {
    viewportPlacesAbortRef.current?.abort();
    const abort = new AbortController();
    viewportPlacesAbortRef.current = abort;
    const bounds = map.getBounds();
    try {
      const response = await fetch("/api/places/viewport", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          south: bounds.getSouth(),
          west: bounds.getWest(),
          north: bounds.getNorth(),
          east: bounds.getEast(),
        }),
        signal: abort.signal,
      });
      if (!response.ok) return;
      const json = (await response.json()) as { places?: ViewportPlaceLite[] };
      if (abort.signal.aborted) return;
      rawPlacesRef.current = Array.isArray(json.places) ? json.places : [];
      setRawPlacesTick((t) => t + 1);
      applyPlacesToSource(map, filtersRef.current);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.warn("[maplibre-preview] viewport places fetch failed:", err);
    }
  }, [applyPlacesToSource]);

  // Re-apply filters on toggle without refetching from the server.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    applyPlacesToSource(map, filters);
  }, [filters, ready, applyPlacesToSource]);

  // ── Sunlit places derivation (powers BarsList + ViewTabs venueCount) ──────
  // DECISION: pragmatic v1. We do NOT consult the sunlight mask atlas to know
  // if each place's cell is currently sunny at frameIndex/localTime — wiring
  // that requires exposing per-tile masks from MapLibreSunlightCustomLayer +
  // a lat/lon → tile bit lookup, out of scope for this chunk. Instead we list
  // every visible place that has `hasOutdoorSeating === true` (i.e. a terrace
  // exists). The venueCount therefore reflects "terrasses visibles", not
  // "terrasses au soleil maintenant". A later chunk will tighten this.
  const sunlitPlaces = useMemo<VenueCardPlace[]>(() => {
    // Read both refs at call time; the tick dep below is what re-triggers us
    // when rawPlacesRef.current was just refreshed.
    void rawPlacesTick;
    const raw = rawPlacesRef.current;
    return raw
      .filter((p) => p.hasOutdoorSeating && filters[placeChipKey(p.category, p.subcategory)])
      .map<VenueCardPlace>((p) => ({
        id: p.id,
        name: p.name,
        // Map OSM subcategory → coarse VenueType bucket used by VenueCard.
        venueType: subcategoryToVenueType(p.subcategory),
        lat: p.lat,
        lon: p.lon,
        evaluationLat: p.lat,
        evaluationLon: p.lon,
        selectionStrategy: p.selectionStrategy ?? "original",
        selectionOffsetMeters: 0,
        // DECISION: no sun status wired yet — see comment above. We surface
        // null so getVenueSunStatus falls back to the "Ombre/Créneau" branch
        // (visually neutral) instead of falsely showing "Soleil".
        isSunnyNow: null,
        sunnyMinutes: 0,
        sunlightStartLocalTime: null,
        sunlightEndLocalTime: null,
      }));
  }, [rawPlacesTick, filters]);

  // ── Mobile search handlers (mirror SearchPanel/sunlight-map-client) ───────
  const SUGGESTION_TARGET_ZOOM = 19;
  const handleOpenSearch = useCallback(() => {
    setSearchError(null);
    setIsSearchOpen(true);
  }, []);
  const handleSubmitSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setIsSearchLoading(true);
    setSearchError(null);
    try {
      const response = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
        cache: "no-store",
      });
      const result = (await response.json().catch(() => null)) as {
        lat?: number;
        lon?: number;
        bbox?: [number, number, number, number];
        error?: string;
      } | null;
      if (!response.ok || !result?.lat || !result?.lon) {
        throw new Error(result?.error ?? "Aucun résultat trouvé.");
      }
      const map = mapRef.current;
      if (map) {
        if (result.bbox) {
          const [minLon, minLat, maxLon, maxLat] = result.bbox;
          map.fitBounds(
            [[minLon, minLat], [maxLon, maxLat]],
            { padding: 40, animate: true, maxZoom: SUGGESTION_TARGET_ZOOM },
          );
        } else {
          map.flyTo({
            center: [result.lon, result.lat],
            zoom: Math.max(map.getZoom(), SUGGESTION_TARGET_ZOOM),
            animate: true,
          });
        }
      }
      setIsSearchOpen(false);
      setSuggestionsCloseSignal((c) => c + 1);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Recherche impossible.");
    } finally {
      setIsSearchLoading(false);
    }
  }, [searchQuery]);
  const handleSelectSuggestion = useCallback(
    (suggestion: PlaceSuggestion) => {
      const map = mapRef.current;
      if (map) {
        if (suggestion.bbox) {
          const [minLon, minLat, maxLon, maxLat] = suggestion.bbox;
          map.fitBounds(
            [[minLon, minLat], [maxLon, maxLat]],
            { padding: 40, animate: true, maxZoom: SUGGESTION_TARGET_ZOOM },
          );
        } else {
          map.flyTo({
            center: [suggestion.lon, suggestion.lat],
            zoom: SUGGESTION_TARGET_ZOOM,
            animate: true,
          });
        }
      }
      setSearchQuery(suggestion.name);
      setSearchError(null);
      setIsSearchOpen(false);
      setSuggestionsCloseSignal((c) => c + 1);
    },
    [],
  );

  const handleSelectVenue = useCallback((place: VenueCardPlace) => {
    setSelectedVenueId(place.id);
    const map = mapRef.current;
    if (map) {
      const targetZoom = Math.max(map.getZoom(), 18);
      map.flyTo({ center: [place.lon, place.lat], zoom: targetZoom });
    }
    // Open the place-detail card for this venue so the user sees the same
    // floating panel they'd get by clicking the marker. We rebuild a minimal
    // ViewportPlaceLite from the cached raw list.
    const raw = rawPlacesRef.current.find((p) => p.id === place.id);
    if (raw) setSelectedPlace(raw);
  }, []);

  // ── Sunlight timeline fetch (re-runs whenever date / ready changes) ───────
  // DECISION: this is now the SINGLE SSE call for the daily sunlight overlay.
  // The previous `handleRunCalculation` daily branch used to launch a separate
  // discard-only stream just to drive analytics + progress; that flow ignored
  // every UI toggle (cacheOnly / sampleEveryMinutes / ignoreVegetation / etc.)
  // and produced the well-known "toggles do nothing" bug. We now route every
  // daily fetch through `fetchTimeline` with the live UI params and surface
  // analytics from its onStart/onDone callbacks.
  const refreshTimeline = useCallback(
    (map: MapLibreMap, atDate: string) => {
      timelineAbortRef.current?.abort();
      const abort = new AbortController();
      timelineAbortRef.current = abort;
      // Snapshot bounds for analytics labels (3-decimal bucket ≈ 110 m to keep
      // Umami cardinality usable, matching the Leaflet client). Cached at
      // request time so concurrent map movement can't shift the reported point.
      const bounds = map.getBounds();
      const centerLat =
        Math.round(((bounds.getSouth() + bounds.getNorth()) / 2) * 1000) / 1000;
      const centerLon =
        Math.round(((bounds.getWest() + bounds.getEast()) / 2) * 1000) / 1000;
      let requestedTileCount = 0;
      void fetchTimeline({
        map,
        date: atDate,
        startLocalTime: dailyStartLocalTime,
        endLocalTime: dailyEndLocalTime,
        sampleEveryMinutes,
        gridStepMeters,
        buildingHeightBiasMeters,
        ignoreVegetationShadow,
        cacheOnly,
        signal: abort.signal,
        onLoadingChange: setSunlightLoading,
        onProgress: (value) => {
          setTimelineFetchProgress(value);
          // Mirror percent into the richer `dailyProgress` so the
          // ProgressStatus daily UI tracks the same SSE stream. We only flip
          // into "computing" once we have a determinate percent — the
          // "starting" phase is set by `handleRunCalculation` / `onStart`.
          if (typeof value === "number" && requestedTileCount > 0) {
            setDailyProgress((previous) => ({
              phase: "computing",
              percent: value,
              totalTiles: requestedTileCount,
              etaSeconds: previous?.etaSeconds ?? null,
              elapsedMs: previous?.elapsedMs,
            }));
          }
        },
        onError: (err) => console.warn("[maplibre-preview] timeline:", err),
        onStart: ({ totalTiles }) => {
          requestedTileCount = totalTiles;
          setDailyProgress((previous) => ({
            phase: "computing",
            percent: previous?.percent ?? 0,
            totalTiles,
            etaSeconds: previous?.etaSeconds ?? null,
            elapsedMs: previous?.elapsedMs,
          }));
          // Umami analytics — emit one event per compute job the server
          // actually accepted (mirrors Leaflet: tracking earlier overcounts
          // pan/zoom cancellations).
          if (typeof window !== "undefined" && window.umami) {
            window.umami.track("compute-start", {
              centerLat,
              centerLon,
              tilesRequested: totalTiles,
              basemap: baseMapIdToBaseMapStyle(basemapId),
            });
          }
        },
        onDone: ({ tilesFromCache, tilesComputed, elapsedMs }) => {
          setDailyProgress({
            phase: "done",
            percent: 100,
            etaSeconds: 0,
            elapsedMs,
          });
          // Umami analytics — track requests where the server accepted a
          // non-empty bbox but couldn't serve a single tile. With cacheOnly=
          // true on Mitch this is the canonical signal that the user asked
          // about a zone we haven't precomputed yet — the most actionable
          // input for picking which region to ingest next.
          if (
            typeof window !== "undefined" &&
            window.umami &&
            requestedTileCount > 0 &&
            tilesFromCache === 0 &&
            tilesComputed === 0
          ) {
            window.umami.track("unchartered-territory", {
              centerLat,
              centerLon,
              tilesRequested: requestedTileCount,
            });
          }
        },
        onResult: ({ tiles, frames }) => {
          // Preserve the user's current slider position when a new fetch
          // lands. If the new timeline is shorter, clamp; on first load
          // frameIndexRef is still 0 so it naturally lands at frame 0.
          const clamped = Math.min(
            frameIndexRef.current,
            Math.max(0, frames.length - 1),
          );
          const layer = sunlightLayerRef.current;
          if (layer) layer.setTimeline(tiles, clamped, showSunny, showShadow);
          // Sync the satellite patchwork with the currently-loaded sunlight
          // tile set. Only tileCorners is consumed by the patchwork layer.
          const patchworkTiles: SatelliteLoadedTile[] = tiles.map((t) => ({
            tileId: t.tileId,
            tileCorners: t.tileCorners,
          }));
          loadedSunlightTilesRef.current = patchworkTiles;
          satellitePatchworkLayerRef.current?.setLoadedTiles(patchworkTiles);
          // Rebuild the daily aggregate for the new tile set. The aggregate is
          // cached per-tile inside the layer, so subsequent slider moves do
          // not re-run this computation.
          heatmapLayerRef.current?.setTiles(tiles);
          setTimelineFrames(frames);
          setFrameIndex(clamped);
        },
      });
    },
    // Re-create whenever any UI param feeding the SSE URL changes — that's
    // what wires the toggles back to the overlay. showSunny / showShadow are
    // intentionally read at call time (style-only, no refetch needed).
    [
      basemapId,
      cacheOnly,
      ignoreVegetationShadow,
      sampleEveryMinutes,
      gridStepMeters,
      buildingHeightBiasMeters,
      dailyStartLocalTime,
      dailyEndLocalTime,
    ],
  );

  // Trigger initial fetch + on every date change OR recalc bump. refreshTimeline
  // is itself memoised on the UI params, so a toggle change naturally
  // re-triggers this effect → refetch.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    refreshTimeline(map, date);
  }, [date, ready, recalcSignal, refreshTimeline]);

  // ── Place card sunlight windows fetch ─────────────────────────────────────
  useEffect(() => {
    if (!selectedPlace) {
      setCardSunlightWindows(null);
      setCardSunlightError(null);
      setIsCardSunlightLoading(false);
      return;
    }
    const token = ++cardSunlightRequestRef.current;
    const place = selectedPlace;
    const dLat = 5 / 111_320;
    const dLon = dLat / Math.max(Math.cos((place.lat * Math.PI) / 180), 0.01);
    const bbox: [number, number, number, number] = [
      place.lon - dLon, place.lat - dLat,
      place.lon + dLon, place.lat + dLat,
    ];
    const controller = new AbortController();
    setIsCardSunlightLoading(true);
    setCardSunlightError(null);
    setCardSunlightWindows(null);
    fetch("/api/places/windows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date, timezone: "Europe/Zurich", mode: "daily",
        startLocalTime: "00:00", endLocalTime: "23:59",
        sampleEveryMinutes: 15, includeNonSunny: true, bbox, limit: 10,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (controller.signal.aborted || token !== cardSunlightRequestRef.current) return;
        if (!response.ok) {
          setCardSunlightError(
            response.status === 400 || response.status === 404
              ? "Lancer un calcul du jour pour voir l'ensoleillement."
              : "Erreur de chargement de l'ensoleillement.",
          );
          setIsCardSunlightLoading(false);
          return;
        }
        const json = (await response.json()) as {
          places?: Array<{ id: string; sunnyWindows?: SunlightWindow[] }>;
        };
        if (token !== cardSunlightRequestRef.current) return;
        const match = json.places?.find((p) => p.id === place.id);
        setCardSunlightWindows(match?.sunnyWindows ?? []);
        setIsCardSunlightLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (token !== cardSunlightRequestRef.current) return;
        setCardSunlightError(err instanceof Error ? err.message : "Erreur.");
        setIsCardSunlightLoading(false);
      });
    return () => controller.abort();
  }, [selectedPlace, date]);

  // ── Map mount ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const baseMaps = baseMapsRef.current!;
    const initial = baseMaps.find((b) => b.id === "aquarelle") ?? baseMaps[0];
    const storedView = loadStoredMapView();
    // 1x1 transparent GIF data URI — returned in place of Stadia watercolor
    // tiles that are fully covered by the satellite patchwork. MapLibre still
    // sees a "tile" response (no warning) but no network request lands on the
    // metered Stadia origin.
    const TRANSPARENT_PIXEL_DATA_URL =
      "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(initial),
      center: storedView ? [storedView.lon, storedView.lat] : DEFAULT_CENTER,
      zoom: storedView?.zoom ?? DEFAULT_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      transformRequest: (url, resourceType) => {
        // Only consider Stadia watercolor tiles. Other URLs (CARTO, Esri,
        // glyphs) pass through untouched.
        if (resourceType !== "Tile") return { url };
        if (!url.includes("tiles.stadiamaps.com/tiles/stamen_watercolor/")) {
          return { url };
        }
        const m = /\/stamen_watercolor\/(\d+)\/(\d+)\/(\d+)\.jpg/.exec(url);
        if (!m) return { url };
        const z = Number(m[1]);
        const x = Number(m[2]);
        const y = Number(m[3]);
        if (isAquarelleTileCovered(z, x, y, loadedSunlightTilesRef.current)) {
          return { url: TRANSPARENT_PIXEL_DATA_URL };
        }
        return { url };
      },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-left");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");

    // Add the instant-points source + one circle layer per category. Idempotent:
    // safe to call again after setStyle wipes user-defined sources.
    const addInstantPointsLayers = (m: MapLibreMap) => {
      if (!m.getSource(INSTANT_POINTS_SOURCE_ID)) {
        m.addSource(INSTANT_POINTS_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      for (const category of Object.keys(INSTANT_POINT_LAYER_IDS) as InstantPointCategory[]) {
        const layerId = INSTANT_POINT_LAYER_IDS[category];
        if (m.getLayer(layerId)) continue;
        m.addLayer({
          id: layerId,
          type: "circle",
          source: INSTANT_POINTS_SOURCE_ID,
          filter: ["==", ["get", "category"], category],
          paint: {
            "circle-radius": 3,
            "circle-color": INSTANT_POINT_COLORS[category],
            "circle-stroke-width": 0.5,
            "circle-stroke-color": "rgba(0,0,0,0.35)",
            "circle-opacity": 0.85,
          },
          layout: { visibility: "none" },
        });
      }
    };

    map.on("load", () => {
      addPlacesLayers(map);
      attachPlacesInteractions(map, setSelectedPlace);
      addInstantPointsLayers(map);
      setReady(true);

      // Insert satellite patchwork FIRST (below sunlight): basemap (aquarelle)
      // → satellite patchwork → sunlight → heatmap → cluster-circles → places.
      const satellitePatchworkLayer = new MapLibreSatellitePatchworkLayer(map);
      map.addLayer(satellitePatchworkLayer, "cluster-circles");
      satellitePatchworkLayerRef.current = satellitePatchworkLayer;

      const sunlightLayer = new MapLibreSunlightCustomLayer(map);
      map.addLayer(sunlightLayer, "cluster-circles");
      sunlightLayerRef.current = sunlightLayer;
      // TEMP: expose for visual A/B style testing + cache diagnostics
      (window as unknown as Record<string, unknown>).__sl = sunlightLayer;
      (window as unknown as Record<string, unknown>).__tileCache = inspectTileCache;

      // Heatmap layer sits on top of the sunlight layer (added after) so when
      // it becomes visible it covers the timeline overlay. Only one of the two
      // is visible at any time (toggled via showHeatmap).
      const heatmapLayer = new MapLibreHeatmapCustomLayer(map);
      map.addLayer(heatmapLayer, "cluster-circles");
      heatmapLayerRef.current = heatmapLayer;
      void fetchViewportPlaces(map);
    });

    map.on("moveend", () => {
      const c = map.getCenter();
      persistMapView({
        lat: Number(c.lat.toFixed(6)),
        lon: Number(c.lng.toFixed(6)),
        zoom: map.getZoom(),
      });
      if (viewportPlacesDebounceRef.current !== null) {
        window.clearTimeout(viewportPlacesDebounceRef.current);
      }
      viewportPlacesDebounceRef.current = window.setTimeout(() => {
        void fetchViewportPlaces(map);
      }, 400);
      // Auto-refresh the sunlight timeline ~1s after the user stops moving.
      // Longer debounce than places because the SSE is heavier (worth waiting
      // until the user has clearly settled on a viewport).
      if (sunlightDebounceRef.current !== null) {
        window.clearTimeout(sunlightDebounceRef.current);
      }
      sunlightDebounceRef.current = window.setTimeout(() => {
        setRecalcSignal((c) => c + 1);
      }, 1000);
    });

    // Track whether we already wired place click/hover listeners — those
    // attach to the map itself and survive setStyle, so re-attaching on
    // every styledata would leak duplicate listeners. We only attach once.
    let placeInteractionsAttached = false;
    map.on("styledata", () => {
      if (!map.getSource("places")) {
        addPlacesLayers(map);
        if (!placeInteractionsAttached) {
          attachPlacesInteractions(map, setSelectedPlace);
          placeInteractionsAttached = true;
        }
        // Re-apply current filters from the cached raw places so the cluster
        // counts repaint immediately without waiting for a refetch.
        applyPlacesToSource(map, filtersRef.current);
      }
      // setStyle wipes user-defined GeoJSON sources too — re-add the instant
      // points overlay. Data + visibility are re-applied by the dedicated
      // effects below (they re-run on `ready`/`lastResult`/toggle changes).
      addInstantPointsLayers(map);
      const sp = satellitePatchworkLayerRef.current;
      if (sp) {
        if (map.getLayer(sp.id)) map.removeLayer(sp.id);
        map.addLayer(sp, "cluster-circles");
      }
      const sl = sunlightLayerRef.current;
      if (sl) {
        // MapLibre keeps the custom layer reference across setStyle but does
        // NOT call onAdd/onRemove on the swap. We force the lifecycle ourselves
        // so the layer reinitialises its GL program and re-uploads tile
        // textures into the (potentially) reset GL state machine.
        if (map.getLayer(sl.id)) map.removeLayer(sl.id);
        map.addLayer(sl, "cluster-circles");
      }
      const hm = heatmapLayerRef.current;
      if (hm) {
        if (map.getLayer(hm.id)) map.removeLayer(hm.id);
        map.addLayer(hm, "cluster-circles");
      }
    });

    return () => {
      timelineAbortRef.current?.abort();
      timelineAbortRef.current = null;
      if (viewportPlacesDebounceRef.current !== null) {
        window.clearTimeout(viewportPlacesDebounceRef.current);
        viewportPlacesDebounceRef.current = null;
      }
      if (sunlightDebounceRef.current !== null) {
        window.clearTimeout(sunlightDebounceRef.current);
        sunlightDebounceRef.current = null;
      }
      viewportPlacesAbortRef.current?.abort();
      viewportPlacesAbortRef.current = null;
      map.remove();
      sunlightLayerRef.current?.dispose();
      sunlightLayerRef.current = null;
      satellitePatchworkLayerRef.current?.dispose();
      satellitePatchworkLayerRef.current = null;
      heatmapLayerRef.current?.dispose();
      heatmapLayerRef.current = null;
      mapRef.current = null;
    };
  }, [fetchViewportPlaces]);

  // Apply basemap switches.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const target = baseMapsRef.current!.find((b) => b.id === basemapId);
    if (target) map.setStyle(buildStyle(target));
  }, [basemapId, ready]);

  // Debug snapshot exposed on the window. Updated on every render so the
  // closure captures fresh state.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__diag = () => {
      const map = mapRef.current;
      // Cast to any for debug introspection — the layer instances expose
      // private state we want to peek at without leaking it through their
      // public API.
      const sl = sunlightLayerRef.current as unknown as
        { visible?: boolean; tiles?: unknown[]; tileStates?: Map<string, unknown> } | null;
      const hm = heatmapLayerRef.current as unknown as
        { tiles?: unknown[] } | null;
      const pw = satellitePatchworkLayerRef.current as unknown as
        { loadedTiles?: unknown[]; tileTextures?: Map<string, unknown> } | null;
      const center = map?.getCenter();
      const bounds = map?.getBounds();
      return {
        map: map
          ? {
              center: center ? [Number(center.lng.toFixed(6)), Number(center.lat.toFixed(6))] : null,
              zoom: Number((map.getZoom() ?? 0).toFixed(3)),
              bounds: bounds
                ? {
                    w: Number(bounds.getWest().toFixed(6)),
                    s: Number(bounds.getSouth().toFixed(6)),
                    e: Number(bounds.getEast().toFixed(6)),
                    n: Number(bounds.getNorth().toFixed(6)),
                  }
                : null,
              basemapId,
              layerOrder: map.getStyle().layers.map((l) => l.id),
            }
          : null,
        sunlight: sl
          ? {
              visible: sl.visible ?? null,
              tilesCount: sl.tiles?.length ?? 0,
              tileStatesCount: sl.tileStates?.size ?? 0,
            }
          : null,
        heatmap: hm ? { tilesCount: hm.tiles?.length ?? 0 } : null,
        patchwork: pw
          ? {
              loadedTilesCount: pw.loadedTiles?.length ?? 0,
              satelliteTexturesCount: pw.tileTextures?.size ?? 0,
            }
          : null,
        tileCache: inspectTileCache(),
        ui: {
          mode,
          date,
          frameIndex,
          timelineFrames: timelineFrames.length,
          sunlightLoading,
          timelineFetchProgress,
          isCalculating,
          selectedPlace: selectedPlace?.id ?? null,
          panelTab,
          showSunny,
          showShadow,
          showHeatmap,
          showTerrain,
          showBuildings,
          showVegetation,
          showPlaces,
          ignoreVegetationShadow,
        },
        dpr: window.devicePixelRatio,
      };
    };
  });

  // Repaint sunlight overlay on slider / toggle changes. When the heatmap is
  // active we hide the sunlight overlay entirely — same behaviour as the
  // Leaflet client (the two visualisations are mutually exclusive).
  useEffect(() => {
    const layer = sunlightLayerRef.current;
    if (!layer) return;
    const sunlightShouldRender = sunlightVisible && !showHeatmap;
    layer.setVisible(sunlightShouldRender);
    if (sunlightShouldRender) layer.setFrameIndex(frameIndex, showSunny, showShadow);
  }, [sunlightVisible, frameIndex, showSunny, showShadow, showHeatmap]);

  // Propagate the "ignore vegetation shadow" flag to the GPU layer so the
  // daily rendering switches between `sun` and `sunNoVeg` masks. Mirrors the
  // Leaflet client where `getTileMask(tile, frameIdx, ignoreVegetationShadow)`
  // picks the appropriate base64-encoded mask.
  useEffect(() => {
    sunlightLayerRef.current?.setIgnoreVegetationShadow(ignoreVegetationShadow);
  }, [ignoreVegetationShadow]);

  // Show/hide the venue markers (cluster bubbles, individual dots, labels)
  // when the user toggles "Terrasses". Mirrors the Leaflet client where
  // `showPlaces=false` disposes the PlacesViewportOverlay entirely.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const visibility = showPlaces ? "visible" : "none";
    for (const id of ["cluster-circles", "cluster-counts", "places-dots", "places-labels"]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
    }
  }, [ready, showPlaces]);

  // Push accumulated instant-mode points into the GeoJSON source on every
  // partial/start/done. Cheap: setData is O(features) once per batch.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(INSTANT_POINTS_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!source) return;
    source.setData(instantPointsToFeatureCollection(lastResult ?? []));
  }, [lastResult, ready]);

  // Per-category visibility for the instant points. Each layer is toggled
  // independently so user can hide e.g. only `terrain-blocked` while keeping
  // `sunny` visible. Switching to daily hides every category.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const isInstant = mode === "instant";
    const visibility: Record<InstantPointCategory, boolean> = {
      sunny: isInstant && showSunny,
      shadow: isInstant && showShadow,
      "terrain-blocked": isInstant && showTerrain,
      "buildings-blocked": isInstant && showBuildings,
      // DECISION: vegetation-blocked points stay visible (in green) only when
      // the user has NOT enabled "ignore vegetation shadow". When the user
      // explicitly ignores vegetation, those points should not show up as a
      // shadow cause — matches the Leaflet visibility.ignoreVegetationShadow
      // branch which skips buildInstantBlockedContours for vegetation.
      "vegetation-blocked":
        isInstant && showVegetation && !ignoreVegetationShadow,
    };
    for (const category of Object.keys(INSTANT_POINT_LAYER_IDS) as InstantPointCategory[]) {
      const layerId = INSTANT_POINT_LAYER_IDS[category];
      if (!map.getLayer(layerId)) continue;
      map.setLayoutProperty(
        layerId,
        "visibility",
        visibility[category] ? "visible" : "none",
      );
    }
  }, [
    ready,
    mode,
    showSunny,
    showShadow,
    showTerrain,
    showBuildings,
    showVegetation,
    ignoreVegetationShadow,
  ]);

  // Heatmap visibility — independent of sunlightVisible so the user can flip
  // back and forth without losing the sunlight slider position.
  useEffect(() => {
    const layer = heatmapLayerRef.current;
    if (!layer) return;
    layer.setVisible(showHeatmap);
  }, [showHeatmap]);

  // One-shot basemap swap: stay on Aquarelle while the first sunlight
  // timeline is loading, then flip to Satellite once the tiles are ready.
  // Subsequent date changes / recalculations don't re-trigger the swap, and
  // the user can still manually pick another basemap.
  useEffect(() => {
    if (autoBasemapDone.current) return;
    if (sunlightLoading || timelineFrames.length === 0) return;
    autoBasemapDone.current = true;
    setBasemapId("satellite");
  }, [sunlightLoading, timelineFrames]);

  // Push style-panel settings to the layer (texture filter + outline + hatch).
  useEffect(() => {
    const layer = sunlightLayerRef.current;
    if (!layer) return;
    layer.setTextureFilter(styleSettings.textureFilter);
    layer.setStyle({
      outlineWidthPx: styleSettings.outlineEnabled ? styleSettings.outlineWidthPx : -1,
      hatchAlpha: styleSettings.hatchEnabled ? 0.95 : 0,
      hatchSpacingPx: styleSettings.hatchSpacingPx,
      hatchJitter: styleSettings.hatchWobble,
      hatchSpaceJitter: styleSettings.hatchSpaceJitter,
    });
  }, [styleSettings, ready]);

  // ── Shared UI fragments (rendered in desktop left panel AND mobile sheet) ─
  // DECISION: same node passed to both call sites is fine because they're in
  // different DOM trees gated by `hidden lg:flex` / `lg:hidden` — React
  // simply renders them twice. This mirrors the Leaflet client's approach.
  const calculationControlsNode = (
    <CalculationControls
      mode={mode}
      date={date}
      isLoading={isCalculating}
      isDailyRangeInvalid={isDailyRangeInvalid}
      onDateChange={setDate}
      onRunCalculation={() => void handleRunCalculation()}
      onCancelDailyCalculation={handleCancelDailyCalculation}
    />
  );
  const progressStatusNode = (
    <ProgressStatus
      mode={mode}
      dailyProgress={dailyProgress}
      instantProgress={instantProgress}
      formatDuration={formatDuration}
    />
  );
  // DECISION: the preview client does not (yet) wire SSE timeline warnings,
  // focus-run messaging, calc/timeline errors or places-error state. Pass the
  // empty defaults so DailyCoverage renders null when there is nothing to say.
  const coveragePanel = (
    <DailyCoverage
      focusRunMessage={null}
      focusRunMessageIsError={false}
      error={null}
      warnings={[]}
      placesError={null}
    />
  );
  const layerFiltersNode = (
    <LayerFilters
      overlayMode={overlayMode}
      showTerrain={showTerrain}
      showPlaces={showPlaces}
      ignoreVegetationShadow={ignoreVegetationShadow}
      canShowHeatmap={canShowHeatmap}
      cacheOnly={cacheOnly}
      forceCacheOnly={forceCacheOnly}
      onOverlayModeChange={(value) => {
        if (value === "heatmap") {
          setStyleSettings((s) => ({ ...s, showSunny: false, showShadow: false }));
          setShowHeatmap(true);
        } else {
          setStyleSettings((s) => ({ ...s, showSunny: true, showShadow: true }));
          setShowHeatmap(false);
        }
      }}
      onShowTerrainChange={setShowTerrain}
      onShowPlacesChange={setShowPlaces}
      onIgnoreVegetationShadowChange={setIgnoreVegetationShadow}
      onCacheOnlyChange={() => {}}
    />
  );

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      {/* Desktop horizontal search banner at the top of the screen. Hidden on
          mobile (FloatingSearch lives there). */}
      <div className="pointer-events-auto absolute left-1/2 top-3 z-10 hidden w-[420px] -translate-x-1/2 rounded-2xl bg-white/80 p-2 shadow-md backdrop-blur lg:block">
        <SearchPanel mapRef={mapRef} />
      </div>

      {/* Left control panel — date + filters. Desktop only: 280px sidebar.
          DECISION: mobile no longer renders this stack at the top; controls
          and filters live in MobileBottomSheet. The desktop panel keeps the
          same content so the desktop layout stays identical. */}
      <div
        className={`pointer-events-auto absolute left-3 top-3 z-10 hidden flex-col gap-3 overflow-hidden rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur transition-[height] duration-300 ease-out lg:flex lg:right-auto lg:w-[280px] ${
          panelTab === "terraces"
            ? "lg:h-[calc(100dvh-24px)]"
            : "lg:h-[min(640px,calc(100dvh-24px))]"
        }`}
      >
        <ViewTabs
          activeTab={panelTab}
          venueCount={sunlitPlaces.length}
          onTabChange={(tab) => {
            setPanelTab(tab);
            if (tab === "terraces") {
              setShowPlaces(true);
            }
          }}
        />
        {panelTab === "map" ? (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
            {calculationControlsNode}
            {/* No visible Instant/Daily toggle: the Leaflet homepage does not
                expose one either (mode is driven by localStorage, deep-link
                query params, and cache-focus selection). */}
            {progressStatusNode}
            {layerFiltersNode}
            {coveragePanel}
            <FilterPanel filters={filters} onChange={setFilters} />
            <StylePanel settings={styleSettings} onChange={setStyleSettings} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2">
              <p className="text-sm font-semibold text-slate-900">
                Terrasses au soleil
              </p>
              <p className="text-xs text-slate-500">
                {`${sunlitPlaces.length} établissements visibles`}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <BarsList
                places={sunlitPlaces}
                isLoading={false}
                mode={mode}
                localTime={localTime}
                selectedVenueId={selectedVenueId}
                onSelectVenue={handleSelectVenue}
              />
            </div>
          </div>
        )}
      </div>


      {/* Basemap switcher — top-right on desktop, hidden on mobile (rarely
          used; could be moved to a popover later). */}
      <div
        className="absolute right-3 top-3 z-10 hidden rounded-md bg-white/95 px-2 py-2 shadow-md backdrop-blur lg:block"
        style={{ font: "13px system-ui, sans-serif" }}
      >
        <div className="mb-1 px-1 text-xs font-semibold text-gray-700">Basemap</div>
        <div className="flex flex-col gap-1">
          {baseMapsRef.current!.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                // Manual selection locks the one-shot auto-swap so a late
                // sunlight-loaded event can't override the user's choice.
                autoBasemapDone.current = true;
                // Umami analytics — explicit user interaction with the basemap
                // selector. State restoration paths (storage, deep-link) set
                // basemapId directly via setBasemapId without going through
                // this onClick, so they don't pollute the metric.
                if (b.id !== basemapId && typeof window !== "undefined" && window.umami) {
                  window.umami.track("basemap-change", {
                    fromBasemap: baseMapIdToBaseMapStyle(basemapId),
                    toBasemap: baseMapIdToBaseMapStyle(b.id),
                  });
                }
                setBasemapId(b.id);
              }}
              className={
                "rounded px-2 py-1 text-left text-sm transition-colors " +
                (b.id === basemapId
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-800 hover:bg-gray-200")
              }
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* Sunlight overlay controls (bottom). Wraps on narrow screens. */}
      <div
        className="absolute bottom-10 left-3 right-3 z-10 mx-auto flex max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-center gap-2 rounded-md bg-white/95 px-3 py-2 shadow-md backdrop-blur lg:left-1/2 lg:right-auto lg:max-w-none lg:-translate-x-1/2 lg:flex-nowrap"
        style={{ font: "13px system-ui, sans-serif" }}
      >
        <button
          type="button"
          onClick={() => setSunlightVisible((v) => !v)}
          title="Afficher/masquer l'overlay"
          style={{ fontSize: "16px", lineHeight: 1 }}
        >
          {sunlightVisible ? "☀️" : "🌙"}
        </button>
        <button
          type="button"
          onClick={() => setStyleSettings((s) => ({ ...s, showSunny: !s.showSunny }))}
          className={showSunny ? "opacity-100" : "opacity-40"}
          title="Ensoleillé"
          style={{ fontSize: "16px", lineHeight: 1 }}
        >
          ☀
        </button>
        <button
          type="button"
          onClick={() => setStyleSettings((s) => ({ ...s, showShadow: !s.showShadow }))}
          className={showShadow ? "opacity-100" : "opacity-40"}
          title="Ombragé"
          style={{ fontSize: "16px", lineHeight: 1 }}
        >
          🌑
        </button>

        <button
          type="button"
          onClick={() => setRecalcSignal((c) => c + 1)}
          title="Recalculer l'ensoleillement pour la zone visible"
          className="rounded-full bg-amber-200 px-2 py-0.5 text-sm font-semibold text-amber-900 hover:bg-amber-300 disabled:bg-slate-200 disabled:text-slate-400"
          disabled={sunlightLoading}
        >
          ↻
        </button>

        {timelineFrames.length > 1 && (
          <div className="min-w-[200px] flex-1">
            <TimeSlider
              mode="daily"
              frameIndex={frameIndex}
              frameCount={timelineFrames.length}
              activeFrameTime={timelineFrames[frameIndex]?.localTime ?? null}
              computeProgress={timelineFetchProgress}
              disabled={sunlightLoading && timelineFetchProgress === undefined}
              onFrameIndexChange={setFrameIndex}
            />
          </div>
        )}
      </div>

      {/* Phase tag (bottom-right). */}
      <div
        className="absolute bottom-3 right-3 z-10 rounded-md bg-white/95 px-3 py-2 shadow-md backdrop-blur"
        style={{ font: "12px system-ui, sans-serif" }}
      >
        <div className="font-semibold text-gray-800">MapLibre preview</div>
        <a href="/" className="mt-1 inline-block text-blue-600 hover:underline">
          ← Retour à la carte Leaflet
        </a>
      </div>

      {/* ── Mobile UX stack (lg:hidden) ──────────────────────────────────── */}
      <FloatingSearch
        isOpen={isSearchOpen}
        query={searchQuery}
        isLoading={isSearchLoading}
        error={searchError}
        onOpen={handleOpenSearch}
        onClose={() => setIsSearchOpen(false)}
        onQueryChange={setSearchQuery}
        onSubmit={() => void handleSubmitSearch()}
      />
      {isSearchOpen ? (
        <div
          className="pointer-events-auto absolute inset-x-0 top-0 z-[600] lg:hidden"
          data-mobile-search-root
        >
          <PlaceSuggestionsDropdown
            query={searchQuery}
            onSelect={handleSelectSuggestion}
            variant="floating"
            closeSignal={suggestionsCloseSignal}
          />
        </div>
      ) : null}

      <div className="lg:hidden">
        <MobileBottomSheet
          state={bottomSheetState}
          venueCount={sunlitPlaces.length}
          timeline={
            timelineFrames.length > 1 ? (
              <TimeSlider
                mode="daily"
                frameIndex={frameIndex}
                frameCount={timelineFrames.length}
                activeFrameTime={timelineFrames[frameIndex]?.localTime ?? null}
                computeProgress={timelineFetchProgress}
                disabled={sunlightLoading && timelineFetchProgress === undefined}
                onFrameIndexChange={setFrameIndex}
              />
            ) : null
          }
          controls={
            <div className="grid gap-3">
              {calculationControlsNode}
              {progressStatusNode}
            </div>
          }
          filters={layerFiltersNode}
          coverage={coveragePanel}
          onStateChange={setBottomSheetState}
          onOpenBars={() => setIsMobileBarsOpen(true)}
        />
      </div>

      <MobileBarsView
        open={isMobileBarsOpen}
        places={sunlitPlaces}
        isLoading={false}
        mode={mode}
        localTime={localTime}
        selectedVenueId={selectedVenueId}
        onClose={() => setIsMobileBarsOpen(false)}
        onSelectVenue={handleSelectVenue}
      />

      {selectedPlace ? (
        <PlaceDetailCard
          place={selectedPlace}
          sunlightWindows={cardSunlightWindows}
          isLoading={isCardSunlightLoading}
          error={cardSunlightError}
          onClose={() => setSelectedPlace(null)}
        />
      ) : null}
    </div>
  );
}
