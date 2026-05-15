import type { StyleSpecification } from "maplibre-gl";

export type BaseMapId = "aquarelle" | "carto-voyager" | "osm" | "satellite";

export interface BaseMapDef {
  id: BaseMapId;
  label: string;
  baseTiles: string[];
  baseAttribution: string;
  overlayTiles?: string[];
  overlayAttribution?: string;
  maxZoom: number;
  tileSize?: number;
}

export function buildBaseMaps(stadiaApiKey: string | undefined): BaseMapDef[] {
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

export function buildStyle(basemap: BaseMapDef): StyleSpecification {
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
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources,
    layers,
  };
}
