/**
 * Framework-agnostic Leaflet wrapper around the pure
 * `viewport-places.ts` logic. Owns a single `L.layerGroup`, listens to
 * `moveend`/`zoomend`, and emits glyphs / labels / clusters per LOD.
 *
 * Mirrors the shape of `BitmapTileOverlay` (constructor + verbs, no internal
 * React state). The owning React component decides WHEN to call `setPlaces`
 * / `setFilters` / `dispose`; this class only reacts to map events.
 */

import type {
  CircleMarker,
  DivIcon,
  LayerGroup,
  Map as LeafletMap,
  Marker,
} from "leaflet";

import {
  applyHardLimit,
  clusterPoints,
  CLUSTER_CELL_PX,
  filterPlacesInBounds,
  MAX_RENDERED,
  pickLod,
  type NormalizedPlaceLite,
  type ViewportClusterPoint,
  type ViewportPlaceLod,
} from "./viewport-places";

export interface PlacesViewportOverlayFilters {
  showParks: boolean;
  showTerraces: boolean;
  /** Kept for source/binary compat with previous callers. With the default
   *  `/api/places/viewport?mode=confirmed` server-side prefilter, the
   *  unconfirmed places never reach the client so this flag is now a no-op
   *  here. Only meaningful when the caller fetches `mode=all`. */
  confirmedOnly: boolean;
  /** Subcategory names (matching `NormalizedPlace.subcategory`, ie OSM
   *  amenity tag values) that must be excluded even when their parent
   *  category is enabled. Default: `["food_court"]`. */
  excludedSubcategories: Set<string>;
}

export interface PlacesViewportOverlayOptions {
  map: LeafletMap;
  /** Imported Leaflet module — passed in to avoid a hard dep on the client bundle. */
  leaflet: typeof import("leaflet");
  onPlaceClick?: (place: NormalizedPlaceLite) => void;
  /** Max zoom-in level used when clicking a cluster. Defaults to 18. */
  maxZoom?: number;
}

/** Category → color mapping. Kept in sync with the CSS palette in
 *  `globals.css` and the icon set in `venue-assets.tsx`. */
const COLOR_BY_SUBCATEGORY: Record<string, string> = {
  cafe: "#f59e0b",
  bar: "#a855f7",
  pub: "#a855f7",
  restaurant: "#ef4444",
  fast_food: "#94a3b8",
};
const COLOR_PARK = "#10b981";
const COLOR_DEFAULT = "#64748b";
const HALO_COLOR = "#fbbf24";

/** Subcategory → emoji used for L1/L2 glyphs. */
const EMOJI_BY_SUBCATEGORY: Record<string, string> = {
  cafe: "☕",
  bar: "🍺",
  pub: "🍺",
  restaurant: "🍴",
  fast_food: "🥡",
};
const EMOJI_PARK = "🌳";
const EMOJI_DEFAULT = "📍";

function colorFor(place: NormalizedPlaceLite): string {
  if (place.category === "park") return COLOR_PARK;
  return COLOR_BY_SUBCATEGORY[place.subcategory] ?? COLOR_DEFAULT;
}

function emojiFor(place: NormalizedPlaceLite): string {
  if (place.category === "park") return EMOJI_PARK;
  return EMOJI_BY_SUBCATEGORY[place.subcategory] ?? EMOJI_DEFAULT;
}

/** Pick the dominant color of a cluster (the most frequent subcategory).
 *  When tied, parks win over terrace candidates (greener = friendlier
 *  outdoors). */
function dominantColor(places: NormalizedPlaceLite[]): string {
  const counts = new Map<string, number>();
  for (const p of places) {
    const color = colorFor(p);
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  let bestColor = COLOR_DEFAULT;
  let bestCount = -1;
  for (const [color, count] of counts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      bestColor = color;
    }
  }
  return bestColor;
}

export class PlacesViewportOverlay {
  private readonly map: LeafletMap;
  private readonly L: typeof import("leaflet");
  private readonly layer: LayerGroup;
  private readonly onPlaceClick?: (place: NormalizedPlaceLite) => void;
  private readonly maxZoom: number;

  private places: NormalizedPlaceLite[] = [];
  // Defaults aligned with the app's purpose: it's "Mappy HOUR for sunny
  // terrasses", not a general POI browser. So:
  //  - parks are off (they're a distinct outdoor concept, not "terrace");
  //  - `confirmedOnly` is now a no-op default — the server pre-filters via
  //    `/api/places/viewport?mode=confirmed` so the payload only contains
  //    HORECA places with explicit `outdoor_seating=yes`. Kept on the
  //    interface for callers that fetch `mode=all` and want the same
  //    behaviour client-side.
  //  - food_court excluded by default (the server already drops it under
  //    `mode=confirmed`; kept here as a belt-and-suspenders for `mode=all`).
  private filters: PlacesViewportOverlayFilters = {
    showParks: false,
    showTerraces: true,
    confirmedOnly: true,
    excludedSubcategories: new Set(["food_court"]),
  };
  private disposed = false;
  private readonly handleMoveEnd: () => void;

