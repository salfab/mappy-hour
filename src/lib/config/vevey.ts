import { BBox, bboxFromRadiusKm } from "@/lib/config/lausanne";

export const VEVEY_CENTER = {
  lat: 46.4628,
  lon: 6.8419,
};

// Vevey + La Tour-de-Peilz + Corseaux + Corsier + Chardonne + Lavaux foothills.
// Historical "Lavaux + Vevey extended" region (the city of Vevey itself is
// now handled by vevey_city). Widened to cover the full LV95 envelope
// E:2545000→2550000, N:1147000→1154000 of the 268 high-value tiles tagged
// region=vevey (commune-lausanne-east-tiles.json, E≥2545000). WGS84 envelope
// derived from the four LV95 corners via lv95ToWgs84Precise:
//   lon 6.72167 → 6.79089, lat 46.47206 → 46.53769
// plus a ~0.003° safety margin on every side for tile-corner protrusion
// due to the non-orthogonal LV95↔WGS84 mapping.
export const VEVEY_LOCAL_BBOX: BBox = [6.715, 46.468, 6.795, 46.541];

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
