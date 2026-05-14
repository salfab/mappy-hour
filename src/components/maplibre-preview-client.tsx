"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { MapLibreSunlightCustomLayer } from "@/components/sunlight-overlay/maplibre-sunlight-custom-layer";
import {
  CalculationControls,
  LayerFilters,
  ProgressStatus,
  ViewTabs,
  type AreaMode,
  type MapPanelTab,
  type OverlayMode,
  type TimelineProgressView,
} from "@/components/map-ui/controls";

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
  addPlacesLayers,
  attachPlacesInteractions,
  placesToFeatureCollection,
  type SunlightWindow,
  type ViewportPlaceLite,
} from "@/components/maplibre-preview/places-source";
import { PlaceDetailCard } from "@/components/maplibre-preview/place-card";
import { SearchPanel } from "@/components/maplibre-preview/search-panel";
import {
  FilterPanel,
  DEFAULT_FILTERS,
  placeChipKey,
  type CategoryFilters,
} from "@/components/maplibre-preview/filter-panel";
import { fetchTimeline } from "@/components/maplibre-preview/sunlight-timeline";
import {
  StylePanel,
  DEFAULT_STYLE_SETTINGS,
  type SunlightStyleSettings,
} from "@/components/maplibre-preview/style-panel";

const DEFAULT_CENTER: [number, number] = [6.6323, 46.5197];
const DEFAULT_ZOOM = 17;

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
  const [ready, setReady] = useState(false);
  const [basemapId, setBasemapId] = useState<BaseMapId>("aquarelle");

  // ── Sunlight state ────────────────────────────────────────────────────────
  const [sunlightVisible, setSunlightVisible] = useState(true);
  const [frameIndex, setFrameIndex] = useState(0);
  const [timelineFrames, setTimelineFrames] = useState<Array<{ localTime: string }>>([]);
  const [sunlightLoading, setSunlightLoading] = useState(false);
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
  const [filters, setFilters] = useState<CategoryFilters>(DEFAULT_FILTERS);
  // Ref mirror so closures captured in setStyle / moveend handlers always see
  // the latest filter state without re-creating the listeners.
  const filtersRef = useRef(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);

  // ── Calculation state (ported from Leaflet client) ────────────────────────
  // DECISION: instant mode rendering of points is intentionally NOT ported
  // (scope). We only consume SSE progress events; the timeline overlay refreshes
  // via `recalcSignal` once the precompute completes, which makes the new tiles
  // visible without us reimplementing the lastResult pipeline.
  const [mode, setMode] = useState<AreaMode>("daily");
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
  // DECISION: instant-mode rendering of points is not ported, so heatmap
  // cannot be derived from a daily run here yet. We still expose the toggle
  // so the UI looks like the homepage; canShowHeatmap stays false for now so
  // the heatmap pill is disabled (Leaflet behaviour when no daily timeline).
  const canShowHeatmap = false;

  // ── View tabs + LayerFilters state (ported from Leaflet homepage) ─────────
  // DECISION: venue count is not wired to a sunlitPlaces list in the preview
  // yet (no BarsList in this chunk). We surface rawPlacesRef length for now;
  // the next chunk that wires BarsList will replace this with a memo on a
  // properly filtered list.
  const [panelTab, setPanelTab] = useState<MapPanelTab>("map");
  // DECISION: showSunny/showShadow already live in `styleSettings` so the
  // OverlayMode derivation reuses them (no duplicate state). showHeatmap is
  // new state because no equivalent exists yet in the preview.
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showTerrain, setShowTerrain] = useState(true);
  // showBuildings / showVegetation are kept for symmetry with the homepage
  // even though LayerFilters itself does not surface them — they will be
  // wired to MapLibre layers in a later chunk. Marked with eslint-disable so
  // the unused setter does not break the build right now.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [showBuildings, setShowBuildings] = useState(true);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [showVegetation, setShowVegetation] = useState(true);
  const [showPlaces, setShowPlaces] = useState(true);
  const overlayMode: OverlayMode =
    showHeatmap && !showSunny && !showShadow ? "heatmap" : "sunlight";
  const isDailyRangeInvalid = false; // defaults are valid; no UI to break them

  const timelineCalcAbortRef = useRef<AbortController | null>(null);
  const timelineCancelledRef = useRef(false);
  const instantStreamRef = useRef<EventSource | null>(null);
  const instantCancelledRef = useRef(false);

  const handleCancelDailyCalculation = useCallback(() => {
    if (mode !== "daily") return;
    timelineCancelledRef.current = true;
    if (timelineCalcAbortRef.current) {
      timelineCalcAbortRef.current.abort();
      timelineCalcAbortRef.current = null;
    }
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
      const stream = new EventSource(
        `/api/sunlight/instant/stream?${query.toString()}`,
      );
      instantStreamRef.current = stream;

      stream.addEventListener("progress", (event) => {
        if (instantCancelledRef.current) return;
        const data = JSON.parse((event as MessageEvent).data) as TimelineProgressView;
        setInstantProgress(data);
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

    // Daily mode — fetch + ReadableStream SSE parser (faithful copy of Leaflet).
    setInstantProgress(null);
    setDailyProgress({
      phase: "starting",
      percent: 0,
      etaSeconds: null,
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
      maxPoints: "2000000",
      buildingHeightBiasMeters: String(buildingHeightBiasMeters),
      ignoreVegetation: String(ignoreVegetationShadow),
      ...(cacheOnly ? { cacheOnly: "true" } : {}),
    });

    timelineCancelledRef.current = false;
    const abortController = new AbortController();
    timelineCalcAbortRef.current = abortController;

    const handleSseEvent = (eventType: string, jsonData: string) => {
      if (timelineCancelledRef.current) return;
      if (eventType === "tile") {
        // DECISION: we don't accumulate tiles client-side (no overlay rendering
        // here). Just surface progress.
        const data = JSON.parse(jsonData) as {
          tileIndex: number;
          totalTiles: number;
        };
        if (typeof data.totalTiles === "number" && data.totalTiles > 0) {
          const doneCount = data.tileIndex + 1;
          const tileFraction = Math.min(1, doneCount / data.totalTiles);
          setDailyProgress((previous) => ({
            phase: "computing",
            percent: tileFraction * 100,
            tileIndex: doneCount,
            totalTiles: data.totalTiles,
            etaSeconds: previous?.etaSeconds ?? null,
            elapsedMs: previous?.elapsedMs,
          }));
        }
      } else if (eventType === "progress") {
        const data = JSON.parse(jsonData) as TimelineProgressView;
        setDailyProgress(data);
      } else if (eventType === "done") {
        const parsed = JSON.parse(jsonData) as {
          stats?: { elapsedMs?: number; totalEvaluations?: number };
        };
        setDailyProgress({
          phase: "done",
          percent: 100,
          etaSeconds: 0,
          elapsedMs: parsed.stats?.elapsedMs,
        });
      }
    };

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
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let eventType = "message";
          let dataLine = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            else if (line.startsWith("data: ")) dataLine = line.slice(6);
          }
          if (dataLine) handleSseEvent(eventType, dataLine);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        console.warn("[maplibre-preview] timeline calc failed:", err);
      }
    } finally {
      if (timelineCalcAbortRef.current === abortController) {
        timelineCalcAbortRef.current = null;
      }
      setIsCalculating(false);
      // Refresh the overlay timeline so the new precompute is visible.
      setRecalcSignal((c) => c + 1);
    }
  }, [date, mode]);

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

  // ── Sunlight timeline fetch (re-runs whenever date / ready changes) ───────
  const refreshTimeline = useCallback(
    (map: MapLibreMap, atDate: string) => {
      timelineAbortRef.current?.abort();
      const abort = new AbortController();
      timelineAbortRef.current = abort;
      void fetchTimeline({
        map,
        date: atDate,
        signal: abort.signal,
        onLoadingChange: setSunlightLoading,
        onError: (err) => console.warn("[maplibre-preview] timeline:", err),
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
          setTimelineFrames(frames);
          setFrameIndex(clamped);
        },
      });
    },
    // Intentionally only depends on stable setters / refs. showSunny / showShadow
    // are read at call time so a date change doesn't force toggle-coupled refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Trigger initial fetch + on every date change OR recalc bump.
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
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(initial),
      center: storedView ? [storedView.lon, storedView.lat] : DEFAULT_CENTER,
      zoom: storedView?.zoom ?? DEFAULT_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-left");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");

    map.on("load", () => {
      addPlacesLayers(map);
      attachPlacesInteractions(map, setSelectedPlace);
      setReady(true);

      const sunlightLayer = new MapLibreSunlightCustomLayer(map);
      map.addLayer(sunlightLayer, "cluster-circles");
      sunlightLayerRef.current = sunlightLayer;
      // TEMP: expose for visual A/B style testing
      (window as unknown as Record<string, unknown>).__sl = sunlightLayer;
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
      const sl = sunlightLayerRef.current;
      if (sl) {
        // MapLibre keeps the custom layer reference across setStyle but does
        // NOT call onAdd/onRemove on the swap. We force the lifecycle ourselves
        // so the layer reinitialises its GL program and re-uploads tile
        // textures into the (potentially) reset GL state machine.
        if (map.getLayer(sl.id)) map.removeLayer(sl.id);
        map.addLayer(sl, "cluster-circles");
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

  // Repaint sunlight overlay on slider / toggle changes.
  useEffect(() => {
    const layer = sunlightLayerRef.current;
    if (!layer) return;
    layer.setVisible(sunlightVisible);
    if (sunlightVisible) layer.setFrameIndex(frameIndex, showSunny, showShadow);
  }, [sunlightVisible, frameIndex, showSunny, showShadow]);

  // One-shot basemap swap: stay on Aquarelle while the first sunlight
  // timeline is loading, then flip to Satellite once the tiles are ready.
  // Subsequent date changes / recalculations don't re-trigger the swap, and
  // the user can still manually pick another basemap.
  const autoBasemapDone = useRef(false);
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

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      {/* Desktop horizontal search banner at the top of the screen. Hidden on
          mobile (the mobile search lives inside the left panel below). */}
      <div className="pointer-events-auto absolute left-1/2 top-3 z-10 hidden w-[420px] -translate-x-1/2 rounded-2xl bg-white/80 p-2 shadow-md backdrop-blur lg:block">
        <SearchPanel mapRef={mapRef} />
      </div>

      {/* Left control panel — date + filters (+ search on mobile).
          Mobile: full-width minus margins at top. Desktop: 280px sidebar. */}
      <div className="pointer-events-auto absolute left-3 right-3 top-3 z-10 flex flex-col gap-3 rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur lg:right-auto lg:w-[280px]">
        <ViewTabs
          activeTab={panelTab}
          venueCount={rawPlacesRef.current.length}
          onTabChange={(tab) => {
            setPanelTab(tab);
            if (tab === "terraces") {
              setShowPlaces(true);
            }
          }}
        />
        <CalculationControls
          mode={mode}
          date={date}
          isLoading={isCalculating}
          isDailyRangeInvalid={isDailyRangeInvalid}
          onDateChange={setDate}
          onRunCalculation={() => void handleRunCalculation()}
          onCancelDailyCalculation={handleCancelDailyCalculation}
        />
        {/* DECISION: instant/daily toggle UI not provided by CalculationControls
            itself — adding a small segmented control here so the user can flip
            mode. Defaults to "daily" like the Leaflet client. */}
        <div className="flex gap-2 text-sm">
          <button
            type="button"
            className={`flex-1 rounded-lg px-3 py-2 font-semibold transition ${
              mode === "instant"
                ? "bg-amber-200 text-slate-950"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
            onClick={() => setMode("instant")}
          >
            Instant
          </button>
          <button
            type="button"
            className={`flex-1 rounded-lg px-3 py-2 font-semibold transition ${
              mode === "daily"
                ? "bg-amber-200 text-slate-950"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
            onClick={() => setMode("daily")}
          >
            Daily
          </button>
        </div>
        <ProgressStatus
          mode={mode}
          dailyProgress={dailyProgress}
          instantProgress={instantProgress}
          formatDuration={formatDuration}
        />
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
          // DECISION: no cache-only UI in the preview yet; provide a no-op so
          // LayerFilters' contract is satisfied. Wiring will land with the
          // admin/cache-only chunk later.
          onCacheOnlyChange={() => {}}
        />
        <div className="lg:hidden">
          <SearchPanel mapRef={mapRef} />
        </div>
        <FilterPanel filters={filters} onChange={setFilters} />
        <StylePanel settings={styleSettings} onChange={setStyleSettings} />
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
          <>
            <input
              type="range"
              min={0}
              max={timelineFrames.length - 1}
              value={frameIndex}
              onChange={(e) => setFrameIndex(Number(e.target.value))}
              style={{ width: "140px" }}
            />
            <span className="w-12 text-center">
              {timelineFrames[frameIndex]?.localTime ?? "--:--"}
            </span>
          </>
        )}

        {sunlightLoading && <span className="text-gray-500">chargement…</span>}
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
