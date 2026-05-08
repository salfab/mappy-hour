import { BBox, bboxFromRadiusKm } from "@/lib/config/lausanne";

export const GENEVE_CENTER = {
  lat: 46.204,
  lon: 6.143,
};

// Genève ville + Carouge, Lancy, Vernier, Meyrin
export const GENEVE_LOCAL_BBOX: BBox = [6.05, 46.15, 6.25, 46.26];

export const GENEVE_HORIZON_RADIUS_KM = 120;

export const GENEVE_HORIZON_BBOX: BBox = bboxFromRadiusKm(
  GENEVE_CENTER.lon,
  GENEVE_CENTER.lat,
  GENEVE_HORIZON_RADIUS_KM,
);

export const GENEVE_CONFIG = {
  center: GENEVE_CENTER,
  localBbox: GENEVE_LOCAL_BBOX,
  horizonBbox: GENEVE_HORIZON_BBOX,
  horizonRadiusKm: GENEVE_HORIZON_RADIUS_KM,
} as const;
