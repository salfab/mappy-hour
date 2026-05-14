/**
 * Shared lightweight types for the sunlight-map* modules.
 *
 * Anything Leaflet-specific stays out of this file so the engine swap
 * (Leaflet → MapLibre) doesn't touch the type contracts other modules
 * depend on.
 */

export type { AreaMode } from "@/components/map-ui/controls";

export type BaseMapStyle =
  | "stamen-watercolor"
  | "carto-voyager"
  | "osm"
  | "satellite";

export interface BaseMapOption {
  id: BaseMapStyle;
  label: string;
  url: string;
  attribution: string;
  maxNativeZoom: number;
  /** Additional raster tile URLs stacked on top of the base layer. */
  overlays?: Array<{ url: string; maxNativeZoom?: number; opacity?: number }>;
}

// Order matters — the first entry is the default basemap (Aquarelle).
export const BASE_MAP_OPTIONS: BaseMapOption[] = [
  {
    id: "stamen-watercolor",
    label: "Aquarelle",
    url: "https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg",
    overlays: [
      { url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png", maxNativeZoom: 20 },
    ],
    attribution:
      "&copy; <a href=\"https://stamen.com\">Stamen Design</a>, hosted by <a href=\"https://stadiamaps.com/\">Stadia Maps</a> | Labels &copy; CARTO &mdash; Map data &copy; OpenStreetMap contributors",
    maxNativeZoom: 18,
  },
  {
    id: "carto-voyager",
    label: "CARTO Voyager",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    maxNativeZoom: 20,
  },
  {
    id: "osm",
    label: "OSM standard",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    maxNativeZoom: 19,
  },
  {
    id: "satellite",
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
    maxNativeZoom: 19,
  },
];

export const BASE_MAP_OPTION_BY_ID = new Map(
  BASE_MAP_OPTIONS.map((option) => [option.id, option]),
);

export function isBaseMapStyle(value: unknown): value is BaseMapStyle {
  return typeof value === "string" && BASE_MAP_OPTION_BY_ID.has(value as BaseMapStyle);
}
