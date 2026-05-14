"use client";

/**
 * MapLibre GL JS preview — Phase 1 + 2 of the Leaflet -> MapLibre migration.
 *
 * Phase 1 goals (done):
 *  - Demonstrate the 4 raster basemaps (Aquarelle = Stamen Watercolor +
 *    CARTO Voyager labels, CARTO Voyager, OSM standard, Esri Satellite)
 *    with a switcher UI.
 *  - Render the OSM places overlay through a NATIVE MapLibre GeoJSON source
 *    with built-in clustering + symbol layers.
 *
 * Phase 2 goals (done):
 *  - Port the sunlight / shadow overlay via `BitmapTileOverlay` + a thin
 *    `MapLike` adapter that bridges `map.project()` to the Leaflet-style
 *    `latLngToLayerPoint` API.
 *  - SSE timeline fetch for the current viewport bbox.
 *  - Slider UI for frame selection + sunny/shadow toggles.
 *
 * This component is NOT integrated in the main `/` route — the existing
 * Leaflet `SunlightMapClient` is untouched. The preview lives at
 * `/maplibre-preview` so the user can A/B both implementations side-by-side.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  MapLibreSunlightCustomLayer,
  type TimelineTile,
} from "@/components/sunlight-overlay/maplibre-sunlight-custom-layer";
import { decodeTileMasksBlob } from "@/lib/encoding/mask-codec-client";
import type { NormalizedPlaceLite } from "@/components/places-overlay/viewport-places";
import { DaySelector } from "@/components/map-ui/controls";

type BaseMapId = "aquarelle" | "carto-voyager" | "osm" | "satellite";

interface ViewportPlaceLite extends NormalizedPlaceLite {
  osmType: "node" | "way" | "relation";
  osmId: number;
}

interface SunlightWindow {
  startLocalTime: string;
  endLocalTime: string;
}

/** Same logic as sunlight-map-client. The /api/places/windows route returns mixed
 *  shapes; this extracts the `HH:mm` from either `HH:mm` or `YYYY-MM-DD HH:mm:ss`. */
function formatCardClock(value: string): string {
  const match = /\b(\d{2}:\d{2})(?::\d{2})?\b/.exec(value);
  return match ? match[1] : value;
}

function viewportCardEmoji(place: ViewportPlaceLite): string {
  if (place.category === "park") return "🌳";
  switch (place.subcategory) {
    case "cafe": return "☕";
    case "bar":
    case "pub": return "🍺";
    case "restaurant": return "🍴";
    case "fast_food": return "🥡";
    default: return "📍";
  }
}

function placesToFeatureCollection(places: ViewportPlaceLite[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: places.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: {
        id: p.id,
        name: p.name,
        category: p.category,
        subcategory: p.subcategory,
        hasOutdoorSeating: p.hasOutdoorSeating,
        hasOutdoorSeatingUnknown: p.hasOutdoorSeatingUnknown ?? false,
        openingHours: p.openingHours ?? "",
        osmType: p.osmType,
        osmId: p.osmId,
        lat: p.lat,
        lon: p.lon,
      },
    })),
  };
}

interface BaseMapDef {
  id: BaseMapId;
  label: string;
  /** Tile URL templates (MapLibre `tiles` array). Multiple entries become
   *  one source with subdomain rotation. */
  baseTiles: string[];
  baseAttribution: string;
  /** Optional overlay raster stacked on top of the base (e.g. CARTO labels
   *  on top of Stamen Watercolor). */
  overlayTiles?: string[];
  overlayAttribution?: string;
  maxZoom: number;
  tileSize?: number;
}

