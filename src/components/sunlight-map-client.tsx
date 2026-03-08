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

const METERS_PER_DEGREE_LAT = 111_320;
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

export function SunlightMapClient() {
  const defaultNow = useMemo(() => zurichNowDateAndTime(), []);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
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
  const [showSunny, setShowSunny] = useState(true);
  const [showShadow, setShowShadow] = useState(true);
  const [showBuildings, setShowBuildings] = useState(true);

  const helperText = useMemo(() => {
    if (!lastResult) {
      return "Aucun calcul encore lance.";
    }
    const excludedIndoor = lastResult.stats.indoorPointsExcluded ?? 0;
    const buildingCount = lastBuildings?.count ?? 0;
    return `${lastResult.pointCount} points, ${lastResult.stats.elapsedMs} ms, indoor exclus: ${excludedIndoor}, batiments: ${buildingCount}, warnings: ${lastResult.warnings.length}`;
  }, [lastBuildings?.count, lastResult]);

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
      const map = L.map(mapContainerRef.current, {
        zoomControl: true,
      }).setView([46.5197, 6.6323], 13);

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
    };

    void initMap();

    return () => {
      isCancelled = true;
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
      response: AreaApiResponse,
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

      const { sunnyContours, shadowContours } = buildSunAndShadowContours(response);
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
    if (!lastResult) {
      return;
    }

    renderLayers(lastResult, lastBuildings, {
      sunny: showSunny,
      shadow: showShadow,
      buildings: showBuildings,
    });
  }, [lastBuildings, lastResult, renderLayers, showBuildings, showShadow, showSunny]);

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

    setIsLoading(true);
    setError(null);

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
      const buildingsPayload = {
        bbox,
        maxBuildings: 6000,
      };

      const [areaResponse, buildingsResponse] = await Promise.all([
        fetch("/api/sunlight/area", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(areaPayload),
        }),
        fetch("/api/buildings/area", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildingsPayload),
        }),
      ]);

      const areaJson = (await areaResponse.json()) as AreaApiResponse & {
        error?: string;
        detail?: string;
      };
      if (!areaResponse.ok) {
        throw new Error(areaJson.detail ?? areaJson.error ?? "Area calculation failed");
      }

      let buildingsJson: BuildingsAreaApiResponse = {
        count: 0,
        buildings: [],
        warnings: [],
        stats: {
          elapsedMs: 0,
          rawIntersectingCount: 0,
        },
      };

      if (buildingsResponse.ok) {
        buildingsJson = (await buildingsResponse.json()) as BuildingsAreaApiResponse;
      } else {
        const buildingError = (await buildingsResponse.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        buildingsJson = {
          count: 0,
          buildings: [],
          warnings: [
            buildingError?.detail ??
              buildingError?.error ??
              "Buildings layer unavailable.",
          ],
          stats: {
            elapsedMs: 0,
            rawIntersectingCount: 0,
          },
        };
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
      renderLayers(mergedResult, buildingsJson, {
        sunny: showSunny,
        shadow: showShadow,
        buildings: showBuildings,
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, [
    date,
    gridStepMeters,
    localTime,
    mode,
    renderLayers,
    sampleEveryMinutes,
    showBuildings,
    showShadow,
    showSunny,
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
          {isLoading ? "Calcul..." : "Calculer zone visible"}
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

      <p className="text-sm text-slate-200">{helperText}</p>
      {error ? (
        <p className="rounded border border-red-300/40 bg-red-500/20 px-3 py-2 text-sm text-red-100">
          {error}
        </p>
      ) : null}
      {lastResult?.warnings?.length ? (
        <div className="rounded border border-amber-300/40 bg-amber-200/10 px-3 py-2 text-sm text-amber-100">
          <p className="font-semibold">Warnings</p>
          <ul className="list-disc pl-5">
            {lastResult.warnings.map((warning) => (
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
