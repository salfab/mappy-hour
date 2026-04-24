import { BBox, bboxFromRadiusKm } from "@/lib/config/lausanne";

export const VEVEY_CENTER = {
  lat: 46.4628,
  lon: 6.8419,
};

// Vevey + La Tour-de-Peilz + Corseaux + Corsier + Chardonne
// Extended westward (minLon 6.80→6.76) to cover the Lavaux gap between
// Lausanne region and Vevey proper: Villette, Cully, Grandvaux, Riex,
// Epesses, Rivaz, Saint-Saphorin. Extended north (maxLat 46.49→46.50)
// to include upper Grandvaux slopes.
export const VEVEY_LOCAL_BBOX: BBox = [6.76, 46.44, 6.89, 46.50];

export const VEVEY_HORIZON_RADIUS_KM = 120;

export const VEVEY_HORIZON_BBOX: BBox = bboxFromRadiusKm(
  VEVEY_CENTER.lon,
  VEVEY_CENTER.lat,
  VEVEY_HORIZON_RADIUS_KM,
);

export const VEVEY_CONFIG = {
  center: VEVEY_CENTER,
  localBbox: VEVEY_LOCAL_BBOX,
  horizonBbox: VEVEY_HORIZON_BBOX,
  horizonRadiusKm: VEVEY_HORIZON_RADIUS_KM,
} as const;
