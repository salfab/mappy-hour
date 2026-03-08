import { BBox, bboxFromRadiusKm } from "@/lib/config/lausanne";

export const NYON_CENTER = {
  lat: 46.3833,
  lon: 6.239,
};

export const NYON_LOCAL_BBOX: BBox = [6.14, 46.33, 6.33, 46.45];

export const NYON_HORIZON_RADIUS_KM = 120;

export const NYON_HORIZON_BBOX: BBox = bboxFromRadiusKm(
  NYON_CENTER.lon,
  NYON_CENTER.lat,
  NYON_HORIZON_RADIUS_KM,
);

export const NYON_CONFIG = {
  center: NYON_CENTER,
  localBbox: NYON_LOCAL_BBOX,
  horizonBbox: NYON_HORIZON_BBOX,
  horizonRadiusKm: NYON_HORIZON_RADIUS_KM,
} as const;
