"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import polygonClipping from "polygon-clipping";
import type {
  LayerGroup,
  LeafletMouseEvent,
  Map as LeafletMap,
  TileLayer,
} from "leaflet";
import type { CacheRunDetailResponse } from "@/lib/admin/cache-run-detail";
import { decodeTileMasksBlob } from "@/lib/encoding/mask-codec-client";
import { BitmapTileOverlay } from "@/components/sunlight-overlay/bitmap-tile-overlay";
import {
  PlacesViewportOverlay,
  type PlacesViewportOverlayFilters,
} from "@/components/places-overlay/places-viewport-overlay";
import type { NormalizedPlaceLite } from "@/components/places-overlay/viewport-places";

interface ViewportPlaceLite extends NormalizedPlaceLite {
  osmType: "node" | "way" | "relation";
  osmId: number;
  outdoorSeatingCovered?: "yes" | "no" | "partial";
  outdoorSeatingHeated?: boolean;
}

function viewportCardEmoji(place: ViewportPlaceLite): string {
  if (place.category === "park") return "🌳";
  switch (place.subcategory) {
    case "cafe":
      return "☕";
    case "bar":
    case "pub":
      return "🍺";
    case "restaurant":
      return "🍴";
    case "fast_food":
      return "🥡";
    default:
      return "📍";
  }
}
import { paintTileImageData } from "@/components/sunlight-overlay/paint-tile";
import {
  buildUnifiedViewportContours,
  type VisibleTileInput,
} from "@/components/sunlight-overlay/unified-viewport-contours";
import {
  selectRenderStrategy,
  shouldRerasterize,
  type RenderMode,
} from "@/components/sunlight-overlay/render-strategy";
import { useModeOverride } from "@/components/sunlight-overlay/use-mode-override";
import { BarsList } from "@/components/map-ui/bars-list";
import {
  CalculationControls,
  DailyCoverage,
  LayerFilters,
  type OverlayMode,
  ProgressStatus,
  TimeSlider,
  ViewTabs,
} from "@/components/map-ui/controls";
import { FloatingSearch } from "@/components/map-ui/floating-search";
import {
  PlaceSuggestionsDropdown,
  type PlaceSuggestion,
} from "@/components/map-ui/place-suggestions-dropdown";
import {
  MobileBarsView,
  MobileBottomSheet,
  type BottomSheetState,
} from "@/components/map-ui/layouts";
import {
  buildVenueMarkerHtml,
  getVenueSunStatus,
  venueMarkerClassName,
} from "@/components/map-ui/venue-assets";
import type { VenueCardPlace } from "@/components/map-ui/venue-card";

type AreaMode = "instant" | "daily";
type BaseMapStyle =
  | "stamen-watercolor"
  | "carto-voyager"
  | "osm"
  | "satellite";
type MapPanelTab = "map" | "terraces";

interface BaseMapOption {
  id: BaseMapStyle;
  label: string;
  url: string;
  attribution: string;
  maxNativeZoom: number;
  /** Additional raster tile URLs stacked on top of the base layer (e.g.
   *  Stamen Watercolor with Toner labels). Rendered in array order — first
   *  overlay sits directly above the base, last overlay on top. */
  overlays?: Array<{ url: string; maxNativeZoom?: number; opacity?: number }>;
}

// Order matters — the first entry is the default basemap (Aquarelle).
// The selector in the UI keeps this order.
const BASE_MAP_OPTIONS: BaseMapOption[] = [
  {
    // Stamen Watercolor — peinture artistique + labels CARTO Voyager.
    // Les labels viennent de CARTO (`voyager_only_labels`) pour rester
    // indépendants du quota Stadia : si Stadia tombe, le watercolor
    // bascule en Voyager via le fallback per-tile (`attachStadiaFallback`)
    // et les labels continuent à charger normalement.
    id: "stamen-watercolor",
    label: "Aquarelle",
    url: "https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg",
    overlays: [
      { url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png", maxNativeZoom: 20 },
    ],
    attribution:
      "&copy; <a href=\"https://stamen.com\">Stamen Design</a>, hosted by <a href=\"https://stadiamaps.com/\">Stadia Maps</a> | Labels &copy; CARTO &mdash; Map data &copy; OpenStreetMap contributors",
    maxNativeZoom: 18,
  },
  {
    id: "carto-voyager",
    label: "CARTO Voyager",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    maxNativeZoom: 20,
  },
  {
    id: "osm",
    label: "OSM standard",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    maxNativeZoom: 19,
  },
  {
    id: "satellite",
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
    maxNativeZoom: 19,
  },
];

const BASE_MAP_OPTION_BY_ID = new Map(BASE_MAP_OPTIONS.map((option) => [option.id, option]));

function isBaseMapStyle(value: unknown): value is BaseMapStyle {
  return typeof value === "string" && BASE_MAP_OPTION_BY_ID.has(value as BaseMapStyle);
}

interface AreaInstantPoint {
  id: string;
  lat: number;
  lon: number;
  isSunny: boolean;
  terrainBlocked: boolean;
  buildingsBlocked: boolean;
  vegetationBlocked?: boolean;
  altitudeDeg: number;
  azimuthDeg: number;
  pointElevationMeters: number | null;
}

interface AreaDailyPoint {
  id: string;
  lat: number;
  lon: number;
  sunnyMinutes: number;
  pointElevationMeters: number | null;
}

interface TerrainHorizonRidgePoint {
  azimuthDeg: number;
  lat: number;
  lon: number;
  distanceMeters: number;
  horizonAngleDeg: number;
  peakElevationMeters: number;
}

interface TerrainHorizonDebug {
  center: {
    lat: number;
    lon: number;
  };
  radiusKm: number;
  ridgePoints: TerrainHorizonRidgePoint[];
}

interface PointInstantApiResponse {
  mode: "instant";
  date: string;
  timezone: string;
  localTime: string;
  utcTime: string;
  sample: {
    azimuthDeg: number;
    altitudeDeg: number;
    horizonAngleDeg: number | null;
    aboveAstronomicalHorizon: boolean;
    terrainBlocked: boolean;
    buildingsBlocked: boolean;
    vegetationBlocked?: boolean;
    buildingBlockerId: string | null;
    buildingBlockerDistanceMeters: number | null;
    buildingBlockerAltitudeAngleDeg: number | null;
    vegetationBlockerDistanceMeters?: number | null;
    vegetationBlockerAltitudeAngleDeg?: number | null;
    vegetationBlockerSurfaceElevationMeters?: number | null;
    vegetationBlockerClearanceMeters?: number | null;
    isSunny: boolean;
  };
  model: {
    terrainHorizonMethod: string;
    buildingsShadowMethod: string;
    vegetationShadowMethod?: string;
    terrainHorizonDebug?: TerrainHorizonDebug | null;
  };
  pointContext: {
    lv95Easting: number;
    lv95Northing: number;
    pointElevationMeters: number | null;
    insideBuilding: boolean;
    indoorBuildingId: string | null;
  };
  diagnostics?: {
    terrainRidgePoint?: TerrainHorizonRidgePoint | null;
  };
  warnings: string[];
  error?: string;
  details?: string;
}

interface AreaApiResponse {
  mode: AreaMode;
  gridStepMeters: number;
  pointCount: number;
  points: AreaInstantPoint[] | AreaDailyPoint[];
  model?: {
    terrainHorizonMethod: string;
    buildingsShadowMethod: string;
    vegetationShadowMethod?: string;
    terrainHorizonDebug?: TerrainHorizonDebug | null;
  };
  warnings: string[];
  stats: {
    elapsedMs: number;
    pointsWithElevation: number;
    pointsWithoutElevation: number;
    indoorPointsExcluded?: number;
  };
}

type FoodVenueType = "restaurant" | "bar" | "snack" | "foodtruck" | "other";

interface SunlitPlaceEntry {
  id: string;
  name: string;
  category: string;
  subcategory: string;
  venueType: FoodVenueType;
  hasOutdoorSeating: boolean;
  lat: number;
  lon: number;
  evaluationLat: number;
  evaluationLon: number;
  selectionStrategy: "original" | "terrace_offset" | "indoor_fallback";
  selectionOffsetMeters: number;
  pointElevationMeters: number | null;
  insideBuilding: boolean;
  isSunnyNow: boolean | null;
  sunnyMinutes: number;
  sunnyWindows: Array<{
    startLocalTime: string;
    endLocalTime: string;
    durationMinutes: number;
  }>;
  sunlightStartLocalTime: string | null;
  sunlightEndLocalTime: string | null;
  warnings: string[];
}

interface TimelinePoint {
  id: string;
  lat: number;
  lon: number;
}

interface TimelineFrame {
  index: number;
  localTime: string;
  sunnyCount: number;
  sunnyCountNoVegetation?: number;
  sunMaskBase64: string;
  sunMaskNoVegetationBase64?: string;
}

/** Pre-decoded masks from gzip-concat-v1 blob — stored directly as Uint8Array */
interface DecodedTileMasks {
  outdoor: Uint8Array;
  frames: Array<{ sun: Uint8Array; sunNoVeg: Uint8Array }>;
}

interface TileGrid {
  minIx: number;
  maxIx: number;
  minIy: number;
  maxIy: number;
  width: number;
  height: number;
}

interface LatLon { lat: number; lon: number; }

interface TimelineTile {
  tileId: string;
  grid?: TileGrid;
  outdoorMaskBase64?: string;
  decodedMasks?: DecodedTileMasks;
  points: TimelinePoint[];
  frames: TimelineFrame[];
  tileBounds?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  tileCorners?: { nw: LatLon; ne: LatLon; sw: LatLon; se: LatLon };
}

interface DailyTimelineState {
  date: string;
  timezone: string;
  startLocalTime: string;
  endLocalTime: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  pointCount: number;
  gridPointCount: number;
  indoorPointsExcluded: number;
  frameCount: number;
  tiles: TimelineTile[];
  points: TimelinePoint[];
  frames: TimelineFrame[];
  overlayBounds?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  model: {
    terrainHorizonMethod: string;
    buildingsShadowMethod: string;
    vegetationShadowMethod?: string;
    terrainHorizonDebug?: TerrainHorizonDebug | null;
  } | null;
  warnings: string[];
  stats: {
    elapsedMs: number;
    evaluationElapsedMs: number;
    pointsWithElevation: number;
    pointsWithoutElevation: number;
    indoorPointsExcluded: number;
    frameCount: number;
    totalEvaluations: number;
  } | null;
}

interface DailyExposurePoint {
  id: string;
  lat: number;
  lon: number;
  sunnyFrames: number;
  totalFrames: number;
  exposureRatio: number;
}

interface DailyExposureCell {
  ring: Ring;
  exposureRatio: number;
  sunnyFrames: number;
  totalFrames: number;
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

interface TimelineProgress {
  phase: string;
  done: number;
  total: number;
  percent: number;
  etaSeconds: number | null;
  elapsedMs?: number;
  tileIndex?: number;
  totalTiles?: number;
}

interface InstantStreamStartPayload {
  mode: "instant";
  date: string;
  timezone: string;
  localTime: string;
  utcTime: string;
  bbox: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
  gridStepMeters: number;
  gridPointCount: number;
  model: NonNullable<AreaApiResponse["model"]>;
  warnings: string[];
}

interface InstantStreamPartialPayload {
  points: AreaInstantPoint[];
  pointCount: number;
  indoorPointsExcluded: number;
}

interface InstantStreamDonePayload {
  mode: "instant";
  date: string;
  timezone: string;
  localTime: string;
  utcTime: string;
  bbox: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
  gridStepMeters: number;
  pointCount: number;
  gridPointCount: number;
  model: NonNullable<AreaApiResponse["model"]>;
  warnings: string[];
  stats: {
    elapsedMs: number;
    pointsWithElevation: number;
    pointsWithoutElevation: number;
    indoorPointsExcluded: number;
  };
}

const METERS_PER_DEGREE_LAT = 111_320;
const DEFAULT_MAP_CENTER: [number, number] = [46.5197, 6.6323];
const DEFAULT_MAP_ZOOM = 13;
const MAP_MAX_NATIVE_ZOOM = 19;
const MAP_MAX_ZOOM = 23;
const MAP_VIEW_STORAGE_KEY = "mappy-hour:map:view";
const UI_PARAMS_STORAGE_KEY = "mappy-hour:ui:params";
const FOCUS_RUN_QUERY_KEYS = {
  region: "focusRunRegion",
  modelVersionHash: "focusRunModel",
  date: "focusRunDate",
  gridStepMeters: "focusRunGrid",
  sampleEveryMinutes: "focusRunSample",
  startLocalTime: "focusRunStart",
  endLocalTime: "focusRunEnd",
} as const;
const DEEP_LINK_QUERY_KEYS = {
  mode: "mode",
  date: "date",
  localTime: "time",
  dailyStartLocalTime: "dailyStart",
  dailyEndLocalTime: "dailyEnd",
  gridStepMeters: "grid",
  sampleEveryMinutes: "sample",
  buildingHeightBiasMeters: "bias",
  baseMapStyle: "basemap",
  ignoreVegetationShadow: "ignoreVegetation",
  showSunny: "showSunny",
  showShadow: "showShadow",
  showBuildings: "showBuildings",
  showTerrain: "showTerrain",
  showVegetation: "showVegetation",
  showHeatmap: "showHeatmap",
  showPlaces: "showPlaces",
  bbox: "bbox",
  center: "center",
  zoom: "zoom",
  autoRun: "autoRun",
} as const;
type XY = [number, number];
type Ring = XY[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface FocusRunParams {
  region: "lausanne" | "nyon";
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}

interface FocusRunOverlayState {
  token: string;
  bbox: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
  outlineRings: Array<Array<[number, number]>>;
}

interface DeepLinkMapState {
  bbox?: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
  center?: {
    lat: number;
    lon: number;
  };
  zoom?: number;
}

interface DeepLinkParams {
  mode?: AreaMode;
  date?: string;
  localTime?: string;
  dailyStartLocalTime?: string;
  dailyEndLocalTime?: string;
  gridStepMeters?: number;
  sampleEveryMinutes?: number;
  buildingHeightBiasMeters?: number;
  baseMapStyle?: BaseMapStyle;
  ignoreVegetationShadow?: boolean;
  showSunny?: boolean;
  showShadow?: boolean;
  showBuildings?: boolean;
  showTerrain?: boolean;
  showVegetation?: boolean;
  showHeatmap?: boolean;
  showPlaces?: boolean;
  map?: DeepLinkMapState;
  autoRun: boolean;
}

interface ParsedPoint {
  row: number;
  col: number;
  lat: number;
  lon: number;
  isSunny: boolean;
}

interface StoredMapView {
  lat: number;
  lon: number;
  zoom: number;
}

interface StoredUiParams {
  mode: AreaMode;
  date: string;
  localTime: string;
  dailyStartLocalTime: string;
  dailyEndLocalTime: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  buildingHeightBiasMeters: number;
  baseMapStyle: BaseMapStyle;
  ignoreVegetationShadow: boolean;
  showSunny: boolean;
  showShadow: boolean;
  showBuildings: boolean;
  showTerrain: boolean;
  showVegetation: boolean;
  showHeatmap: boolean;
  showPlaces: boolean;
}

function loadStoredMapView(): StoredMapView | null {
  try {
    const raw = globalThis.localStorage.getItem(MAP_VIEW_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<StoredMapView>;
    const lat = parsed.lat;
    const lon = parsed.lon;
    const zoom = parsed.zoom;
    if (
      typeof lat !== "number" ||
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      typeof lon !== "number" ||
      !Number.isFinite(lon) ||
      lon < -180 ||
      lon > 180 ||
      typeof zoom !== "number" ||
      !Number.isFinite(zoom) ||
      zoom < 0 ||
      zoom > MAP_MAX_ZOOM
    ) {
      return null;
    }

    return {
      lat,
      lon,
      zoom,
    };
  } catch {
    return null;
  }
}

function persistMapView(view: StoredMapView): void {
  try {
    globalThis.localStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Ignore storage errors to avoid blocking map interactions.
  }
}

function loadStoredUiParams(): StoredUiParams | null {
  try {
    const raw = globalThis.localStorage.getItem(UI_PARAMS_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<StoredUiParams>;
    const mode = parsed.mode;
    const date = parsed.date;
    const localTime = parsed.localTime;
    const dailyStartLocalTime = parsed.dailyStartLocalTime;
    const dailyEndLocalTime = parsed.dailyEndLocalTime;
    const gridStepMeters = parsed.gridStepMeters;
    const sampleEveryMinutes = parsed.sampleEveryMinutes;
    const buildingHeightBiasMeters = parsed.buildingHeightBiasMeters;
    const baseMapStyle = parsed.baseMapStyle as BaseMapStyle | "map" | undefined;
    const ignoreVegetationShadow = parsed.ignoreVegetationShadow;
    const showSunny = parsed.showSunny;
    const showShadow = parsed.showShadow;
    const showBuildings = parsed.showBuildings;
    const showTerrain = parsed.showTerrain;
    const showVegetation = parsed.showVegetation;
    const showHeatmap = parsed.showHeatmap;
    const showPlaces = parsed.showPlaces;

    const valid =
      (mode === "instant" || mode === "daily") &&
      typeof date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      typeof localTime === "string" &&
      /^\d{2}:\d{2}$/.test(localTime) &&
      (typeof dailyStartLocalTime === "string"
        ? /^\d{2}:\d{2}$/.test(dailyStartLocalTime)
        : dailyStartLocalTime === undefined) &&
      (typeof dailyEndLocalTime === "string"
        ? /^\d{2}:\d{2}$/.test(dailyEndLocalTime)
        : dailyEndLocalTime === undefined) &&
      typeof gridStepMeters === "number" &&
      Number.isFinite(gridStepMeters) &&
      gridStepMeters >= 1 &&
      gridStepMeters <= 2000 &&
      typeof sampleEveryMinutes === "number" &&
      Number.isFinite(sampleEveryMinutes) &&
      sampleEveryMinutes >= 1 &&
      sampleEveryMinutes <= 60 &&
      (typeof buildingHeightBiasMeters === "number"
        ? Number.isFinite(buildingHeightBiasMeters) &&
          buildingHeightBiasMeters >= -20 &&
          buildingHeightBiasMeters <= 20
        : buildingHeightBiasMeters === undefined) &&
      (isBaseMapStyle(baseMapStyle) || baseMapStyle === "map" || baseMapStyle === undefined) &&
      (typeof ignoreVegetationShadow === "boolean" ||
        ignoreVegetationShadow === undefined) &&
      typeof showSunny === "boolean" &&
      typeof showShadow === "boolean" &&
      typeof showBuildings === "boolean" &&
      (typeof showTerrain === "boolean" || showTerrain === undefined) &&
      (typeof showVegetation === "boolean" || showVegetation === undefined) &&
      (typeof showHeatmap === "boolean" || showHeatmap === undefined) &&
      (typeof showPlaces === "boolean" || showPlaces === undefined);
    if (!valid) {
      return null;
    }

    return {
      mode,
      date,
      localTime,
      dailyStartLocalTime: dailyStartLocalTime ?? "06:00",
      dailyEndLocalTime: dailyEndLocalTime ?? "21:00",
      gridStepMeters,
      sampleEveryMinutes,
      buildingHeightBiasMeters: buildingHeightBiasMeters ?? 0,
      baseMapStyle:
        baseMapStyle === "map"
          ? "osm"
          : isBaseMapStyle(baseMapStyle)
            ? baseMapStyle
            : "carto-voyager",
      ignoreVegetationShadow: ignoreVegetationShadow ?? false,
      showSunny,
      showShadow,
      showBuildings,
      showTerrain: showTerrain ?? true,
      showVegetation: showVegetation ?? true,
      showHeatmap: showHeatmap ?? true,
      showPlaces: showPlaces ?? true,
    };
  } catch {
    return null;
  }
}

function persistUiParams(params: StoredUiParams): void {
  try {
    globalThis.localStorage.setItem(UI_PARAMS_STORAGE_KEY, JSON.stringify(params));
  } catch {
    // Ignore storage errors to avoid blocking interactions.
  }
}

function parseBoundedInteger(
  value: string | null,
  bounds: { min: number; max: number },
): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    return null;
  }
  return parsed;
}

function parseBoundedFloat(
  value: string | null,
  bounds: { min: number; max: number },
): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    return null;
  }
  return parsed;
}

function parseQueryBoolean(value: string | null): boolean | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return null;
}

function parseBboxQuery(value: string | null): DeepLinkMapState["bbox"] | null {
  if (!value) {
    return null;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (
    minLon < -180 ||
    maxLon > 180 ||
    minLat < -90 ||
    maxLat > 90 ||
    minLon >= maxLon ||
    minLat >= maxLat
  ) {
    return null;
  }
  return { minLon, minLat, maxLon, maxLat };
}

function parseCenterQuery(value: string | null): DeepLinkMapState["center"] | null {
  if (!value) {
    return null;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const [lat, lon] = parts;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  return { lat, lon };
}

function parseDeepLinkParams(searchParams: URLSearchParams): DeepLinkParams | null {
  const parsed: DeepLinkParams = {
    autoRun: parseQueryBoolean(searchParams.get(DEEP_LINK_QUERY_KEYS.autoRun)) ?? false,
  };
  let hasValue = parsed.autoRun;

  const mode = searchParams.get(DEEP_LINK_QUERY_KEYS.mode);
  if (mode === "instant" || mode === "daily") {
    parsed.mode = mode;
    hasValue = true;
  }

  const date = searchParams.get(DEEP_LINK_QUERY_KEYS.date);
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    parsed.date = date;
    hasValue = true;
  }

  const localTime = searchParams.get(DEEP_LINK_QUERY_KEYS.localTime);
  if (localTime && /^\d{2}:\d{2}$/.test(localTime)) {
    parsed.localTime = localTime;
    hasValue = true;
  }

  const dailyStartLocalTime = searchParams.get(DEEP_LINK_QUERY_KEYS.dailyStartLocalTime);
  if (dailyStartLocalTime && /^\d{2}:\d{2}$/.test(dailyStartLocalTime)) {
    parsed.dailyStartLocalTime = dailyStartLocalTime;
    hasValue = true;
  }

  const dailyEndLocalTime = searchParams.get(DEEP_LINK_QUERY_KEYS.dailyEndLocalTime);
  if (dailyEndLocalTime && /^\d{2}:\d{2}$/.test(dailyEndLocalTime)) {
    parsed.dailyEndLocalTime = dailyEndLocalTime;
    hasValue = true;
  }

  const gridStepMeters = parseBoundedInteger(
    searchParams.get(DEEP_LINK_QUERY_KEYS.gridStepMeters),
    { min: 1, max: 2000 },
  );
  if (gridStepMeters !== null) {
    parsed.gridStepMeters = gridStepMeters;
    hasValue = true;
  }

  const sampleEveryMinutes = parseBoundedInteger(
    searchParams.get(DEEP_LINK_QUERY_KEYS.sampleEveryMinutes),
    { min: 1, max: 60 },
  );
  if (sampleEveryMinutes !== null) {
    parsed.sampleEveryMinutes = sampleEveryMinutes;
    hasValue = true;
  }

  const buildingHeightBiasMeters = parseBoundedFloat(
    searchParams.get(DEEP_LINK_QUERY_KEYS.buildingHeightBiasMeters),
    { min: -20, max: 20 },
  );
  if (buildingHeightBiasMeters !== null) {
    parsed.buildingHeightBiasMeters = buildingHeightBiasMeters;
    hasValue = true;
  }

  const baseMapStyle = searchParams.get(DEEP_LINK_QUERY_KEYS.baseMapStyle);
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
    const parsedBoolean = parseQueryBoolean(searchParams.get(queryKey));
    if (parsedBoolean !== null) {
      (parsed[targetKey] as boolean | undefined) = parsedBoolean;
      hasValue = true;
    }
  }

  const mapBbox = parseBboxQuery(searchParams.get(DEEP_LINK_QUERY_KEYS.bbox));
  const mapCenter = parseCenterQuery(searchParams.get(DEEP_LINK_QUERY_KEYS.center));
  const mapZoom = parseBoundedInteger(searchParams.get(DEEP_LINK_QUERY_KEYS.zoom), {
    min: 0,
    max: MAP_MAX_ZOOM,
  });
  if (mapBbox || mapCenter || mapZoom !== null) {
    parsed.map = {};
    if (mapBbox) {
      parsed.map.bbox = mapBbox;
    }
    if (mapCenter) {
      parsed.map.center = mapCenter;
    }
    if (mapZoom !== null) {
      parsed.map.zoom = mapZoom;
    }
    hasValue = true;
  }

  return hasValue ? parsed : null;
}

