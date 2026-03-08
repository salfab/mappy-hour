"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

function getInstantColor(point: AreaInstantPoint): string {
  if (point.isSunny) {
    return "#facc15";
  }
  if (point.buildingsBlocked) {
    return "#ef4444";
  }
  if (point.terrainBlocked) {
    return "#64748b";
  }
  return "#334155";
}

function getDailyColor(sunnyMinutes: number): string {
  if (sunnyMinutes >= 480) {
    return "#fde047";
  }
  if (sunnyMinutes >= 240) {
    return "#f97316";
  }
  if (sunnyMinutes > 0) {
    return "#fb7185";
  }
  return "#1e293b";
}

export function SunlightMapClient() {
  const defaultNow = useMemo(() => zurichNowDateAndTime(), []);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const pointsLayerRef = useRef<LayerGroup | null>(null);
  const leafletModuleRef = useRef<typeof import("leaflet") | null>(null);

  const [mode, setMode] = useState<AreaMode>("instant");
  const [date, setDate] = useState(defaultNow.date);
  const [localTime, setLocalTime] = useState(defaultNow.time);
  const [gridStepMeters, setGridStepMeters] = useState(200);
  const [sampleEveryMinutes, setSampleEveryMinutes] = useState(15);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<AreaApiResponse | null>(null);

  const helperText = useMemo(() => {
    if (!lastResult) {
      return "Aucun calcul encore lance.";
    }
    const excludedIndoor = lastResult.stats.indoorPointsExcluded ?? 0;
    return `${lastResult.pointCount} points, ${lastResult.stats.elapsedMs} ms, indoor exclus: ${excludedIndoor}, warnings: ${lastResult.warnings.length}`;
  }, [lastResult]);

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

      const pointsLayer = L.layerGroup().addTo(map);
      pointsLayerRef.current = pointsLayer;
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
      pointsLayerRef.current = null;
      leafletModuleRef.current = null;
    };
  }, []);

  const renderPoints = useCallback(
    (response: AreaApiResponse) => {
      const L = leafletModuleRef.current;
      const layer = pointsLayerRef.current;
      if (!L || !layer) {
        return;
      }

      layer.clearLayers();

      if (response.mode === "instant") {
        for (const point of response.points as AreaInstantPoint[]) {
          const color = getInstantColor(point);
          const circle = L.circleMarker([point.lat, point.lon], {
            radius: 5,
            color,
            weight: 1,
            fillColor: color,
            fillOpacity: 0.8,
          });
          circle.bindTooltip(
            [
              `id: ${point.id}`,
              `sunny: ${point.isSunny}`,
              `terrainBlocked: ${point.terrainBlocked}`,
              `buildingsBlocked: ${point.buildingsBlocked}`,
              `alt: ${point.altitudeDeg.toFixed(2)} deg`,
              `az: ${point.azimuthDeg.toFixed(2)} deg`,
            ].join("<br/>"),
          );
          circle.addTo(layer);
        }
        return;
      }

      for (const point of response.points as AreaDailyPoint[]) {
        const color = getDailyColor(point.sunnyMinutes);
        const circle = L.circleMarker([point.lat, point.lon], {
          radius: 5,
          color,
          weight: 1,
          fillColor: color,
          fillOpacity: 0.8,
        });
        circle.bindTooltip(
          [
            `id: ${point.id}`,
            `sunnyMinutes: ${point.sunnyMinutes}`,
            `sunnyHours: ${(point.sunnyMinutes / 60).toFixed(2)}`,
          ].join("<br/>"),
        );
        circle.addTo(layer);
      }
    },
    [],
  );

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
      const payload = {
        bbox,
        date,
        timezone: "Europe/Zurich",
        mode,
        localTime,
        sampleEveryMinutes,
        gridStepMeters,
        maxPoints: 2000,
      };

      const response = await fetch("/api/sunlight/area", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const json = (await response.json()) as AreaApiResponse & {
        error?: string;
        detail?: string;
      };
      if (!response.ok) {
        throw new Error(json.detail ?? json.error ?? "Area calculation failed");
      }

      setLastResult(json);
      renderPoints(json);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, [date, gridStepMeters, localTime, mode, renderPoints, sampleEveryMinutes]);

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
            min={5}
            max={2000}
            step={10}
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
