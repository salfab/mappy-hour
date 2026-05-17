import maplibregl, { type Map as MapLibreMap, type FilterSpecification } from "maplibre-gl";
import type { NormalizedPlaceLite } from "@/components/places-overlay/viewport-places";

export interface ViewportPlaceLite extends NormalizedPlaceLite {
  osmType: "node" | "way" | "relation";
  osmId: number;
}

export interface SunlightWindow {
  startLocalTime: string;
  endLocalTime: string;
}

/** `/api/places/windows` returns mixed shapes: `HH:mm` (tile cache fast path)
 *  or `YYYY-MM-DD HH:mm:ss` (GPU fallback). Extract the first `HH:mm`. */
export function formatCardClock(value: string): string {
  const match = /\b(\d{2}:\d{2})(?::\d{2})?\b/.exec(value);
  return match ? match[1] : value;
}

export function viewportCardEmoji(place: ViewportPlaceLite): string {
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

export function placesToFeatureCollection(
  places: ViewportPlaceLite[],
): GeoJSON.FeatureCollection {
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
        // Outdoor-snap audit trail: needed downstream by the click handler so
        // the selected-place overlay can draw the OSM → evaluation pointer.
        selectionStrategy: p.selectionStrategy ?? "original",
        osmLat: p.osmLat ?? null,
        osmLon: p.osmLon ?? null,
      },
    })),
  };
}

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
  "#3b82f6",
];

export function addPlacesLayers(map: MapLibreMap) {
  if (map.getSource("places")) return;

  map.addSource("places", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 50,
  });

  map.addLayer({
    id: "cluster-circles",
    type: "circle",
    source: "places",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": [
        "step", ["get", "point_count"],
        "#60a5fa", 10, "#3b82f6", 30, "#1d4ed8", 100, "#1e3a8a",
      ],
      "circle-radius": [
        "step", ["get", "point_count"],
        14, 10, 18, 30, 22, 100, 28,
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
      // demotiles.maplibre.org only ships "Open Sans Semibold" + "Noto Sans Regular".
      "text-font": ["Open Sans Semibold"],
      "text-size": 13,
      "text-allow-overlap": true,
    },
    paint: { "text-color": "#ffffff" },
  });

  const unclusteredFilter: FilterSpecification = [
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
        "interpolate", ["linear"], ["zoom"],
        12, 3, 15, 5, 18, 7,
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
      "text-font": ["Open Sans Semibold"],
      "text-size": [
        "interpolate", ["linear"], ["zoom"],
        13, 0, 14, 10, 16, 12, 18, 14,
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

export function attachPlacesInteractions(
  map: MapLibreMap,
  onSelectPlace: (place: ViewportPlaceLite) => void,
) {
  map.on("click", "cluster-circles", (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: ["cluster-circles"] });
    const clusterId = features[0]?.properties?.cluster_id;
    if (clusterId == null) return;
    const source = map.getSource("places") as maplibregl.GeoJSONSource;
    source.getClusterExpansionZoom(clusterId).then((zoom) => {
      const geom = features[0].geometry as GeoJSON.Point;
      map.easeTo({ center: geom.coordinates as [number, number], zoom });
    }).catch(() => {});
  });

  map.on("click", "places-dots", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const p = (f.properties ?? {}) as Record<string, unknown>;
    onSelectPlace({
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
      // Outdoor-snap fields, needed by the selected-place overlay to draw
      // the OSM → evaluation pointer when the place was nudged.
      selectionStrategy:
        (p.selectionStrategy as ViewportPlaceLite["selectionStrategy"]) ?? "original",
      osmLat: typeof p.osmLat === "number" ? p.osmLat : undefined,
      osmLon: typeof p.osmLon === "number" ? p.osmLon : undefined,
    });
  });

  for (const layerId of ["cluster-circles", "places-dots"]) {
    map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
  }
}
