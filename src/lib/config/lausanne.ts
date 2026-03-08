export type BBox = [number, number, number, number];

export const LAUSANNE_CENTER = {
  lat: 46.5197,
  lon: 6.6323,
};

export const LAUSANNE_LOCAL_BBOX: BBox = [6.54, 46.49, 6.74, 46.62];

export const LAUSANNE_HORIZON_RADIUS_KM = 120;

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function bboxFromRadiusKm(
  centerLon: number,
  centerLat: number,
  radiusKm: number,
): BBox {
  const latitudeDelta = radiusKm / 111.32;
  const longitudeScale = Math.max(Math.cos(toRadians(centerLat)), 0.01);
  const longitudeDelta = radiusKm / (111.32 * longitudeScale);

  return [
    centerLon - longitudeDelta,
    centerLat - latitudeDelta,
    centerLon + longitudeDelta,
    centerLat + latitudeDelta,
  ];
}

export const LAUSANNE_HORIZON_BBOX: BBox = bboxFromRadiusKm(
  LAUSANNE_CENTER.lon,
  LAUSANNE_CENTER.lat,
  LAUSANNE_HORIZON_RADIUS_KM,
);

export const LAUSANNE_CONFIG = {
  center: LAUSANNE_CENTER,
  localBbox: LAUSANNE_LOCAL_BBOX,
  horizonBbox: LAUSANNE_HORIZON_BBOX,
  horizonRadiusKm: LAUSANNE_HORIZON_RADIUS_KM,
} as const;