function deepLinkToken(params: DeepLinkParams): string {
  return JSON.stringify(params);
}

function parseFocusRunParams(
  searchParams: URLSearchParams,
): FocusRunParams | null {
  const region = searchParams.get(FOCUS_RUN_QUERY_KEYS.region);
  const modelVersionHash = searchParams.get(FOCUS_RUN_QUERY_KEYS.modelVersionHash);
  const date = searchParams.get(FOCUS_RUN_QUERY_KEYS.date);
  const gridStepMeters = parseBoundedInteger(
    searchParams.get(FOCUS_RUN_QUERY_KEYS.gridStepMeters),
    { min: 1, max: 2000 },
  );
  const sampleEveryMinutes = parseBoundedInteger(
    searchParams.get(FOCUS_RUN_QUERY_KEYS.sampleEveryMinutes),
    { min: 1, max: 60 },
  );
  const startLocalTime = searchParams.get(FOCUS_RUN_QUERY_KEYS.startLocalTime);
  const endLocalTime = searchParams.get(FOCUS_RUN_QUERY_KEYS.endLocalTime);

  if (region !== "lausanne" && region !== "nyon") {
    return null;
  }
  if (!modelVersionHash || modelVersionHash.trim().length === 0) {
    return null;
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  if (!startLocalTime || !/^\d{2}:\d{2}$/.test(startLocalTime)) {
    return null;
  }
  if (!endLocalTime || !/^\d{2}:\d{2}$/.test(endLocalTime)) {
    return null;
  }
  if (gridStepMeters === null || sampleEveryMinutes === null) {
    return null;
  }

  return {
    region,
    modelVersionHash: modelVersionHash.trim(),
    date,
    gridStepMeters,
    sampleEveryMinutes,
    startLocalTime,
    endLocalTime,
  };
}

function focusRunToken(params: FocusRunParams): string {
  return [
    params.region,
    params.modelVersionHash,
    params.date,
    params.gridStepMeters,
    params.sampleEveryMinutes,
    params.startLocalTime,
    params.endLocalTime,
  ].join("|");
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeAzimuth(azimuthDeg: number): number {
  const rounded = Math.round(azimuthDeg) % 360;
  return rounded >= 0 ? rounded : rounded + 360;
}

function extractTimeFromLocalDateTime(localDateTime: string | null): string | null {
  if (!localDateTime) {
    return null;
  }
  const match = /\b(\d{2}:\d{2})(?::\d{2})?\b/.exec(localDateTime);
  return match ? match[1] : null;
}

function localTimeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return hour * 60 + minute;
}

function destinationPointByAzimuth(
  lat: number,
  lon: number,
  azimuthDeg: number,
  distanceMeters: number,
): { lat: number; lon: number } {
  const azimuthRad = (azimuthDeg * Math.PI) / 180;
  const deltaEastMeters = Math.sin(azimuthRad) * distanceMeters;
  const deltaNorthMeters = Math.cos(azimuthRad) * distanceMeters;
  const deltaLat = deltaNorthMeters / METERS_PER_DEGREE_LAT;
  const metersPerDegreeLon =
    METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
  const deltaLon =
    Math.abs(metersPerDegreeLon) < 1e-9
      ? 0
      : deltaEastMeters / metersPerDegreeLon;

  return {
    lat: lat + deltaLat,
    lon: lon + deltaLon,
  };
}

function classifyTerrainSource(
  response: PointInstantApiResponse,
): "DEM local (colline du terrain de la ville)" | "montagnes" | null {
  if (!response.sample.terrainBlocked) {
    return null;
  }

  const ridgePoint =
    response.diagnostics?.terrainRidgePoint ??
    response.model.terrainHorizonDebug?.ridgePoints.find(
      (point) => point.azimuthDeg === normalizeAzimuth(response.sample.azimuthDeg),
    ) ??
    null;

  if (!ridgePoint) {
    return null;
  }

  return classifyRidgeDistance(ridgePoint.distanceMeters);
}

function classifyRidgeDistance(
  distanceMeters: number,
): "DEM local (colline du terrain de la ville)" | "montagnes" {
  return distanceMeters >= 20_000
    ? "montagnes"
    : "DEM local (colline du terrain de la ville)";
}

function selectPrimaryShadowCause(input: {
  aboveAstronomicalHorizon: boolean;
  terrainBlocked: boolean;
  vegetationBlocked: boolean;
  buildingsBlocked: boolean;
  terrainSource: "DEM local (colline du terrain de la ville)" | "montagnes" | null;
  isSunny: boolean;
}): { primary: string; secondary: string[] } {
  if (input.isSunny) {
    return { primary: "aucune (point ensoleillé)", secondary: [] };
  }

  const causes = new Set<string>();
  if (!input.aboveAstronomicalHorizon) {
    causes.add("courbure de la terre");
  }
  if (input.terrainBlocked) {
    causes.add(input.terrainSource ?? "terrain/horizon");
  }
  if (input.vegetationBlocked) {
    causes.add("végétation");
  }
  if (input.buildingsBlocked) {
    causes.add("bâtiment");
  }

  const priority = [
    "courbure de la terre",
    "montagnes",
    "DEM local (colline du terrain de la ville)",
    "terrain/horizon",
    "végétation",
    "bâtiment",
  ];
  for (const candidate of priority) {
    if (causes.has(candidate)) {
      const secondary = Array.from(causes).filter((cause) => cause !== candidate);
      return { primary: candidate, secondary };
    }
  }

  return { primary: "inconnu", secondary: Array.from(causes) };
}

function zurichNowDateAndTime(): { date: string; time: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((accumulator, part) => {
      if (part.type !== "literal") {
        accumulator[part.type] = part.value;
      }
      return accumulator;
    }, {});

  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  return { date, time };
}

function parseGridPointId(id: string): { row: number; col: number } | null {
  const gridMatch = /^r(-?\d+)c(-?\d+)$/.exec(id);
  if (gridMatch) {
    const row = Number(gridMatch[1]);
    const col = Number(gridMatch[2]);
    if (Number.isInteger(row) && Number.isInteger(col)) {
      return { row, col };
    }
    return null;
  }

  // Cached tile artifacts use canonical LV95 indices (`ix{col}-iy{row}`).
  const lv95Match = /^ix(-?\d+)-iy(-?\d+)$/.exec(id);
  if (lv95Match) {
    const col = Number(lv95Match[1]);
    const row = Number(lv95Match[2]);
    if (Number.isInteger(row) && Number.isInteger(col)) {
      return { row, col };
    }
  }

  return null;
}

function buildBoundsFromCenters(centers: number[], fallbackHalfStep: number): number[] {
  if (centers.length === 0) {
    return [];
  }
  if (centers.length === 1) {
    return [centers[0] - fallbackHalfStep, centers[0] + fallbackHalfStep];
  }

  const bounds: number[] = new Array(centers.length + 1);
  bounds[0] = centers[0] - (centers[1] - centers[0]) / 2;
  bounds[centers.length] =
    centers[centers.length - 1] +
    (centers[centers.length - 1] - centers[centers.length - 2]) / 2;

  for (let i = 1; i < centers.length; i += 1) {
    bounds[i] = (centers[i - 1] + centers[i]) / 2;
  }

  return bounds;
}

function closeRing(ring: Ring): Ring {
  if (ring.length < 3) {
    return ring;
  }

  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) {
    return ring;
  }

  return [...ring, first];
}

function mergePolygons(polygons: Polygon[]): MultiPolygon {
  if (polygons.length === 0) {
    return [];
  }

  const [first, ...rest] = polygons;
  try {
    const merged = polygonClipping.union(first, ...rest);
    return Array.isArray(merged) ? (merged as MultiPolygon) : [];
  } catch {
    // Fallback path: merge incrementally and skip invalid geometries
    // so one bad ring does not crash the whole map rendering.
    let result: MultiPolygon = [first];
    for (const polygon of rest) {
      try {
        const mergedIncremental = polygonClipping.union(result, [polygon]);
        if (Array.isArray(mergedIncremental)) {
          result = mergedIncremental as MultiPolygon;
        }
      } catch {
        // Skip invalid polygon
      }
    }
    return result;
  }
}

function parsePointsForContours(response: AreaApiResponse): ParsedPoint[] {
  if (response.mode === "instant") {
    return (response.points as AreaInstantPoint[])
      .map((point) => {
        const parsedId = parseGridPointId(point.id);
        if (!parsedId) {
          return null;
        }
        return {
          row: parsedId.row,
          col: parsedId.col,
          lat: point.lat,
          lon: point.lon,
          isSunny: point.isSunny,
        };
      })
      .filter((point): point is ParsedPoint => point !== null);
  }

  return (response.points as AreaDailyPoint[])
    .map((point) => {
      const parsedId = parseGridPointId(point.id);
      if (!parsedId) {
        return null;
      }
      return {
        row: parsedId.row,
        col: parsedId.col,
        lat: point.lat,
        lon: point.lon,
        isSunny: point.sunnyMinutes > 0,
      };
    })
    .filter((point): point is ParsedPoint => point !== null);
}

function buildSunAndShadowContours(response: AreaApiResponse): {
  sunnyContours: MultiPolygon;
  shadowContours: MultiPolygon;
} {
  const parsedPoints = parsePointsForContours(response);
  if (parsedPoints.length === 0) {
    return { sunnyContours: [], shadowContours: [] };
  }

  const rowLatMap = new Map<number, number>();
  const colLonMap = new Map<number, number>();
  for (const point of parsedPoints) {
    if (!rowLatMap.has(point.row)) {
      rowLatMap.set(point.row, point.lat);
    }
    if (!colLonMap.has(point.col)) {
      colLonMap.set(point.col, point.lon);
    }
  }

  const sortedRows = Array.from(rowLatMap.keys()).sort((a, b) => a - b);
  const sortedCols = Array.from(colLonMap.keys()).sort((a, b) => a - b);
  const rowIndex = new Map<number, number>(
    sortedRows.map((row, index) => [row, index]),
  );
  const colIndex = new Map<number, number>(
    sortedCols.map((col, index) => [col, index]),
  );
  const latCenters = sortedRows.map((row) => rowLatMap.get(row) ?? 0);
  const lonCenters = sortedCols.map((col) => colLonMap.get(col) ?? 0);
  const meanLat =
    latCenters.reduce((accumulator, value) => accumulator + value, 0) /
    Math.max(1, latCenters.length);
  const latHalfStepDeg = response.gridStepMeters / METERS_PER_DEGREE_LAT / 2;
  const lonHalfStepDeg =
    response.gridStepMeters /
    (METERS_PER_DEGREE_LAT * Math.max(Math.cos((meanLat * Math.PI) / 180), 0.01)) /
    2;
  const latBounds = buildBoundsFromCenters(latCenters, latHalfStepDeg);
  const lonBounds = buildBoundsFromCenters(lonCenters, lonHalfStepDeg);

  const sunnyCells: Polygon[] = [];
  const shadowCells: Polygon[] = [];

  for (const point of parsedPoints) {
    const row = rowIndex.get(point.row);
    const col = colIndex.get(point.col);
    if (row === undefined || col === undefined) {
      continue;
    }
    if (row + 1 >= latBounds.length || col + 1 >= lonBounds.length) {
      continue;
    }

    const ring: Ring = closeRing([
      [lonBounds[col], latBounds[row]],
      [lonBounds[col + 1], latBounds[row]],
      [lonBounds[col + 1], latBounds[row + 1]],
      [lonBounds[col], latBounds[row + 1]],
    ]);
    const polygon: Polygon = [ring];
    if (point.isSunny) {
      sunnyCells.push(polygon);
    } else {
      shadowCells.push(polygon);
    }
  }

  return {
    sunnyContours: mergePolygons(sunnyCells),
    shadowContours: mergePolygons(shadowCells),
  };
}

const CANVAS_OVERLAY_THRESHOLD = 10_000;

// RGBA colors for canvas pixels
const SUNNY_RGBA = [250, 204, 21, 102] as const; // yellow-400 @ 40% (mirrors vector fillOpacity 0.4)
const SHADOW_RGBA = [100, 116, 139, 89] as const; // slate-500 @ 35% (mirrors vector fillOpacity 0.35)

// Phase 2 overlay LOD: shared palette (used by paint-tile.ts when rendering
// bitmap tiles). Mirrors SUNNY_RGBA / SHADOW_RGBA + an indoor-grey color
// matching the legacy vector mode building footprint blue tint.
const PAINT_TILE_PALETTE = {
  sunny: { r: SUNNY_RGBA[0], g: SUNNY_RGBA[1], b: SUNNY_RGBA[2], a: SUNNY_RGBA[3] },
  shadow: { r: SHADOW_RGBA[0], g: SHADOW_RGBA[1], b: SHADOW_RGBA[2], a: SHADOW_RGBA[3] },
  indoor: { r: 37, g: 99, b: 235, a: 50 }, // blue-600 @ 20% — match buildings layer
};

const SUNLIGHT_TILE_SIZE_METERS = 250;

/**
 * Count how many `tiles` intersect the current viewport `bounds`. Used by the
 * Phase 2 render-strategy LOD to choose vector vs bitmap. If `bounds` is
 * missing (pre-mount), fall back to the unfiltered tile count.
 */
function countVisibleTiles(
  tiles: TimelineTile[],
  bounds: L.LatLngBounds | null,
): number {
  if (!bounds) return tiles.length;
  let n = 0;
  for (const t of tiles) {
    if (!t.tileCorners) {
      // Without corners we can't cull cheaply — count it as visible.
      n++;
      continue;
    }
    const c = t.tileCorners;
    const tileMinLat = Math.min(c.nw.lat, c.ne.lat, c.sw.lat, c.se.lat);
    const tileMaxLat = Math.max(c.nw.lat, c.ne.lat, c.sw.lat, c.se.lat);
    const tileMinLon = Math.min(c.nw.lon, c.ne.lon, c.sw.lon, c.se.lon);
    const tileMaxLon = Math.max(c.nw.lon, c.ne.lon, c.sw.lon, c.se.lon);
    // AABB ∩ AABB
    if (
      tileMaxLat >= bounds.getSouth() &&
      tileMinLat <= bounds.getNorth() &&
      tileMaxLon >= bounds.getWest() &&
      tileMinLon <= bounds.getEast()
    ) {
      n++;
    }
  }
  return n;
}

