/**
 * Pure logic for the viewport-filtered places overlay (ADR-0025 follow-up).
 *
 * Responsibilities :
 *  - Pick a LOD level from the current map zoom.
 *  - Filter a list of `NormalizedPlace` to the visible bbox.
 *  - Cluster densely-packed markers on a screen-pixel grid so the rendered
 *    overlay never explodes in DOM nodes (helps at L0/L1 over Geneva where
 *    ~2800 places live).
 *
 * Framework-agnostic — no Leaflet imports. The rendering wrapper consumes
 * the cluster output and emits `<canvas>` / `divIcon` / `circleMarker`
 * depending on the chosen LOD.
 */

export type ViewportPlaceLod = "L0" | "L1" | "L2";

export interface NormalizedPlaceLite {
  id: string;
  name: string;
  category: "park" | "terrace_candidate";
  subcategory: string;
  lat: number;
  lon: number;
  hasOutdoorSeating: boolean;
  hasOutdoorSeatingUnknown?: boolean;
  /** Raw OSM `opening_hours` tag (e.g. `Mo-Fr 09:00-18:00; Sa 10:00-16:00`).
   *  Surfaced by /api/places/viewport so the floating card can display it.
   *  Free-form: the OSM `opening_hours` spec is rich (PH/SH, off, easter,
   *  sunrise/sunset, …) so we render it verbatim, splitting on `;`. */
  openingHours?: string;
}

export interface BoundsLatLon {
  /** Inclusive south-west / north-east */
  south: number;
  west: number;
  north: number;
  east: number;
}

/** What the renderer needs for a single drawn glyph. */
export interface ViewportClusterPoint {
  /** "single" → a real place; "cluster" → ≥ 2 places aggregated. */
  kind: "single" | "cluster";
  /** Centroid lat/lon used to position the glyph. */
  lat: number;
  lon: number;
  /** Only set for `single` — handy for click/hover. */
  place?: NormalizedPlaceLite;
  /** Only set for `cluster` — count + the underlying places (used for the
   *  click-to-zoom-in interaction and the numbered badge). */
  count?: number;
  places?: NormalizedPlaceLite[];
  /** Stable key for React/Leaflet diffing. */
  key: string;
}

/** Zoom → LOD mapping. Tuned so:
 *   - L0 covers world/regional pan (everything is small dots, no labels).
 *   - L1 is the typical "city overview" zoom (categories visible, no labels).
 *   - L2 is when the user is committed to walking the streets (labels +
 *     full venue glyph).
 */
export function pickLod(zoom: number): ViewportPlaceLod {
  if (zoom <= 12) return "L0";
  if (zoom <= 17) return "L1";
  return "L2";
}

/** Per-LOD cluster cell size in CSS px. Larger = fewer DOM nodes at the
 *  cost of more aggressive aggregation. */
export const CLUSTER_CELL_PX: Record<ViewportPlaceLod, number> = {
  L0: 32,
  L1: 48,
  L2: 0, // no clustering at L2 — user wants every label
};

/** Maximum count of single markers we'll ever render at once. Even at L2,
 *  if the user manages to zoom to a viewport with > MAX_RENDERED markers,
 *  we sort by category-preference (terrasses first) and truncate. */
export const MAX_RENDERED = 800;

export function filterPlacesInBounds<P extends { lat: number; lon: number }>(
  places: ReadonlyArray<P>,
  bounds: BoundsLatLon,
): P[] {
  const out: P[] = [];
  for (const p of places) {
    if (p.lat < bounds.south || p.lat > bounds.north) continue;
    if (p.lon < bounds.west || p.lon > bounds.east) continue;
    out.push(p);
  }
  return out;
}

/** Grid-based clustering on container-pixel coords. Caller must supply a
 *  `latLngToPixel` function so we don't need a Leaflet dep here. Pure & easy
 *  to unit-test. */
export function clusterPoints(
  places: ReadonlyArray<NormalizedPlaceLite>,
  cellPx: number,
  latLngToPixel: (lat: number, lon: number) => { x: number; y: number },
): ViewportClusterPoint[] {
  if (cellPx <= 0 || places.length === 0) {
    // No clustering — every place becomes a `single`.
    return places.map((place) => ({
      kind: "single",
      lat: place.lat,
      lon: place.lon,
      place,
      key: place.id,
    }));
  }
  const cells = new Map<string, NormalizedPlaceLite[]>();
  for (const p of places) {
    const pt = latLngToPixel(p.lat, p.lon);
    const key = `${Math.floor(pt.x / cellPx)}_${Math.floor(pt.y / cellPx)}`;
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = [];
      cells.set(key, bucket);
    }
    bucket.push(p);
  }
  const out: ViewportClusterPoint[] = [];
  for (const [key, bucket] of cells.entries()) {
    if (bucket.length === 1) {
      const place = bucket[0];
      out.push({ kind: "single", lat: place.lat, lon: place.lon, place, key: place.id });
    } else {
      // Anchor the cluster on a REAL place's position rather than a synthetic
      // centroid (mean lat/lon). The pixel-grid clustering re-partitions
      // every time the map zooms — using the centroid made the badge drift
      // around as composition changed, giving the impression that POIs
      // weren't pinned to the map. Sort by id and pick the lowest so the
      // anchor is stable across zoom levels: if the same place remains in
      // the cluster, the badge stays exactly on top of it; when the cluster
      // breaks apart, that place is one of the visible singles at its
      // unchanged position. Other places in the bucket are still listed in
      // `places` so the click-to-zoom logic remains correct.
      bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const anchor = bucket[0];
      out.push({
        kind: "cluster",
        lat: anchor.lat,
        lon: anchor.lon,
        count: bucket.length,
        places: bucket,
        key: `cluster_${key}`,
      });
    }
  }
  return out;
}

/** Category-aware truncation when we'd render too many singles. Keeps
 *  confirmed terrasses (`hasOutdoorSeating=true`) first, then the others. */
export function applyHardLimit(
  points: ViewportClusterPoint[],
  limit: number,
): ViewportClusterPoint[] {
  if (points.length <= limit) return points;
  const confirmed: ViewportClusterPoint[] = [];
  const rest: ViewportClusterPoint[] = [];
  for (const p of points) {
    const isConfirmedSingle =
      p.kind === "single" && p.place?.hasOutdoorSeating === true;
    if (isConfirmedSingle) confirmed.push(p);
    else rest.push(p);
  }
  // Clusters always survive (they REPRESENT many places). Then confirmed
  // singles. Then fill until the cap with the rest.
  const clusters = rest.filter((p) => p.kind === "cluster");
  const others = rest.filter((p) => p.kind === "single");
  const result = [...clusters, ...confirmed];
  for (const p of others) {
    if (result.length >= limit) break;
    result.push(p);
  }
  return result;
}