  constructor(opts: PlacesViewportOverlayOptions) {
    this.map = opts.map;
    this.L = opts.leaflet;
    this.onPlaceClick = opts.onPlaceClick;
    this.maxZoom = opts.maxZoom ?? 18;
    this.layer = this.L.layerGroup().addTo(this.map);

    this.handleMoveEnd = () => {
      if (this.disposed) return;
      this.refresh();
    };
    this.map.on("moveend", this.handleMoveEnd);
    this.map.on("zoomend", this.handleMoveEnd);
  }

  setPlaces(places: NormalizedPlaceLite[]): void {
    this.places = places;
  }

  setFilters(filters: PlacesViewportOverlayFilters): void {
    this.filters = filters;
  }

  refresh(): void {
    if (this.disposed) return;
    const L = this.L;
    const map = this.map;
    const zoom = map.getZoom();
    const lod: ViewportPlaceLod = pickLod(zoom);

    const bounds = map.getBounds();
    const bbox = {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    };

    // 1) bbox filter.
    let visible = filterPlacesInBounds(this.places, bbox);

    // 2) category + subcategory user filters.
    //    NOTE: the server already drops parks, food_court, and unconfirmed
    //    terraces when fetched with the default `mode=confirmed`. These
    //    client-side checks are no-ops in the common case but stay defensive
    //    in case a future caller switches to `mode=all`.
    visible = visible.filter((p) => {
      if (p.category === "park") return this.filters.showParks;
      if (p.category === "terrace_candidate") {
        if (!this.filters.showTerraces) return false;
        if (this.filters.excludedSubcategories.has(p.subcategory)) return false;
      }
      return true;
    });

    // 3) cluster on the screen-pixel grid.
    const cellPx = CLUSTER_CELL_PX[lod];
    const clustered = clusterPoints(visible, cellPx, (lat, lon) => {
      const pt = map.latLngToContainerPoint(L.latLng(lat, lon));
      return { x: pt.x, y: pt.y };
    });

    // 4) cap at MAX_RENDERED. Clusters survive first, then confirmed singles.
    const points = applyHardLimit(clustered, MAX_RENDERED);

    // 5) redraw.
    this.layer.clearLayers();
    for (const point of points) {
      const marker = this.makeMarker(point, lod);
      if (marker) marker.addTo(this.layer);
    }
  }

  private makeMarker(
    point: ViewportClusterPoint,
    lod: ViewportPlaceLod,
  ): CircleMarker | Marker | null {
    const L = this.L;
    if (point.kind === "cluster") {
      const places = point.places ?? [];
      const color = dominantColor(places);
      const html = `<div class="vpo-cluster" style="background:${color}">${point.count ?? places.length}</div>`;
      const icon: DivIcon = L.divIcon({
        className: "vpo-cluster-wrap",
        html,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const marker = L.marker([point.lat, point.lon], { icon, keyboard: false });
      marker.on("click", () => {
        const target = Math.min(this.map.getZoom() + 2, this.maxZoom);
        this.map.flyTo([point.lat, point.lon], target);
      });
      return marker;
    }

    const place = point.place;
    if (!place) return null;
    const color = colorFor(place);
    const halo = place.hasOutdoorSeating === true;

    if (lod === "L0") {
      // Tiny colored dot, no label, no halo (too noisy at L0).
      const marker = L.circleMarker([place.lat, place.lon], {
        radius: 4,
        color: halo ? HALO_COLOR : color,
        weight: halo ? 1.5 : 1,
        fillColor: color,
        fillOpacity: 0.95,
      });
      marker.on("click", () => this.onPlaceClick?.(place));
      return marker;
    }

    // L1 / L2 — emoji glyph, with halo for confirmed terraces, optional label at L2.
    const emoji = emojiFor(place);
    const haloCls = halo ? " vpo-glyph--halo" : "";
    const label =
      lod === "L2"
        ? `<div class="vpo-label">${escapeHtml(place.name)}</div>`
        : "";
    const html = `<div class="vpo-glyph${haloCls}" style="color:${color}">${emoji}</div>${label}`;
    const iconHeight = lod === "L2" ? 44 : 26;
    const icon: DivIcon = L.divIcon({
      className: "vpo-glyph-wrap",
      html,
      iconSize: [60, iconHeight],
      iconAnchor: [30, 13],
    });
    const marker = L.marker([place.lat, place.lon], { icon, keyboard: false });
    marker.on("click", () => this.onPlaceClick?.(place));
    return marker;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.map.off("moveend", this.handleMoveEnd);
    this.map.off("zoomend", this.handleMoveEnd);
    this.layer.clearLayers();
    this.map.removeLayer(this.layer);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
