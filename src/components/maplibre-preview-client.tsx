"use client";

/**
 * MapLibre GL JS preview — Phase 1 of the Leaflet -> MapLibre migration.
 *
 * Goals (intentionally narrow):
 *  - Demonstrate the 4 raster basemaps (Aquarelle = Stamen Watercolor +
 *    CARTO Voyager labels, CARTO Voyager, OSM standard, Esri Satellite)
 *    with a switcher UI.
 *  - Render the OSM places overlay through a NATIVE MapLibre GeoJSON source
 *    with built-in clustering + symbol layers. Validates whether MapLibre's
 *    label engine fixes the "labels slide during zoom anim" issue the
 *    home-grown Leaflet overlay has.
 *  - No sunlight / shadow overlay. That's Phase 2.
 *
 * This component is NOT integrated in the main `/` route — the existing
 * Leaflet `SunlightMapClient` is untouched. The preview lives at
 * `/maplibre-preview` so the user can A/B both implementations side-by-side
 * before we tackle the sunlight overlay port.
 */

import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type BaseMapId = "aquarelle" | "carto-voyager" | "osm" | "satellite";

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
const DEFAULT_ZOOM = 13;

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

  map.addSource("places", {
    type: "geojson",
    // Fetched via the GET /api/places?format=geojson endpoint. Inline data
    // (no bbox filter server-side) — MapLibre handles viewport culling.
    // `outdoorOnly=true` pulls the same "confirmed terrasses" subset that
    // `/api/places/viewport?mode=confirmed` serves to Leaflet, so the
    // cluster point_count is consistent across the two maps. food_court is
    // still excluded client-side via the unclustered-layer filter below
    // (the `/api/places` endpoint doesn't do subcategory filtering — fine,
    // food_court is a tiny minority).
    data: "/api/places?format=geojson&outdoorOnly=true",
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

function attachInteractions(map: MapLibreMap) {
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

  // Single point click -> popup.
  map.on("click", "places-dots", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const coords = (f.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
    const name = String(props.name ?? "(sans nom)");
    const subcat = String(props.subcategory ?? "");
    const hasOutdoor = props.hasOutdoorSeating === true || props.hasOutdoorSeating === "true";
    const osmType = String(props.osmType ?? "");
    const osmId = String(props.osmId ?? "");
    const osmUrl = osmType && osmId ? `https://www.openstreetmap.org/${osmType}/${osmId}` : null;
    const html = `
      <div style="font: 13px/1.4 system-ui, sans-serif; min-width: 180px;">
        <div style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(name)}</div>
        <div style="color: #6b7280; font-size: 12px; margin-bottom: 6px;">${escapeHtml(subcat)}</div>
        <div style="margin-bottom: 6px;">
          ${hasOutdoor ? "🌞 Terrasse confirmée" : "❔ Terrasse non confirmée"}
        </div>
        ${osmUrl ? `<a href="${osmUrl}" target="_blank" rel="noreferrer" style="color: #2563eb; font-size: 12px;">Voir sur OSM ↗</a>` : ""}
      </div>
    `;
    new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
      .setLngLat(coords)
      .setHTML(html)
      .addTo(map);
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function MapLibrePreviewClient() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [basemapId, setBasemapId] = useState<BaseMapId>("aquarelle");
  const [ready, setReady] = useState(false);

  // Build basemap defs once. Stadia key is a public env, baked at build.
  const baseMapsRef = useRef<BaseMapDef[] | null>(null);
  if (baseMapsRef.current === null) {
    baseMapsRef.current = buildBaseMaps(process.env.NEXT_PUBLIC_STADIA_API_KEY);
  }

  // Mount the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const baseMaps = baseMapsRef.current!;
    const initial = baseMaps.find((b) => b.id === "aquarelle") ?? baseMaps[0];
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(initial),
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      maxZoom: 20,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-left");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");

    map.on("load", () => {
      addPlacesLayers(map);
      attachInteractions(map);
      setReady(true);
    });

    // On every style swap (basemap switcher), re-add the places overlay
    // because setStyle wipes user-added sources/layers by default.
    map.on("styledata", () => {
      if (!map.getSource("places")) {
        addPlacesLayers(map);
        attachInteractions(map);
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Apply basemap switches.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const baseMaps = baseMapsRef.current!;
    const target = baseMaps.find((b) => b.id === basemapId);
    if (!target) return;
    map.setStyle(buildStyle(target));
  }, [basemapId, ready]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
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
      {/* Phase tag */}
      <div
        className="absolute bottom-3 right-3 z-10 rounded-md bg-white/95 px-3 py-2 shadow-md backdrop-blur"
        style={{ font: "12px system-ui, sans-serif" }}
      >
        <div className="font-semibold text-gray-800">MapLibre preview — Phase 1</div>
        <div className="text-gray-600">
          Basemap natif + clustering GeoJSON. Pas d&apos;overlay soleil (Phase 2).
        </div>
        <a href="/" className="mt-1 inline-block text-blue-600 hover:underline">
          ← Retour à la carte Leaflet
        </a>
      </div>
    </div>
  );
}
