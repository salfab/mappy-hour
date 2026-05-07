import type { TerrainTileSource } from "@/lib/terrain/swiss-terrain";
import { sampleSwissTerrainElevationLv95FromTiles } from "@/lib/terrain/swiss-terrain";

export interface TerrainShadowResult {
  blocked: boolean;
  blockerDistanceMeters: number | null;
  blockerAltitudeAngleDeg: number | null;
  blockerSurfaceElevationMeters: number | null;
  checkedSamplesCount: number;
}

export interface TerrainShadowEvaluatorInput {
  azimuthDeg: number;
  altitudeDeg: number;
}

export interface TerrainShadowEvaluator {
  (sample: TerrainShadowEvaluatorInput): TerrainShadowResult;
}

export const TERRAIN_SHADOW_METHOD = "swissalti3d-raster-step-ray-v1";
export const TERRAIN_SHADOW_DEFAULT_MAX_DISTANCE_METERS = 500;
export const TERRAIN_SHADOW_DEFAULT_STEP_METERS = 5;
export const TERRAIN_SHADOW_ALTITUDE_GATE_DEG = 30;

/**
 * Build an evaluator that detects self-shadowing by nearby terrain (the local
 * DEM). Complements the horizon-mask check which captures only distant relief
 * (> ~500m). Without this evaluator, a point at the foot of a hill never sees
 * the hill itself cast a shadow on it at low sun angles — that's the visual
 * regression reported on Montriond at sunset.
 *
 * Gated by `altitudeDeg < TERRAIN_SHADOW_ALTITUDE_GATE_DEG`: above 30° the sun
 * is too high for local terrain (< 500m) to create long shadows on itself.
 */
export function buildLocalTerrainShadowEvaluator(params: {
  pointLv95Easting: number;
  pointLv95Northing: number;
  pointElevationMeters: number;
  terrainTiles: TerrainTileSource[];
  maxDistanceMeters?: number;
  stepMeters?: number;
}): TerrainShadowEvaluator {
  const maxDistance = params.maxDistanceMeters ?? TERRAIN_SHADOW_DEFAULT_MAX_DISTANCE_METERS;
  const stepMeters = params.stepMeters ?? TERRAIN_SHADOW_DEFAULT_STEP_METERS;

  return (sample) => {
    const altitudeDeg = sample.altitudeDeg;
    if (altitudeDeg <= 0 || altitudeDeg >= TERRAIN_SHADOW_ALTITUDE_GATE_DEG) {
      return {
        blocked: false,
        blockerDistanceMeters: null,
        blockerAltitudeAngleDeg: null,
        blockerSurfaceElevationMeters: null,
        checkedSamplesCount: 0,
      };
    }

    const azRad = (sample.azimuthDeg * Math.PI) / 180;
    // Sun is at azimuth `az`, so the ray from point toward sun has horizontal
    // direction (sin(az), cos(az)) in LV95 (x=east, y=north).
    const dirX = Math.sin(azRad);
    const dirY = Math.cos(azRad);
    const tanAlt = Math.tan((altitudeDeg * Math.PI) / 180);

    let checkedSamples = 0;
    for (let dist = stepMeters; dist <= maxDistance; dist += stepMeters) {
      const sx = params.pointLv95Easting + dirX * dist;
      const sy = params.pointLv95Northing + dirY * dist;
      const surfaceElev = sampleSwissTerrainElevationLv95FromTiles(params.terrainTiles, sx, sy);
      checkedSamples++;
      if (surfaceElev === null) continue;
      const clearance = surfaceElev - params.pointElevationMeters;
      if (clearance <= 0) continue;
      // Ray altitude at distance `dist`: point_elev + dist * tan(altitudeDeg)
      // If the surface is above the ray → blocked
      const rayHeightAbovePoint = dist * tanAlt;
      if (clearance > rayHeightAbovePoint) {
        const blockerAngle = (Math.atan2(clearance, dist) * 180) / Math.PI;
        return {
          blocked: true,
          blockerDistanceMeters: dist,
          blockerAltitudeAngleDeg: blockerAngle,
          blockerSurfaceElevationMeters: surfaceElev,
          checkedSamplesCount: checkedSamples,
        };
      }
    }

    return {
      blocked: false,
      blockerDistanceMeters: null,
      blockerAltitudeAngleDeg: null,
      blockerSurfaceElevationMeters: null,
      checkedSamplesCount: checkedSamples,
    };
  };
}
