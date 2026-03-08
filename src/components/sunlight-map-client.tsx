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

interface AreaApiResponse {
  mode: AreaMode;
  gridStepMeters: number;
  pointCount: number;
  points: AreaInstantPoint[] | AreaDailyPoint[];
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

interface TimelinePoint {
  id: string;
  lat: number;
  lon: number;
}

interface TimelineFrame {
  index: number;
  localTime: string;
  sunnyCount: number;
  sunMaskBase64: string;
}

interface DailyTimelineState {
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  pointCount: number;
  gridPointCount: number;
  indoorPointsExcluded: number;
  frameCount: number;
  points: TimelinePoint[];
  frames: TimelineFrame[];
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

interface TimelineProgress {
  phase: string;
  done: number;
  total: number;
  percent: number;
  etaSeconds: number | null;
}

const METERS_PER_DEGREE_LAT = 111_320;
const DEFAULT_MAP_CENTER: [number, number] = [46.5197, 6.6323];
const DEFAULT_MAP_ZOOM = 13;
const MAP_VIEW_STORAGE_KEY = "mappy-hour:map:view";
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

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
  const merged = polygonClipping.union(first, ...rest);
  return Array.isArray(merged) ? (merged as MultiPolygon) : [];
}

function subtractPolygons(base: MultiPolygon, mask: MultiPolygon): MultiPolygon {
  if (base.length === 0 || mask.length === 0) {
    return base;
  }

  const difference = polygonClipping.difference(base, mask);
  return Array.isArray(difference) ? (difference as MultiPolygon) : [];
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

function toInstantAreaResponseFromTimeline(
  timeline: DailyTimelineState,
  frameIndex: number,
  decodedMaskCache: Map<number, Uint8Array>,
): AreaApiResponse | null {
  if (timeline.frames.length === 0 || timeline.points.length === 0) {
    return null;
  }

  const safeIndex = Math.max(0, Math.min(frameIndex, timeline.frames.length - 1));
  const frame = timeline.frames[safeIndex];
  let mask = decodedMaskCache.get(frame.index);
  if (!mask) {
    mask = decodeBase64ToBytes(frame.sunMaskBase64);
    decodedMaskCache.set(frame.index, mask);
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
    warnings: timeline.warnings,
    stats: {
      elapsedMs: stats?.elapsedMs ?? 0,
      pointsWithElevation: stats?.pointsWithElevation ?? 0,
      pointsWithoutElevation: stats?.pointsWithoutElevation ?? 0,
      indoorPointsExcluded: stats?.indoorPointsExcluded ?? timeline.indoorPointsExcluded,
    },
  };
}

export function SunlightMapClient() {
  const defaultNow = useMemo(() => zurichNowDateAndTime(), []);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const timelineStreamRef = useRef<EventSource | null>(null);
  const decodedTimelineMaskCacheRef = useRef<Map<number, Uint8Array>>(new Map());
  const sunnyLayerRef = useRef<LayerGroup | null>(null);
  const shadowLayerRef = useRef<LayerGroup | null>(null);
  const buildingsLayerRef = useRef<LayerGroup | null>(null);
  const leafletModuleRef = useRef<typeof import("leaflet") | null>(null);

  const [mode, setMode] = useState<AreaMode>("instant");
  const [date, setDate] = useState(defaultNow.date);
  const [localTime, setLocalTime] = useState(defaultNow.time);
  const [gridStepMeters, setGridStepMeters] = useState(200);
  const [sampleEveryMinutes, setSampleEveryMinutes] = useState(15);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<AreaApiResponse | null>(null);
  const [lastBuildings, setLastBuildings] = useState<BuildingsAreaApiResponse | null>(
    null,
  );
  const [dailyTimeline, setDailyTimeline] = useState<DailyTimelineState | null>(
    null,
  );
  const [dailyFrameIndex, setDailyFrameIndex] = useState(0);
  const [dailyProgress, setDailyProgress] = useState<TimelineProgress | null>(null);
  const [buildingWarnings, setBuildingWarnings] = useState<string[]>([]);
  const [showSunny, setShowSunny] = useState(true);
  const [showShadow, setShowShadow] = useState(true);
  const [showBuildings, setShowBuildings] = useState(true);

  const visualAreaResponse = useMemo(() => {
    if (mode === "daily" && dailyTimeline) {
      return toInstantAreaResponseFromTimeline(
        dailyTimeline,
        dailyFrameIndex,
        decodedTimelineMaskCacheRef.current,
      );
    }

    return lastResult;
  }, [dailyFrameIndex, dailyTimeline, lastResult, mode]);

  const activeWarnings = useMemo(() => {
    if (mode === "daily" && dailyTimeline) {
      return Array.from(new Set([...dailyTimeline.warnings, ...buildingWarnings]));
    }

    return lastResult?.warnings ?? [];
  }, [buildingWarnings, dailyTimeline, lastResult, mode]);

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

  const helperText = useMemo(() => {
    if (mode === "daily" && dailyTimeline) {
      const stats = dailyTimeline.stats;
      const base = `${dailyTimeline.pointCount} points, frames: ${dailyTimeline.frames.length}/${dailyTimeline.frameCount}, indoor exclus: ${dailyTimeline.indoorPointsExcluded}`;
      if (!stats) {
        return `${base}, calcul timeline en cours...`;
      }

      return `${base}, ${stats.elapsedMs} ms, evaluations: ${stats.totalEvaluations}`;
    }

    if (!lastResult) {
      return "Aucun calcul encore lance.";
    }
    const excludedIndoor = lastResult.stats.indoorPointsExcluded ?? 0;
    const buildingCount = lastBuildings?.count ?? 0;
    return `${lastResult.pointCount} points, ${lastResult.stats.elapsedMs} ms, indoor exclus: ${excludedIndoor}, batiments: ${buildingCount}, warnings: ${lastResult.warnings.length}`;
  }, [dailyTimeline, lastBuildings?.count, lastResult, mode]);

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
      buildingsLayerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;

      map.on("click", (event: LeafletMouseEvent) => {
        const message = `Lat ${event.latlng.lat.toFixed(5)}, Lon ${event.latlng.lng.toFixed(5)}`;
        map.attributionControl.setPrefix(`Mappy Hour - ${message}`);
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
      if (timelineStreamRef.current) {
        timelineStreamRef.current.close();
        timelineStreamRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      sunnyLayerRef.current = null;
      shadowLayerRef.current = null;
      buildingsLayerRef.current = null;
      leafletModuleRef.current = null;
    };
  }, []);

  const renderLayers = useCallback(
    (
      response: AreaApiResponse | null,
      buildings: BuildingsAreaApiResponse | null,
      visibility: {
        sunny: boolean;
        shadow: boolean;
        buildings: boolean;
      },
    ) => {
      const L = leafletModuleRef.current;
      const sunnyLayer = sunnyLayerRef.current;
      const shadowLayer = shadowLayerRef.current;
      const buildingsLayer = buildingsLayerRef.current;
      if (!L || !sunnyLayer || !shadowLayer || !buildingsLayer) {
        return;
      }

      sunnyLayer.clearLayers();
      shadowLayer.clearLayers();
      buildingsLayer.clearLayers();

      const { sunnyContours, shadowContours } = response
        ? buildSunAndShadowContours(response)
        : { sunnyContours: [], shadowContours: [] };
      const buildingsContours = buildBuildingsContours(buildings);
      const sunnyOutdoorContours = subtractPolygons(sunnyContours, buildingsContours);
      const shadowOutdoorContours = subtractPolygons(shadowContours, buildingsContours);

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
    },
    [],
  );

  useEffect(() => {
    renderLayers(visualAreaResponse, lastBuildings, {
      sunny: showSunny,
      shadow: showShadow,
      buildings: showBuildings,
    });
  }, [
    lastBuildings,
    renderLayers,
    showBuildings,
    showShadow,
    showSunny,
    visualAreaResponse,
  ]);

  useEffect(() => {
    if (mode === "daily") {
      return;
    }

    if (timelineStreamRef.current) {
      timelineStreamRef.current.close();
      timelineStreamRef.current = null;
      setIsLoading(false);
    }
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

  const runAreaCalculation = useCallback(async () => {
    const map = mapRef.current;
    if (!map) {
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
      timelineStreamRef.current.close();
      timelineStreamRef.current = null;
    }

    setIsLoading(true);
    setError(null);
    setBuildingWarnings([]);
    decodedTimelineMaskCacheRef.current.clear();

    if (mode === "instant") {
      setDailyTimeline(null);
      setDailyProgress(null);
      try {
        const areaPayload = {
          bbox,
          date,
          timezone: "Europe/Zurich",
          mode,
          localTime,
          sampleEveryMinutes,
          gridStepMeters,
          maxPoints: 3000,
        };

        const [areaResponse, buildingsJson] = await Promise.all([
          fetch("/api/sunlight/area", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(areaPayload),
          }),
          loadBuildingsLayer(bbox),
        ]);

        const areaJson = (await areaResponse.json()) as AreaApiResponse & {
          error?: string;
          detail?: string;
        };
        if (!areaResponse.ok) {
          throw new Error(areaJson.detail ?? areaJson.error ?? "Area calculation failed");
        }

        const mergedResult: AreaApiResponse = {
          ...areaJson,
          warnings: Array.from(
            new Set([
              ...areaJson.warnings,
              ...buildingsJson.warnings.map((warning) => `buildings: ${warning}`),
            ]),
          ),
        };

        setLastResult(mergedResult);
        setLastBuildings(buildingsJson);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Unknown error");
      } finally {
        setIsLoading(false);
      }
      return;
    }

    setLastResult(null);
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
      sampleEveryMinutes: String(sampleEveryMinutes),
      gridStepMeters: String(gridStepMeters),
      maxPoints: "3000",
    });

    const timelineStream = new EventSource(
      `/api/sunlight/timeline/stream?${query.toString()}`,
    );
    timelineStreamRef.current = timelineStream;

    timelineStream.addEventListener("start", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as {
        date: string;
        timezone: string;
        sampleEveryMinutes: number;
        gridStepMeters: number;
        pointCount: number;
        gridPointCount: number;
        indoorPointsExcluded: number;
        frameCount: number;
        points: TimelinePoint[];
        warnings: string[];
      };

      decodedTimelineMaskCacheRef.current.clear();
      setDailyTimeline({
        date: data.date,
        timezone: data.timezone,
        sampleEveryMinutes: data.sampleEveryMinutes,
        gridStepMeters: data.gridStepMeters,
        pointCount: data.pointCount,
        gridPointCount: data.gridPointCount,
        indoorPointsExcluded: data.indoorPointsExcluded,
        frameCount: data.frameCount,
        points: data.points,
        frames: [],
        warnings: data.warnings,
        stats: null,
      });
      setDailyFrameIndex(0);
    });

    timelineStream.addEventListener("progress", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as TimelineProgress;
      setDailyProgress(data);
    });

    timelineStream.addEventListener("frame", (event) => {
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
      streamFailed = true;
      timelineStream.close();
      if (timelineStreamRef.current === timelineStream) {
        timelineStreamRef.current = null;
      }
      streamFinished = true;
      finalizeIfDone();
    });

    timelineStream.addEventListener("error", (event) => {
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
    gridStepMeters,
    loadBuildingsLayer,
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

        <label className="grid gap-1 text-sm">
          <span>Sample (min)</span>
          <input
            type="number"
            min={1}
            max={60}
            value={sampleEveryMinutes}
            className="w-28 rounded border border-white/20 bg-black/40 px-2 py-1"
            onChange={(event) => setSampleEveryMinutes(Number(event.target.value))}
            disabled={mode !== "daily"}
          />
        </label>

        <button
          type="button"
          className="rounded bg-yellow-300 px-4 py-2 font-semibold text-black transition hover:bg-yellow-200 disabled:cursor-not-allowed disabled:bg-slate-500"
          onClick={() => void runAreaCalculation()}
          disabled={isLoading}
        >
          {isLoading
            ? "Calcul..."
            : mode === "daily"
              ? "Calculer timeline"
              : "Calculer zone visible"}
        </button>
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
            checked={showBuildings}
            onChange={(event) => setShowBuildings(event.target.checked)}
          />
          <span className="rounded bg-blue-600 px-2 py-0.5 text-white">buildings</span>
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

      <div className="h-[560px] w-full overflow-hidden rounded-xl border border-white/20">
        <div ref={mapContainerRef} className="h-full w-full" />
      </div>
    </section>
  );
}
