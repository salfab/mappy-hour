/**
 * Backend interface for building shadow evaluation.
 *
 * Abstracts the shadow computation strategy (CPU ray-tracing vs GPU shadow map)
 * behind a uniform API. The key pattern is:
 *
 *   1. `prepareSunPosition(azimuth, altitude)` — set up for a sun direction
 *      (GPU renders a shadow map; CPU is a no-op or caches the direction)
 *   2. N × `evaluate(query)` — test individual points against the prepared sun
 *
 * This interface is designed to be stable so it can later be fronted by a
 * microservice boundary.
 */

export interface BuildingShadowQuery {
  /** LV95 easting */
  pointX: number;
  /** LV95 northing */
  pointY: number;
  /** Terrain elevation at point (meters) */
  pointElevation: number;
  /** Solar azimuth in degrees (0 = N, 90 = E, 180 = S, 270 = W) */
  solarAzimuthDeg: number;
  /** Solar altitude in degrees above horizon */
  solarAltitudeDeg: number;
}

export interface BuildingShadowResult {
  blocked: boolean;
  blockerId: string | null;
  blockerDistanceMeters: number | null;
  blockerAltitudeAngleDeg: number | null;
}

export interface BuildingShadowBackend {
  readonly name: string;

  /**
   * Prepare the backend for a sun position.
   * GPU: renders the shadow map (one render call per invocation).
   * CPU: stores the sun direction for subsequent evaluate() calls.
   */
  prepareSunPosition(azimuthDeg: number, altitudeDeg: number): void;

  /**
   * Evaluate whether a point is in shadow. Must call prepareSunPosition first.
   */
  evaluate(query: BuildingShadowQuery): BuildingShadowResult;

  /** Release resources (GPU buffers, GL context, etc.) */
  dispose(): void;
}

/**
 * Extended backend that supports batch evaluation of many points in one GPU dispatch.
 * Used by the WebGPU compute backend for precompute (not the API server).
 */
export interface BatchBuildingShadowBackend extends BuildingShadowBackend {
  /**
   * Evaluate all points against the shadow map in a single GPU dispatch.
   * Points are in centered coordinates (LV95 - origin), packed as vec4f.
   * Returns a Uint32Array bitmask where bit=1 means blocked.
   */
  evaluateBatch(
    points: Float32Array,
    pointCount: number,
    azimuthDeg: number,
    altitudeDeg: number,
  ): Promise<Uint32Array>;

  /** Origin offsets for converting LV95 to centered coords. */
  getOrigin(): { x: number; y: number };

  /** Set frustum focus for shadow map precision. */
  setFrustumFocus(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    maxBuildingHeight: number,
  ): void;

  /**
   * (Optional, Phase B+) Upload per-tile horizon data so the shader can
   * compute the terrain-blocked bitmask alongside the buildings bitmask.
   *
   * - `masks`: packed (maskCount × 360) f32 array of horizon angles (deg)
   * - `pointMaskIndices`: one u32 per point, indexing into `masks`
   *
   * The caller is responsible for passing the same `pointCount` in the
   * subsequent evaluate call as was used when building
   * `pointMaskIndices`.
   */
  uploadHorizonMasks?(params: {
    masks: Float32Array;
    pointMaskIndices: Uint32Array;
  }): Promise<void>;

  /**
   * (Optional, Phase C+) Upload per-region vegetation rasters so the
   * shader can compute the vegetation-blocked bitmask via ray-march.
   *
   * Meta is one entry per tile with absolute LV95 bounds + raster
   * dimensions + offset into `data`. Data is the flat concatenation of
   * all tile rasters as f32.
   */
  uploadVegetationRasters?(params: {
    meta: Float32Array; // tileCount × 8 slots (minX/minY/maxX/maxY as f32, width/height/dataOffset/pad as u32 reinterpreted as f32)
    data: Float32Array;
    nodata: number;
    stepMeters: number;
    maxDistanceMeters: number;
    minClearance: number;
    originX: number;
    originY: number;
  }): Promise<void>;

  /**
   * (Optional, Phase B+ / C+) Like evaluateBatch, but also returns the
   * terrain-blocked and/or vegetation-blocked bitmasks produced on the
   * GPU. When a payload is passed, the backend syncs it (deduped by
   * hash across frames) after points are in place; subsequent frames
   * of the same tile skip the actual upload.
   *
   * When no payload has ever been uploaded for a given kind, its mask
   * in the result is null.
   */
  evaluateBatchWithShadows?(
    points: Float32Array,
    pointCount: number,
    azimuthDeg: number,
    altitudeDeg: number,
    options?: {
      horizon?: { masks: Float32Array; pointMaskIndices: Uint32Array };
      vegetation?: {
        meta: Float32Array;
        data: Float32Array;
        nodata: number;
        stepMeters: number;
        maxDistanceMeters: number;
        minClearance: number;
        originX: number;
        originY: number;
      };
    },
  ): Promise<{
    buildingsMask: Uint32Array;
    terrainMask: Uint32Array | null;
    vegetationMask: Uint32Array | null;
  }>;
}

export function isBatchBackend(
  backend: BuildingShadowBackend,
): backend is BatchBuildingShadowBackend {
  return "evaluateBatch" in backend;
}
