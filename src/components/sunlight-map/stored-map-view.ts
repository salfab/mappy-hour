/**
 * localStorage persistence helpers for the homepage map view + UI params.
 *
 * Extracted from `sunlight-map-client.tsx` as part of the engine-swap prep
 * (Leaflet → MapLibre). Pure functions, no Leaflet/MapLibre coupling.
 */

import { isBaseMapStyle, type BaseMapStyle, type AreaMode } from "./types";

const MAP_VIEW_STORAGE_KEY = "mappy-hour:map:view";
const UI_PARAMS_STORAGE_KEY = "mappy-hour:ui:params";

export const MAP_MAX_ZOOM = 23;

export interface StoredMapView {
  lat: number;
  lon: number;
  zoom: number;
}

export interface StoredUiParams {
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

export function loadStoredMapView(): StoredMapView | null {
  try {
    const raw = globalThis.localStorage.getItem(MAP_VIEW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredMapView>;
    const { lat, lon, zoom } = parsed;
    if (
      typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180 ||
      typeof zoom !== "number" || !Number.isFinite(zoom) || zoom < 0 || zoom > MAP_MAX_ZOOM
    ) {
      return null;
    }
    return { lat, lon, zoom };
  } catch {
    return null;
  }
}

export function persistMapView(view: StoredMapView): void {
  try {
    globalThis.localStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Ignore storage errors to avoid blocking map interactions.
  }
}

export function loadStoredUiParams(): StoredUiParams | null {
  try {
    const raw = globalThis.localStorage.getItem(UI_PARAMS_STORAGE_KEY);
    if (!raw) return null;

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
    if (!valid) return null;

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

export function persistUiParams(params: StoredUiParams): void {
  try {
    globalThis.localStorage.setItem(UI_PARAMS_STORAGE_KEY, JSON.stringify(params));
  } catch {
    // Ignore storage errors.
  }
}
