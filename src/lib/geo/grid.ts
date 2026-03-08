export interface BBoxWgs84 {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface GridPointWgs84 {
  id: string;
  lon: number;
  lat: number;
}

const METERS_PER_DEGREE_LAT = 111_320;

export function buildGridFromBbox(
  bbox: BBoxWgs84,
  stepMeters: number,
): GridPointWgs84[] {
  const points: GridPointWgs84[] = [];
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const latStepDeg = stepMeters / METERS_PER_DEGREE_LAT;
  const lonStepDeg =
    stepMeters /
    (METERS_PER_DEGREE_LAT * Math.max(Math.cos((centerLat * Math.PI) / 180), 0.01));

  let row = 0;
  for (let lat = bbox.minLat; lat <= bbox.maxLat + 1e-12; lat += latStepDeg) {
    let col = 0;
    for (let lon = bbox.minLon; lon <= bbox.maxLon + 1e-12; lon += lonStepDeg) {
      points.push({
        id: `r${row}c${col}`,
        lon: Math.round(lon * 1_000_000) / 1_000_000,
        lat: Math.round(lat * 1_000_000) / 1_000_000,
      });
      col += 1;
    }
    row += 1;
  }

  return points;
}
