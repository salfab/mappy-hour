/**
 * Overlay that materializes the gap between a place's OSM position and the
 * outdoor-snapped point used to evaluate sunlight, whenever the user selects
 * a place whose `selectionStrategy` is non-`"original"`.
 *
 * Rendered as a single GeoJSON source with two layers:
 *   - A dashed teal line connecting the OSM coordinate to the evaluation
 *     coordinate.
 *   - A small ringed dot pinned on the OSM coordinate.
 *
 * The main place marker (in the `places` source) already sits at the
 * evaluation coordinate, so we only need to *add* the OSM marker + the link
 * to make the offset legible.
 *
 * Source + layers are idempotent on add (no-op if already present) and the
 * data setter clears to an empty FeatureCollection when no offset applies.
 */
import type maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { ViewportPlaceLite } from "@/components/maplibre-preview/places-source";

const SOURCE_ID = "selected-place-eval-offset";
const LINE_LAYER_ID = `${SOURCE_ID}-line`;
const POINT_LAYER_ID = `${SOURCE_ID}-point`;

const EMPTY_COLLECTION: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export function addSelectedPlaceOverlayLayers(map: MapLibreMap): void {
  if (map.getSource(SOURCE_ID)) return;
  map.addSource(SOURCE_ID, {
    type: "geojson",
    data: EMPTY_COLLECTION,
  });
  map.addLayer({
    id: LINE_LAYER_ID,
    type: "line",
    source: SOURCE_ID,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": "#0f766e", // teal-700 — distinct from the amber sunlight palette
      "line-width": 2.5,
      "line-dasharray": [2, 2],
      "line-opacity": 0.95,
    },
  });
  map.addLayer({
    id: POINT_LAYER_ID,
    type: "circle",
    source: SOURCE_ID,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-color": "#ffffff",
      "circle-radius": 6,
      "circle-stroke-color": "#0f766e",
      "circle-stroke-width": 2.5,
      "circle-opacity": 0.95,
    },
  });
}

export function updateSelectedPlaceOverlay(
  map: MapLibreMap,
  place: ViewportPlaceLite | null,
): void {
  const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  if (
    !place ||
    place.selectionStrategy === undefined ||
    place.selectionStrategy === "original" ||
    place.osmLat === undefined ||
    place.osmLon === undefined
  ) {
    src.setData(EMPTY_COLLECTION);
    return;
  }
  src.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [place.osmLon, place.osmLat],
            [place.lon, place.lat],
          ],
        },
        properties: {},
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [place.osmLon, place.osmLat] },
        properties: { kind: "osm-origin" },
      },
    ],
  });
}