// Same set/order as the Leaflet implementation in sunlight-map-client.tsx.
function buildBaseMaps(stadiaApiKey: string | undefined): BaseMapDef[] {
  // Stadia hosts the Stamen watercolor tiles; the API key is appended as a
  // query string in prod. Anonymous in dev (low rate limit).
  const withKey = (url: string): string => {
    if (!stadiaApiKey || !url.includes("tiles.stadiamaps.com")) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}api_key=${stadiaApiKey}`;
  };
  return [
    {
      id: "aquarelle",
      label: "Aquarelle",
      baseTiles: [withKey("https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg")],
      baseAttribution:
        "© <a href=\"https://stamen.com\">Stamen Design</a> / <a href=\"https://stadiamaps.com/\">Stadia Maps</a>",
      overlayTiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
      ],
      overlayAttribution: "Labels © CARTO",
      maxZoom: 18,
    },
    {
      id: "carto-voyager",
      label: "CARTO Voyager",
      baseTiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
      ],
      baseAttribution: "© OpenStreetMap contributors © CARTO",
      maxZoom: 20,
    },
    {
      id: "osm",
      label: "OSM standard",
      baseTiles: [
        "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
      ],
      baseAttribution: "© OpenStreetMap contributors",
      maxZoom: 19,
    },
    {
      id: "satellite",
      label: "Satellite",
      baseTiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      baseAttribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics",
      maxZoom: 19,
    },
  ];
}

/** Build a MapLibre style for a given basemap. The PLACES source/layers are
 *  added separately after the map is ready (they survive a `setStyle`
 *  re-load in the switcher because we re-add them on `styledata`). */
function buildStyle(basemap: BaseMapDef): StyleSpecification {
  const sources: StyleSpecification["sources"] = {
    "basemap-raster": {
      type: "raster",
      tiles: basemap.baseTiles,
      tileSize: basemap.tileSize ?? 256,
      attribution: basemap.baseAttribution,
      maxzoom: basemap.maxZoom,
    },
  };
  const layers: StyleSpecification["layers"] = [
    {
      id: "basemap-raster-layer",
      type: "raster",
      source: "basemap-raster",
    },
  ];
  if (basemap.overlayTiles && basemap.overlayTiles.length > 0) {
    sources["basemap-overlay"] = {
      type: "raster",
      tiles: basemap.overlayTiles,
      tileSize: 256,
      attribution: basemap.overlayAttribution ?? "",
      maxzoom: 20,
    };
    layers.push({
      id: "basemap-overlay-layer",
      type: "raster",
      source: "basemap-overlay",
    });
  }
  return {
    version: 8,
    // Glyph URL needed for symbol layers (text rendering). Demotiles is the
    // public MapLibre glyphs endpoint — fine for the preview.
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources,
    layers,
  };
}

// Lausanne center, same as the Leaflet default.
const DEFAULT_CENTER: [number, number] = [6.6323, 46.5197]; // [lng, lat] for MapLibre
const DEFAULT_ZOOM = 17;

// localStorage key shared with the Leaflet client (sunlight-map-client.tsx)
// so the map view persists across the two pages.
const MAP_VIEW_STORAGE_KEY = "mappy-hour:map:view";
const MAP_MAX_ZOOM = 20;

interface StoredMapView {
  lat: number;
  lon: number;
  zoom: number;
}

function loadStoredMapView(): StoredMapView | null {
  try {
    const raw = globalThis.localStorage?.getItem(MAP_VIEW_STORAGE_KEY);
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

function persistMapView(view: StoredMapView): void {
  try {
    globalThis.localStorage?.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Ignore storage errors (private browsing, quota, etc.).
  }
}

// Subcategory -> color. Same palette intent as Leaflet overlay (amber/red/violet/gray/green).
const SUBCATEGORY_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "subcategory"],
  "cafe", "#f59e0b",
  "restaurant", "#ef4444",
  "bar", "#8b5cf6",
  "pub", "#8b5cf6",
  "biergarten", "#22c55e",
  "fast_food", "#9ca3af",
  "park", "#16a34a",
  /* default */ "#3b82f6",
];

function addPlacesLayers(map: MapLibreMap) {
  if (map.getSource("places")) return; // already added

  // Empty source initially — populated via /api/places/viewport on moveend.
  // We use the viewport endpoint (POST with bounds) instead of /api/places
  // because it surfaces `openingHours` and other rich fields needed by the
  // place detail card.
  map.addSource("places", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 50,
  });

  // Cluster circles — sized by point_count.
  map.addLayer({
    id: "cluster-circles",
    type: "circle",
    source: "places",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": [
        "step",
        ["get", "point_count"],
        "#60a5fa", // < 10
        10, "#3b82f6", // 10-30
        30, "#1d4ed8", // 30-100
        100, "#1e3a8a", // >= 100
      ],
      "circle-radius": [
        "step",
        ["get", "point_count"],
        14,
        10, 18,
        30, 22,
        100, 28,
      ],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
      "circle-opacity": 0.9,
    },
  });

  map.addLayer({
    id: "cluster-counts",
    type: "symbol",
    source: "places",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      // demotiles.maplibre.org only ships "Open Sans Semibold" and
      // "Noto Sans Regular" today — confirmed via curl 2026-05-13. Any
      // other name (incl. "Open Sans Regular" / "Open Sans Bold") returns
      // 404 and MapLibre warns 50× per render.
      "text-font": ["Open Sans Semibold"],
      "text-size": 13,
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": "#ffffff",
    },
  });

  // Unclustered points — circle for the dot, separate symbol layer for the
  // label. The source is already pre-filtered to confirmed terrasses (see
  // `outdoorOnly=true` above), so we only need to drop food_court here.
  const unclusteredFilter: maplibregl.FilterSpecification = [
    "all",
    ["!", ["has", "point_count"]],
    ["!=", ["get", "subcategory"], "food_court"],
  ];

  map.addLayer({
    id: "places-dots",
    type: "circle",
    source: "places",
    filter: unclusteredFilter,
    paint: {
      "circle-color": SUBCATEGORY_COLOR_EXPR,
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        12, 3,
        15, 5,
        18, 7,
      ],
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#ffffff",
      "circle-opacity": 0.95,
    },
  });

  map.addLayer({
    id: "places-labels",
    type: "symbol",
    source: "places",
    filter: unclusteredFilter,
    minzoom: 13,
    layout: {
      "text-field": ["get", "name"],
      // demotiles.maplibre.org only ships "Open Sans Semibold" and
      // "Noto Sans Regular" today — confirmed via curl 2026-05-13. Any
      // other name (incl. "Open Sans Regular" / "Open Sans Bold") returns
      // 404 and MapLibre warns 50× per render.
      "text-font": ["Open Sans Semibold"],
      "text-size": [
        "interpolate",
        ["linear"],
        ["zoom"],
        13, 0,
        14, 10,
        16, 12,
        18, 14,
      ],
      "text-anchor": "top",
      "text-offset": [0, 0.8],
      "text-allow-overlap": false,
      "text-optional": true,
    },
    paint: {
      "text-color": "#111827",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  });
}

function attachInteractions(
  map: MapLibreMap,
  onSelectPlace: (place: ViewportPlaceLite) => void,
) {
  // Cluster click -> zoom in.
  map.on("click", "cluster-circles", (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: ["cluster-circles"] });
    const clusterId = features[0]?.properties?.cluster_id;
    if (clusterId == null) return;
    const source = map.getSource("places") as maplibregl.GeoJSONSource;
    source.getClusterExpansionZoom(clusterId).then((zoom) => {
      const geom = features[0].geometry as GeoJSON.Point;
      map.easeTo({
        center: geom.coordinates as [number, number],
        zoom,
      });
    }).catch(() => {});
  });

  // Single point click -> open the detail card. Properties were JSON-encoded
  // into the feature by placesToFeatureCollection, so we just rehydrate them.
  map.on("click", "places-dots", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const place: ViewportPlaceLite = {
      id: String(p.id ?? ""),
      name: String(p.name ?? "(sans nom)"),
      category: (p.category as ViewportPlaceLite["category"]) ?? "terrace_candidate",
      subcategory: String(p.subcategory ?? ""),
      lat: Number(p.lat),
      lon: Number(p.lon),
      hasOutdoorSeating: p.hasOutdoorSeating === true || p.hasOutdoorSeating === "true",
      hasOutdoorSeatingUnknown:
        p.hasOutdoorSeatingUnknown === true || p.hasOutdoorSeatingUnknown === "true",
      openingHours: typeof p.openingHours === "string" && p.openingHours.length > 0
        ? p.openingHours
        : undefined,
      osmType: (p.osmType as ViewportPlaceLite["osmType"]) ?? "node",
      osmId: Number(p.osmId),
    };
    onSelectPlace(place);
  });

  for (const layerId of ["cluster-circles", "places-dots"]) {
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  }
}

export function MapLibrePreviewClient() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [basemapId, setBasemapId] = useState<BaseMapId>("aquarelle");
  const [ready, setReady] = useState(false);

  // ── Sunlight state ──────────────────────────────────────────────────────────
  const [sunlightVisible, setSunlightVisible] = useState(true);
  const [showSunny, setShowSunny] = useState(true);
  const [showShadow, setShowShadow] = useState(true);
  const [frameIndex, setFrameIndex] = useState(0);
  const [timelineFrames, setTimelineFrames] = useState<Array<{ localTime: string }>>([]);
  const [sunlightLoading, setSunlightLoading] = useState(false);
  // Local date (YYYY-MM-DD) used for both the timeline SSE and the place
  // card's /api/places/windows fetch. Defaults to today in Europe/Zurich.
  const [date, setDate] = useState<string>(() =>
    new Date().toLocaleDateString("sv", { timeZone: "Europe/Zurich" }),
  );
  const sunlightLayerRef = useRef<MapLibreSunlightCustomLayer | null>(null);

  // ── Place card state ────────────────────────────────────────────────────────
  const [selectedPlace, setSelectedPlace] = useState<ViewportPlaceLite | null>(null);
  const [cardSunlightWindows, setCardSunlightWindows] = useState<SunlightWindow[] | null>(null);
  const [isCardSunlightLoading, setIsCardSunlightLoading] = useState(false);
  const [cardSunlightError, setCardSunlightError] = useState<string | null>(null);
  const cardSunlightRequestRef = useRef(0);
  const viewportPlacesDebounceRef = useRef<number | null>(null);
  const viewportPlacesAbortRef = useRef<AbortController | null>(null);

  // Build basemap defs once. Stadia key is a public env, baked at build.
  const baseMapsRef = useRef<BaseMapDef[] | null>(null);
  if (baseMapsRef.current === null) {
    baseMapsRef.current = buildBaseMaps(process.env.NEXT_PUBLIC_STADIA_API_KEY);
  }

  // ── SSE timeline fetch ──────────────────────────────────────────────────────
  const fetchTimeline = useCallback(async (map: MapLibreMap, date: string) => {
    setSunlightLoading(true);
    const bounds = map.getBounds();
    const params = new URLSearchParams({
      minLon: String(bounds.getWest()),
      minLat: String(bounds.getSouth()),
      maxLon: String(bounds.getEast()),
      maxLat: String(bounds.getNorth()),
      date,
      timezone: "Europe/Zurich",
      startLocalTime: "06:00",
      endLocalTime: "21:00",
      sampleEveryMinutes: "30",
      gridStepMeters: "1",
      maxPoints: "2000000",
      buildingHeightBiasMeters: "0",
      cacheOnly: "true",
    });

    try {
      const response = await fetch(`/api/sunlight/timeline/stream?${params.toString()}`);
      if (!response.ok || !response.body) {
        console.error("[maplibre-preview] SSE fetch failed:", response.status);
        setSunlightLoading(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const collectedTiles: TimelineTile[] = [];
      // Pending gzip decodes — started per-tile, awaited before setTimeline.
      // Same pattern as sunlight-map-client.tsx to avoid blocking the read loop.
      const pendingDecodes: Promise<void>[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE blocks separated by double newlines.
        const blocks = buffer.split(/\n\n/);
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          if (!block.trim()) continue;
          const lines = block.split("\n");
          let eventType = "";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataStr = line.slice(5).trim();
            }
          }

          if (!eventType || !dataStr) continue;

          try {
            const payload = JSON.parse(dataStr) as Record<string, unknown>;

            if (eventType === "start") {
              collectedTiles.length = 0;
              pendingDecodes.length = 0;
            } else if (eventType === "tile") {
              const tile = payload as unknown as TimelineTile & {
                masksEncoding?: string;
                masksBase64?: string;
                grid?: { width: number; height: number };
              };
              // Fire gzip decode in the background — do NOT await here so the
              // read loop keeps consuming chunks without stalling on each tile.
              if (tile.masksEncoding === "gzip-concat-v1" && tile.masksBase64 && tile.grid) {
                const maskBytes = Math.ceil(tile.grid.width * tile.grid.height / 8);
                const frameCount = tile.frames.length;
                pendingDecodes.push(
                  decodeTileMasksBlob(tile.masksBase64, maskBytes, frameCount).then((decoded) => {
                    tile.decodedMasks = decoded;
                  }),
                );
              }
              collectedTiles.push(tile);
            } else if (eventType === "done") {
              // Wait for all background gzip decodes to finish before painting.
              await Promise.all(pendingDecodes);
              const layer = sunlightLayerRef.current;
              if (layer) {
                layer.setTimeline(collectedTiles, 0, showSunny, showShadow);
              }
              // Extract frame list from the first tile for the slider.
              const firstTile = collectedTiles[0];
              if (firstTile?.frames) {
                setTimelineFrames(firstTile.frames.map((f) => ({ localTime: f.localTime })));
              }
              setFrameIndex(0);
              setSunlightLoading(false);
            } else if (eventType === "error") {
              console.error("[maplibre-preview] SSE error event:", payload);
              setSunlightLoading(false);
            }
          } catch (parseErr) {
            console.warn("[maplibre-preview] SSE parse error:", parseErr);
          }
        }
      }
    } catch (err) {
      console.error("[maplibre-preview] SSE stream error:", err);
      setSunlightLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Viewport places fetch (POST /api/places/viewport) ─────────────────────
  const fetchViewportPlaces = useCallback(async (map: MapLibreMap) => {
    const previous = viewportPlacesAbortRef.current;
    if (previous) previous.abort();
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
      const places = Array.isArray(json.places) ? json.places : [];
      const source = map.getSource("places") as maplibregl.GeoJSONSource | undefined;
      if (source) source.setData(placesToFeatureCollection(places));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.warn("[maplibre-preview] viewport places fetch failed:", err);
    }
  }, []);

  // ── Sunlight windows fetch on place selection (POST /api/places/windows) ───
  useEffect(() => {
    if (!selectedPlace) {
      setCardSunlightWindows(null);
      setCardSunlightError(null);
      setIsCardSunlightLoading(false);
      return;
    }
    const token = ++cardSunlightRequestRef.current;
    const place = selectedPlace;
    // ~5 m offset around the place: 1° lat ≈ 111 320 m. Clamp lon by cos(lat).
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
          if (response.status === 400 || response.status === 404) {
            setCardSunlightError("Lancer un calcul du jour pour voir l'ensoleillement.");
          } else {
            setCardSunlightError("Erreur de chargement de l'ensoleillement.");
          }
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
        setCardSunlightError(
          err instanceof Error ? err.message : "Erreur de chargement.",
        );
        setIsCardSunlightLoading(false);
      });
    return () => controller.abort();
  }, [selectedPlace, date]);

  // Refetch the timeline SSE whenever the user changes the date.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    void fetchTimeline(map, date);
  }, [date, ready, fetchTimeline]);

  // Mount the map once.
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
      attachInteractions(map, setSelectedPlace);
      setReady(true);

      // Instantiate the sunlight custom layer (WebGL) and insert it BEFORE
      // cluster-circles so clusters always render on top of the sunlight overlay.
      const sunlightLayer = new MapLibreSunlightCustomLayer(map);
      map.addLayer(sunlightLayer, "cluster-circles");
      sunlightLayerRef.current = sunlightLayer;
      // The date-watching effect triggers the initial fetchTimeline once
      // setReady(true) above causes it to re-evaluate.
      void fetchViewportPlaces(map);
    });

    // Debounced viewport places fetch on map move/zoom. Mirrors the Leaflet
    // implementation: 400ms debounce, abort in-flight requests on re-trigger.
    // Also persists the current view to localStorage so reloads keep the
    // user's pan/zoom (shared key with the Leaflet page).
    map.on("moveend", () => {
      const center = map.getCenter();
      persistMapView({
        lat: Number(center.lat.toFixed(6)),
        lon: Number(center.lng.toFixed(6)),
        zoom: map.getZoom(),
      });
      if (viewportPlacesDebounceRef.current !== null) {
        window.clearTimeout(viewportPlacesDebounceRef.current);
      }
      viewportPlacesDebounceRef.current = window.setTimeout(() => {
        void fetchViewportPlaces(map);
      }, 400);
    });

    // On every style swap (basemap switcher), re-add user layers because
    // setStyle wipes all user-added sources/layers by default.
    map.on("styledata", () => {
      if (!map.getSource("places")) {
        addPlacesLayers(map);
        attachInteractions(map, setSelectedPlace);
        // After a style swap, the source is freshly empty — repopulate it.
        void fetchViewportPlaces(map);
      }
      // Re-add the sunlight custom layer before cluster-circles if setStyle
      // removed it. The layer object keeps its CPU tile data across swaps
      // (disposeGPU in onRemove preserves luminance buffers); onAdd will
      // recreate GL textures and triggerRepaint automatically.
      const sl = sunlightLayerRef.current;
      if (sl && !map.getLayer(sl.id)) {
        map.addLayer(sl, "cluster-circles");
      }
    });

    return () => {
      if (viewportPlacesDebounceRef.current !== null) {
        window.clearTimeout(viewportPlacesDebounceRef.current);
        viewportPlacesDebounceRef.current = null;
      }
      viewportPlacesAbortRef.current?.abort();
      viewportPlacesAbortRef.current = null;
      map.remove();
      sunlightLayerRef.current?.dispose();
      sunlightLayerRef.current = null;
      mapRef.current = null;
    };
  }, [fetchTimeline, fetchViewportPlaces]);

  // Apply basemap switches.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const baseMaps = baseMapsRef.current!;
    const target = baseMaps.find((b) => b.id === basemapId);
    if (!target) return;
    map.setStyle(buildStyle(target));
  }, [basemapId, ready]);

  // Repaint the sunlight overlay when the slider or toggles change.
  useEffect(() => {
    const layer = sunlightLayerRef.current;
    if (!layer) return;
    layer.setVisible(sunlightVisible);
    if (sunlightVisible) {
      layer.setFrameIndex(frameIndex, showSunny, showShadow);
    }
  }, [sunlightVisible, frameIndex, showSunny, showShadow]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      {/* Left control panel — date picker (matches the Leaflet main page). */}
      <div className="pointer-events-auto absolute left-3 top-3 z-10 w-[260px] rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur">
        <DaySelector date={date} onDateChange={setDate} />
      </div>

      {/* Basemap switcher */}
      <div
        className="absolute top-3 right-3 z-10 rounded-md bg-white/95 px-2 py-2 shadow-md backdrop-blur"
        style={{ font: "13px system-ui, sans-serif" }}
      >
        <div className="mb-1 px-1 text-xs font-semibold text-gray-700">Basemap</div>
        <div className="flex flex-col gap-1">
          {baseMapsRef.current!.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setBasemapId(b.id)}
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
      {/* Sunlight overlay controls */}
      <div
        className="absolute bottom-10 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2
          rounded-md bg-white/95 px-3 py-2 shadow-md backdrop-blur"
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
          onClick={() => setShowSunny((v) => !v)}
          className={showSunny ? "opacity-100" : "opacity-40"}
          title="Ensoleillé"
          style={{ fontSize: "16px", lineHeight: 1 }}
        >
          ☀
        </button>

        <button
          type="button"
          onClick={() => setShowShadow((v) => !v)}
          className={showShadow ? "opacity-100" : "opacity-40"}
          title="Ombragé"
          style={{ fontSize: "16px", lineHeight: 1 }}
        >
          🌑
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

        {sunlightLoading && (
          <span className="text-gray-500">chargement…</span>
        )}
      </div>

      {/* Phase tag */}
      <div
        className="absolute bottom-3 right-3 z-10 rounded-md bg-white/95 px-3 py-2 shadow-md backdrop-blur"
        style={{ font: "12px system-ui, sans-serif" }}
      >
        <div className="font-semibold text-gray-800">MapLibre preview — Phase 3</div>
        <div className="text-gray-600">
          Overlay soleil WebGL custom layer (Phase 3 ✓). Clusters au-dessus.
        </div>
        <a href="/" className="mt-1 inline-block text-blue-600 hover:underline">
          ← Retour à la carte Leaflet
        </a>
      </div>

      {/* Place detail card — same look as the Leaflet implementation, reuses
          the `vpo-card-*` classes defined in globals.css. */}
      {selectedPlace ? (
        <div className="vpo-card" role="dialog" aria-label="Détails du lieu">
          <div className="flex items-start justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <p className="truncate text-sm font-semibold text-slate-900">
                {viewportCardEmoji(selectedPlace)} {selectedPlace.name}
              </p>
              <p className="text-xs text-slate-500">
                {selectedPlace.subcategory || selectedPlace.category}
              </p>
            </div>
            <button
              type="button"
              className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              onClick={() => setSelectedPlace(null)}
              aria-label="Fermer"
            >
              ×
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                selectedPlace.hasOutdoorSeating
                  ? "bg-amber-100 text-amber-900 ring-amber-200"
                  : selectedPlace.hasOutdoorSeatingUnknown
                    ? "bg-slate-100 text-slate-600 ring-slate-200"
                    : "bg-rose-100 text-rose-700 ring-rose-200"
              }`}
            >
              {selectedPlace.hasOutdoorSeating
                ? "Terrasse ✓"
                : selectedPlace.hasOutdoorSeatingUnknown
                  ? "Terrasse ?"
                  : "Pas de terrasse"}
            </span>
          </div>

          <div className="vpo-card-divider" />
          <div className="vpo-card-section">
            <p className="vpo-card-section-title">Heures d&apos;ouverture</p>
            {selectedPlace.openingHours ? (
              <ul className="vpo-card-hours-list">
                {selectedPlace.openingHours
                  .split(";")
                  .map((segment) => segment.trim())
                  .filter((segment) => segment.length > 0)
                  .map((segment, idx) => (
                    <li key={idx}>{segment}</li>
                  ))}
              </ul>
            ) : (
              <p className="vpo-card-muted">Horaires non renseignés</p>
            )}
          </div>

          <div className="vpo-card-divider" />
          <div className="vpo-card-section">
            <p className="vpo-card-section-title">Ensoleillement aujourd&apos;hui</p>
            {isCardSunlightLoading ? (
              <p className="vpo-card-muted">Calcul en cours…</p>
            ) : cardSunlightError ? (
              <p className="vpo-card-muted">{cardSunlightError}</p>
            ) : cardSunlightWindows && cardSunlightWindows.length > 0 ? (
              <div className="vpo-card-sun-pills">
                {cardSunlightWindows.map((w, idx) => (
                  <span key={idx} className="vpo-card-sun-pill">
                    {formatCardClock(w.startLocalTime)} – {formatCardClock(w.endLocalTime)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="vpo-card-muted">Aucune fenêtre ensoleillée ce jour</p>
            )}
          </div>

          <a
            className="mt-3 inline-block text-xs font-semibold text-amber-700 hover:text-amber-900"
            href={`https://www.openstreetmap.org/${selectedPlace.osmType}/${selectedPlace.osmId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Voir sur OpenStreetMap →
          </a>
        </div>
      ) : null}
    </div>
  );
}