interface SunShadowGrid {
  /** Pixel coordinates for each tile's outdoor points (tile index → array of {x, y, outdoorIndex}) */
  tilePixelMaps: Array<{ x: number; y: number }[]>;
  width: number;
  height: number;
  bounds: [[number, number], [number, number]];
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

interface PerTileOverlay {
  tileId: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  overlay: L.ImageOverlay;
  width: number;
  height: number;
  bounds: [[number, number], [number, number]];
}

function prepareSunShadowGrid(
  timeline: DailyTimelineState,
): SunShadowGrid | null {
  if (timeline.tiles.length === 0) return null;

  // Use grid bounds from tiles (new format) or parse point IDs (legacy)
  const hasGridFormat = timeline.tiles.some(t => t.grid);

  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;

  // For grid format: tilePixelMaps are not needed (paintSunShadowFrame
  // reads grid-indexed masks directly). We still need global col/row.
  // For legacy format: build pixel maps from parsed point IDs.
  const tilePixelMaps: Array<{ x: number; y: number }[]> = [];

  if (hasGridFormat) {
    for (const tile of timeline.tiles) {
      if (!tile.grid) continue;
      if (tile.grid.minIx < minCol) minCol = tile.grid.minIx;
      if (tile.grid.maxIx > maxCol) maxCol = tile.grid.maxIx;
      if (tile.grid.minIy < minRow) minRow = tile.grid.minIy;
      if (tile.grid.maxIy > maxRow) maxRow = tile.grid.maxIy;
      tilePixelMaps.push([]); // placeholder — grid format uses direct indexing
    }
  } else {
    for (const tile of timeline.tiles) {
      const parsed: Array<{ row: number; col: number }> = [];
      for (const p of tile.points) {
        const id = parseGridPointId(p.id);
        if (!id) continue;
        parsed.push({ row: id.row, col: id.col });
        if (id.row < minRow) minRow = id.row;
        if (id.row > maxRow) maxRow = id.row;
        if (id.col < minCol) minCol = id.col;
        if (id.col > maxCol) maxCol = id.col;
      }
      tilePixelMaps.push(parsed.map((p) => ({ x: p.col - minCol, y: maxRow - p.row })));
    }
  }

  const colRange = maxCol - minCol;
  const rowRange = maxRow - minRow;
  if (colRange <= 0 || rowRange <= 0) return null;

  const width = colRange + 1;
  const height = rowRange + 1;
  if (width > 10000 || height > 10000) return null;

  // Use overlayBounds from the done event (server-computed via lv95ToWgs84).
  // Before done arrives, use approximate bounds from grid extent.
  if (!timeline.overlayBounds) {
    // No bounds yet — cannot create overlay (wait for done event)
    return null;
  }
  const boundsS = timeline.overlayBounds.minLat;
  const boundsN = timeline.overlayBounds.maxLat;
  const boundsW = timeline.overlayBounds.minLon;
  const boundsE = timeline.overlayBounds.maxLon;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  return {
    tilePixelMaps,
    width,
    height,
    bounds: [
      [boundsS, boundsW],
      [boundsN, boundsE],
    ] as [[number, number], [number, number]],
    canvas,
    ctx,
  };
}

function paintSunShadowFrame(
  grid: SunShadowGrid,
  timeline: DailyTimelineState,
  frameIndex: number,
  decodedMaskCache: Map<string, Uint8Array>,
  ignoreVegetation: boolean,
): void {
  const { width, height, ctx, tilePixelMaps } = grid;
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  const safeIndex = Math.max(0, Math.min(frameIndex, (timeline.tiles[0]?.frames.length ?? 1) - 1));

  // Extract global minCol/maxRow from the grid dimensions
  // The grid object stores tilePixelMaps but for grid-indexed tiles
  // we need the global offsets. Compute from the first tile with grid data.
  let globalMinCol = Infinity, globalMaxRow = -Infinity;
  for (const tile of timeline.tiles) {
    if (tile.grid) {
      if (tile.grid.minIx < globalMinCol) globalMinCol = tile.grid.minIx;
      if (tile.grid.maxIy > globalMaxRow) globalMaxRow = tile.grid.maxIy;
    }
  }

  for (let tileIdx = 0; tileIdx < timeline.tiles.length; tileIdx++) {
    const tile = timeline.tiles[tileIdx];
    const mask = getTileMask(tile, safeIndex, ignoreVegetation, decodedMaskCache);
    if (!mask) continue;

    if (tile.grid) {
      // Grid-indexed format: each bit = 1 grid cell, ordered iy asc then ix asc.
      // Map grid cells to canvas pixels using the tile's grid bounds.
      const tileW = tile.grid.width;
      const outdoorMask = getTileOutdoorMask(tile, decodedMaskCache);
      const cellCount = tileW * tile.grid.height;
      for (let cellIdx = 0; cellIdx < cellCount; cellIdx++) {
        // Only paint outdoor cells
        if (outdoorMask && !((outdoorMask[cellIdx >> 3] >> (cellIdx & 7)) & 1)) continue;
        const isSunny = ((mask[cellIdx >> 3] >> (cellIdx & 7)) & 1) === 1;
        const tileRow: number = tile.grid.minIy + Math.floor(cellIdx / tileW);
        const tileCol: number = tile.grid.minIx + (cellIdx % tileW);
        const x: number = tileCol - globalMinCol;
        const y: number = globalMaxRow - tileRow;
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const offset = (y * width + x) * 4;
        const rgba = isSunny ? SUNNY_RGBA : SHADOW_RGBA;
        data[offset] = rgba[0];
        data[offset + 1] = rgba[1];
        data[offset + 2] = rgba[2];
        data[offset + 3] = rgba[3];
      }
    } else {
      // Legacy format: use pixel maps
      const pixelMap = tilePixelMaps[tileIdx];
      for (let i = 0; i < pixelMap.length; i++) {
        const isSunny = ((mask[i >> 3] >> (i & 7)) & 1) === 1;
        const { x, y } = pixelMap[i];
        const offset = (y * width + x) * 4;
        const rgba = isSunny ? SUNNY_RGBA : SHADOW_RGBA;
        data[offset] = rgba[0];
        data[offset + 1] = rgba[1];
        data[offset + 2] = rgba[2];
        data[offset + 3] = rgba[3];
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * Marching squares contour extraction from a grid mask.
 * Produces a small number of polygon rings (~20-50) that trace the
 * boundaries between sunny and shadow regions. O(N) time.
 * Each vertex is positioned via bilinear interpolation from the tile's
 * 4 corners → precise lat/lon, no alignment error.
 */
// d3-contour produces MultiPolygon GeoJSON with proper holes
import { contours as d3Contours } from "d3-contour";

function buildTileContourPolygons(
  tile: TimelineTile,
  frameIndex: number,
  decodedMaskCache: Map<string, Uint8Array>,
  ignoreVegetation: boolean,
): { sunnyPolygons: Array<[number, number][][]>; shadowPolygons: Array<[number, number][][]>; buildingPolygons: Array<[number, number][][]> } {
  const empty = { sunnyPolygons: [], shadowPolygons: [], buildingPolygons: [] };
  if (!tile.grid || !tile.tileCorners || tile.frames.length === 0) return empty;

  const grid = tile.grid;
  const tileW = grid.width;
  const tileH = grid.height;
  const mask = getTileMask(tile, frameIndex, ignoreVegetation, decodedMaskCache);
  if (!mask) return empty;

  const outdoorMask = getTileOutdoorMask(tile, decodedMaskCache);

  // Bilinear interpolation from tile corners for vertex positioning
  const { nw, ne, sw, se } = tile.tileCorners;
  const toLatLon = (fx: number, fy: number): [number, number] => {
    // d3-contour uses x=col (0→tileW), y=row (0→tileH) where y=0 is top
    // Our grid: iy=0 is south, iy=tileH-1 is north
    // d3-contour y=0 is the first row in the flat array = iy=0 = south
    const tx = tileW > 0 ? fx / tileW : 0.5;
    const ty = tileH > 0 ? fy / tileH : 0.5;
    // ty=0 → south, ty=1 → north
    const lat = sw.lat * (1 - tx) * (1 - ty) + se.lat * tx * (1 - ty) + nw.lat * (1 - tx) * ty + ne.lat * tx * ty;
    const lon = sw.lon * (1 - tx) * (1 - ty) + se.lon * tx * (1 - ty) + nw.lon * (1 - tx) * ty + ne.lon * tx * ty;
    return [lat, lon];
  };

  // Build zero-padded grid for d3-contour. Indoor cells are set to
  // their nearest outdoor neighbor's value (sunny=1 or shadow=1) so
  // that d3-contour does NOT create a boundary at building edges.
  // The building footprint comes from the outdoor mask (separate layer),
  // not from contour edges — this prevents the 0.5m smoothing artifact
  // that made building outlines appear shifted.
  const padW = tileW + 2;
  const padH = tileH + 2;
  const sunnyGrid = new Float64Array(padW * padH);
  const shadowGrid = new Float64Array(padW * padH);
  // First pass: set outdoor cells normally
  for (let iy = 0; iy < tileH; iy++) {
    for (let ix = 0; ix < tileW; ix++) {
      const cellIdx = iy * tileW + ix;
      const isOutdoor = outdoorMask ? ((outdoorMask[cellIdx >> 3] >> (cellIdx & 7)) & 1) === 1 : true;
      const isSunny = isOutdoor && ((mask![cellIdx >> 3] >> (cellIdx & 7)) & 1) === 1;
      const padIdx = (iy + 1) * padW + (ix + 1);
      if (isOutdoor) {
        sunnyGrid[padIdx] = isSunny ? 1 : 0;
        shadowGrid[padIdx] = isSunny ? 0 : 1;
      }
      // Indoor cells stay 0 for now, filled in second pass
    }
  }
  // Second pass: fill indoor cells by flood-filling from nearest outdoor neighbor.
  // This makes contours extend smoothly through buildings without edge artifacts.
  for (let iy = 0; iy < tileH; iy++) {
    for (let ix = 0; ix < tileW; ix++) {
      const cellIdx = iy * tileW + ix;
      const isOutdoor = outdoorMask ? ((outdoorMask[cellIdx >> 3] >> (cellIdx & 7)) & 1) === 1 : true;
      if (isOutdoor) continue;
      const padIdx = (iy + 1) * padW + (ix + 1);
      // Check 4-connected neighbors for an outdoor value to copy
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = ix + dx, ny = iy + dy;
        if (nx < 0 || nx >= tileW || ny < 0 || ny >= tileH) continue;
        const nIdx = ny * tileW + nx;
        const nOutdoor = outdoorMask ? ((outdoorMask[nIdx >> 3] >> (nIdx & 7)) & 1) === 1 : true;
        if (nOutdoor) {
          const nPadIdx = (ny + 1) * padW + (nx + 1);
          sunnyGrid[padIdx] = sunnyGrid[nPadIdx];
          shadowGrid[padIdx] = shadowGrid[nPadIdx];
          break;
        }
      }
    }
  }

  const contourGen = d3Contours().size([padW, padH]).thresholds([0.5]);

  // Shift by -0.5: d3-contour places isolines between cells, so the
  // transition at padded col 0→1 is at x=0.5. Shifting maps it to x=0
  // (exact tile edge). Same for the far edge.
  function convertContour(contour: { coordinates: number[][][][] }): Array<[number, number][][]> {
    return contour.coordinates.map((polygon: number[][][]) =>
      polygon.map((ring: number[][]) =>
        ring.map((pt: number[]) => toLatLon(pt[0] - 0.5, pt[1] - 0.5))
      )
    );
  }

  // Buildings grid: indoor=1, outdoor=0 (inverse of outdoor mask)
  const buildingsGrid = new Float64Array(padW * padH);
  for (let iy = 0; iy < tileH; iy++) {
    for (let ix = 0; ix < tileW; ix++) {
      const cellIdx = iy * tileW + ix;
      const isOutdoor = outdoorMask ? ((outdoorMask[cellIdx >> 3] >> (cellIdx & 7)) & 1) === 1 : true;
      buildingsGrid[(iy + 1) * padW + (ix + 1)] = isOutdoor ? 0 : 1;
    }
  }

  const sunnyContours = contourGen(Array.from(sunnyGrid));
  const shadowContours = contourGen(Array.from(shadowGrid));
  const buildingContours = contourGen(Array.from(buildingsGrid));

  return {
    sunnyPolygons: sunnyContours.length > 0 ? convertContour(sunnyContours[0]) : [],
    shadowPolygons: shadowContours.length > 0 ? convertContour(shadowContours[0]) : [],
    buildingPolygons: buildingContours.length > 0 ? convertContour(buildingContours[0]) : [],
  };
}

function paintTileCanvas(
  tile: TimelineTile,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frameIndex: number,
  decodedMaskCache: Map<string, Uint8Array>,
  ignoreVegetation: boolean,
  mode: "sunShadow" | "heatmap",
): void {
  if (!tile.grid) return;
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;
  const tileW = tile.grid.width;
  const cellCount = tileW * tile.grid.height;

  const outdoorMask = getTileOutdoorMask(tile, decodedMaskCache);

  if (mode === "sunShadow") {
    const mask = getTileMask(tile, frameIndex, ignoreVegetation, decodedMaskCache);
    if (!mask) { ctx.putImageData(imageData, 0, 0); return; }
    for (let cellIdx = 0; cellIdx < cellCount; cellIdx++) {
      if (outdoorMask && !((outdoorMask[cellIdx >> 3] >> (cellIdx & 7)) & 1)) continue;
      const isSunny = ((mask[cellIdx >> 3] >> (cellIdx & 7)) & 1) === 1;
      const iy = Math.floor(cellIdx / tileW);
      const ix = cellIdx % tileW;
      const x = ix;
      const y = height - 1 - iy; // flip Y: north = top
      const offset = (y * width + x) * 4;
      const rgba = isSunny ? SUNNY_RGBA : SHADOW_RGBA;
      data[offset] = rgba[0]; data[offset + 1] = rgba[1]; data[offset + 2] = rgba[2]; data[offset + 3] = rgba[3];
    }
  } else {
    // Heatmap: count sunny frames per cell
    const totalFrames = tile.frames.length;
    if (totalFrames === 0) { ctx.putImageData(imageData, 0, 0); return; }
    const sunnyFrames = new Uint16Array(cellCount);
    for (let fi = 0; fi < tile.frames.length; fi++) {
      const mask = getTileMask(tile, fi, ignoreVegetation, decodedMaskCache);
      if (!mask) continue;
      for (let i = 0; i < cellCount; i++) {
        if (((mask[i >> 3] >> (i & 7)) & 1) === 1) sunnyFrames[i] += 1;
      }
    }
    for (let cellIdx = 0; cellIdx < cellCount; cellIdx++) {
      if (outdoorMask && !((outdoorMask[cellIdx >> 3] >> (cellIdx & 7)) & 1)) continue;
      const iy = Math.floor(cellIdx / tileW);
      const ix = cellIdx % tileW;
      const x = ix;
      const y = height - 1 - iy;
      const offset = (y * width + x) * 4;
      const rgba = exposureRatioToRGBA(sunnyFrames[cellIdx] / totalFrames);
      data[offset] = rgba[0]; data[offset + 1] = rgba[1]; data[offset + 2] = rgba[2]; data[offset + 3] = rgba[3];
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function buildInstantBlockedContours(
  response: AreaApiResponse | null,
  predicate: (point: AreaInstantPoint) => boolean,
): MultiPolygon {
  if (!response || response.mode !== "instant") {
    return [];
  }

  const points = response.points as AreaInstantPoint[];
  if (points.length === 0) {
    return [];
  }

  const parsed = points
    .map((point) => {
      const parsedId = parseGridPointId(point.id);
      if (!parsedId) {
        return null;
      }
      return {
        row: parsedId.row,
        col: parsedId.col,
        lat: point.lat,
        lon: point.lon,
        blocked: predicate(point),
      };
    })
    .filter(
      (
        point,
      ): point is {
        row: number;
        col: number;
        lat: number;
        lon: number;
        blocked: boolean;
      } => point !== null,
    );

  if (parsed.length === 0) {
    return [];
  }

  const rowLatMap = new Map<number, number>();
  const colLonMap = new Map<number, number>();
  for (const point of parsed) {
    if (!rowLatMap.has(point.row)) {
      rowLatMap.set(point.row, point.lat);
    }
    if (!colLonMap.has(point.col)) {
      colLonMap.set(point.col, point.lon);
    }
  }

  const sortedRows = Array.from(rowLatMap.keys()).sort((a, b) => a - b);
  const sortedCols = Array.from(colLonMap.keys()).sort((a, b) => a - b);
  const rowIndex = new Map<number, number>(
    sortedRows.map((row, index) => [row, index]),
  );
  const colIndex = new Map<number, number>(
    sortedCols.map((col, index) => [col, index]),
  );
  const latCenters = sortedRows.map((row) => rowLatMap.get(row) ?? 0);
  const lonCenters = sortedCols.map((col) => colLonMap.get(col) ?? 0);
  const meanLat =
    latCenters.reduce((accumulator, value) => accumulator + value, 0) /
    Math.max(1, latCenters.length);
  const latHalfStepDeg = response.gridStepMeters / METERS_PER_DEGREE_LAT / 2;
  const lonHalfStepDeg =
    response.gridStepMeters /
    (METERS_PER_DEGREE_LAT * Math.max(Math.cos((meanLat * Math.PI) / 180), 0.01)) /
    2;
  const latBounds = buildBoundsFromCenters(latCenters, latHalfStepDeg);
  const lonBounds = buildBoundsFromCenters(lonCenters, lonHalfStepDeg);

  const blockedCells: Polygon[] = [];
  for (const point of parsed) {
    if (!point.blocked) {
      continue;
    }
    const row = rowIndex.get(point.row);
    const col = colIndex.get(point.col);
    if (row === undefined || col === undefined) {
      continue;
    }
    if (row + 1 >= latBounds.length || col + 1 >= lonBounds.length) {
      continue;
    }

    blockedCells.push([
      closeRing([
        [lonBounds[col], latBounds[row]],
        [lonBounds[col + 1], latBounds[row]],
        [lonBounds[col + 1], latBounds[row + 1]],
        [lonBounds[col], latBounds[row + 1]],
      ]),
    ]);
  }

  return mergePolygons(blockedCells);
}

// buildBuildingsContours removed — instant mode no longer uses convex hull footprints.
// Daily mode uses zenith shadow map (outdoor mask) from tile grid metadata instead.}

function timelineMaskCacheKey(frameIndex: number, ignoreVegetation: boolean): string {
  return `${frameIndex}:${ignoreVegetation ? "no-veg" : "full"}`;
}

function selectTimelineMaskBase64(
  frame: TimelineFrame,
  ignoreVegetation: boolean,
): string {
  if (ignoreVegetation && frame.sunMaskNoVegetationBase64) {
    return frame.sunMaskNoVegetationBase64;
  }
  return frame.sunMaskBase64;
}

/** Resolve a frame mask from pre-decoded blob or fall back to base64 decode + cache. */
function getTileMask(
  tile: TimelineTile,
  frameIndex: number,
  ignoreVegetation: boolean,
  cache: Map<string, Uint8Array>,
): Uint8Array | null {
  const safeIdx = Math.max(0, Math.min(frameIndex, tile.frames.length - 1));
  if (tile.decodedMasks) {
    const dm = tile.decodedMasks.frames[safeIdx];
    return dm ? (ignoreVegetation ? dm.sunNoVeg : dm.sun) : null;
  }
  const frame = tile.frames[safeIdx];
  if (!frame) return null;
  const cacheKey = `${tile.tileId}:${frame.index}:${ignoreVegetation ? "nv" : "f"}`;
  let mask = cache.get(cacheKey);
  if (!mask) {
    mask = decodeBase64ToBytes(selectTimelineMaskBase64(frame, ignoreVegetation));
    cache.set(cacheKey, mask);
  }
  return mask;
}

/** Resolve the outdoor mask from pre-decoded blob or fall back to base64 decode + cache. */
function getTileOutdoorMask(
  tile: TimelineTile,
  cache: Map<string, Uint8Array>,
): Uint8Array | undefined {
  if (tile.decodedMasks) return tile.decodedMasks.outdoor;
  const cacheKey = `${tile.tileId}:outdoor`;
  let mask = cache.get(cacheKey);
  if (!mask && tile.outdoorMaskBase64) {
    mask = decodeBase64ToBytes(tile.outdoorMaskBase64);
    cache.set(cacheKey, mask);
  }
  return mask;
}

function isPointSunnyIgnoringVegetation(point: AreaInstantPoint): boolean {
  return point.altitudeDeg > 0 && !point.terrainBlocked && !point.buildingsBlocked;
}

function deriveInstantResponseWithoutVegetation(
  response: AreaApiResponse,
): AreaApiResponse {
  if (response.mode !== "instant") {
    return response;
  }

  const points = (response.points as AreaInstantPoint[]).map((point) => ({
    ...point,
    isSunny: isPointSunnyIgnoringVegetation(point),
  }));

  return {
    ...response,
    points,
  };
}

function toInstantAreaResponseFromTimeline(
  timeline: DailyTimelineState,
  frameIndex: number,
  decodedMaskCache: Map<string, Uint8Array>,
  ignoreVegetation: boolean,
): AreaApiResponse | null {
  if (timeline.tiles.length === 0) {
    return null;
  }

  const safeIndex = Math.max(0, Math.min(frameIndex, (timeline.tiles[0]?.frames.length ?? 1) - 1));

  const points: AreaInstantPoint[] = [];
  for (const tile of timeline.tiles) {
    const mask = getTileMask(tile, safeIndex, ignoreVegetation, decodedMaskCache);
    if (!mask) continue;
    for (let i = 0; i < tile.points.length; i++) {
      const isSunny = ((mask[i >> 3] >> (i & 7)) & 1) === 1;
      points.push({
        id: tile.points[i].id,
        lat: tile.points[i].lat,
        lon: tile.points[i].lon,
        isSunny,
        terrainBlocked: false,
        buildingsBlocked: false,
        vegetationBlocked: false,
        altitudeDeg: 0,
        azimuthDeg: 0,
        pointElevationMeters: null,
      });
    }
  }

  const stats = timeline.stats;
  return {
    mode: "instant",
    gridStepMeters: timeline.gridStepMeters,
    pointCount: points.length,
    points,
    model: timeline.model ?? undefined,
    warnings: timeline.warnings,
    stats: {
      elapsedMs: stats?.elapsedMs ?? 0,
      pointsWithElevation: stats?.pointsWithElevation ?? 0,
      pointsWithoutElevation: stats?.pointsWithoutElevation ?? 0,
      indoorPointsExcluded: stats?.indoorPointsExcluded ?? timeline.indoorPointsExcluded,
    },
  };
}

function buildDailyExposurePoints(
  timeline: DailyTimelineState,
  decodedMaskCache: Map<string, Uint8Array>,
  ignoreVegetation: boolean,
): DailyExposurePoint[] {
  if (timeline.tiles.length === 0) {
    return [];
  }

  const totalFrames = timeline.tiles[0]?.frames.length ?? 0;
  if (totalFrames === 0) {
    return [];
  }

  const result: DailyExposurePoint[] = [];
  for (const tile of timeline.tiles) {
    const sunnyFrames = new Uint16Array(tile.points.length);
    for (let fi = 0; fi < tile.frames.length; fi++) {
      const mask = getTileMask(tile, fi, ignoreVegetation, decodedMaskCache);
      if (!mask) continue;
      for (let i = 0; i < tile.points.length; i++) {
        if (((mask[i >> 3] >> (i & 7)) & 1) === 1) {
          sunnyFrames[i] += 1;
        }
      }
    }
    for (let i = 0; i < tile.points.length; i++) {
      const pointSunnyFrames = sunnyFrames[i] ?? 0;
      result.push({
        id: tile.points[i].id,
        lat: tile.points[i].lat,
        lon: tile.points[i].lon,
        sunnyFrames: pointSunnyFrames,
        totalFrames,
        exposureRatio: totalFrames === 0 ? 0 : pointSunnyFrames / totalFrames,
      });
    }
  }

  return result;
}

function buildDailyExposureCells(
  points: DailyExposurePoint[],
  gridStepMeters: number,
): DailyExposureCell[] {
  if (points.length === 0) {
    return [];
  }

  const parsed = points
    .map((point) => {
      const parsedId = parseGridPointId(point.id);
      if (!parsedId) {
        return null;
      }
      return {
        row: parsedId.row,
        col: parsedId.col,
        lat: point.lat,
        lon: point.lon,
        exposureRatio: point.exposureRatio,
        sunnyFrames: point.sunnyFrames,
        totalFrames: point.totalFrames,
      };
    })
    .filter(
      (
        point,
      ): point is {
        row: number;
        col: number;
        lat: number;
        lon: number;
        exposureRatio: number;
        sunnyFrames: number;
        totalFrames: number;
      } => point !== null,
    );

  if (parsed.length === 0) {
    return [];
  }

  const rowLatMap = new Map<number, number>();
  const colLonMap = new Map<number, number>();
  for (const point of parsed) {
    if (!rowLatMap.has(point.row)) {
      rowLatMap.set(point.row, point.lat);
    }
    if (!colLonMap.has(point.col)) {
      colLonMap.set(point.col, point.lon);
    }
  }

  const sortedRows = Array.from(rowLatMap.keys()).sort((a, b) => a - b);
  const sortedCols = Array.from(colLonMap.keys()).sort((a, b) => a - b);
  const rowIndex = new Map<number, number>(
    sortedRows.map((row, index) => [row, index]),
  );
  const colIndex = new Map<number, number>(
    sortedCols.map((col, index) => [col, index]),
  );
  const latCenters = sortedRows.map((row) => rowLatMap.get(row) ?? 0);
  const lonCenters = sortedCols.map((col) => colLonMap.get(col) ?? 0);
  const meanLat =
    latCenters.reduce((accumulator, value) => accumulator + value, 0) /
    Math.max(1, latCenters.length);
  const latHalfStepDeg = gridStepMeters / METERS_PER_DEGREE_LAT / 2;
  const lonHalfStepDeg =
    gridStepMeters /
    (METERS_PER_DEGREE_LAT * Math.max(Math.cos((meanLat * Math.PI) / 180), 0.01)) /
    2;
  const latBounds = buildBoundsFromCenters(latCenters, latHalfStepDeg);
  const lonBounds = buildBoundsFromCenters(lonCenters, lonHalfStepDeg);

  const cells: DailyExposureCell[] = [];
  for (const point of parsed) {
    const row = rowIndex.get(point.row);
    const col = colIndex.get(point.col);
    if (row === undefined || col === undefined) {
      continue;
    }
    if (row + 1 >= latBounds.length || col + 1 >= lonBounds.length) {
      continue;
    }

    cells.push({
      ring: closeRing([
        [lonBounds[col], latBounds[row]],
        [lonBounds[col + 1], latBounds[row]],
        [lonBounds[col + 1], latBounds[row + 1]],
        [lonBounds[col], latBounds[row + 1]],
      ]),
      exposureRatio: point.exposureRatio,
      sunnyFrames: point.sunnyFrames,
      totalFrames: point.totalFrames,
    });
  }

  return cells;
}

function exposureRatioToColor(exposureRatio: number): string {
  const clamped = Math.max(0, Math.min(1, exposureRatio));
  const cold = { r: 37, g: 99, b: 235 }; // blue
  const hot = { r: 239, g: 68, b: 68 }; // red
  const r = Math.round(cold.r + (hot.r - cold.r) * clamped);
  const g = Math.round(cold.g + (hot.g - cold.g) * clamped);
  const b = Math.round(cold.b + (hot.b - cold.b) * clamped);
  return `rgb(${r}, ${g}, ${b})`;
}

function exposureRatioToRGBA(ratio: number): [number, number, number, number] {
  const clamped = Math.max(0, Math.min(1, ratio));
  const cold = { r: 37, g: 99, b: 235 }; // blue
  const hot = { r: 239, g: 68, b: 68 }; // red
  return [
    Math.round(cold.r + (hot.r - cold.r) * clamped),
    Math.round(cold.g + (hot.g - cold.g) * clamped),
    Math.round(cold.b + (hot.b - cold.b) * clamped),
    180, // ~70% opacity
  ];
}

function paintHeatmapCanvas(
  grid: SunShadowGrid,
  timeline: DailyTimelineState,
  decodedMaskCache: Map<string, Uint8Array>,
  ignoreVegetation: boolean,
): void {
  const { width, height, ctx, tilePixelMaps } = grid;
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;
  const totalFrames = timeline.tiles[0]?.frames.length ?? 0;
  if (totalFrames === 0) return;

  let globalMinCol = Infinity, globalMaxRow = -Infinity;
  for (const tile of timeline.tiles) {
    if (tile.grid) {
      if (tile.grid.minIx < globalMinCol) globalMinCol = tile.grid.minIx;
      if (tile.grid.maxIy > globalMaxRow) globalMaxRow = tile.grid.maxIy;
    }
  }

  for (let tileIdx = 0; tileIdx < timeline.tiles.length; tileIdx++) {
    const tile = timeline.tiles[tileIdx];

    if (tile.grid) {
      const tileW = tile.grid.width;
      const cellCount = tileW * tile.grid.height;
      const outdoorMask = getTileOutdoorMask(tile, decodedMaskCache);
      const sunnyFrames = new Uint16Array(cellCount);
      for (let fi = 0; fi < tile.frames.length; fi++) {
        const mask = getTileMask(tile, fi, ignoreVegetation, decodedMaskCache);
        if (!mask) continue;
        for (let i = 0; i < cellCount; i++) {
          if (((mask[i >> 3] >> (i & 7)) & 1) === 1) sunnyFrames[i] += 1;
        }
      }
      for (let cellIdx = 0; cellIdx < cellCount; cellIdx++) {
        if (outdoorMask && !((outdoorMask[cellIdx >> 3] >> (cellIdx & 7)) & 1)) continue;
        const tileRow: number = tile.grid.minIy + Math.floor(cellIdx / tileW);
        const tileCol: number = tile.grid.minIx + (cellIdx % tileW);
        const x: number = tileCol - globalMinCol;
        const y: number = globalMaxRow - tileRow;
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const ratio = sunnyFrames[cellIdx] / totalFrames;
        const offset = (y * width + x) * 4;
        const rgba = exposureRatioToRGBA(ratio);
        data[offset] = rgba[0];
        data[offset + 1] = rgba[1];
        data[offset + 2] = rgba[2];
        data[offset + 3] = rgba[3];
      }
    } else {
      const pixelMap = tilePixelMaps[tileIdx];
      const sunnyFrames = new Uint16Array(tile.points.length);
      for (let fi = 0; fi < tile.frames.length; fi++) {
        const mask = getTileMask(tile, fi, ignoreVegetation, decodedMaskCache);
        if (!mask) continue;
        for (let i = 0; i < tile.points.length; i++) {
          if (((mask[i >> 3] >> (i & 7)) & 1) === 1) sunnyFrames[i] += 1;
        }
      }
      for (let i = 0; i < pixelMap.length; i++) {
        const ratio = sunnyFrames[i] / totalFrames;
        const { x, y } = pixelMap[i];
        const offset = (y * width + x) * 4;
        const rgba = exposureRatioToRGBA(ratio);
        data[offset] = rgba[0];
        data[offset + 1] = rgba[1];
        data[offset + 2] = rgba[2];
        data[offset + 3] = rgba[3];
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function venueTypeBadgeLabel(venueType: FoodVenueType): string {
  switch (venueType) {
    case "restaurant":
      return "restaurant";
    case "bar":
      return "bar";
    case "snack":
      return "snack";
    case "foodtruck":
      return "foodtruck";
    default:
      return "other";
  }
}

function createEmptyInstantAreaResult(
  start: InstantStreamStartPayload,
): AreaApiResponse {
  return {
    mode: "instant",
    gridStepMeters: start.gridStepMeters,
    pointCount: 0,
    points: [],
    model: start.model,
    warnings: start.warnings,
    stats: {
      elapsedMs: 0,
      pointsWithElevation: 0,
      pointsWithoutElevation: 0,
      indoorPointsExcluded: 0,
    },
  };
}

export interface SunlightMapClientProps {
  /** Server-injected at request time from MAPPY_FORCE_CACHE_ONLY env var.
   * Runtime config — same build artifact runs on a GPU server (false) or
   * a headless cache-only server (true) without rebuilding. */
  forceCacheOnly: boolean;
}

export function SunlightMapClient({ forceCacheOnly }: SunlightMapClientProps) {
  const defaultNow = useMemo(() => zurichNowDateAndTime(), []);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const baseTileLayersRef = useRef<{
    layers: Partial<Record<BaseMapStyle, TileLayer | LayerGroup>>;
    active: BaseMapStyle;
  }>({
    layers: {},
    active: "carto-voyager",
  });
  const baseMapStyleRef = useRef<BaseMapStyle>("stamen-watercolor");
  const instantStreamRef = useRef<EventSource | null>(null);
  const instantCancelledRef = useRef(false);
  const timelineAbortRef = useRef<AbortController | null>(null);
  const timelineCancelledRef = useRef(false);
  const decodedTimelineMaskCacheRef = useRef<Map<string, Uint8Array>>(new Map());
  const pendingTilesRef = useRef<TimelineTile[]>([]);
  const pendingStatsRef = useRef<{ gridPointCount: number; indoorPointsExcluded: number }>({ gridPointCount: 0, indoorPointsExcluded: 0 });
  const lastTileFlushRef = useRef<number>(0);
  const sunShadowGridRef = useRef<SunShadowGrid | null>(null);
  const sunShadowOverlayRef = useRef<L.ImageOverlay | null>(null);
  const heatmapCanvasRef = useRef<SunShadowGrid | null>(null);
  const heatmapOverlayRef = useRef<L.ImageOverlay | null>(null);
  const perTileOverlaysRef = useRef<Map<string, PerTileOverlay>>(new Map());
  const perTileHeatmapOverlaysRef = useRef<Map<string, PerTileOverlay>>(new Map());
  const contourLayerRef = useRef<L.LayerGroup | null>(null);
  // ── Phase 2 overlay LOD ──────────────────────────────────────────────────
  // Bitmap overlays keyed by tileId. Each owns its <canvas>, ctx, and the CSS
  // matrix transform. Lifecycle: created on first paint, repainted on slider /
  // re-rasterize, transform refreshed on map move/zoom, disposed when the
  // tile leaves the timeline or the user re-enters vector mode.
  const bitmapOverlaysRef = useRef<Map<string, BitmapTileOverlay>>(new Map());
  // ── Idle vector upgrade ───────────────────────────────────────────────
  // When bitmap mode is active and the user pauses interaction (~400ms),
  // we compute a single unified-viewport marching-squares pass and layer
  // its polygons on top of the bitmaps. Any interaction (slider, zoom,
  // pan, mode toggle) tears the layer down and re-arms the timer.
  const unifiedVectorLayerRef = useRef<L.LayerGroup | null>(null);
  const idleVectorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stores the strategy's last-chosen mode so the next call can apply
  // hysteresis. Read in the useMemo below, written after the strategy runs.
  const previousRenderModeRef = useRef<RenderMode | null>(null);
  // Logged DPR (captured once after mount — SSR-safe). Tracked separately so
  // it doesn't trigger renders.
  const dprRef = useRef<number>(1);
  const ignoreVegetationShadowRef = useRef(false);
  const sunnyLayerRef = useRef<LayerGroup | null>(null);
  const shadowLayerRef = useRef<LayerGroup | null>(null);
  const vegetationLayerRef = useRef<LayerGroup | null>(null);
  const buildingsLayerRef = useRef<LayerGroup | null>(null);
  const terrainLayerRef = useRef<LayerGroup | null>(null);
  const cacheFocusLayerRef = useRef<LayerGroup | null>(null);
  const heatmapLayerRef = useRef<LayerGroup | null>(null);
  const placesLayerRef = useRef<LayerGroup | null>(null);
  const viewportPlacesOverlayRef = useRef<PlacesViewportOverlay | null>(null);
  const viewportPlacesFetchAbortRef = useRef<AbortController | null>(null);
  const viewportPlacesDebounceRef = useRef<number | null>(null);
  const clickHighlightLayerRef = useRef<LayerGroup | null>(null);
  const leafletModuleRef = useRef<typeof import("leaflet") | null>(null);
  const placesRequestIdRef = useRef(0);
  const focusRunLoadedTokenRef = useRef<string | null>(null);
  const focusRunAutoAppliedTokenRef = useRef<string | null>(null);
  const deepLinkMapAppliedTokenRef = useRef<string | null>(null);
  const clickDebugParamsRef = useRef<{
    mode: AreaMode;
    date: string;
    localTime: string;
    activeFrameTime: string | null;
    sampleEveryMinutes: number;
    buildingHeightBiasMeters: number;
  }>({
    mode: "instant",
    date: defaultNow.date,
    localTime: defaultNow.time,
    activeFrameTime: null,
    sampleEveryMinutes: 15,
    buildingHeightBiasMeters: 0,
  });

  const [mode, setMode] = useState<AreaMode>("daily");
  const [date, setDate] = useState(defaultNow.date);
  const [localTime, setLocalTime] = useState(defaultNow.time);
  const [dailyStartLocalTime, setDailyStartLocalTime] = useState("06:00");
  const [dailyEndLocalTime, setDailyEndLocalTime] = useState("21:00");
  const [gridStepMeters, setGridStepMeters] = useState(1);
  const [sampleEveryMinutes, setSampleEveryMinutes] = useState(15);
  const [buildingHeightBiasMeters, setBuildingHeightBiasMeters] = useState(0);
  const [baseMapStyle, setBaseMapStyle] = useState<BaseMapStyle>("stamen-watercolor");
  const [ignoreVegetationShadow, setIgnoreVegetationShadow] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<AreaApiResponse | null>(null);
  const [sunlitPlaces, setSunlitPlaces] = useState<SunlitPlaceEntry[]>([]);
  const [placesWarnings, setPlacesWarnings] = useState<string[]>([]);
  const [placesError, setPlacesError] = useState<string | null>(null);
  const [isPlacesLoading, setIsPlacesLoading] = useState(false);
  const [dailyTimeline, setDailyTimeline] = useState<DailyTimelineState | null>(
    null,
  );
  const [dailyFrameIndex, setDailyFrameIndex] = useState(0);
  const [instantProgress, setInstantProgress] = useState<TimelineProgress | null>(
    null,
  );
  const [dailyProgress, setDailyProgress] = useState<TimelineProgress | null>(null);
  const [showSunny, setShowSunny] = useState(true);
  const [showShadow, setShowShadow] = useState(true);
  const [showVegetation, setShowVegetation] = useState(true);
  const [showBuildings, setShowBuildings] = useState(true);
  const [showTerrain, setShowTerrain] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showPlaces, setShowPlaces] = useState(true);
  const [viewportPlaces, setViewportPlaces] = useState<ViewportPlaceLite[]>([]);
  const [selectedViewportPlace, setSelectedViewportPlace] =
    useState<ViewportPlaceLite | null>(null);
  const [activeDesktopTab, setActiveDesktopTab] = useState<MapPanelTab>("map");
  const [bottomSheetState, setBottomSheetState] =
    useState<BottomSheetState>("middle");
  const [isMobileBarsOpen, setIsMobileBarsOpen] = useState(false);
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Increment to force PlaceSuggestionsDropdown to hide after submit/select.
  // The dropdown manages its own visibility from the query value; this is the
  // signal channel for "the user is done picking, drop the open list".
  const [suggestionsCloseSignal, setSuggestionsCloseSignal] = useState(0);
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [isSearchLoading, setIsSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [cacheOnly, setCacheOnly] = useState(forceCacheOnly);
  const [uiParamsHydrated, setUiParamsHydrated] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);
  const [focusRunParamsFromUrl, setFocusRunParamsFromUrl] =
    useState<FocusRunParams | null>(null);
  const [deepLinkParamsFromUrl, setDeepLinkParamsFromUrl] =
    useState<DeepLinkParams | null>(null);
  const [focusRunOverlay, setFocusRunOverlay] = useState<FocusRunOverlayState | null>(
    null,
  );
  const [focusRunMessage, setFocusRunMessage] = useState<string | null>(null);
  const [focusRunMessageIsError, setFocusRunMessageIsError] = useState(false);
  const activeFocusRunParams = focusRunParamsFromUrl;
  const activeFocusRunToken = useMemo(
    () => (activeFocusRunParams ? focusRunToken(activeFocusRunParams) : null),
    [activeFocusRunParams],
  );
  const activeDeepLinkToken = useMemo(
    () => (deepLinkParamsFromUrl ? deepLinkToken(deepLinkParamsFromUrl) : null),
    [deepLinkParamsFromUrl],
  );

  // ── Phase 2 overlay LOD: state ──────────────────────────────────────────
  // Map zoom & viewport-tile-count drive the vector ↔ bitmap decision. We
  // track them as state (not refs) so the strategy memo can be a useMemo —
  // changes here flow through to the rendering effects below.
  const [mapZoom, setMapZoom] = useState<number | null>(null);
  const [mapBounds, setMapBounds] = useState<L.LatLngBounds | null>(null);
  const [modeOverride] = useModeOverride({ forceEnable: true });

  // Capture DPR once after mount (SSR-safe).
  useEffect(() => {
    if (typeof window !== "undefined") {
      dprRef.current = window.devicePixelRatio || 1;
    }
  }, []);

  const renderStrategy = useMemo(() => {
    const tiles = dailyTimeline?.tiles ?? [];
    // tileNativeSizePx = grid_size_m × cells_per_meter. Tile = 250m,
    // grid_step = 1m typically → 250 cells. Use the first tile's grid
    // width as the actual native size if available.
    const sample = tiles.find((t) => t.grid);
    const tileNativeSizePx = sample?.grid?.width ?? 250;
    const zoom = mapZoom ?? 18;
    const visibleTileCount = countVisibleTiles(tiles, mapBounds);
    const out = selectRenderStrategy({
      zoom,
      visibleTileCount,
      devicePixelRatio: dprRef.current,
      tileSizeMeters: SUNLIGHT_TILE_SIZE_METERS,
      tileNativeSizePx,
      previousMode: previousRenderModeRef.current,
    });
    previousRenderModeRef.current = out.mode;
    return out;
  }, [dailyTimeline, mapZoom, mapBounds]);

  // Effective mode: user override (Shift+B/V) wins; null = follow strategy.
  const effectiveRenderMode: RenderMode = modeOverride ?? renderStrategy.mode;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const searchParams = new URLSearchParams(window.location.search);
    setFocusRunParamsFromUrl(parseFocusRunParams(searchParams));
    setDeepLinkParamsFromUrl(parseDeepLinkParams(searchParams));
  }, []);

  useEffect(() => {
    baseMapStyleRef.current = baseMapStyle;
  }, [baseMapStyle]);

  const visualAreaResponse = useMemo(() => {
    if (mode === "daily" && dailyTimeline) {
      // For large grids, skip building the full AreaApiResponse —
      // the canvas overlay useEffect handles rendering directly.
      if (dailyTimeline.pointCount >= CANVAS_OVERLAY_THRESHOLD) {
        return null;
      }
      return toInstantAreaResponseFromTimeline(
        dailyTimeline,
        dailyFrameIndex,
        decodedTimelineMaskCacheRef.current,
        ignoreVegetationShadow,
      );
    }

    if (mode === "instant" && lastResult && ignoreVegetationShadow) {
      return deriveInstantResponseWithoutVegetation(lastResult);
    }

    return lastResult;
  }, [
    dailyFrameIndex,
    dailyTimeline,
    ignoreVegetationShadow,
    lastResult,
    mode,
  ]);

  const dailyExposurePoints = useMemo(() => {
    if (
      mode !== "daily" ||
      !dailyTimeline ||
      !dailyTimeline.stats ||
      dailyTimeline.tiles.length === 0
    ) {
      return null;
    }

    // For large grids, skip building exposure points array — the canvas
    // heatmap useEffect computes exposure directly on the pixel grid.
    if (dailyTimeline.pointCount >= CANVAS_OVERLAY_THRESHOLD) {
      return null;
    }

    return buildDailyExposurePoints(
      dailyTimeline,
      decodedTimelineMaskCacheRef.current,
      ignoreVegetationShadow,
    );
  }, [dailyTimeline, ignoreVegetationShadow, mode]);

  const dailyExposureCells = useMemo(() => {
    if (!dailyExposurePoints || !dailyTimeline) {
      return null;
    }
    return buildDailyExposureCells(dailyExposurePoints, dailyTimeline.gridStepMeters);
  }, [dailyExposurePoints, dailyTimeline]);

  const activeWarnings = useMemo(() => {
    if (mode === "daily" && dailyTimeline) {
      return Array.from(
        new Set([...dailyTimeline.warnings, ...placesWarnings]),
      );
    }

    return Array.from(
      new Set([...(lastResult?.warnings ?? []), ...placesWarnings]),
    );
  }, [dailyTimeline, lastResult, mode, placesWarnings]);

  const activeFrameTime = useMemo(() => {
    if (!dailyTimeline || dailyTimeline.tiles.length === 0) {
      return null;
    }

    const firstTileFrames = dailyTimeline.tiles[0]?.frames ?? [];
    if (firstTileFrames.length === 0) return null;
    const safeIndex = Math.max(
      0,
      Math.min(dailyFrameIndex, firstTileFrames.length - 1),
    );
    return firstTileFrames[safeIndex]?.localTime ?? null;
  }, [dailyFrameIndex, dailyTimeline]);

  const canShowHeatmap = useMemo(
    () =>
      mode === "daily" &&
      Boolean(dailyTimeline?.stats) &&
      Boolean(
        (dailyExposureCells && dailyExposureCells.length > 0) ||
          ((dailyTimeline?.pointCount ?? 0) >= CANVAS_OVERLAY_THRESHOLD &&
            (dailyTimeline?.tiles.length ?? 0) > 0),
      ),
    [dailyExposureCells, dailyTimeline?.pointCount, dailyTimeline?.stats, dailyTimeline?.tiles.length, mode],
  );

  // Auto-fallback to sunlight overlay when heatmap becomes unavailable
  // (e.g. user switches to instant mode while heatmap was active).
  useEffect(() => {
    if (!canShowHeatmap && showHeatmap && !showSunny && !showShadow) {
      setShowHeatmap(false);
      setShowSunny(true);
      setShowShadow(true);
    }
  }, [canShowHeatmap, showHeatmap, showShadow, showSunny]);

  const isDailyRangeInvalid = useMemo(() => {
    if (mode !== "daily") {
      return false;
    }
    const startMinutes = localTimeToMinutes(dailyStartLocalTime);
    const endMinutes = localTimeToMinutes(dailyEndLocalTime);
    if (startMinutes === null || endMinutes === null) {
      return true;
    }
    return endMinutes <= startMinutes;
  }, [dailyEndLocalTime, dailyStartLocalTime, mode]);

  useEffect(() => {
    clickDebugParamsRef.current = {
      mode,
      date,
      localTime,
      activeFrameTime,
      sampleEveryMinutes,
      buildingHeightBiasMeters,
    };
  }, [
    activeFrameTime,
    buildingHeightBiasMeters,
    date,
    localTime,
    mode,
    sampleEveryMinutes,
  ]);

  useEffect(() => {
    ignoreVegetationShadowRef.current = ignoreVegetationShadow;
  }, [ignoreVegetationShadow]);

  const renderShadowBlockerHighlight = useCallback(
    (params: {
      lat: number;
      lon: number;
      response: PointInstantApiResponse;
      primarySource: string;
      ridgePoint: TerrainHorizonRidgePoint | null;
    }) => {
      const L = leafletModuleRef.current;
      const highlightLayer = clickHighlightLayerRef.current;
      if (!L || !highlightLayer) {
        return;
      }

      highlightLayer.clearLayers();

      L.circleMarker([params.lat, params.lon], {
        radius: 5,
        color: "#111827",
        fillColor: "#f8fafc",
        fillOpacity: 0.95,
        weight: 2,
      })
        .addTo(highlightLayer)
        .bindTooltip("Point diagnostique", {
          direction: "top",
          opacity: 0.9,
        });

      const drawRayToTarget = (
        targetLat: number,
        targetLon: number,
        color: string,
        label: string,
      ) => {
        L.polyline(
          [
            [params.lat, params.lon],
            [targetLat, targetLon],
          ],
          {
            color,
            weight: 2.2,
            opacity: 0.9,
            dashArray: "8 5",
          },
        )
          .addTo(highlightLayer)
          .bindTooltip(label, { sticky: true });
      };

      if (params.primarySource === "bâtiment") {
        const distance = params.response.sample.buildingBlockerDistanceMeters;
        if (distance !== null && Number.isFinite(distance) && distance > 0) {
          const fallbackPoint = destinationPointByAzimuth(
            params.lat,
            params.lon,
            params.response.sample.azimuthDeg,
            distance,
          );
          L.circleMarker([fallbackPoint.lat, fallbackPoint.lon], {
            radius: 6,
            color: "#c2410c",
            fillColor: "#fb923c",
            fillOpacity: 0.9,
            weight: 2,
          })
            .addTo(highlightLayer)
            .bindTooltip("Approximation du bloqueur bâtiment", { sticky: true });
          drawRayToTarget(
            fallbackPoint.lat,
            fallbackPoint.lon,
            "#ea580c",
            "Rayon vers le bloqueur bâtiment (approx.)",
          );
        }
        return;
      }

      if (params.primarySource === "végétation") {
        const distance = params.response.sample.vegetationBlockerDistanceMeters;
        const vegetationPoint =
          typeof distance === "number" && Number.isFinite(distance) && distance > 0
            ? destinationPointByAzimuth(
                params.lat,
                params.lon,
                params.response.sample.azimuthDeg,
                distance,
              )
            : destinationPointByAzimuth(
                params.lat,
                params.lon,
                params.response.sample.azimuthDeg,
                30,
              );

        L.circleMarker([vegetationPoint.lat, vegetationPoint.lon], {
          radius: 6,
          color: "#166534",
          fillColor: "#22c55e",
          fillOpacity: 0.92,
          weight: 2,
        })
          .addTo(highlightLayer)
          .bindTooltip("Bloqueur végétation", { sticky: true });
        drawRayToTarget(
          vegetationPoint.lat,
          vegetationPoint.lon,
          "#16a34a",
          "Rayon vers le bloqueur végétation",
        );
        return;
      }

      if (
        params.primarySource === "montagnes" ||
        params.primarySource === "DEM local (colline du terrain de la ville)" ||
        params.primarySource === "terrain/horizon"
      ) {
        if (params.ridgePoint) {
          L.circleMarker([params.ridgePoint.lat, params.ridgePoint.lon], {
            radius: 6,
            color: "#92400e",
            fillColor: "#f59e0b",
            fillOpacity: 0.95,
            weight: 2,
          })
            .addTo(highlightLayer)
            .bindTooltip(`Bloqueur terrain: ${params.primarySource}`, {
              sticky: true,
            });
          drawRayToTarget(
            params.ridgePoint.lat,
            params.ridgePoint.lon,
            "#b45309",
            `Rayon vers ${params.primarySource}`,
          );
        }
        return;
      }

      if (params.primarySource === "courbure de la terre") {
        L.circleMarker([params.lat, params.lon], {
          radius: 8,
          color: "#7c3aed",
          fillColor: "#a78bfa",
          fillOpacity: 0.3,
          weight: 2,
        })
          .addTo(highlightLayer)
          .bindTooltip("Soleil sous l'horizon (courbure de la terre)", {
            sticky: true,
          });
      }
    },
    [],
  );

  const runPointClickDiagnostics = useCallback(async (lat: number, lon: number) => {
    const params = clickDebugParamsRef.current;
    const ignoreVegetationForUi = ignoreVegetationShadowRef.current;
    const localTimeForDiagnostic =
      params.mode === "daily"
        ? (extractTimeFromLocalDateTime(params.activeFrameTime) ?? params.localTime)
        : params.localTime;

    const payload = {
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      date: params.date,
      timezone: "Europe/Zurich",
      mode: "instant" as const,
      localTime: localTimeForDiagnostic,
      sampleEveryMinutes: params.sampleEveryMinutes,
      buildingHeightBiasMeters: params.buildingHeightBiasMeters,
    };

    const response = await fetch("/api/sunlight/point", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const json = (await response.json()) as PointInstantApiResponse;
    if (!response.ok || json.error) {
      throw new Error(json.details ?? json.error ?? "Point diagnostic failed.");
    }

    const terrainSource = classifyTerrainSource(json);
    const ridgePoint =
      json.diagnostics?.terrainRidgePoint ??
      json.model.terrainHorizonDebug?.ridgePoints.find(
        (point) => point.azimuthDeg === normalizeAzimuth(json.sample.azimuthDeg),
      ) ??
      null;
    const buildingsBlocked = json.sample.buildingsBlocked || json.pointContext.insideBuilding;
    const vegetationBlockedRaw = json.sample.vegetationBlocked ?? false;

    const { primary: primarySourceRaw, secondary: secondarySourcesRaw } =
      selectPrimaryShadowCause({
        aboveAstronomicalHorizon: json.sample.aboveAstronomicalHorizon,
        terrainBlocked: json.sample.terrainBlocked,
        vegetationBlocked: vegetationBlockedRaw,
        buildingsBlocked,
        terrainSource,
        isSunny: json.sample.isSunny,
      });
    const vegetationBlockedEffective = ignoreVegetationForUi
      ? false
      : vegetationBlockedRaw;
    const isSunnyEffective =
      json.sample.aboveAstronomicalHorizon &&
      !json.sample.terrainBlocked &&
      !buildingsBlocked &&
      !vegetationBlockedEffective;
    const { primary: primarySourceEffective, secondary: secondarySourcesEffective } =
      selectPrimaryShadowCause({
        aboveAstronomicalHorizon: json.sample.aboveAstronomicalHorizon,
        terrainBlocked: json.sample.terrainBlocked,
        vegetationBlocked: vegetationBlockedEffective,
        buildingsBlocked,
        terrainSource,
        isSunny: isSunnyEffective,
      });
    const buildingShadowBudget =
      json.sample.buildingBlockerDistanceMeters !== null &&
      json.sample.buildingBlockerAltitudeAngleDeg !== null
        ? (() => {
            const distanceMeters = json.sample.buildingBlockerDistanceMeters!;
            const blockerClearanceMeters =
              Math.tan((json.sample.buildingBlockerAltitudeAngleDeg! * Math.PI) / 180) *
              distanceMeters;
            const requiredClearanceMeters =
              Math.tan((json.sample.altitudeDeg * Math.PI) / 180) * distanceMeters;
            const deficitMeters = blockerClearanceMeters - requiredClearanceMeters;
            return {
              blockerClearanceMeters: Number(blockerClearanceMeters.toFixed(3)),
              requiredClearanceMeters: Number(requiredClearanceMeters.toFixed(3)),
              deficitMeters: Number(deficitMeters.toFixed(3)),
            };
          })()
        : null;

    console.groupCollapsed(
      `[Mappy Hour][click] lat=${payload.lat.toFixed(6)} lon=${payload.lon.toFixed(6)} ` +
        `-> ${primarySourceEffective}`,
    );
    console.log("Cause principale (mode brut):", primarySourceRaw);
    if (secondarySourcesRaw.length > 0) {
      console.log("Causes secondaires (mode brut):", secondarySourcesRaw.join(", "));
    }
    console.log(
      "Cause principale (avec toggle UI ignore végétation =",
      ignoreVegetationForUi,
      "):",
      primarySourceEffective,
    );
    if (secondarySourcesEffective.length > 0) {
      console.log(
        "Causes secondaires (avec toggle UI):",
        secondarySourcesEffective.join(", "),
      );
    }
    console.log("Indoor/Outdoor:", json.pointContext.insideBuilding ? "indoor" : "outdoor");
    console.log("Date/Heure locale:", `${json.date} ${json.localTime}`, "| UTC:", json.utcTime);
    console.log("Coordonnées LV95:", {
      easting: json.pointContext.lv95Easting,
      northing: json.pointContext.lv95Northing,
    });
    console.log("Altitude terrain DEM (m):", json.pointContext.pointElevationMeters);
    console.log("Soleil:", {
      azimuthDeg: Number(json.sample.azimuthDeg.toFixed(3)),
      altitudeDeg: Number(json.sample.altitudeDeg.toFixed(3)),
      horizonAngleDeg:
        json.sample.horizonAngleDeg === null
          ? null
          : Number(json.sample.horizonAngleDeg.toFixed(3)),
      aboveAstronomicalHorizon: json.sample.aboveAstronomicalHorizon,
      isSunny: json.sample.isSunny,
    });
    console.log("Blocages:", {
      terrainBlocked: json.sample.terrainBlocked,
      vegetationBlocked: json.sample.vegetationBlocked ?? false,
      buildingsBlocked: json.sample.buildingsBlocked,
      buildingBlockerId: json.sample.buildingBlockerId,
      buildingBlockerDistanceMeters: json.sample.buildingBlockerDistanceMeters,
      buildingBlockerAltitudeAngleDeg: json.sample.buildingBlockerAltitudeAngleDeg,
      buildingShadowBudget,
      vegetationBlockerDistanceMeters:
        json.sample.vegetationBlockerDistanceMeters ?? null,
      vegetationBlockerAltitudeAngleDeg:
        json.sample.vegetationBlockerAltitudeAngleDeg ?? null,
      vegetationBlockerSurfaceElevationMeters:
        json.sample.vegetationBlockerSurfaceElevationMeters ?? null,
      vegetationBlockerClearanceMeters:
        json.sample.vegetationBlockerClearanceMeters ?? null,
      terrainSource,
      ridgePoint,
    });
    console.log("Modeles:", json.model);
    console.log("Calibration active:", {
      buildingHeightBiasMeters: payload.buildingHeightBiasMeters,
      ignoreVegetationForUi,
    });
    if (json.warnings.length > 0) {
      console.warn("Warnings:", json.warnings);
    }
    console.groupEnd();

    renderShadowBlockerHighlight({
      lat: payload.lat,
      lon: payload.lon,
      response: json,
      primarySource: primarySourceEffective,
      ridgePoint,
    });
  }, [renderShadowBlockerHighlight]);

  useEffect(() => {
    const stored = loadStoredUiParams();
    if (stored) {
      setMode(stored.mode);
      setDate(stored.date);
      setLocalTime(stored.localTime);
      setDailyStartLocalTime(stored.dailyStartLocalTime);
      setDailyEndLocalTime(stored.dailyEndLocalTime);
      setGridStepMeters(stored.gridStepMeters);
      setSampleEveryMinutes(stored.sampleEveryMinutes);
      setBuildingHeightBiasMeters(stored.buildingHeightBiasMeters);
      setBaseMapStyle(stored.baseMapStyle);
      setIgnoreVegetationShadow(stored.ignoreVegetationShadow);
      setShowSunny(stored.showSunny);
      setShowShadow(stored.showShadow);
      setShowVegetation(stored.showVegetation);
      setShowBuildings(stored.showBuildings);
      setShowTerrain(stored.showTerrain);
      setShowHeatmap(stored.showHeatmap);
      setShowPlaces(stored.showPlaces);
    }

    if (deepLinkParamsFromUrl) {
      if (deepLinkParamsFromUrl.mode) {
        setMode(deepLinkParamsFromUrl.mode);
      }
      if (deepLinkParamsFromUrl.date) {
        setDate(deepLinkParamsFromUrl.date);
      }
      if (deepLinkParamsFromUrl.localTime) {
        setLocalTime(deepLinkParamsFromUrl.localTime);
      }
      if (deepLinkParamsFromUrl.dailyStartLocalTime) {
        setDailyStartLocalTime(deepLinkParamsFromUrl.dailyStartLocalTime);
      }
      if (deepLinkParamsFromUrl.dailyEndLocalTime) {
        setDailyEndLocalTime(deepLinkParamsFromUrl.dailyEndLocalTime);
      }
      if (typeof deepLinkParamsFromUrl.gridStepMeters === "number") {
        setGridStepMeters(deepLinkParamsFromUrl.gridStepMeters);
      }
      if (typeof deepLinkParamsFromUrl.sampleEveryMinutes === "number") {
        setSampleEveryMinutes(deepLinkParamsFromUrl.sampleEveryMinutes);
      }
      if (typeof deepLinkParamsFromUrl.buildingHeightBiasMeters === "number") {
        setBuildingHeightBiasMeters(deepLinkParamsFromUrl.buildingHeightBiasMeters);
      }
      if (deepLinkParamsFromUrl.baseMapStyle) {
        setBaseMapStyle(deepLinkParamsFromUrl.baseMapStyle);
      }
      if (typeof deepLinkParamsFromUrl.ignoreVegetationShadow === "boolean") {
        setIgnoreVegetationShadow(deepLinkParamsFromUrl.ignoreVegetationShadow);
      }
      if (typeof deepLinkParamsFromUrl.showSunny === "boolean") {
        setShowSunny(deepLinkParamsFromUrl.showSunny);
      }
      if (typeof deepLinkParamsFromUrl.showShadow === "boolean") {
        setShowShadow(deepLinkParamsFromUrl.showShadow);
      }
      if (typeof deepLinkParamsFromUrl.showBuildings === "boolean") {
        setShowBuildings(deepLinkParamsFromUrl.showBuildings);
      }
      if (typeof deepLinkParamsFromUrl.showTerrain === "boolean") {
        setShowTerrain(deepLinkParamsFromUrl.showTerrain);
      }
      if (typeof deepLinkParamsFromUrl.showVegetation === "boolean") {
        setShowVegetation(deepLinkParamsFromUrl.showVegetation);
      }
      if (typeof deepLinkParamsFromUrl.showHeatmap === "boolean") {
        setShowHeatmap(deepLinkParamsFromUrl.showHeatmap);
      }
      if (typeof deepLinkParamsFromUrl.showPlaces === "boolean") {
        setShowPlaces(deepLinkParamsFromUrl.showPlaces);
      }
    }

    setUiParamsHydrated(true);
  }, [deepLinkParamsFromUrl]);

  useEffect(() => {
    if (!uiParamsHydrated) {
      return;
    }

    persistUiParams({
      mode,
      date,
      localTime,
      dailyStartLocalTime,
      dailyEndLocalTime,
      gridStepMeters,
      sampleEveryMinutes,
      buildingHeightBiasMeters,
      baseMapStyle,
      ignoreVegetationShadow,
      showSunny,
      showShadow,
      showVegetation,
      showBuildings,
      showTerrain,
      showHeatmap,
      showPlaces,
    });
  }, [
    date,
    gridStepMeters,
    localTime,
    dailyEndLocalTime,
    dailyStartLocalTime,
    mode,
    sampleEveryMinutes,
    buildingHeightBiasMeters,
    baseMapStyle,
    ignoreVegetationShadow,
    showBuildings,
    showShadow,
    showSunny,
    showVegetation,
    showTerrain,
    showHeatmap,
    selectedVenueId,
    showPlaces,
    uiParamsHydrated,
  ]);

  useEffect(() => {
    if (!uiParamsHydrated) {
      return;
    }

    if (!activeFocusRunParams || !activeFocusRunToken) {
      setFocusRunOverlay(null);
      setFocusRunMessage(null);
      setFocusRunMessageIsError(false);
      return;
    }

    if (focusRunLoadedTokenRef.current === activeFocusRunToken) {
      return;
    }
    focusRunLoadedTokenRef.current = activeFocusRunToken;

    let cancelled = false;
    const loadFocusRun = async () => {
      setFocusRunMessage("Chargement du contexte cache sélectionné...");
      setFocusRunMessageIsError(false);
      try {
        const params = new URLSearchParams({
          region: activeFocusRunParams.region,
          modelVersionHash: activeFocusRunParams.modelVersionHash,
          date: activeFocusRunParams.date,
          gridStepMeters: String(activeFocusRunParams.gridStepMeters),
          sampleEveryMinutes: String(activeFocusRunParams.sampleEveryMinutes),
          startLocalTime: activeFocusRunParams.startLocalTime,
          endLocalTime: activeFocusRunParams.endLocalTime,
        });
        const response = await fetch(
          `/api/admin/cache/runs/detail?${params.toString()}`,
          {
            cache: "no-store",
          },
        );
        const payload = (await response.json()) as
          | CacheRunDetailResponse
          | { error?: string; details?: string };

        if (!response.ok) {
          const asError = payload as { error?: string; details?: string };
          throw new Error(
            asError.details ??
              asError.error ??
              `HTTP ${response.status} while loading cache run detail.`,
          );
        }

        if (cancelled) {
          return;
        }

        const detail = payload as CacheRunDetailResponse;
        setMode("daily");
        setDate(detail.run.date);
        setLocalTime(detail.run.startLocalTime);
        setDailyStartLocalTime(detail.run.startLocalTime);
        setDailyEndLocalTime(detail.run.endLocalTime);
        setGridStepMeters(detail.run.gridStepMeters);
        setSampleEveryMinutes(detail.run.sampleEveryMinutes);
        setFocusRunOverlay({
          token: activeFocusRunToken,
          bbox: detail.bbox,
          outlineRings: detail.outlineRings,
        });
        setFocusRunMessage(
          `Run cache chargé (${detail.run.region}, ${detail.run.date}, grille ${detail.run.gridStepMeters}m, pas ${detail.run.sampleEveryMinutes}min).`,
        );
        setFocusRunMessageIsError(false);
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setFocusRunOverlay(null);
        setFocusRunMessage(
          loadError instanceof Error
            ? loadError.message
            : "Impossible de charger le détail du run cache sélectionné.",
        );
        setFocusRunMessageIsError(true);
      }
    };

    void loadFocusRun();
    return () => {
      cancelled = true;
    };
  }, [activeFocusRunParams, activeFocusRunToken, uiParamsHydrated]);

  useEffect(() => {
    let isCancelled = false;

    const initMap = async () => {
      if (!mapContainerRef.current || mapRef.current) {
        return;
      }

      const L = await import("leaflet");
      if (isCancelled || !mapContainerRef.current) {
        return;
      }

      leafletModuleRef.current = L;
      const storedView = loadStoredMapView();
      const map = L.map(mapContainerRef.current, {
        zoomControl: false,
        attributionControl: false,
        maxZoom: MAP_MAX_ZOOM,
      }).setView(
        storedView
          ? [storedView.lat, storedView.lon]
          : DEFAULT_MAP_CENTER,
        storedView?.zoom ?? DEFAULT_MAP_ZOOM,
      );

      // Stadia Maps hosts the Stamen tiles and needs an API key in prod.
      // We append `?api_key=<key>` to Stadia URLs when NEXT_PUBLIC_STADIA_API_KEY
      // is set; otherwise (dev / localhost) Stadia serves anonymously up to
      // their low rate limit. Domain authorization is configured on the
      // Stadia dashboard, not here.
      const stadiaApiKey = process.env.NEXT_PUBLIC_STADIA_API_KEY;
      const withStadiaKey = (url: string): string => {
        if (!stadiaApiKey || !url.includes("tiles.stadiamaps.com")) return url;
        const sep = url.includes("?") ? "&" : "?";
        return `${url}${sep}api_key=${stadiaApiKey}`;
      };

      // Per-tile fallback to CARTO Voyager when a Stadia tile errors (HTTP
      // 4xx including 429 quota-exceeded, network error, …). Voyager uses
      // the same {z}/{x}/{y} scheme so the rebuild is straightforward.
      // Applied only to BASE tiles — falling back overlay layers (labels,
      // lines) to Voyager would stack full Voyager tiles on top of the
      // watercolor base = visual mess. If the overlay quota is hit, we
      // just leave the labels blank.
      const CARTO_SUBDOMAINS = ["a", "b", "c", "d"];
      const voyagerUrl = (coords: { x: number; y: number; z: number }) => {
        const sub = CARTO_SUBDOMAINS[(coords.x + coords.y) % CARTO_SUBDOMAINS.length];
        return `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${coords.z}/${coords.x}/${coords.y}.png`;
      };
      const attachStadiaFallback = (layer: TileLayer, url: string) => {
        if (!url.includes("tiles.stadiamaps.com")) return;
        layer.on("tileerror", (event: L.TileErrorEvent) => {
          const tile = event.tile as HTMLImageElement;
          // Guard against infinite-loop when Voyager itself errors out.
          if (tile.dataset.fallbackApplied === "true") return;
          tile.dataset.fallbackApplied = "true";
          tile.src = voyagerUrl(event.coords);
        });
      };

      // For composite basemaps (Stamen Watercolor + Toner overlays), pack
      // the base tile layer and its overlays into an `L.layerGroup` so the
      // layer-control treats them as one selectable unit. Toggling switches
      // the whole stack on/off.
      const baseLayers = Object.fromEntries(
        BASE_MAP_OPTIONS.map((option) => {
          const baseTile = L.tileLayer(withStadiaKey(option.url), {
            maxNativeZoom: Math.min(option.maxNativeZoom, MAP_MAX_NATIVE_ZOOM),
            maxZoom: MAP_MAX_ZOOM,
            attribution: option.attribution,
          });
          attachStadiaFallback(baseTile, option.url);
          if (!option.overlays || option.overlays.length === 0) {
            return [option.id, baseTile];
          }
          const overlayLayers = option.overlays.map((ov) =>
            L.tileLayer(withStadiaKey(ov.url), {
              maxNativeZoom: Math.min(ov.maxNativeZoom ?? option.maxNativeZoom, MAP_MAX_NATIVE_ZOOM),
              maxZoom: MAP_MAX_ZOOM,
              opacity: ov.opacity ?? 1,
            }),
          );
          return [option.id, L.layerGroup([baseTile, ...overlayLayers])];
        }),
      ) as Record<BaseMapStyle, TileLayer | LayerGroup>;
      const initialBaseMapStyle = baseMapStyleRef.current;
      const selectedBaseLayer = baseLayers[initialBaseMapStyle] ?? baseLayers["carto-voyager"];
      selectedBaseLayer.addTo(map);
      baseTileLayersRef.current = {
        layers: baseLayers,
        active: initialBaseMapStyle,
      };

      L.control.zoom({ position: "topleft" }).addTo(map);
      L.control.layers(
        Object.fromEntries(BASE_MAP_OPTIONS.map((option) => [option.label, baseLayers[option.id]])),
        {},
        { position: "topleft", collapsed: true },
      ).addTo(map);

      map.on("baselayerchange", (event: L.LayersControlEvent) => {
        const option = BASE_MAP_OPTIONS.find((candidate) => candidate.label === event.name);
        if (!option) return;
        const fromBasemap = baseMapStyleRef.current;
        baseMapStyleRef.current = option.id;
        setBaseMapStyle(option.id);

        // Umami analytics — explicit user interaction with the basemap
        // selector. State restoration paths (storage, deep-link) call
        // setBaseMapStyle directly without firing this Leaflet event, so we
        // only track real switches initiated from the layers control.
        if (typeof window !== "undefined" && window.umami) {
          window.umami.track("basemap-change", {
            fromBasemap,
            toBasemap: option.id,
          });
        }
      });

      sunnyLayerRef.current = L.layerGroup().addTo(map);
      shadowLayerRef.current = L.layerGroup().addTo(map);
      vegetationLayerRef.current = L.layerGroup().addTo(map);
      buildingsLayerRef.current = L.layerGroup().addTo(map);
      terrainLayerRef.current = L.layerGroup().addTo(map);
      cacheFocusLayerRef.current = L.layerGroup().addTo(map);
      heatmapLayerRef.current = L.layerGroup().addTo(map);
      placesLayerRef.current = L.layerGroup().addTo(map);
      clickHighlightLayerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      setIsMapReady(true);

      map.on("click", (event: LeafletMouseEvent) => {
        const message = `Lat ${event.latlng.lat.toFixed(5)}, Lon ${event.latlng.lng.toFixed(5)}`;
        console.info(`[Mappy Hour][click] ${message}`);
        if (forceCacheOnly) return;
        void runPointClickDiagnostics(event.latlng.lat, event.latlng.lng).catch(
          (error) => {
            console.error(
              "[Mappy Hour][click] Point diagnostic failed:",
              error instanceof Error ? error.message : error,
            );
          },
        );
      });

      map.on("moveend", () => {
        const center = map.getCenter();
        persistMapView({
          lat: Number(center.lat.toFixed(6)),
          lon: Number(center.lng.toFixed(6)),
          zoom: map.getZoom(),
        });
        // Phase 2 overlay LOD: keep strategy inputs fresh.
        setMapBounds(map.getBounds());
        setMapZoom(map.getZoom());
        // Refresh bitmap overlay transforms (cheap; no repaint).
        for (const overlay of bitmapOverlaysRef.current.values()) {
          overlay.updateTransform(map);
        }
      });
      map.on("zoomend", () => {
        setMapZoom(map.getZoom());
        setMapBounds(map.getBounds());
      });
      // Initialize on first ready
      setMapZoom(map.getZoom());
      setMapBounds(map.getBounds());
    };

    void initMap();

    return () => {
      isCancelled = true;
      if (instantStreamRef.current) {
        instantCancelledRef.current = true;
        instantStreamRef.current.close();
        instantStreamRef.current = null;
      }
      if (timelineAbortRef.current) {
        timelineCancelledRef.current = true;
        timelineAbortRef.current.abort();
        timelineAbortRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      sunnyLayerRef.current = null;
      shadowLayerRef.current = null;
      vegetationLayerRef.current = null;
      buildingsLayerRef.current = null;
      terrainLayerRef.current = null;
      cacheFocusLayerRef.current = null;
      heatmapLayerRef.current = null;
      placesLayerRef.current = null;
      clickHighlightLayerRef.current = null;
      baseTileLayersRef.current = {
        layers: {},
        active: "carto-voyager",
      };
      leafletModuleRef.current = null;
      setIsMapReady(false);
    };
  }, [runPointClickDiagnostics]);

  // ===== Viewport places overlay (ADR-0025 follow-up) =====
  // Instantiate once map is ready + showPlaces is true. Owns its own
  // moveend/zoomend listeners (set inside PlacesViewportOverlay). Disposed
  // when showPlaces flips off or on unmount.
  useEffect(() => {
    const map = mapRef.current;
    const L = leafletModuleRef.current;
    if (!isMapReady || !map || !L) return;
    if (!showPlaces) {
      if (viewportPlacesOverlayRef.current) {
        viewportPlacesOverlayRef.current.dispose();
        viewportPlacesOverlayRef.current = null;
      }
      return;
    }
    if (viewportPlacesOverlayRef.current) return;
    const overlay = new PlacesViewportOverlay({
      map,
      leaflet: L,
      onPlaceClick: (place) => {
        // The pure module exports `NormalizedPlaceLite`. The overlay only
        // sees the lite fields it cares about; the cast back to
        // ViewportPlaceLite is safe because that's exactly what we passed
        // into `setPlaces`.
        setSelectedViewportPlace(place as ViewportPlaceLite);
      },
      maxZoom: MAP_MAX_ZOOM,
    });
    viewportPlacesOverlayRef.current = overlay;
    return () => {
      if (viewportPlacesOverlayRef.current) {
        viewportPlacesOverlayRef.current.dispose();
        viewportPlacesOverlayRef.current = null;
      }
    };
  }, [isMapReady, showPlaces]);

  // Push new dataset + redraw whenever it arrives.
  useEffect(() => {
    const overlay = viewportPlacesOverlayRef.current;
    if (!overlay) return;
    overlay.setPlaces(viewportPlaces);
    overlay.refresh();
  }, [viewportPlaces]);

  // Debounced fetch of /api/places/viewport on map move/zoom. We piggy-back
  // on the existing `mapBounds` state (already updated in the map init
  // effect's moveend handler). 400ms matches the rest of the app's
  // movement-driven fetches.
  useEffect(() => {
    if (!isMapReady || !showPlaces) return;
    const bounds = mapBounds;
    if (!bounds) return;
    if (viewportPlacesDebounceRef.current !== null) {
      window.clearTimeout(viewportPlacesDebounceRef.current);
    }
    viewportPlacesDebounceRef.current = window.setTimeout(() => {
      const previous = viewportPlacesFetchAbortRef.current;
      if (previous) previous.abort();
      const abort = new AbortController();
      viewportPlacesFetchAbortRef.current = abort;
      const body = {
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
      };
      fetch("/api/places/viewport", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      })
        .then(async (response) => {
          if (!response.ok) return;
          const json = (await response.json()) as {
            places?: ViewportPlaceLite[];
          };
          if (abort.signal.aborted) return;
          if (Array.isArray(json.places)) setViewportPlaces(json.places);
        })
        .catch((error: unknown) => {
          if (
            error instanceof DOMException &&
            error.name === "AbortError"
          )
            return;
          // Network glitch / 5xx → keep the previous dataset, no toast spam.
          console.warn("[viewport-places] fetch failed:", error);
        });
    }, 400);
    return () => {
      if (viewportPlacesDebounceRef.current !== null) {
        window.clearTimeout(viewportPlacesDebounceRef.current);
        viewportPlacesDebounceRef.current = null;
      }
    };
  }, [isMapReady, showPlaces, mapBounds]);

  useEffect(() => {
    const map = mapRef.current;
    const layerState = baseTileLayersRef.current;
    if (!map) {
      return;
    }
    const previousLayer = layerState.layers[layerState.active];
    const nextLayer = layerState.layers[baseMapStyle];
    if (layerState.active === baseMapStyle || !previousLayer || !nextLayer) {
      return;
    }

    if (map.hasLayer(previousLayer)) {
      map.removeLayer(previousLayer);
    }
    if (!map.hasLayer(nextLayer)) {
      nextLayer.addTo(map);
    }
    layerState.active = baseMapStyle;
  }, [baseMapStyle]);

  const renderLayers = useCallback(
    (
      response: AreaApiResponse | null,
      places: SunlitPlaceEntry[],
      dailyExposureCellsInput: DailyExposureCell[] | null,
      visibility: {
        sunny: boolean;
        shadow: boolean;
        vegetation: boolean;
        buildings: boolean;
        terrain: boolean;
        heatmap: boolean;
        places: boolean;
        ignoreVegetationShadow: boolean;
      },
    ) => {
      const L = leafletModuleRef.current;
      const sunnyLayer = sunnyLayerRef.current;
      const shadowLayer = shadowLayerRef.current;
      const vegetationLayer = vegetationLayerRef.current;
      const buildingsLayer = buildingsLayerRef.current;
      const terrainLayer = terrainLayerRef.current;
      const heatmapLayer = heatmapLayerRef.current;
      const placesLayer = placesLayerRef.current;
      if (
        !L ||
        !sunnyLayer ||
        !shadowLayer ||
        !vegetationLayer ||
        !buildingsLayer ||
        !terrainLayer ||
        !heatmapLayer ||
        !placesLayer
      ) {
        return;
      }

      sunnyLayer.clearLayers();
      shadowLayer.clearLayers();
      vegetationLayer.clearLayers();
      buildingsLayer.clearLayers();
      terrainLayer.clearLayers();
      heatmapLayer.clearLayers();
      placesLayer.clearLayers();

      const useCanvasOverlay =
        response && response.pointCount >= CANVAS_OVERLAY_THRESHOLD;

      // Canvas overlay for large grids is managed by a separate useEffect
      // (sunShadowGridRef + sunShadowOverlayRef) for fast slider updates.

      // For smaller grids, use vector polygon contours
      const { sunnyContours, shadowContours } = !useCanvasOverlay && response
        ? buildSunAndShadowContours(response)
        : { sunnyContours: [], shadowContours: [] };
      const vegetationContours = visibility.ignoreVegetationShadow
        ? []
        : useCanvasOverlay
          ? []
          : buildInstantBlockedContours(
              response,
              (point) => point.vegetationBlocked === true,
            );

      if (visibility.sunny && !useCanvasOverlay) {
        for (const polygon of sunnyContours) {
          const latLngRings = polygon.map((ring) =>
            ring.map(([lon, lat]) => [lat, lon] as [number, number]),
          );
          L.polygon(latLngRings, {
            color: "#eab308",
            fillColor: "#facc15",
            weight: 0.9,
            opacity: 0.5,
            fillOpacity: 0.32,
          }).addTo(sunnyLayer);
        }
      }

      if (visibility.shadow && !useCanvasOverlay) {
        for (const polygon of shadowContours) {
          const latLngRings = polygon.map((ring) =>
            ring.map(([lon, lat]) => [lat, lon] as [number, number]),
          );
          L.polygon(latLngRings, {
            color: "#6b7280",
            fillColor: "#64748b",
            weight: 0.9,
            opacity: 0.5,
            fillOpacity: 0.32,
          }).addTo(shadowLayer);
        }
      }

      // Buildings layer in instant mode: cleared only (no convex hull footprints).
      // Daily mode renders buildings via the tile contour layer (zenith outdoor mask).

      if (visibility.vegetation) {
        for (const polygon of vegetationContours) {
          const latLngRings = polygon.map((ring) =>
            ring.map(([lon, lat]) => [lat, lon] as [number, number]),
          );
          L.polygon(latLngRings, {
            color: "#15803d",
            fillColor: "#22c55e",
            weight: 0.9,
            opacity: 0.62,
            fillOpacity: 0.28,
          }).addTo(vegetationLayer);
        }
      }

      if (visibility.heatmap && !useCanvasOverlay && dailyExposureCellsInput && dailyExposureCellsInput.length > 0) {
        for (const cell of dailyExposureCellsInput) {
          const latLngRing = cell.ring.map(([lon, lat]) => [lat, lon] as [number, number]);
          const color = exposureRatioToColor(cell.exposureRatio);
          const polygon = L.polygon([latLngRing], {
            color,
            fillColor: color,
            weight: 0.2,
            opacity: 0.6,
            fillOpacity: 0.45,
          }).addTo(heatmapLayer);
          polygon.bindTooltip(
            `${Math.round(cell.exposureRatio * 100)}% soleil (${cell.sunnyFrames}/${cell.totalFrames} frames)`,
          );
        }
      }

      if (visibility.places) {
        for (const place of places) {
          const isSelected = place.id === selectedVenueId;
          const sunStatus = getVenueSunStatus(place);
          const markerClassName = venueMarkerClassName(
            place.venueType,
            sunStatus.tone,
            isSelected,
          );
          const marker = L.marker(
            [place.evaluationLat ?? place.lat, place.evaluationLon ?? place.lon],
            {
              icon: L.divIcon({
                html: buildVenueMarkerHtml(markerClassName, place.venueType),
                className: "sunlit-venue-marker-shell",
                iconSize: isSelected ? [42, 48] : [34, 42],
                iconAnchor: isSelected ? [21, 44] : [17, 38],
                popupAnchor: [0, -34],
                tooltipAnchor: [0, -34],
              }),
              keyboard: true,
              title: place.name,
            },
          ).addTo(placesLayer);

          const terraceHint =
            place.selectionStrategy === "terrace_offset"
              ? `terrasse offset ${place.selectionOffsetMeters}m`
              : place.selectionStrategy === "indoor_fallback"
                ? "point indoor fallback"
                : "point original";
          const sunlightHint =
            place.isSunnyNow !== null
              ? place.isSunnyNow
                ? "soleil maintenant"
                : "ombre maintenant"
              : `${place.sunlightStartLocalTime ?? "--:--"} -> ${place.sunlightEndLocalTime ?? "--:--"} (${place.sunnyMinutes} min)`;

          marker.bindTooltip(place.name, {
            permanent: true,
            direction: "top",
            offset: [0, -10],
            className: "sunlit-place-label",
            opacity: 0.95,
          });

          marker.bindPopup(
            `${place.name} (${venueTypeBadgeLabel(place.venueType)})<br/>${sunlightHint}<br/>${terraceHint}`,
          );

          marker.on("click", (event: LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(event);
            setSelectedVenueId(place.id);
            if (!forceCacheOnly) {
              void runPointClickDiagnostics(
                place.evaluationLat ?? place.lat,
                place.evaluationLon ?? place.lon,
              ).catch((error) => {
                console.error(
                  "[Mappy Hour][place] Point diagnostic failed:",
                  error instanceof Error ? error.message : error,
                );
              });
            }
          });
        }
      }

      const terrainHorizonDebug = response?.model?.terrainHorizonDebug;
      if (visibility.terrain && terrainHorizonDebug?.ridgePoints.length) {
        const ridgeLatLngs = [...terrainHorizonDebug.ridgePoints]
          .sort((left, right) => left.azimuthDeg - right.azimuthDeg)
          .map((point) => [point.lat, point.lon] as [number, number]);

        L.polyline(ridgeLatLngs, {
          color: "#b45309",
          weight: 1.8,
          opacity: 0.8,
          dashArray: "6 4",
        }).addTo(terrainLayer);

        const center = terrainHorizonDebug.center;
        L.circleMarker([center.lat, center.lon], {
          radius: 4,
          color: "#92400e",
          fillColor: "#f59e0b",
          fillOpacity: 0.85,
          weight: 1,
        }).addTo(terrainLayer);

        const sortedRidgePoints = [...terrainHorizonDebug.ridgePoints].sort(
          (left, right) => left.azimuthDeg - right.azimuthDeg,
        );
        for (let index = 0; index < sortedRidgePoints.length; index += 12) {
          const ridgePoint = sortedRidgePoints[index];
          const marker = L.circleMarker([ridgePoint.lat, ridgePoint.lon], {
            radius: 2,
            color: "#92400e",
            fillColor: "#f59e0b",
            fillOpacity: 0.65,
            weight: 1,
          }).addTo(terrainLayer);
          marker.bindTooltip(
            `az ${ridgePoint.azimuthDeg}deg | d ${Math.round(ridgePoint.distanceMeters)}m`,
          );
          marker.on("click", (event: LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(event);
            const terrainSource = classifyRidgeDistance(ridgePoint.distanceMeters);
            console.groupCollapsed(
              `[Mappy Hour][ridge] az=${ridgePoint.azimuthDeg}deg -> ${terrainSource}`,
            );
            console.log("Terrain source:", terrainSource);
            console.log("Ridge point:", ridgePoint);
            console.log("Horizon center:", terrainHorizonDebug.center);
            console.log("Horizon radius (km):", terrainHorizonDebug.radiusKm);
            console.groupEnd();
            if (!forceCacheOnly) {
              void runPointClickDiagnostics(ridgePoint.lat, ridgePoint.lon).catch(
                (error) => {
                  console.error(
                    "[Mappy Hour][ridge] Point diagnostic failed:",
                    error instanceof Error ? error.message : error,
                  );
                },
              );
            }
          });
        }
      }
    },
    [runPointClickDiagnostics, selectedVenueId],
  );

  useEffect(() => {
    // In daily mode, the tile contour layer handles sunny/shadow/buildings
    // rendering using the outdoor mask from grid metadata (zenith shadow map).
    // Don't render the instant layers which use convex hull footprints.
    const isDailyMode = mode === "daily" && dailyTimeline && dailyTimeline.tiles.length > 0;
    renderLayers(
      isDailyMode ? null : visualAreaResponse,
      sunlitPlaces,
      dailyExposureCells,
      {
        sunny: isDailyMode ? false : showSunny,
        shadow: isDailyMode ? false : showShadow,
        vegetation: isDailyMode ? false : showVegetation,
        buildings: isDailyMode ? false : showBuildings,
        terrain: isDailyMode ? false : showTerrain,
        heatmap: showHeatmap,
        places: showPlaces,
        ignoreVegetationShadow,
      },
    );
  }, [
    dailyExposureCells,
    dailyTimeline,
    ignoreVegetationShadow,
    mode,
    renderLayers,
    showBuildings,
    showHeatmap,
    showPlaces,
    showShadow,
    showSunny,
    showVegetation,
    showTerrain,
    sunlitPlaces,
    visualAreaResponse,
  ]);

  // Canvas overlay for large grids — fast slider updates
  useEffect(() => {
    console.log("[canvas-effect]", { isMapReady, hasTl: !!dailyTimeline, mode, tiles: dailyTimeline?.tiles.length, pts: dailyTimeline?.pointCount, bounds: !!dailyTimeline?.overlayBounds, showSunny, showShadow });
    if (!isMapReady || !dailyTimeline || mode !== "daily") {
      if (sunShadowOverlayRef.current) {
        sunShadowOverlayRef.current.remove();
        sunShadowOverlayRef.current = null;
      }
      if (contourLayerRef.current) {
        contourLayerRef.current.clearLayers();
      }
      for (const ov of perTileOverlaysRef.current.values()) {
        const customImg = (ov.overlay as unknown as { _customImg?: HTMLElement })._customImg;
        if (customImg) customImg.remove();
        ov.overlay.remove();
      }
      perTileOverlaysRef.current.clear();
      for (const ov of bitmapOverlaysRef.current.values()) ov.dispose();
      bitmapOverlaysRef.current.clear();
      sunShadowGridRef.current = null;
      return;
    }
    const L = leafletModuleRef.current;
    if (!L) return;

    const useCanvas = dailyTimeline.tiles.length > 0 && dailyTimeline.pointCount >= CANVAS_OVERLAY_THRESHOLD;
    const hasGridTiles = dailyTimeline.tiles.some(t => t.grid);
    const overlayVisible = useCanvas && (showSunny || showShadow);

    if (!overlayVisible || !hasGridTiles) {
      // Clean up per-tile overlays
      for (const ov of perTileOverlaysRef.current.values()) {
        const customImg = (ov.overlay as unknown as { _customImg?: HTMLElement })._customImg;
        if (customImg) customImg.remove();
        ov.overlay.remove();
      }
      perTileOverlaysRef.current.clear();
      for (const ov of bitmapOverlaysRef.current.values()) ov.dispose();
      bitmapOverlaysRef.current.clear();
      if (contourLayerRef.current) {
        contourLayerRef.current.clearLayers();
      }
      if (sunShadowOverlayRef.current) {
        sunShadowOverlayRef.current.remove();
        sunShadowOverlayRef.current = null;
      }
      sunShadowGridRef.current = null;
      return;
    }

    const map = mapRef.current;
    if (!map) return;

    // ── Phase 2 overlay LOD: strategy-driven mode selection ───────────────
    // Replaces the binary `tiles.some(t => t.tileCorners)` toggle. We still
    // require tileCorners (without them neither pipeline can place the tile
    // precisely) — when they're missing we fall through to the legacy
    // per-tile L.imageOverlay branch further down.
    const hasCorners = dailyTimeline.tiles.some((t) => t.tileCorners);
    const useVectorial = hasCorners && effectiveRenderMode === "vector";
    const useBitmapTileOverlay = hasCorners && effectiveRenderMode === "bitmap";

    // Clean up the OTHER mode's overlays each time the effect runs.
    if (useVectorial || useBitmapTileOverlay) {
      // Dispose bitmap overlays if we're not in bitmap mode this pass.
      if (!useBitmapTileOverlay) {
        for (const ov of bitmapOverlaysRef.current.values()) ov.dispose();
        bitmapOverlaysRef.current.clear();
      }
    }

    if (useBitmapTileOverlay) {
      // Clean up vector contour layer + legacy per-tile overlays.
      if (contourLayerRef.current) contourLayerRef.current.clearLayers();
      for (const ov of perTileOverlaysRef.current.values()) {
        const customImg = (ov.overlay as unknown as { _customImg?: HTMLElement })._customImg;
        if (customImg) customImg.remove();
        ov.overlay.remove();
      }
      perTileOverlaysRef.current.clear();

      const pane = map.getPane("overlayPane");
      if (!pane) return;
      const targetRes = renderStrategy.bitmapResolution;
      const dpr = dprRef.current;
      const activeTileIds = new Set<string>();
      const viewportBounds = map.getBounds();

      for (const tile of dailyTimeline.tiles) {
        if (!tile.grid || !tile.tileCorners || tile.frames.length === 0) continue;
        // Viewport filter — tiles outside the visible bounds are not painted
        // and their overlay is disposed below. Avoids paying paint cost for
        // tiles the user can't see (huge win on large precomputed zones).
        const c = tile.tileCorners;
        const tileSouth = Math.min(c.sw.lat, c.se.lat);
        const tileNorth = Math.max(c.nw.lat, c.ne.lat);
        const tileWest = Math.min(c.nw.lon, c.sw.lon);
        const tileEast = Math.max(c.ne.lon, c.se.lon);
        if (tileEast < viewportBounds.getWest()) continue;
        if (tileWest > viewportBounds.getEast()) continue;
        if (tileNorth < viewportBounds.getSouth()) continue;
        if (tileSouth > viewportBounds.getNorth()) continue;
        activeTileIds.add(tile.tileId);

        // Edge tiles (region bbox truncates one axis) have rectangular grids
        // — e.g. 43 × 250 on the west edge of Vevey. Per-axis clamp avoids
        // `paintTileImageData` throwing "upsampling not supported" when the
        // square targetRes exceeds the actual grid in one dimension.
        const widthPx = Math.min(targetRes, tile.grid.width);
        const heightPx = Math.min(targetRes, tile.grid.height);

        let overlay = bitmapOverlaysRef.current.get(tile.tileId);
        // Re-rasterize if EITHER axis drifted by > 50% (zoom changed enough).
        if (
          overlay &&
          (shouldRerasterize(overlay.widthPx, widthPx) ||
            shouldRerasterize(overlay.heightPx, heightPx))
        ) {
          overlay.dispose();
          overlay = undefined;
        }
        if (!overlay) {
          overlay = new BitmapTileOverlay({
            tileId: tile.tileId,
            corners: tile.tileCorners,
            widthPx,
            heightPx,
            devicePixelRatio: dpr,
            container: pane,
          });
          bitmapOverlaysRef.current.set(tile.tileId, overlay);
        }

        // Paint current frame.
        // IMPORTANT: paint at the OVERLAY's actual canvas size, not the
        // re-computed target. When we're inside the rerasterize hysteresis
        // band (±50%) we keep the existing canvas — painting a smaller
        // ImageData onto a larger canvas would only fill the top-left,
        // leaving stale pixels from the previous frame visible after the
        // CSS matrix stretches the canvas onto a larger geographic area
        // (yellow "spill" outside the tile after zoom-out).
        const sunMask = getTileMask(tile, dailyFrameIndex, ignoreVegetationShadow, decodedTimelineMaskCacheRef.current);
        if (!sunMask) continue;
        const outdoorMask = getTileOutdoorMask(tile, decodedTimelineMaskCacheRef.current);
        const img = paintTileImageData({
          width: overlay.widthPx,
          height: overlay.heightPx,
          gridWidth: tile.grid.width,
          gridHeight: tile.grid.height,
          mode: {
            kind: "sunShadow",
            sunMask,
            outdoorMask,
            palette: PAINT_TILE_PALETTE,
          },
          downsampleMode: "box",
        });
        overlay.paint(img);
        overlay.updateTransform(map);
      }

      // Dispose overlays whose tile is no longer present.
      for (const [id, ov] of bitmapOverlaysRef.current) {
        if (!activeTileIds.has(id)) {
          ov.dispose();
          bitmapOverlaysRef.current.delete(id);
        }
      }
      return; // bitmap path complete
    }

    if (useVectorial) {
      // Clean up canvas overlays
      for (const ov of perTileOverlaysRef.current.values()) {
        const customImg = (ov.overlay as unknown as { _customImg?: HTMLElement })._customImg;
        if (customImg) customImg.remove();
        ov.overlay.remove();
      }
      perTileOverlaysRef.current.clear();

      // Create or reuse contour layer
      if (!contourLayerRef.current) {
        contourLayerRef.current = L.layerGroup().addTo(map);
      }
      contourLayerRef.current.clearLayers();

      const vectorViewportBounds = map.getBounds();

      for (const tile of dailyTimeline.tiles) {
        if (!tile.grid || !tile.tileCorners || tile.frames.length === 0) continue;
        // Viewport filter — marching-squares is the expensive bit, no point
        // running it on tiles the user can't see. Mirrors the bitmap path.
        const vc = tile.tileCorners;
        const vSouth = Math.min(vc.sw.lat, vc.se.lat);
        const vNorth = Math.max(vc.nw.lat, vc.ne.lat);
        const vWest = Math.min(vc.nw.lon, vc.sw.lon);
        const vEast = Math.max(vc.ne.lon, vc.se.lon);
        if (vEast < vectorViewportBounds.getWest()) continue;
        if (vWest > vectorViewportBounds.getEast()) continue;
        if (vNorth < vectorViewportBounds.getSouth()) continue;
        if (vSouth > vectorViewportBounds.getNorth()) continue;
        const contours = buildTileContourPolygons(
          tile, dailyFrameIndex, decodedTimelineMaskCacheRef.current, ignoreVegetationShadow,
        );
        if (showSunny && showShadow) {
          // Both layers: yellow sunny polygons + gray shadow polygons
          for (const polygon of contours.sunnyPolygons) {
            const latLngRings = polygon.map(ring =>
              ring.map(([lat, lon]) => [lat, lon] as [number, number])
            );
            L.polygon(latLngRings, {
              color: "#eab308",
              fillColor: "#facc15",
              weight: 0,
              fillOpacity: 0.4,
            }).addTo(contourLayerRef.current!);
          }
          for (const polygon of contours.shadowPolygons) {
            const latLngRings = polygon.map(ring =>
              ring.map(([lat, lon]) => [lat, lon] as [number, number])
            );
            L.polygon(latLngRings, {
              color: "#475569",
              fillColor: "#334155",
              weight: 0,
              fillOpacity: 0.35,
            }).addTo(contourLayerRef.current!);
          }
        } else if (showSunny) {
          for (const polygon of contours.sunnyPolygons) {
            const latLngRings = polygon.map(ring =>
              ring.map(([lat, lon]) => [lat, lon] as [number, number])
            );
            L.polygon(latLngRings, {
              color: "#eab308",
              fillColor: "#facc15",
              weight: 0,
              fillOpacity: 0.4,
            }).addTo(contourLayerRef.current!);
          }
        } else if (showShadow) {
          for (const polygon of contours.shadowPolygons) {
            const latLngRings = polygon.map(ring =>
              ring.map(([lat, lon]) => [lat, lon] as [number, number])
            );
            L.polygon(latLngRings, {
              color: "#475569",
              fillColor: "#334155",
              weight: 0,
              fillOpacity: 0.35,
            }).addTo(contourLayerRef.current!);
          }
        }

        // Building footprints from zenith outdoor mask (not convex hull)
        if (showBuildings) {
          for (const polygon of contours.buildingPolygons) {
            const latLngRings = polygon.map(ring =>
              ring.map(([lat, lon]) => [lat, lon] as [number, number])
            );
            L.polygon(latLngRings, {
              color: "#2563eb",
              fillColor: "#2563eb",
              weight: 0.5,
              opacity: 0.5,
              fillOpacity: 0.2,
            }).addTo(contourLayerRef.current!);
          }
        }
      }
      return; // skip canvas path
    }

    // Fallback: per-tile canvas overlays (when tileCorners not available)
    if (contourLayerRef.current) {
      contourLayerRef.current.clearLayers();
    }
    const existingOverlays = perTileOverlaysRef.current;
    const activeTileIds = new Set(dailyTimeline.tiles.map(t => t.tileId));

    // Remove overlays for tiles no longer present
    for (const [id, ov] of existingOverlays) {
      if (!activeTileIds.has(id)) {
        const customImg = (ov.overlay as unknown as { _customImg?: HTMLElement })._customImg;
        if (customImg) customImg.remove();
        ov.overlay.remove();
        existingOverlays.delete(id);
      }
    }

    for (const tile of dailyTimeline.tiles) {
      if (!tile.grid || tile.frames.length === 0) continue;

      let ov = existingOverlays.get(tile.tileId);
      if (!ov) {
        // Create canvas + overlay for this tile
        const w = tile.grid.width;
        const h = tile.grid.height;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;

        if (!tile.tileCorners && !tile.tileBounds) continue;

        let overlay: L.ImageOverlay;
        let bounds: [[number, number], [number, number]];

        if (tile.tileCorners) {
          // Use affine transform via CSS matrix for precise positioning.
          // Canvas coords: (0,0)=NW, (w,0)=NE, (0,h)=SW
          // Map coords: convert corners to layer points
          const nwPt = map.latLngToLayerPoint([tile.tileCorners.nw.lat, tile.tileCorners.nw.lon]);
          const nePt = map.latLngToLayerPoint([tile.tileCorners.ne.lat, tile.tileCorners.ne.lon]);
          const swPt = map.latLngToLayerPoint([tile.tileCorners.sw.lat, tile.tileCorners.sw.lon]);

          // CSS matrix(a,b,c,d,e,f): x'=a*x+c*y+e, y'=b*x+d*y+f
          const a = (nePt.x - nwPt.x) / w;
          const b = (nePt.y - nwPt.y) / w;
          const c = (swPt.x - nwPt.x) / h;
          const d = (swPt.y - nwPt.y) / h;

          // Create a plain img element positioned via CSS transform
          const img = document.createElement("img");
          img.style.position = "absolute";
          img.style.left = "0";
          img.style.top = "0";
          img.style.transformOrigin = "0 0";
          img.style.transform = `matrix(${a},${b},${c},${d},${nwPt.x},${nwPt.y})`;
          img.style.imageRendering = "pixelated";
          img.style.pointerEvents = "none";
          img.src = canvas.toDataURL();

          const mapPane = map.getPane("overlayPane");
          if (mapPane) mapPane.appendChild(img);

          // Wrap in a dummy overlay for cleanup — store the img ref
          bounds = tile.tileBounds
            ? [[tile.tileBounds.minLat, tile.tileBounds.minLon], [tile.tileBounds.maxLat, tile.tileBounds.maxLon]]
            : [[tile.tileCorners.sw.lat, tile.tileCorners.sw.lon], [tile.tileCorners.ne.lat, tile.tileCorners.ne.lon]];
          // Use a minimal L.imageOverlay just for lifecycle management
          overlay = L.imageOverlay(canvas.toDataURL(), bounds, { opacity: 0, interactive: false }).addTo(map);
          // Hide the leaflet overlay and keep our custom img
          const leafletImg = (overlay as unknown as { _image?: HTMLElement })._image;
          if (leafletImg) leafletImg.style.display = "none";
          // Store custom img ref for updates
          (overlay as unknown as { _customImg: HTMLImageElement })._customImg = img;
          (overlay as unknown as { _tileCorners: typeof tile.tileCorners })._tileCorners = tile.tileCorners;
        } else {
          bounds = [[tile.tileBounds!.minLat, tile.tileBounds!.minLon], [tile.tileBounds!.maxLat, tile.tileBounds!.maxLon]];
          overlay = L.imageOverlay(canvas.toDataURL(), bounds, { opacity: 1, interactive: false }).addTo(map);
          const imgEl = (overlay as unknown as { _image?: HTMLElement })._image;
          if (imgEl) imgEl.style.imageRendering = "pixelated";
        }

        ov = { tileId: tile.tileId, canvas, ctx, overlay, width: w, height: h, bounds };
        existingOverlays.set(tile.tileId, ov);
      }

      // Paint the current frame on this tile's canvas
      paintTileCanvas(tile, ov.ctx, ov.width, ov.height, dailyFrameIndex, decodedTimelineMaskCacheRef.current, ignoreVegetationShadow, "sunShadow");
      const dataUrl = ov.canvas.toDataURL();
      const customImg = (ov.overlay as unknown as { _customImg?: HTMLImageElement })._customImg;
      if (customImg) {
        customImg.src = dataUrl;
        // Update transform in case map was panned/zoomed
        const corners = (ov.overlay as unknown as { _tileCorners?: { nw: LatLon; ne: LatLon; sw: LatLon } })._tileCorners;
        if (corners) {
          const nwPt = map.latLngToLayerPoint([corners.nw.lat, corners.nw.lon]);
          const nePt = map.latLngToLayerPoint([corners.ne.lat, corners.ne.lon]);
          const swPt = map.latLngToLayerPoint([corners.sw.lat, corners.sw.lon]);
          const a = (nePt.x - nwPt.x) / ov.width;
          const b = (nePt.y - nwPt.y) / ov.width;
          const c = (swPt.x - nwPt.x) / ov.height;
          const d = (swPt.y - nwPt.y) / ov.height;
          customImg.style.transform = `matrix(${a},${b},${c},${d},${nwPt.x},${nwPt.y})`;
        }
      } else {
        ov.overlay.setUrl(dataUrl);
      }
    }
  }, [dailyFrameIndex, dailyTimeline, ignoreVegetationShadow, isMapReady, mode, showShadow, showSunny, effectiveRenderMode, renderStrategy.bitmapResolution, mapBounds]);

  // ── Idle vector upgrade ────────────────────────────────────────────────
  // When we're in bitmap LOD mode AND the user pauses interaction, run a
  // single unified-viewport marching-squares pass and overlay the resulting
  // polygons on top of the bitmaps. The bitmaps stay underneath so the
  // teardown is instant on the next interaction.
  //
  // Re-armed on every change of the deps array — slider, zoom, pan, mode
  // toggle, toggles for sunny/shadow/buildings. The teardown happens
  // synchronously at the top of the effect so we never paint a stale
  // upgrade against a moved-on viewport.
  useEffect(() => {
    if (!isMapReady || mode !== "daily" || !dailyTimeline) return;
    const map = mapRef.current;
    const L = leafletModuleRef.current;
    if (!map || !L) return;

    // Helper: toggle the visibility of every bitmap overlay's <canvas>.
    // We show the bitmap by default and hide it while the unified vector
    // overlay is displayed on top — otherwise the two layers stack and
    // their alpha channels compound, washing out the colors.
    const setBitmapsVisible = (visible: boolean) => {
      for (const ov of bitmapOverlaysRef.current.values()) {
        ov.element.style.display = visible ? "" : "none";
      }
    };

    // Always tear down the previous upgrade synchronously.
    if (unifiedVectorLayerRef.current) {
      unifiedVectorLayerRef.current.remove();
      unifiedVectorLayerRef.current = null;
      setBitmapsVisible(true);
    }
    if (idleVectorTimerRef.current) {
      clearTimeout(idleVectorTimerRef.current);
      idleVectorTimerRef.current = null;
    }

    // Only upgrade when the strategy chose bitmap. In vector mode the
    // existing per-tile path already shows polygons.
    if (effectiveRenderMode !== "bitmap") return;
    // Disabled when the user has forced a mode via the toggle — the
    // override is meant for clean A/B comparisons, and an automatic
    // vector overlay on top of a forced "bitmap" defeats the purpose.
    if (modeOverride !== null) return;
    // Skip the upgrade at zoom ≤ 17: each source cell is sub-pixel
    // (or close to it) at this scale, so the bitmap's chunky cell
    // edges aren't perceptible and the vector overlay adds no visible
    // value — only cost. The upgrade kicks in above z=17, where each
    // 1m cell starts spanning multiple device pixels.
    if (mapZoom === null || mapZoom <= 17) return;

    const IDLE_DELAY_MS = 400;
    idleVectorTimerRef.current = setTimeout(() => {
      idleVectorTimerRef.current = null;
      const bounds = map.getBounds();

      // Filter to tiles intersecting the viewport. We compare lat/lon
      // bounding boxes — cheap and good enough since tiles are small.
      const visible: VisibleTileInput[] = [];
      for (const tile of dailyTimeline.tiles) {
        if (!tile.grid || !tile.tileCorners || tile.frames.length === 0) continue;
        const c = tile.tileCorners;
        const tileSouth = Math.min(c.sw.lat, c.se.lat);
        const tileNorth = Math.max(c.nw.lat, c.ne.lat);
        const tileWest = Math.min(c.nw.lon, c.sw.lon);
        const tileEast = Math.max(c.ne.lon, c.se.lon);
        if (tileEast < bounds.getWest()) continue;
        if (tileWest > bounds.getEast()) continue;
        if (tileNorth < bounds.getSouth()) continue;
        if (tileSouth > bounds.getNorth()) continue;

        const sunMask = getTileMask(tile, dailyFrameIndex, ignoreVegetationShadow, decodedTimelineMaskCacheRef.current);
        if (!sunMask) continue;
        const outdoorMask = getTileOutdoorMask(tile, decodedTimelineMaskCacheRef.current);
        visible.push({
          tileId: tile.tileId,
          corners: c,
          gridWidth: tile.grid.width,
          gridHeight: tile.grid.height,
          sunMask,
          outdoorMask: outdoorMask ?? undefined,
        });
      }

      if (visible.length === 0) return;

      const t0 = performance.now();
      const result = buildUnifiedViewportContours(visible);
      const elapsedMs = performance.now() - t0;
      // Empirical telemetry — feeds the future "skip upgrade above N
      // cells" cap. Cheap on the console, gone in prod via the strategy
      // gating once we pick a threshold.
      if (typeof window !== "undefined") {
        console.debug(
          `[idle-vector] ${visible.length} tiles, ${result.stats.totalCells} cells, ${elapsedMs.toFixed(0)}ms`,
        );
      }

      const layer = L.layerGroup();
      const pushPolygons = (
        polygons: Array<[number, number][][]>,
        style: L.PathOptions,
      ) => {
        for (const polygon of polygons) {
          const rings = polygon.map((ring) => ring.map(([lat, lon]) => [lat, lon] as [number, number]));
          L.polygon(rings, style).addTo(layer);
        }
      };
      if (showSunny) {
        pushPolygons(result.sunnyPolygons, { color: "#eab308", fillColor: "#facc15", weight: 0, fillOpacity: 0.4 });
      }
      if (showShadow) {
        pushPolygons(result.shadowPolygons, { color: "#475569", fillColor: "#334155", weight: 0, fillOpacity: 0.35 });
      }
      if (showBuildings) {
        pushPolygons(result.buildingPolygons, { color: "#2563eb", fillColor: "#2563eb", weight: 0.5, opacity: 0.5, fillOpacity: 0.2 });
      }
      layer.addTo(map);
      unifiedVectorLayerRef.current = layer;
      setBitmapsVisible(false);
    }, IDLE_DELAY_MS);

    return () => {
      if (idleVectorTimerRef.current) {
        clearTimeout(idleVectorTimerRef.current);
        idleVectorTimerRef.current = null;
      }
      if (unifiedVectorLayerRef.current) {
        unifiedVectorLayerRef.current.remove();
        unifiedVectorLayerRef.current = null;
        setBitmapsVisible(true);
      }
    };
  }, [
    isMapReady, mode, dailyTimeline, dailyFrameIndex, effectiveRenderMode,
    ignoreVegetationShadow, showSunny, showShadow, showBuildings, mapBounds, mapZoom,
    modeOverride,
  ]);

  // Canvas heatmap for large grids
  useEffect(() => {
    if (!isMapReady || !dailyTimeline || mode !== "daily") {
      if (heatmapOverlayRef.current) {
        heatmapOverlayRef.current.remove();
        heatmapOverlayRef.current = null;
      }
      heatmapCanvasRef.current = null;
      return;
    }
    const L = leafletModuleRef.current;
    if (!L) return;

    const useCanvas = dailyTimeline.tiles.length > 0 && dailyTimeline.pointCount >= CANVAS_OVERLAY_THRESHOLD && dailyTimeline.stats;
    if (!useCanvas || !showHeatmap) {
      if (heatmapOverlayRef.current) {
        heatmapOverlayRef.current.remove();
        heatmapOverlayRef.current = null;
      }
      return;
    }

    // Reuse the sun/shadow grid or build a new one
    if (!heatmapCanvasRef.current || heatmapCanvasRef.current.tilePixelMaps.length !== dailyTimeline.tiles.length) {
      if (heatmapOverlayRef.current) {
        heatmapOverlayRef.current.remove();
        heatmapOverlayRef.current = null;
      }
      heatmapCanvasRef.current = prepareSunShadowGrid(dailyTimeline);
    }

    const grid = heatmapCanvasRef.current;
    if (!grid) return;

    paintHeatmapCanvas(
      grid,
      dailyTimeline,
      decodedTimelineMaskCacheRef.current,
      ignoreVegetationShadow,
    );

    const map = mapRef.current;
    if (!map) return;
    const dataUrl = grid.canvas.toDataURL();
    if (!heatmapOverlayRef.current) {
      heatmapOverlayRef.current = L.imageOverlay(
        dataUrl,
        grid.bounds,
        { opacity: 1, interactive: false },
      ).addTo(map);
      const imgEl = (heatmapOverlayRef.current as unknown as { _image?: HTMLElement })._image;
      if (imgEl) {
        imgEl.style.imageRendering = "pixelated";
      }
    } else {
      heatmapOverlayRef.current.setUrl(dataUrl);
    }
  }, [dailyTimeline, ignoreVegetationShadow, isMapReady, mode, showHeatmap]);

  useEffect(() => {
    if (!isMapReady) {
      return;
    }
    const L = leafletModuleRef.current;
    const focusLayer = cacheFocusLayerRef.current;
    if (!L || !focusLayer) {
      return;
    }

    focusLayer.clearLayers();
    if (!focusRunOverlay) {
      return;
    }

    const { bbox, outlineRings } = focusRunOverlay;
    for (const ring of outlineRings) {
      if (ring.length < 2) {
        continue;
      }
      L.polyline(ring, {
        color: "#22d3ee",
        weight: 2.2,
        opacity: 0.9,
        dashArray: "10 6",
      }).addTo(focusLayer);
    }

    L.rectangle(
      [
        [bbox.minLat, bbox.minLon],
        [bbox.maxLat, bbox.maxLon],
      ],
      {
        color: "#67e8f9",
        weight: 1.2,
        opacity: 0.5,
        fillOpacity: 0,
        dashArray: "4 4",
      },
    ).addTo(focusLayer);
  }, [focusRunOverlay, isMapReady]);

  useEffect(() => {
    if (mode === "daily") {
      if (instantStreamRef.current) {
        instantCancelledRef.current = true;
        instantStreamRef.current.close();
        instantStreamRef.current = null;
        setIsLoading(false);
      }
      return;
    }

    if (timelineAbortRef.current) {
      timelineCancelledRef.current = true;
      timelineAbortRef.current.abort();
      timelineAbortRef.current = null;
      setIsLoading(false);
    }
  }, [mode]);

  const cancelDailyCalculation = useCallback(() => {
    if (mode !== "daily") {
      return;
    }

    timelineCancelledRef.current = true;
    if (timelineAbortRef.current) {
      timelineCancelledRef.current = true;
      timelineAbortRef.current.abort();
      timelineAbortRef.current = null;
    }
    timelineCancelledRef.current = false;
    setIsLoading(false);
    setDailyProgress((previous) => ({
      phase: "cancelled",
      done: previous?.done ?? 0,
      total: previous?.total ?? 0,
      percent: previous?.percent ?? 0,
      etaSeconds: null,
    }));
  }, [mode]);

  const centerOnVenue = useCallback((place: SunlitPlaceEntry | VenueCardPlace) => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    map.setView(
      [place.evaluationLat ?? place.lat, place.evaluationLon ?? place.lon],
      Math.max(map.getZoom(), 16),
      { animate: true },
    );
  }, []);

  const handleSelectVenue = useCallback(
    (place: SunlitPlaceEntry | VenueCardPlace) => {
      setSelectedVenueId(place.id);
      centerOnVenue(place);
      setIsMobileBarsOpen(false);
      setBottomSheetState("middle");
    },
    [centerOnVenue],
  );

  const handleOpenSearch = useCallback(() => {
    setSearchError(null);
    setSearchQuery(lastSearchQuery);
    setIsSearchOpen(true);
  }, [lastSearchQuery]);

  const handleSubmitSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query) {
      return;
    }
    setIsSearchLoading(true);
    setSearchError(null);
    try {
      const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`, {
        cache: "no-store",
      });
      const result = (await response.json().catch(() => null)) as
        | {
            lat?: number;
            lon?: number;
            bbox?: [number, number, number, number];
            error?: string;
          }
        | null;
      if (!response.ok || !result?.lat || !result?.lon) {
        throw new Error(result?.error ?? "Aucun résultat trouvé.");
      }
      const map = mapRef.current;
      if (map) {
        if (result.bbox) {
          map.fitBounds(
            [
              [result.bbox[1], result.bbox[0]],
              [result.bbox[3], result.bbox[2]],
            ],
            { padding: [40, 40], animate: true },
          );
        } else {
          map.setView([result.lat, result.lon], Math.max(map.getZoom(), 15), {
            animate: true,
          });
        }
      }
      setLastSearchQuery(query);
      setIsSearchOpen(false);
      setSuggestionsCloseSignal((c) => c + 1);
    } catch (searchSubmitError) {
      setSearchError(
        searchSubmitError instanceof Error
          ? searchSubmitError.message
          : "Recherche impossible.",
      );
    } finally {
      setIsSearchLoading(false);
    }
  }, [searchQuery]);

  // Suggestion target zoom: 17 for a single venue (one 250 m × 250 m tile fits
  // ~300 px on screen at lat 46.5). For city/region suggestions, use the
  // Nominatim bbox to fitBounds instead — way more natural than a fixed zoom.
  // No fancy heuristic on what counts as "a city": if Nominatim returns a bbox,
  // we trust it; otherwise default to zoom 17 (small enough for venues, large
  // enough to avoid the "you see 5 tiles" zoom 19 trap).
  const SUGGESTION_TARGET_ZOOM = 17;

  const handleSelectSuggestion = useCallback(
    (suggestion: PlaceSuggestion) => {
      const map = mapRef.current;
      if (map) {
        if (suggestion.bbox) {
          const [minLon, minLat, maxLon, maxLat] = suggestion.bbox;
          map.fitBounds(
            [
              [minLat, minLon],
              [maxLat, maxLon],
            ],
            { padding: [40, 40], animate: true, maxZoom: SUGGESTION_TARGET_ZOOM },
          );
        } else {
          map.setView([suggestion.lat, suggestion.lon], SUGGESTION_TARGET_ZOOM, {
            animate: true,
          });
        }
      }
      setSearchQuery(suggestion.name);
      setLastSearchQuery(suggestion.name);
      setSearchError(null);
      setIsSearchOpen(false);
      setSuggestionsCloseSignal((c) => c + 1);
    },
    [],
  );

  // Click-out: close the suggestions dropdown whenever the user pointerdowns
  // outside both search roots. Both data attributes are checked so the same
  // listener works for mobile (FloatingSearch container) and desktop without
  // false-positive closes when clicking inside either dropdown.
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest("[data-desktop-search-root]") ||
        target.closest("[data-mobile-search-root]")
      ) {
        return;
      }
      setSuggestionsCloseSignal((c) => c + 1);
    };
    window.addEventListener("pointerdown", handlePointerDown, { capture: true });
    return () =>
      window.removeEventListener("pointerdown", handlePointerDown, { capture: true });
  }, []);

  const loadSunlitPlaces = useCallback(
    async (bbox: [number, number, number, number]) => {
      const placesPayload = {
        date,
        timezone: "Europe/Zurich",
        mode,
        localTime,
        startLocalTime: dailyStartLocalTime,
        endLocalTime: dailyEndLocalTime,
        sampleEveryMinutes,
        buildingHeightBiasMeters,
        category: "terrace_candidate" as const,
        outdoorOnly: true,
        includeNonSunny: false,
        ignoreVegetation: ignoreVegetationShadow,
        foodTypes: ["restaurant", "bar", "snack", "foodtruck"] as const,
        bbox,
        limit: 400,
      };

      const placesResponse = await fetch("/api/places/windows", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(placesPayload),
      });
      const placesJson = (await placesResponse.json().catch(() => null)) as
        | {
            error?: string;
            detail?: string;
            warnings?: string[];
            places?: SunlitPlaceEntry[];
          }
        | null;
      if (!placesResponse.ok) {
        throw new Error(
          placesJson?.detail ??
            placesJson?.error ??
            "Failed to compute sunlit terraces.",
        );
      }

      return {
        places: placesJson?.places ?? [],
        warnings: placesJson?.warnings ?? [],
      };
    },
    [
      dailyEndLocalTime,
      dailyStartLocalTime,
      date,
      ignoreVegetationShadow,
      localTime,
      mode,
      buildingHeightBiasMeters,
      sampleEveryMinutes,
    ],
  );

  const runAreaCalculation = useCallback(async (options?: {
    bboxOverride?: [number, number, number, number];
  }) => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (mode === "daily" && isDailyRangeInvalid) {
      setError("Plage horaire daily invalide: la fin doit être après le début.");
      return;
    }

    const bbox: [number, number, number, number] = options?.bboxOverride
      ? [
          Number(options.bboxOverride[0].toFixed(6)),
          Number(options.bboxOverride[1].toFixed(6)),
          Number(options.bboxOverride[2].toFixed(6)),
          Number(options.bboxOverride[3].toFixed(6)),
        ]
      : (() => {
          const bounds = map.getBounds();
          return [
            Number(bounds.getWest().toFixed(6)),
            Number(bounds.getSouth().toFixed(6)),
            Number(bounds.getEast().toFixed(6)),
            Number(bounds.getNorth().toFixed(6)),
          ];
        })();

    if (timelineAbortRef.current) {
      timelineCancelledRef.current = true;
      timelineAbortRef.current.abort();
      timelineAbortRef.current = null;
    }
    if (instantStreamRef.current) {
      instantCancelledRef.current = true;
      instantStreamRef.current.close();
      instantStreamRef.current = null;
    }

    setIsLoading(true);
    setError(null);
    setPlacesWarnings([]);
    setPlacesError(null);
    setSunlitPlaces([]);
    setIsPlacesLoading(true);
    const placesRequestId = placesRequestIdRef.current + 1;
    placesRequestIdRef.current = placesRequestId;
    decodedTimelineMaskCacheRef.current.clear();

    if (mode === "instant") {
      void loadSunlitPlaces(bbox)
        .then((placesResult) => {
          if (placesRequestIdRef.current !== placesRequestId) {
            return;
          }
          setSunlitPlaces(placesResult.places);
          setPlacesWarnings(placesResult.warnings);
        })
        .catch((placesRequestError) => {
          if (placesRequestIdRef.current !== placesRequestId) {
            return;
          }
          setSunlitPlaces([]);
          setPlacesError(
            placesRequestError instanceof Error
              ? placesRequestError.message
              : "Failed to load sunlit terraces.",
          );
        })
        .finally(() => {
          if (placesRequestIdRef.current !== placesRequestId) {
            return;
          }
          setIsPlacesLoading(false);
        });

      setDailyTimeline(null);
      setDailyProgress(null);
      setLastResult(null);
      setInstantProgress({
        phase: "starting",
        done: 0,
        total: 1,
        percent: 0,
        etaSeconds: null,
      });

      let streamFinished = false;
      let streamFailed = false;

      const finalizeIfDone = () => {
        if (streamFinished) {
          setIsLoading(false);
        }
      };

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
      const instantStream = new EventSource(
        `/api/sunlight/instant/stream?${query.toString()}`,
      );
      instantStreamRef.current = instantStream;

      instantStream.addEventListener("start", (event) => {
        if (instantCancelledRef.current) {
          return;
        }
        const data = JSON.parse((event as MessageEvent).data) as InstantStreamStartPayload;
        setLastResult(createEmptyInstantAreaResult(data));
      });

      instantStream.addEventListener("progress", (event) => {
        if (instantCancelledRef.current) {
          return;
        }
        const data = JSON.parse((event as MessageEvent).data) as TimelineProgress;
        setInstantProgress(data);
      });

      instantStream.addEventListener("partial", (event) => {
        if (instantCancelledRef.current) {
          return;
        }
        const data = JSON.parse((event as MessageEvent).data) as InstantStreamPartialPayload;
        setLastResult((previous) => {
          if (!previous || previous.mode !== "instant") {
            return previous;
          }

          const previousPoints = previous.points as AreaInstantPoint[];
          return {
            ...previous,
            pointCount: data.pointCount,
            points: [...previousPoints, ...data.points],
            stats: {
              ...previous.stats,
              indoorPointsExcluded: data.indoorPointsExcluded,
            },
          };
        });
      });

      instantStream.addEventListener("done", (event) => {
        if (instantCancelledRef.current) {
          instantStream.close();
          if (instantStreamRef.current === instantStream) {
            instantStreamRef.current = null;
          }
          setIsLoading(false);
          return;
        }

        const data = JSON.parse((event as MessageEvent).data) as InstantStreamDonePayload;
        setLastResult((previous) => {
          const previousPoints =
            previous && previous.mode === "instant"
              ? (previous.points as AreaInstantPoint[])
              : [];
          const previousWarnings =
            previous && previous.mode === "instant" ? previous.warnings : [];
          return {
            mode: "instant",
            gridStepMeters: data.gridStepMeters,
            pointCount: data.pointCount,
            points: previousPoints,
            model: data.model,
            warnings: Array.from(new Set([...previousWarnings, ...data.warnings])),
            stats: data.stats,
          };
        });
        setInstantProgress((previous) => ({
          phase: "done",
          done: previous?.total ?? data.pointCount,
          total: previous?.total ?? data.pointCount,
          percent: 100,
          etaSeconds: 0,
        }));

        instantStream.close();
        if (instantStreamRef.current === instantStream) {
          instantStreamRef.current = null;
        }
        streamFinished = true;
        finalizeIfDone();
      });

      instantStream.addEventListener("error", (event) => {
        if (instantCancelledRef.current) {
          instantStream.close();
          if (instantStreamRef.current === instantStream) {
            instantStreamRef.current = null;
          }
          setIsLoading(false);
          return;
        }
        if (streamFailed || streamFinished) {
          return;
        }
        streamFailed = true;
        const errorPayload = (() => {
          try {
            return JSON.parse((event as MessageEvent).data) as {
              error?: string;
              details?: string;
            };
          } catch {
            return null;
          }
        })();
        setError(
          errorPayload?.details ?? errorPayload?.error ?? "Instant streaming failed.",
        );
        instantStream.close();
        if (instantStreamRef.current === instantStream) {
          instantStreamRef.current = null;
        }
        streamFinished = true;
        finalizeIfDone();
      });
      return;
    }

    setLastResult(null);
    setInstantProgress(null);
    setDailyTimeline(null);
    setDailyFrameIndex(0);
    setDailyProgress({
      phase: "starting",
      done: 0,
      total: 1,
      percent: 0,
      etaSeconds: null,
    });

    let streamFinished = false;
    let streamFailed = false;

    const finalizeIfDone = () => {
      if (streamFinished) {
        setIsLoading(false);
      }
    };

    const query = new URLSearchParams({
      minLon: String(bbox[0]),
      minLat: String(bbox[1]),
      maxLon: String(bbox[2]),
      maxLat: String(bbox[3]),
      date,
      timezone: "Europe/Zurich",
      startLocalTime: dailyStartLocalTime,
      endLocalTime: dailyEndLocalTime,
      sampleEveryMinutes: String(sampleEveryMinutes),
      gridStepMeters: String(gridStepMeters),
      maxPoints: "2000000",
      buildingHeightBiasMeters: String(buildingHeightBiasMeters),
      ignoreVegetation: String(ignoreVegetationShadow),
      ...(cacheOnly ? { cacheOnly: "true" } : {}),
    });

    timelineCancelledRef.current = false;
    const abortController = new AbortController();
    timelineAbortRef.current = abortController;

    const flushPendingTiles = () => {
      const pending = pendingTilesRef.current;
      if (pending.length === 0) return;
      const pendingStats = pendingStatsRef.current;
      const tilesToFlush = pending.splice(0);
      const statsToFlush = { ...pendingStats };
      pendingStatsRef.current = { gridPointCount: 0, indoorPointsExcluded: 0 };
      decodedTimelineMaskCacheRef.current.clear();
      setDailyTimeline((previous) => {
        if (!previous) return previous;
        const existingIds = new Set(previous.tiles.map((t) => t.tileId));
        const newTiles = tilesToFlush.filter((t) => !existingIds.has(t.tileId));
        if (newTiles.length === 0) return previous;
        const mergedTiles = [...previous.tiles, ...newTiles];
        const allPoints = mergedTiles.flatMap((t) => t.points);
        return {
          ...previous,
          tiles: mergedTiles,
          points: allPoints,
          pointCount: previous.pointCount + statsToFlush.gridPointCount - statsToFlush.indoorPointsExcluded,
          gridPointCount: previous.gridPointCount + statsToFlush.gridPointCount,
          indoorPointsExcluded: previous.indoorPointsExcluded + statsToFlush.indoorPointsExcluded,
        };
      });
      lastTileFlushRef.current = performance.now();
    };

    // Dispatch a parsed SSE event to the appropriate handler
    // Track pending blob decompressions — resolved in parallel, applied before done
    const pendingBlobDecodes: Array<Promise<void>> = [];
    let doneData: { stats: NonNullable<DailyTimelineState["stats"]>; overlayBounds?: { minLat: number; maxLat: number; minLon: number; maxLon: number }; warnings: string[] } | null = null;
    // Captured at `event: start`, read at `event: done` to detect "the server
    // accepted the bbox but couldn't serve a single tile" — i.e. uncovered zones.
    let requestedTileCount = 0;

    const handleSseEvent = (eventType: string, jsonData: string) => {
      if (timelineCancelledRef.current) return;

      if (eventType === "start") {
        const data = JSON.parse(jsonData) as {
          date: string;
          timezone: string;
          startLocalTime: string;
          endLocalTime: string;
          sampleEveryMinutes: number;
          gridStepMeters: number;
          totalTiles: number;
          frameCount: number;
          model?: NonNullable<AreaApiResponse["model"]>;
        };
        decodedTimelineMaskCacheRef.current.clear();
        pendingTilesRef.current = [];
        pendingStatsRef.current = { gridPointCount: 0, indoorPointsExcluded: 0 };
        lastTileFlushRef.current = performance.now();
        setDailyTimeline((previous) => {
          const canMerge =
            previous &&
            previous.date === data.date &&
            previous.gridStepMeters === data.gridStepMeters &&
            previous.tiles.length > 0;
          return {
            date: data.date,
            timezone: data.timezone,
            startLocalTime: data.startLocalTime,
            endLocalTime: data.endLocalTime,
            sampleEveryMinutes: data.sampleEveryMinutes,
            gridStepMeters: data.gridStepMeters,
            pointCount: canMerge ? previous.pointCount : 0,
            gridPointCount: canMerge ? previous.gridPointCount : 0,
            indoorPointsExcluded: canMerge ? previous.indoorPointsExcluded : 0,
            frameCount: data.frameCount,
            tiles: canMerge ? previous.tiles : [],
            points: canMerge ? previous.points : [],
            frames: [],
            model: data.model ?? null,
            warnings: [],
            stats: null,
          };
        });
        setDailyFrameIndex((prev) => prev || 0);

        // Umami analytics — emit one event per compute job *the server actually
        // accepted* (not per fetch attempt: pan/zoom cancels prior fetches via
        // AbortController, so tracking earlier would overcount). Coordinates
        // bucketed to 3 decimals (~110m) to keep dashboard cardinality usable.
        // `basemap` lets us cross-reference compute usage with the active
        // basemap *without* needing every user to interact with the selector.
        requestedTileCount = data.totalTiles;
        if (typeof window !== "undefined" && window.umami) {
          const centerLat = Math.round(((bbox[1] + bbox[3]) / 2) * 1000) / 1000;
          const centerLon = Math.round(((bbox[0] + bbox[2]) / 2) * 1000) / 1000;
          window.umami.track("compute-start", {
            centerLat,
            centerLon,
            tilesRequested: data.totalTiles,
            basemap: baseMapStyleRef.current,
          });
        }
      } else if (eventType === "tile") {
        const data = JSON.parse(jsonData) as {
          tileId: string;
          tileIndex: number;
          totalTiles: number;
          pointCount: number;
          gridPointCount: number;
          indoorPointsExcluded: number;
          grid?: TileGrid;
          masksEncoding?: string;
          masksBase64?: string;
          outdoorMaskBase64?: string;
          tileBounds?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
          tileCorners?: { nw: LatLon; ne: LatLon; sw: LatLon; se: LatLon };
          points?: Array<{ id: string; lat?: number; lon?: number }>;
          frames: TimelineFrame[];
        };

        // Push tile immediately; decompress blob in parallel
        const tileEntry: TimelineTile = {
          tileId: data.tileId,
          grid: data.grid,
          outdoorMaskBase64: data.outdoorMaskBase64,
          tileBounds: data.tileBounds,
          tileCorners: data.tileCorners,
          points: (data.points ?? []) as TimelinePoint[],
          frames: data.frames,
        };
        if (data.masksEncoding === "gzip-concat-v1" && data.masksBase64 && data.grid) {
          const blob = data.masksBase64;
          const maskBytes = Math.ceil(data.grid.width * data.grid.height / 8);
          const frameCount = data.frames.length;
          pendingBlobDecodes.push(
            decodeTileMasksBlob(blob, maskBytes, frameCount).then((decoded) => {
              tileEntry.decodedMasks = decoded;
            }),
          );
        }
        pendingTilesRef.current.push(tileEntry);
        pendingStatsRef.current.gridPointCount += data.gridPointCount;
        pendingStatsRef.current.indoorPointsExcluded += data.indoorPointsExcluded;
        // Per-tile progress update — the SSE backend only emits `event: progress`
        // for indeterminate phases (loading-cache etc.). Once tiles start
        // streaming there's no explicit progress event, so the slider would
        // jump 0 → 100 % at `event: done`. Compute progress from tileIndex /
        // totalTiles directly so the slider fill advances smoothly.
        if (typeof data.totalTiles === "number" && data.totalTiles > 0) {
          const doneCount = data.tileIndex + 1;
          const tileFraction = Math.min(1, doneCount / data.totalTiles);
          setDailyProgress((previous) => ({
            phase: "computing",
            done: doneCount,
            total: data.totalTiles,
            percent: tileFraction * 100,
            tileIndex: doneCount,
            totalTiles: data.totalTiles,
            etaSeconds: previous?.etaSeconds ?? null,
            elapsedMs: previous?.elapsedMs,
          }));
        }
        const msSinceFlush = performance.now() - lastTileFlushRef.current;
        if (msSinceFlush > 3000 || pendingTilesRef.current.length >= 5) {
          flushPendingTiles();
        }
      } else if (eventType === "places") {
        const data = JSON.parse(jsonData) as {
          tileId: string;
          count: number;
          places: SunlitPlaceEntry[];
          warnings?: string[];
        };
        setSunlitPlaces((previous) => {
          const byId = new Map(previous.map((place) => [place.id, place]));
          for (const place of data.places) {
            const existing = byId.get(place.id);
            if (!existing || place.sunnyMinutes > existing.sunnyMinutes) {
              byId.set(place.id, place);
            }
          }
          return Array.from(byId.values()).sort((left, right) => {
            if (right.sunnyMinutes !== left.sunnyMinutes) {
              return right.sunnyMinutes - left.sunnyMinutes;
            }
            return left.name.localeCompare(right.name);
          });
        });
        if (data.warnings?.length) {
          setPlacesWarnings((previous) =>
            Array.from(new Set([...previous, ...(data.warnings ?? [])])),
          );
        }
      } else if (eventType === "progress") {
        const data = JSON.parse(jsonData) as TimelineProgress;
        setDailyProgress(data);
      } else if (eventType === "done") {
        // Store done data — actual finalization happens in runFetchStream
        // after all blob decompressions complete.
        const parsed = JSON.parse(jsonData) as {
          stats: NonNullable<DailyTimelineState["stats"]> & {
            tilesFromCache?: number;
            tilesComputed?: number;
          };
          overlayBounds?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
          warnings: string[];
        };
        doneData = parsed;

        // Umami analytics — track requests where the server accepted a non-empty
        // bbox but couldn't serve a single tile. With cacheOnly=true on Mitch
        // this is the canonical signal that the user asked about a zone we
        // haven't precomputed yet — the most actionable input for picking
        // which region to ingest next.
        const tilesFromCache = parsed.stats.tilesFromCache ?? 0;
        const tilesComputed = parsed.stats.tilesComputed ?? 0;
        if (
          typeof window !== "undefined" &&
          window.umami &&
          requestedTileCount > 0 &&
          tilesFromCache === 0 &&
          tilesComputed === 0
        ) {
          const centerLat = Math.round(((bbox[1] + bbox[3]) / 2) * 1000) / 1000;
          const centerLon = Math.round(((bbox[0] + bbox[2]) / 2) * 1000) / 1000;
          window.umami.track("unchartered-territory", {
            centerLat,
            centerLon,
            tilesRequested: requestedTileCount,
          });
        }
      } else if (eventType === "error") {
        streamFailed = true;
        const errorPayload = (() => {
          try {
            return JSON.parse(jsonData) as { error?: string; details?: string };
          } catch {
            return null;
          }
        })();
        setError(
          errorPayload?.details ?? errorPayload?.error ?? "Timeline streaming failed.",
        );
        setIsPlacesLoading(false);
        timelineAbortRef.current = null;
        streamFinished = true;
        finalizeIfDone();
      }
    };

    // fetch + ReadableStream: gzip-decompressed natively by the browser,
    // then we parse SSE events manually — much faster than EventSource for large payloads.
    const runFetchStream = async () => {
      try {
        const response = await fetch(
          `/api/sunlight/timeline/stream?${query.toString()}`,
          { signal: abortController.signal },
        );
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events: "event: <type>\ndata: <json>\n\n"
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let eventType = "message";
            let dataLine = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7);
              } else if (line.startsWith("data: ")) {
                dataLine = line.slice(6);
              }
            }
            if (dataLine) {
              handleSseEvent(eventType, dataLine);
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
        // Wait for all blob decompressions to complete
        if (pendingBlobDecodes.length > 0) {
          await Promise.all(pendingBlobDecodes);
        }

        // Now finalize with decoded masks available
        if (doneData && !streamFinished && !streamFailed) {
          const pendingToFlush = pendingTilesRef.current.splice(0);
          const pendingStatsToFlush = { ...pendingStatsRef.current };
          pendingStatsRef.current = { gridPointCount: 0, indoorPointsExcluded: 0 };
          decodedTimelineMaskCacheRef.current.clear();
          const data = doneData;
          setDailyTimeline((previous) => {
            if (!previous) return previous;
            const existingIds = new Set(previous.tiles.map((t) => t.tileId));
            const newTiles = pendingToFlush.filter((t) => !existingIds.has(t.tileId));
            const mergedTiles = newTiles.length > 0 ? [...previous.tiles, ...newTiles] : previous.tiles;
            const allPoints = newTiles.length > 0 ? mergedTiles.flatMap((t) => t.points) : previous.points;
            return {
              ...previous,
              tiles: mergedTiles,
              points: allPoints,
              pointCount: previous.pointCount + pendingStatsToFlush.gridPointCount - pendingStatsToFlush.indoorPointsExcluded,
              gridPointCount: previous.gridPointCount + pendingStatsToFlush.gridPointCount,
              indoorPointsExcluded: previous.indoorPointsExcluded + pendingStatsToFlush.indoorPointsExcluded,
              stats: data.stats,
              overlayBounds: data.overlayBounds ?? previous.overlayBounds,
              warnings: Array.from(new Set([...previous.warnings, ...data.warnings])),
            };
          });
          setDailyProgress({
            phase: "done",
            done: data.stats.totalEvaluations,
            total: data.stats.totalEvaluations,
            percent: 100,
            etaSeconds: 0,
            elapsedMs: data.stats.elapsedMs,
          });
          setIsPlacesLoading(false);
          timelineAbortRef.current = null;
          streamFinished = true;
          finalizeIfDone();
        } else if (!streamFinished && !streamFailed) {
          setIsPlacesLoading(false);
          streamFinished = true;
          finalizeIfDone();
        }
      } catch (err) {
        if (abortController.signal.aborted) return;
        if (!streamFailed && !streamFinished) {
          streamFailed = true;
          setError(err instanceof Error ? err.message : "Timeline streaming failed.");
          setIsPlacesLoading(false);
          streamFinished = true;
          finalizeIfDone();
        }
      } finally {
        if (timelineAbortRef.current === abortController) {
          timelineAbortRef.current = null;
        }
      }
    };

    void runFetchStream();
  }, [
    buildingHeightBiasMeters,
    cacheOnly,
    date,
    dailyEndLocalTime,
    dailyStartLocalTime,
    gridStepMeters,
    ignoreVegetationShadow,
    isDailyRangeInvalid,
    loadSunlitPlaces,
    localTime,
    mode,
    sampleEveryMinutes,
  ]);

  useEffect(() => {
    if (!focusRunOverlay || !isMapReady) {
      return;
    }

    if (focusRunAutoAppliedTokenRef.current === focusRunOverlay.token) {
      return;
    }

    const map = mapRef.current;
    if (!map) {
      return;
    }

    map.fitBounds(
      [
        [focusRunOverlay.bbox.minLat, focusRunOverlay.bbox.minLon],
        [focusRunOverlay.bbox.maxLat, focusRunOverlay.bbox.maxLon],
      ],
      { padding: [28, 28], animate: false },
    );
    focusRunAutoAppliedTokenRef.current = focusRunOverlay.token;
    void runAreaCalculation();
  }, [focusRunOverlay, isMapReady, runAreaCalculation]);

  useEffect(() => {
    if (!isMapReady || !uiParamsHydrated) {
      return;
    }
    if (!deepLinkParamsFromUrl || !activeDeepLinkToken) {
      return;
    }
    if (activeFocusRunParams) {
      return;
    }
    if (deepLinkMapAppliedTokenRef.current === activeDeepLinkToken) {
      return;
    }

    const map = mapRef.current;
    if (!map) {
      return;
    }

    const mapParams = deepLinkParamsFromUrl.map;
    if (mapParams?.bbox) {
      map.fitBounds(
        [
          [mapParams.bbox.minLat, mapParams.bbox.minLon],
          [mapParams.bbox.maxLat, mapParams.bbox.maxLon],
        ],
        { padding: [28, 28], animate: false },
      );
      if (typeof mapParams.zoom === "number") {
        map.setZoom(mapParams.zoom, { animate: false });
      }
    } else if (mapParams?.center) {
      map.setView(
        [mapParams.center.lat, mapParams.center.lon],
        mapParams.zoom ?? map.getZoom(),
        { animate: false },
      );
    } else if (typeof mapParams?.zoom === "number") {
      map.setZoom(mapParams.zoom, { animate: false });
    }

    deepLinkMapAppliedTokenRef.current = activeDeepLinkToken;
    if (deepLinkParamsFromUrl.autoRun) {
      const bboxOverride = mapParams?.bbox
        ? ([
            mapParams.bbox.minLon,
            mapParams.bbox.minLat,
            mapParams.bbox.maxLon,
            mapParams.bbox.maxLat,
          ] as [number, number, number, number])
        : undefined;
      void runAreaCalculation({ bboxOverride });
    }
  }, [
    activeDeepLinkToken,
    activeFocusRunParams,
    deepLinkParamsFromUrl,
    isMapReady,
    runAreaCalculation,
    uiParamsHydrated,
  ]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      mapRef.current?.invalidateSize({ animate: false });
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [bottomSheetState, isMobileBarsOpen]);

  // Compute progress for the slider fill — null = indeterminate, undefined = idle.
  // Daily run uses tile-arrival progress (incremental). Phases without a known
  // tile total ⇒ null (animated stripe).
  const timelineComputeProgress: number | null | undefined =
    mode === "daily" && dailyProgress
      ? dailyProgress.phase === "loading-cache" ||
        dailyProgress.phase === "loading-scene" ||
        dailyProgress.phase === "reconnecting"
        ? null
        : Math.max(0, Math.min(100, dailyProgress.percent))
      : undefined;

  const timelineControl = (
    <TimeSlider
      mode={mode}
      activeFrameTime={activeFrameTime}
      frameCount={dailyTimeline?.frameCount ?? 0}
      frameIndex={dailyFrameIndex}
      disabled={!dailyTimeline || dailyTimeline.tiles.length === 0}
      onFrameIndexChange={setDailyFrameIndex}
      computeProgress={timelineComputeProgress}
    />
  );

  const calculationControls = (
    <CalculationControls
      mode={mode}
      date={date}
      isLoading={isLoading}
      isDailyRangeInvalid={isDailyRangeInvalid}
      onDateChange={setDate}
      onRunCalculation={() => void runAreaCalculation()}
      onCancelDailyCalculation={cancelDailyCalculation}
    />
  );

  const overlayMode: OverlayMode =
    showHeatmap && !showSunny && !showShadow ? "heatmap" : "sunlight";

  const layerFilters = (
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
          setShowSunny(false);
          setShowShadow(false);
          setShowHeatmap(true);
        } else {
          setShowSunny(true);
          setShowShadow(true);
          setShowHeatmap(false);
        }
      }}
      onShowTerrainChange={setShowTerrain}
      onShowPlacesChange={setShowPlaces}
      onIgnoreVegetationShadowChange={setIgnoreVegetationShadow}
      onCacheOnlyChange={setCacheOnly}
    />
  );

  const progressStatus = (
    <ProgressStatus
      mode={mode}
      dailyProgress={dailyProgress}
      instantProgress={instantProgress}
      formatDuration={formatDuration}
    />
  );

  const coveragePanel = (
    <DailyCoverage
      focusRunMessage={focusRunMessage}
      focusRunMessageIsError={focusRunMessageIsError}
      error={error}
      warnings={activeWarnings}
      placesError={placesError}
    />
  );

  const desktopSearch = (
    <div className="relative z-[720] hidden lg:inline-block" data-desktop-search-root>
      <form
        className="flex items-center gap-2 rounded-full border border-white/70 bg-white/88 p-2 text-slate-900 shadow-xl backdrop-blur"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmitSearch();
        }}
      >
        <input
          className="w-72 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-amber-300"
          value={searchQuery}
          placeholder="Chercher une adresse ou un lieu"
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        <button
          type="submit"
          className="rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:bg-slate-300 disabled:text-slate-500"
          disabled={isSearchLoading || searchQuery.trim().length === 0}
        >
          {isSearchLoading ? "..." : "OK"}
        </button>
      </form>
      <PlaceSuggestionsDropdown
        query={searchQuery}
        onSelect={handleSelectSuggestion}
        variant="inline"
        closeSignal={suggestionsCloseSignal}
      />
    </div>
  );


  return (
    <section className="relative h-dvh max-h-dvh overflow-hidden bg-slate-950 text-white">
      <div ref={mapContainerRef} className="absolute inset-0 z-0 h-full w-full" />

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
      {/* Mobile suggestions dropdown — only when FloatingSearch is open. */}
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
      <div className="absolute left-5 top-5 z-[700] hidden items-center gap-3 lg:flex">
        <div className="rounded-full border border-white/70 bg-white/88 px-4 py-2 text-sm font-semibold text-slate-900 shadow-xl backdrop-blur">
          Mappy Hour
        </div>
      </div>
      <div className="absolute left-1/2 top-5 z-[700] hidden -translate-x-1/2 lg:block">
        {desktopSearch}
      </div>

      <div
        className={`absolute left-5 top-20 z-[460] hidden w-[360px] grid-rows-[auto_1fr] gap-4 overflow-hidden rounded-3xl border border-white/70 bg-white/90 p-4 text-slate-900 shadow-2xl backdrop-blur transition-[height,width] duration-300 ease-out lg:grid ${
          activeDesktopTab === "terraces"
            ? "h-[calc(100dvh-104px)]"
            : "h-[min(560px,calc(100dvh-104px))]"
        }`}
      >
        <ViewTabs
          activeTab={activeDesktopTab}
          venueCount={sunlitPlaces.length}
          onTabChange={(tab) => {
            setActiveDesktopTab(tab);
            if (tab === "terraces") {
              setShowPlaces(true);
            }
          }}
        />
        <div className="relative min-h-0 overflow-hidden">
          {activeDesktopTab === "map" ? (
            <div
              key="desktop-map-tab"
              className="desktop-tab-panel grid gap-4 overflow-y-auto pr-1"
            >
              {calculationControls}
              {layerFilters}
              {timelineControl}
              {progressStatus}
              {coveragePanel}
            </div>
          ) : (
            <div
              key="desktop-terraces-tab"
              className="desktop-tab-panel grid h-full min-h-0 grid-rows-[auto_1fr] gap-3"
            >
              <div className="rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3">
                <p className="text-sm font-semibold">Terrasses au soleil</p>
                <p className="text-xs text-slate-500">
                  {isPlacesLoading
                    ? "Calcul des terrasses en cours..."
                    : `${sunlitPlaces.length} établissements visibles`}
                </p>
              </div>
              <div className="min-h-0 overflow-y-auto pr-1">
                <BarsList
                  places={sunlitPlaces}
                  isLoading={isPlacesLoading}
                  mode={mode}
                  localTime={localTime}
                  selectedVenueId={selectedVenueId}
                  onSelectVenue={handleSelectVenue}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="lg:hidden">
        <MobileBottomSheet
          state={bottomSheetState}
          venueCount={sunlitPlaces.length}
          timeline={timelineControl}
          controls={
            <div className="grid gap-3">
              {calculationControls}
              {progressStatus}
            </div>
          }
          filters={layerFilters}
          coverage={coveragePanel}
          onStateChange={setBottomSheetState}
          onOpenBars={() => setIsMobileBarsOpen(true)}
        />
      </div>

      {selectedViewportPlace ? (
        <div className="vpo-card" role="dialog" aria-label="Détails du lieu">
          <div className="flex items-start justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <p className="truncate text-sm font-semibold text-slate-900">
                {viewportCardEmoji(selectedViewportPlace)} {selectedViewportPlace.name}
              </p>
              <p className="text-xs text-slate-500">
                {selectedViewportPlace.subcategory || selectedViewportPlace.category}
              </p>
            </div>
            <button
              type="button"
              className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              onClick={() => setSelectedViewportPlace(null)}
              aria-label="Fermer"
            >
              ×
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                selectedViewportPlace.hasOutdoorSeating
                  ? "bg-amber-100 text-amber-900 ring-amber-200"
                  : selectedViewportPlace.hasOutdoorSeatingUnknown
                    ? "bg-slate-100 text-slate-600 ring-slate-200"
                    : "bg-rose-100 text-rose-700 ring-rose-200"
              }`}
            >
              {selectedViewportPlace.hasOutdoorSeating
                ? "Terrasse ✓"
                : selectedViewportPlace.hasOutdoorSeatingUnknown
                  ? "Terrasse ?"
                  : "Pas de terrasse"}
            </span>
          </div>
          <a
            className="mt-3 inline-block text-xs font-semibold text-amber-700 hover:text-amber-900"
            href={`https://www.openstreetmap.org/${selectedViewportPlace.osmType}/${selectedViewportPlace.osmId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Voir sur OpenStreetMap →
          </a>
        </div>
      ) : null}

      <MobileBarsView
        open={isMobileBarsOpen}
        places={sunlitPlaces}
        isLoading={isPlacesLoading}
        mode={mode}
        localTime={localTime}
        selectedVenueId={selectedVenueId}
        onClose={() => setIsMobileBarsOpen(false)}
        onSelectVenue={handleSelectVenue}
      />
    </section>
  );
}

