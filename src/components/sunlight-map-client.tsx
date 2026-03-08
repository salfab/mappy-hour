"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import polygonClipping from "polygon-clipping";
import type {
  LayerGroup,
  LeafletMouseEvent,
  Map as LeafletMap,
} from "leaflet";

type AreaMode = "instant" | "daily";

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

interface BuildingPolygon {
  id: string;
  footprint: Array<{
    lat: number;
    lon: number;
  }>;
}

interface BuildingsAreaApiResponse {
  count: number;
  buildings: BuildingPolygon[];
  warnings: string[];
  stats: {
    elapsedMs: number;
    rawIntersectingCount: number;
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
  points: TimelinePoint[];
  frames: TimelineFrame[];
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

interface TimelineProgress {
  phase: string;
  done: number;
  total: number;
  percent: number;
  etaSeconds: number | null;
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
const MAP_VIEW_STORAGE_KEY = "mappy-hour:map:view";
const UI_PARAMS_STORAGE_KEY = "mappy-hour:ui:params";
type XY = [number, number];
type Ring = XY[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

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
      !Number.isFinite(zoom)
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
    return { primary: "aucune (point ensoleille)", secondary: [] };
  }

  const causes = new Set<string>();
  if (!input.aboveAstronomicalHorizon) {
    causes.add("courbure de la terre");
  }
  if (input.terrainBlocked) {
    causes.add(input.terrainSource ?? "terrain/horizon");
  }
  if (input.vegetationBlocked) {
    causes.add("vegetation");
  }
  if (input.buildingsBlocked) {
    causes.add("batiment");
  }

  const priority = [
    "courbure de la terre",
    "montagnes",
    "DEM local (colline du terrain de la ville)",
    "terrain/horizon",
    "vegetation",
    "batiment",
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
  const match = /^r(\d+)c(\d+)$/.exec(id);
  if (!match) {
    return null;
  }

  const row = Number(match[1]);
  const col = Number(match[2]);
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    return null;
  }

  return { row, col };
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

function subtractPolygons(base: MultiPolygon, mask: MultiPolygon): MultiPolygon {
  if (base.length === 0 || mask.length === 0) {
    return base;
  }

  try {
    const difference = polygonClipping.difference(base, mask);
    return Array.isArray(difference) ? (difference as MultiPolygon) : [];
  } catch {
    // Keep base as fallback instead of crashing rendering.
    return base;
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

function buildBuildingsContours(buildings: BuildingsAreaApiResponse | null): MultiPolygon {
  if (!buildings || buildings.buildings.length === 0) {
    return [];
  }

  const polygons: Polygon[] = [];
  for (const building of buildings.buildings) {
    if (building.footprint.length < 3) {
      continue;
    }
    polygons.push([
      closeRing(
        building.footprint.map((vertex) => [vertex.lon, vertex.lat] as XY),
      ),
    ]);
  }

  return mergePolygons(polygons);
}

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
  if (timeline.frames.length === 0 || timeline.points.length === 0) {
    return null;
  }

  const safeIndex = Math.max(0, Math.min(frameIndex, timeline.frames.length - 1));
  const frame = timeline.frames[safeIndex];
  const cacheKey = timelineMaskCacheKey(frame.index, ignoreVegetation);
  let mask = decodedMaskCache.get(cacheKey);
  if (!mask) {
    mask = decodeBase64ToBytes(selectTimelineMaskBase64(frame, ignoreVegetation));
    decodedMaskCache.set(cacheKey, mask);
  }

  const points: AreaInstantPoint[] = timeline.points.map((point, index) => {
    const isSunny = ((mask[index >> 3] >> (index & 7)) & 1) === 1;
    return {
      id: point.id,
      lat: point.lat,
      lon: point.lon,
      isSunny,
      terrainBlocked: false,
      buildingsBlocked: false,
      vegetationBlocked: false,
      altitudeDeg: 0,
      azimuthDeg: 0,
      pointElevationMeters: null,
    };
  });

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
  if (timeline.points.length === 0 || timeline.frames.length === 0) {
    return [];
  }

  const sunnyFrames = new Uint16Array(timeline.points.length);
  for (const frame of timeline.frames) {
    const cacheKey = timelineMaskCacheKey(frame.index, ignoreVegetation);
    let mask = decodedMaskCache.get(cacheKey);
    if (!mask) {
      mask = decodeBase64ToBytes(selectTimelineMaskBase64(frame, ignoreVegetation));
      decodedMaskCache.set(cacheKey, mask);
    }
    for (let pointIndex = 0; pointIndex < timeline.points.length; pointIndex += 1) {
      if (((mask[pointIndex >> 3] >> (pointIndex & 7)) & 1) === 1) {
        sunnyFrames[pointIndex] += 1;
      }
    }
  }

  return timeline.points.map((point, index) => {
    const totalFrames = timeline.frames.length;
    const pointSunnyFrames = sunnyFrames[index] ?? 0;
    return {
      id: point.id,
      lat: point.lat,
      lon: point.lon,
      sunnyFrames: pointSunnyFrames,
      totalFrames,
      exposureRatio: totalFrames === 0 ? 0 : pointSunnyFrames / totalFrames,
    };
  });
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

function venueTypeColor(venueType: FoodVenueType): string {
  switch (venueType) {
    case "restaurant":
      return "#dc2626";
    case "bar":
      return "#0f766e";
    case "snack":
      return "#ea580c";
    case "foodtruck":
      return "#0891b2";
    default:
      return "#475569";
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

export function SunlightMapClient() {
  const defaultNow = useMemo(() => zurichNowDateAndTime(), []);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const instantStreamRef = useRef<EventSource | null>(null);
  const instantCancelledRef = useRef(false);
  const timelineStreamRef = useRef<EventSource | null>(null);
  const timelineCancelledRef = useRef(false);
  const decodedTimelineMaskCacheRef = useRef<Map<string, Uint8Array>>(new Map());
  const ignoreVegetationShadowRef = useRef(false);
  const sunnyLayerRef = useRef<LayerGroup | null>(null);
  const shadowLayerRef = useRef<LayerGroup | null>(null);
  const vegetationLayerRef = useRef<LayerGroup | null>(null);
  const buildingsLayerRef = useRef<LayerGroup | null>(null);
  const terrainLayerRef = useRef<LayerGroup | null>(null);
  const heatmapLayerRef = useRef<LayerGroup | null>(null);
  const placesLayerRef = useRef<LayerGroup | null>(null);
  const leafletModuleRef = useRef<typeof import("leaflet") | null>(null);
  const placesRequestIdRef = useRef(0);
  const clickDebugParamsRef = useRef<{
    mode: AreaMode;
    date: string;
    localTime: string;
    activeFrameTime: string | null;
    sampleEveryMinutes: number;
  }>({
    mode: "instant",
    date: defaultNow.date,
    localTime: defaultNow.time,
    activeFrameTime: null,
    sampleEveryMinutes: 15,
  });

  const [mode, setMode] = useState<AreaMode>("instant");
  const [date, setDate] = useState(defaultNow.date);
  const [localTime, setLocalTime] = useState(defaultNow.time);
  const [dailyStartLocalTime, setDailyStartLocalTime] = useState("06:00");
  const [dailyEndLocalTime, setDailyEndLocalTime] = useState("21:00");
  const [gridStepMeters, setGridStepMeters] = useState(200);
  const [sampleEveryMinutes, setSampleEveryMinutes] = useState(15);
  const [ignoreVegetationShadow, setIgnoreVegetationShadow] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<AreaApiResponse | null>(null);
  const [lastBuildings, setLastBuildings] = useState<BuildingsAreaApiResponse | null>(
    null,
  );
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
  const [buildingWarnings, setBuildingWarnings] = useState<string[]>([]);
  const [showSunny, setShowSunny] = useState(true);
  const [showShadow, setShowShadow] = useState(true);
  const [showVegetation, setShowVegetation] = useState(true);
  const [showBuildings, setShowBuildings] = useState(true);
  const [showTerrain, setShowTerrain] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showPlaces, setShowPlaces] = useState(true);
  const [uiParamsHydrated, setUiParamsHydrated] = useState(false);

  const visualAreaResponse = useMemo(() => {
    if (mode === "daily" && dailyTimeline) {
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
      dailyTimeline.frames.length === 0
    ) {
      return null;
    }

    return buildDailyExposurePoints(
      dailyTimeline,
      decodedTimelineMaskCacheRef.current,
      ignoreVegetationShadow,
    );
  }, [dailyTimeline, ignoreVegetationShadow, mode]);

  const dailyExposureHotspot = useMemo(() => {
    if (!dailyExposurePoints || dailyExposurePoints.length === 0) {
      return null;
    }

    return dailyExposurePoints.reduce((best, current) =>
      current.exposureRatio > best.exposureRatio ? current : best,
    );
  }, [dailyExposurePoints]);

  const dailyExposureCells = useMemo(() => {
    if (!dailyExposurePoints || !dailyTimeline) {
      return null;
    }
    return buildDailyExposureCells(dailyExposurePoints, dailyTimeline.gridStepMeters);
  }, [dailyExposurePoints, dailyTimeline]);

  const activeWarnings = useMemo(() => {
    if (mode === "daily" && dailyTimeline) {
      return Array.from(
        new Set([...dailyTimeline.warnings, ...buildingWarnings, ...placesWarnings]),
      );
    }

    return Array.from(
      new Set([...(lastResult?.warnings ?? []), ...buildingWarnings, ...placesWarnings]),
    );
  }, [buildingWarnings, dailyTimeline, lastResult, mode, placesWarnings]);

  const activeFrameTime = useMemo(() => {
    if (!dailyTimeline || dailyTimeline.frames.length === 0) {
      return null;
    }

    const safeIndex = Math.max(
      0,
      Math.min(dailyFrameIndex, dailyTimeline.frames.length - 1),
    );
    return dailyTimeline.frames[safeIndex]?.localTime ?? null;
  }, [dailyFrameIndex, dailyTimeline]);

  const canShowHeatmap = useMemo(
    () =>
      mode === "daily" &&
      Boolean(dailyTimeline?.stats) &&
      Boolean(dailyExposureCells && dailyExposureCells.length > 0),
    [dailyExposureCells, dailyTimeline?.stats, mode],
  );

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

  const helperText = useMemo(() => {
    if (mode === "daily" && dailyTimeline) {
      const stats = dailyTimeline.stats;
      const base = `${dailyTimeline.pointCount} points, frames: ${dailyTimeline.frames.length}/${dailyTimeline.frameCount}, plage: ${dailyTimeline.startLocalTime}-${dailyTimeline.endLocalTime}, indoor exclus: ${dailyTimeline.indoorPointsExcluded}, terrasses soleil: ${sunlitPlaces.length}`;
      if (!stats) {
        return `${base}, calcul timeline en cours...`;
      }

      if (!dailyExposureHotspot) {
        return `${base}, ${stats.elapsedMs} ms, evaluations: ${stats.totalEvaluations}`;
      }

      const exposurePercent = Math.round(dailyExposureHotspot.exposureRatio * 100);
      return `${base}, ${stats.elapsedMs} ms, evaluations: ${stats.totalEvaluations}, hotspot: ${exposurePercent}% (${dailyExposureHotspot.lat.toFixed(5)}, ${dailyExposureHotspot.lon.toFixed(5)})`;
    }

    if (!lastResult) {
      return "Aucun calcul encore lance.";
    }
    const warningCount = Array.from(
      new Set([...(lastResult.warnings ?? []), ...buildingWarnings, ...placesWarnings]),
    ).length;
    const excludedIndoor = lastResult.stats.indoorPointsExcluded ?? 0;
    const buildingCount = lastBuildings?.count ?? 0;
    return `${lastResult.pointCount} points, ${lastResult.stats.elapsedMs} ms, indoor exclus: ${excludedIndoor}, batiments: ${buildingCount}, terrasses soleil: ${sunlitPlaces.length}, warnings: ${warningCount}`;
  }, [
    buildingWarnings,
    dailyExposureHotspot,
    dailyTimeline,
    lastBuildings?.count,
    lastResult,
    mode,
    placesWarnings,
    sunlitPlaces.length,
  ]);

  useEffect(() => {
    clickDebugParamsRef.current = {
      mode,
      date,
      localTime,
      activeFrameTime,
      sampleEveryMinutes,
    };
  }, [activeFrameTime, date, localTime, mode, sampleEveryMinutes]);

  useEffect(() => {
    ignoreVegetationShadowRef.current = ignoreVegetationShadow;
  }, [ignoreVegetationShadow]);

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

    console.groupCollapsed(
      `[Mappy Hour][click] lat=${payload.lat.toFixed(6)} lon=${payload.lon.toFixed(6)} ` +
        `-> ${primarySourceEffective}`,
    );
    console.log("Cause principale (mode brut):", primarySourceRaw);
    if (secondarySourcesRaw.length > 0) {
      console.log("Causes secondaires (mode brut):", secondarySourcesRaw.join(", "));
    }
    console.log(
      "Cause principale (avec toggle UI ignore vegetation =",
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
    console.log("Coordonnees LV95:", {
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
    if (json.warnings.length > 0) {
      console.warn("Warnings:", json.warnings);
    }
    console.groupEnd();
  }, []);

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
      setIgnoreVegetationShadow(stored.ignoreVegetationShadow);
      setShowSunny(stored.showSunny);
      setShowShadow(stored.showShadow);
      setShowVegetation(stored.showVegetation);
      setShowBuildings(stored.showBuildings);
      setShowTerrain(stored.showTerrain);
      setShowHeatmap(stored.showHeatmap);
      setShowPlaces(stored.showPlaces);
    }
    setUiParamsHydrated(true);
  }, []);

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
    ignoreVegetationShadow,
    showBuildings,
    showShadow,
    showSunny,
    showVegetation,
    showTerrain,
    showHeatmap,
    showPlaces,
    uiParamsHydrated,
  ]);

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
        zoomControl: true,
      }).setView(
        storedView
          ? [storedView.lat, storedView.lon]
          : DEFAULT_MAP_CENTER,
        storedView?.zoom ?? DEFAULT_MAP_ZOOM,
      );

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);

      sunnyLayerRef.current = L.layerGroup().addTo(map);
      shadowLayerRef.current = L.layerGroup().addTo(map);
      vegetationLayerRef.current = L.layerGroup().addTo(map);
      buildingsLayerRef.current = L.layerGroup().addTo(map);
      terrainLayerRef.current = L.layerGroup().addTo(map);
      heatmapLayerRef.current = L.layerGroup().addTo(map);
      placesLayerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;

      map.on("click", (event: LeafletMouseEvent) => {
        const message = `Lat ${event.latlng.lat.toFixed(5)}, Lon ${event.latlng.lng.toFixed(5)}`;
        map.attributionControl.setPrefix(`Mappy Hour - ${message}`);
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
      });
    };

    void initMap();

    return () => {
      isCancelled = true;
      if (instantStreamRef.current) {
        instantCancelledRef.current = true;
        instantStreamRef.current.close();
        instantStreamRef.current = null;
      }
      if (timelineStreamRef.current) {
        timelineCancelledRef.current = true;
        timelineStreamRef.current.close();
        timelineStreamRef.current = null;
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
      heatmapLayerRef.current = null;
      placesLayerRef.current = null;
      leafletModuleRef.current = null;
    };
  }, [runPointClickDiagnostics]);

  const renderLayers = useCallback(
    (
      response: AreaApiResponse | null,
      buildings: BuildingsAreaApiResponse | null,
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

      const { sunnyContours, shadowContours } = response
        ? buildSunAndShadowContours(response)
        : { sunnyContours: [], shadowContours: [] };
      const buildingsContours = buildBuildingsContours(buildings);
      const sunnyOutdoorContours = subtractPolygons(sunnyContours, buildingsContours);
      const shadowOutdoorContours = subtractPolygons(shadowContours, buildingsContours);
      const vegetationContours = visibility.ignoreVegetationShadow
        ? []
        : buildInstantBlockedContours(
            response,
            (point) => point.vegetationBlocked === true,
          );

      if (visibility.sunny) {
        for (const polygon of sunnyOutdoorContours) {
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

      if (visibility.shadow) {
        for (const polygon of shadowOutdoorContours) {
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

      if (visibility.buildings) {
        for (const polygon of buildingsContours) {
          const latLngRings = polygon.map((ring) =>
            ring.map(([lon, lat]) => [lat, lon] as [number, number]),
          );
          L.polygon(latLngRings, {
            color: "#2563eb",
            fillColor: "#2563eb",
            weight: 0.9,
            opacity: 0.58,
            fillOpacity: 0.24,
          }).addTo(buildingsLayer);
        }
      }

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

      if (visibility.heatmap && dailyExposureCellsInput && dailyExposureCellsInput.length > 0) {
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
          const baseColor = venueTypeColor(place.venueType);
          const sunny =
            place.isSunnyNow === true || (place.isSunnyNow === null && place.sunnyMinutes > 0);
          const marker = L.circleMarker(
            [place.evaluationLat ?? place.lat, place.evaluationLon ?? place.lon],
            {
              radius: sunny ? 5 : 4,
              color: baseColor,
              fillColor: sunny ? "#fde047" : baseColor,
              fillOpacity: sunny ? 0.9 : 0.6,
              weight: 1.2,
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
            offset: [0, -8],
            className: "sunlit-place-label",
            opacity: 0.95,
          });

          marker.bindPopup(
            `${place.name} (${venueTypeBadgeLabel(place.venueType)})<br/>${sunlightHint}<br/>${terraceHint}`,
          );

          marker.on("click", (event: LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(event);
            void runPointClickDiagnostics(
              place.evaluationLat ?? place.lat,
              place.evaluationLon ?? place.lon,
            ).catch((error) => {
              console.error(
                "[Mappy Hour][place] Point diagnostic failed:",
                error instanceof Error ? error.message : error,
              );
            });
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
            void runPointClickDiagnostics(ridgePoint.lat, ridgePoint.lon).catch(
              (error) => {
                console.error(
                  "[Mappy Hour][ridge] Point diagnostic failed:",
                  error instanceof Error ? error.message : error,
                );
              },
            );
          });
        }
      }
    },
    [runPointClickDiagnostics],
  );

  useEffect(() => {
    renderLayers(visualAreaResponse, lastBuildings, sunlitPlaces, dailyExposureCells, {
      sunny: showSunny,
      shadow: showShadow,
      vegetation: showVegetation,
      buildings: showBuildings,
      terrain: showTerrain,
      heatmap: showHeatmap,
      places: showPlaces,
      ignoreVegetationShadow,
    });
  }, [
    dailyExposureCells,
    ignoreVegetationShadow,
    lastBuildings,
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

    if (timelineStreamRef.current) {
      timelineCancelledRef.current = true;
      timelineStreamRef.current.close();
      timelineStreamRef.current = null;
      setIsLoading(false);
    }
  }, [mode]);

  const cancelDailyCalculation = useCallback(() => {
    if (mode !== "daily") {
      return;
    }

    timelineCancelledRef.current = true;
    if (timelineStreamRef.current) {
      timelineCancelledRef.current = true;
      timelineStreamRef.current.close();
      timelineStreamRef.current = null;
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

  const loadBuildingsLayer = useCallback(async (bbox: [number, number, number, number]) => {
    const buildingsPayload = {
      bbox,
      maxBuildings: 6000,
    };

    const buildingsResponse = await fetch("/api/buildings/area", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildingsPayload),
    });

    if (buildingsResponse.ok) {
      return (await buildingsResponse.json()) as BuildingsAreaApiResponse;
    }

    const buildingError = (await buildingsResponse.json().catch(() => null)) as
      | { error?: string; detail?: string }
      | null;
    return {
      count: 0,
      buildings: [],
      warnings: [
        buildingError?.detail ?? buildingError?.error ?? "Buildings layer unavailable.",
      ],
      stats: {
        elapsedMs: 0,
        rawIntersectingCount: 0,
      },
    } satisfies BuildingsAreaApiResponse;
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
      sampleEveryMinutes,
    ],
  );

  const runAreaCalculation = useCallback(async () => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (mode === "daily" && isDailyRangeInvalid) {
      setError("Plage horaire daily invalide: la fin doit etre apres le debut.");
      return;
    }

    const bounds = map.getBounds();
    const bbox: [number, number, number, number] = [
      Number(bounds.getWest().toFixed(6)),
      Number(bounds.getSouth().toFixed(6)),
      Number(bounds.getEast().toFixed(6)),
      Number(bounds.getNorth().toFixed(6)),
    ];

    if (timelineStreamRef.current) {
      timelineCancelledRef.current = true;
      timelineStreamRef.current.close();
      timelineStreamRef.current = null;
    }
    if (instantStreamRef.current) {
      instantCancelledRef.current = true;
      instantStreamRef.current.close();
      instantStreamRef.current = null;
    }

    setIsLoading(true);
    setError(null);
    setBuildingWarnings([]);
    setPlacesWarnings([]);
    setPlacesError(null);
    setSunlitPlaces([]);
    setIsPlacesLoading(true);
    const placesRequestId = placesRequestIdRef.current + 1;
    placesRequestIdRef.current = placesRequestId;
    decodedTimelineMaskCacheRef.current.clear();

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

    if (mode === "instant") {
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
      let buildingsFinished = false;
      let streamFailed = false;

      const finalizeIfDone = () => {
        if (streamFinished && buildingsFinished) {
          setIsLoading(false);
        }
      };

      void loadBuildingsLayer(bbox)
        .then((buildingsJson) => {
          setLastBuildings(buildingsJson);
          setBuildingWarnings(
            buildingsJson.warnings.map((warning) => `buildings: ${warning}`),
          );
        })
        .catch((buildingError) => {
          setError(
            buildingError instanceof Error
              ? buildingError.message
              : "Buildings layer request failed.",
          );
        })
        .finally(() => {
          buildingsFinished = true;
          finalizeIfDone();
        });

      const query = new URLSearchParams({
        minLon: String(bbox[0]),
        minLat: String(bbox[1]),
        maxLon: String(bbox[2]),
        maxLat: String(bbox[3]),
        date,
        timezone: "Europe/Zurich",
        localTime,
        gridStepMeters: String(gridStepMeters),
        maxPoints: "3000",
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
    let buildingsFinished = false;
    let streamFailed = false;

    const finalizeIfDone = () => {
      if (streamFinished && buildingsFinished) {
        setIsLoading(false);
      }
    };

    void loadBuildingsLayer(bbox)
      .then((buildingsJson) => {
        setLastBuildings(buildingsJson);
        const prefixedWarnings = buildingsJson.warnings.map(
          (warning) => `buildings: ${warning}`,
        );
        setBuildingWarnings(prefixedWarnings);
        if (buildingsJson.warnings.length > 0) {
          setDailyTimeline((previous) => {
            if (!previous) {
              return previous;
            }
            return {
              ...previous,
              warnings: Array.from(
                new Set([
                  ...previous.warnings,
                  ...prefixedWarnings,
                ]),
              ),
            };
          });
        }
      })
      .catch((buildingError) => {
        setError(
          buildingError instanceof Error
            ? buildingError.message
            : "Buildings layer request failed.",
        );
      })
      .finally(() => {
        buildingsFinished = true;
        finalizeIfDone();
      });

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
      maxPoints: "3000",
    });

    timelineCancelledRef.current = false;
    const timelineStream = new EventSource(
      `/api/sunlight/timeline/stream?${query.toString()}`,
    );
    timelineStreamRef.current = timelineStream;

    timelineStream.addEventListener("start", (event) => {
      if (timelineCancelledRef.current) {
        return;
      }
      const data = JSON.parse((event as MessageEvent).data) as {
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
        points: TimelinePoint[];
        model?: NonNullable<AreaApiResponse["model"]>;
        warnings: string[];
      };

      decodedTimelineMaskCacheRef.current.clear();
      setDailyTimeline({
        date: data.date,
        timezone: data.timezone,
        startLocalTime: data.startLocalTime,
        endLocalTime: data.endLocalTime,
        sampleEveryMinutes: data.sampleEveryMinutes,
        gridStepMeters: data.gridStepMeters,
        pointCount: data.pointCount,
        gridPointCount: data.gridPointCount,
        indoorPointsExcluded: data.indoorPointsExcluded,
        frameCount: data.frameCount,
        points: data.points,
        frames: [],
        model: data.model ?? null,
        warnings: data.warnings,
        stats: null,
      });
      setDailyFrameIndex(0);
    });

    timelineStream.addEventListener("progress", (event) => {
      if (timelineCancelledRef.current) {
        return;
      }
      const data = JSON.parse((event as MessageEvent).data) as TimelineProgress;
      setDailyProgress(data);
    });

    timelineStream.addEventListener("frame", (event) => {
      if (timelineCancelledRef.current) {
        return;
      }
      const data = JSON.parse((event as MessageEvent).data) as TimelineFrame;
      setDailyTimeline((previous) => {
        if (!previous) {
          return previous;
        }

        const nextFrames = [...previous.frames, data];
        return {
          ...previous,
          frames: nextFrames,
        };
      });
      setDailyFrameIndex(data.index);
    });

    timelineStream.addEventListener("done", (event) => {
      if (timelineCancelledRef.current) {
        timelineStream.close();
        if (timelineStreamRef.current === timelineStream) {
          timelineStreamRef.current = null;
        }
        setIsLoading(false);
        return;
      }
      const data = JSON.parse((event as MessageEvent).data) as {
        stats: NonNullable<DailyTimelineState["stats"]>;
        warnings: string[];
      };
      setDailyTimeline((previous) => {
        if (!previous) {
          return previous;
        }

        return {
          ...previous,
          stats: data.stats,
          warnings: Array.from(new Set([...previous.warnings, ...data.warnings])),
        };
      });
      setDailyProgress({
        phase: "done",
        done: data.stats.totalEvaluations,
        total: data.stats.totalEvaluations,
        percent: 100,
        etaSeconds: 0,
      });
      timelineStream.close();
      if (timelineStreamRef.current === timelineStream) {
        timelineStreamRef.current = null;
      }
      streamFinished = true;
      finalizeIfDone();
    });

    timelineStream.addEventListener("error", (event) => {
      if (timelineCancelledRef.current) {
        timelineStream.close();
        if (timelineStreamRef.current === timelineStream) {
          timelineStreamRef.current = null;
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
        errorPayload?.details ??
          errorPayload?.error ??
          "Timeline streaming failed.",
      );
      timelineStream.close();
      if (timelineStreamRef.current === timelineStream) {
        timelineStreamRef.current = null;
      }
      streamFinished = true;
      finalizeIfDone();
    });
  }, [
    date,
    dailyEndLocalTime,
    dailyStartLocalTime,
    gridStepMeters,
    isDailyRangeInvalid,
    loadBuildingsLayer,
    loadSunlitPlaces,
    localTime,
    mode,
    sampleEveryMinutes,
  ]);

  return (
    <section className="grid gap-4 rounded-2xl border border-white/15 bg-white/5 p-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          <span>Mode</span>
          <select
            className="rounded border border-white/20 bg-black/40 px-2 py-1"
            value={mode}
            onChange={(event) => setMode(event.target.value as AreaMode)}
          >
            <option value="instant">instant</option>
            <option value="daily">daily</option>
          </select>
        </label>

        <label className="grid gap-1 text-sm">
          <span>Date</span>
          <input
            type="date"
            value={date}
            className="rounded border border-white/20 bg-black/40 px-2 py-1"
            onChange={(event) => setDate(event.target.value)}
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>Heure locale</span>
          <input
            type="time"
            value={localTime}
            className="rounded border border-white/20 bg-black/40 px-2 py-1"
            onChange={(event) => setLocalTime(event.target.value)}
            disabled={mode !== "instant"}
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span>Grille (m)</span>
          <input
            type="number"
            min={1}
            max={2000}
            step={1}
            value={gridStepMeters}
            className="w-28 rounded border border-white/20 bg-black/40 px-2 py-1"
            onChange={(event) => setGridStepMeters(Number(event.target.value))}
          />
        </label>

        {mode === "daily" ? (
          <label className="grid gap-1 text-sm">
            <span>Debut</span>
            <input
              type="time"
              value={dailyStartLocalTime}
              className="w-28 rounded border border-white/20 bg-black/40 px-2 py-1"
              onChange={(event) => setDailyStartLocalTime(event.target.value)}
            />
          </label>
        ) : null}

        {mode === "daily" ? (
          <label className="grid gap-1 text-sm">
            <span>Fin</span>
            <input
              type="time"
              value={dailyEndLocalTime}
              className="w-28 rounded border border-white/20 bg-black/40 px-2 py-1"
              onChange={(event) => setDailyEndLocalTime(event.target.value)}
            />
          </label>
        ) : null}

        {mode === "daily" ? (
          <label className="grid gap-1 text-sm">
            <span>Sample (min)</span>
            <input
              type="number"
              min={1}
              max={60}
              value={sampleEveryMinutes}
              className="w-28 rounded border border-white/20 bg-black/40 px-2 py-1"
              onChange={(event) => setSampleEveryMinutes(Number(event.target.value))}
            />
          </label>
        ) : null}

        <button
          type="button"
          className="rounded bg-yellow-300 px-4 py-2 font-semibold text-black transition hover:bg-yellow-200 disabled:cursor-not-allowed disabled:bg-slate-500"
          onClick={() => void runAreaCalculation()}
          disabled={isLoading || (mode === "daily" && isDailyRangeInvalid)}
        >
          {isLoading
            ? "Calcul..."
            : mode === "daily"
              ? "Calculer timeline"
              : "Calculer zone visible"}
        </button>
        {mode === "daily" && isLoading ? (
          <button
            type="button"
            className="rounded bg-rose-500 px-4 py-2 font-semibold text-white transition hover:bg-rose-400"
            onClick={cancelDailyCalculation}
          >
            Interrompre
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-white/15 bg-black/20 px-3 py-2 text-sm">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showSunny}
            onChange={(event) => setShowSunny(event.target.checked)}
          />
          <span className="rounded px-2 py-0.5 text-black" style={{ background: "#facc15" }}>
            ensoleille
          </span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showShadow}
            onChange={(event) => setShowShadow(event.target.checked)}
          />
          <span className="rounded bg-slate-500 px-2 py-0.5 text-white">ombre</span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showVegetation}
            onChange={(event) => setShowVegetation(event.target.checked)}
          />
          <span className="rounded bg-green-700 px-2 py-0.5 text-white">vegetation</span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showBuildings}
            onChange={(event) => setShowBuildings(event.target.checked)}
          />
          <span className="rounded bg-blue-600 px-2 py-0.5 text-white">buildings</span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showTerrain}
            onChange={(event) => setShowTerrain(event.target.checked)}
          />
          <span className="rounded bg-amber-700 px-2 py-0.5 text-white">
            montagnes horizon
          </span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showHeatmap}
            onChange={(event) => setShowHeatmap(event.target.checked)}
            disabled={!canShowHeatmap}
          />
          <span className="rounded bg-rose-600 px-2 py-0.5 text-white">
            heatmap expo
          </span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showPlaces}
            onChange={(event) => setShowPlaces(event.target.checked)}
          />
          <span className="rounded bg-red-600 px-2 py-0.5 text-white">
            terrasses soleil
          </span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={ignoreVegetationShadow}
            onChange={(event) => setIgnoreVegetationShadow(event.target.checked)}
          />
          <span className="rounded bg-emerald-800 px-2 py-0.5 text-white">
            ignorer ombre vegetation
          </span>
        </label>
      </div>

      {mode === "daily" ? (
        <div className="grid gap-2 rounded-lg border border-white/15 bg-black/20 px-3 py-3 text-sm">
          <div className="flex items-center justify-between">
            <span>Timeline quotidienne</span>
            <span>{activeFrameTime ?? "--:--:--"}</span>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0, (dailyTimeline?.frames.length ?? 1) - 1)}
            step={1}
            value={Math.min(
              dailyFrameIndex,
              Math.max(0, (dailyTimeline?.frames.length ?? 1) - 1),
            )}
            onChange={(event) => setDailyFrameIndex(Number(event.target.value))}
            disabled={!dailyTimeline || dailyTimeline.frames.length === 0}
          />
          <p className="text-xs text-slate-300">
            Frames recues: {dailyTimeline?.frames.length ?? 0}/
            {dailyTimeline?.frameCount ?? 0}
          </p>
          {canShowHeatmap ? (
            <p className="text-xs text-rose-200">
              Heatmap disponible: active &quot;heatmap expo&quot; pour voir
              l&apos;exposition cumulee de la journee.
            </p>
          ) : null}
          {isDailyRangeInvalid ? (
            <p className="text-xs text-red-300">
              Plage horaire invalide: la fin doit etre strictement apres le debut.
            </p>
          ) : null}
          {dailyProgress ? (
            <div className="grid gap-1">
              <div className="h-2 w-full overflow-hidden rounded bg-slate-700/70">
                <div
                  className="h-full rounded bg-yellow-300 transition-[width] duration-150"
                  style={{ width: `${Math.min(100, Math.max(0, dailyProgress.percent))}%` }}
                />
              </div>
              <p className="text-xs text-slate-300">
                {dailyProgress.phase} - {dailyProgress.percent.toFixed(1)}% (
                {dailyProgress.done}/{dailyProgress.total}), ETA:{" "}
                {dailyProgress.etaSeconds === null
                  ? "-"
                  : `${dailyProgress.etaSeconds}s`}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === "instant" && instantProgress ? (
        <div className="grid gap-1 rounded-lg border border-white/15 bg-black/20 px-3 py-3 text-sm">
          <div className="h-2 w-full overflow-hidden rounded bg-slate-700/70">
            <div
              className="h-full rounded bg-yellow-300 transition-[width] duration-150"
              style={{ width: `${Math.min(100, Math.max(0, instantProgress.percent))}%` }}
            />
          </div>
          <p className="text-xs text-slate-300">
            {instantProgress.phase} - {instantProgress.percent.toFixed(1)}% (
            {instantProgress.done}/{instantProgress.total}), ETA:{" "}
            {instantProgress.etaSeconds === null
              ? "-"
              : `${instantProgress.etaSeconds}s`}
          </p>
        </div>
      ) : null}

      <p className="text-sm text-slate-200">{helperText}</p>
      {error ? (
        <p className="rounded border border-red-300/40 bg-red-500/20 px-3 py-2 text-sm text-red-100">
          {error}
        </p>
      ) : null}
      {activeWarnings.length ? (
        <div className="rounded border border-amber-300/40 bg-amber-200/10 px-3 py-2 text-sm text-amber-100">
          <p className="font-semibold">Warnings</p>
          <ul className="list-disc pl-5">
            {activeWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {placesError ? (
        <p className="rounded border border-red-300/40 bg-red-500/20 px-3 py-2 text-sm text-red-100">
          Terrasses: {placesError}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="h-[560px] w-full overflow-hidden rounded-xl border border-white/20">
          <div ref={mapContainerRef} className="h-full w-full" />
        </div>
        <aside className="h-[560px] overflow-hidden rounded-xl border border-white/20 bg-black/20">
          <div className="border-b border-white/15 px-3 py-2">
            <p className="text-sm font-semibold">Bars / restos au soleil</p>
            <p className="text-xs text-slate-300">
              {isPlacesLoading
                ? "Calcul terrasses en cours..."
                : `${sunlitPlaces.length} etablissements visibles`}
            </p>
          </div>
          <div className="h-[calc(560px-56px)] overflow-y-auto px-2 py-2">
            {sunlitPlaces.length === 0 && !isPlacesLoading ? (
              <p className="px-2 py-2 text-xs text-slate-300">
                Aucun etablissement ensoleille pour les filtres actuels.
              </p>
            ) : null}
            <div className="grid gap-2">
              {sunlitPlaces.map((place) => (
                <button
                  key={place.id}
                  type="button"
                  className="grid gap-1 rounded border border-white/15 bg-white/5 px-2 py-2 text-left text-sm hover:bg-white/10"
                  onClick={() => {
                    const map = mapRef.current;
                    if (!map) {
                      return;
                    }
                    map.setView(
                      [place.evaluationLat ?? place.lat, place.evaluationLon ?? place.lon],
                      Math.max(map.getZoom(), 16),
                      { animate: true },
                    );
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{place.name}</span>
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-white"
                      style={{ background: venueTypeColor(place.venueType) }}
                    >
                      {venueTypeBadgeLabel(place.venueType)}
                    </span>
                  </div>
                  <div className="text-xs text-slate-300">
                    {mode === "instant"
                      ? place.isSunnyNow
                        ? `Soleil maintenant (${localTime})`
                        : "A l'ombre maintenant"
                      : `${place.sunlightStartLocalTime ?? "--:--"} -> ${place.sunlightEndLocalTime ?? "--:--"} (${place.sunnyMinutes} min)`}
                  </div>
                  {place.selectionStrategy !== "original" ? (
                    <div className="text-[11px] text-amber-200">
                      Terrasse decalee ({place.selectionOffsetMeters}m) pour eviter un point indoor.
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
