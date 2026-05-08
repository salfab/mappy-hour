import { BBox, bboxFromRadiusKm } from "@/lib/config/lausanne";

export const MORGES_CENTER = {
  lat: 46.511,
  lon: 6.498,
};

// Morges + surrounding area (Tolochenaz, St-Prex, Préverenges)
export const MORGES_LOCAL_BBOX: BBox = [6.44, 46.48, 6.55, 46.54];

export const MORGES_HORIZON_RADIUS_KM = 120;

export const MORGES_HORIZON_BBOX: BBox = bboxFromRadiusKm(
  MORGES_CENTER.lon,
  MORGES_CENTER.lat,
  MORGES_HORIZON_RADIUS_KM,
);

export const MORGES_CONFIG = {
  center: MORGES_CENTER,
  localBbox: MORGES_LOCAL_BBOX,
  horizonBbox: MORGES_HORIZON_BBOX,
  horizonRadiusKm: MORGES_HORIZON_RADIUS_KM,
} as const;
