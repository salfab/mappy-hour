/**
 * CPU backend for building shadow evaluation.
 *
 * Wraps the existing `evaluateBuildingsShadow` from buildings-shadow.ts
 * behind the BuildingShadowBackend interface.
 */
import {
  evaluateBuildingsShadow,
  type BuildingShadowInput,
  type BuildingShadowResult as InternalResult,
} from "@/lib/sun/buildings-shadow";
import type {
  BuildingShadowBackend,
  BuildingShadowQuery,
  BuildingShadowResult,
} from "@/lib/sun/building-shadow-backend";

type BuildingObstacle = Parameters<typeof evaluateBuildingsShadow>[0][number];
type BuildingSpatialGrid = Parameters<typeof evaluateBuildingsShadow>[2];

export class CpuBuildingShadowBackend implements BuildingShadowBackend {
  readonly name = "cpu-raytrace";

  private obstacles: BuildingObstacle[];
  private spatialGrid: BuildingSpatialGrid | undefined;
  private currentAzimuthDeg = 0;
  private currentAltitudeDeg = 0;

  constructor(
    obstacles: BuildingObstacle[],
    spatialGrid?: BuildingSpatialGrid,
  ) {
    this.obstacles = obstacles;
    this.spatialGrid = spatialGrid;
  }

  prepareSunPosition(azimuthDeg: number, altitudeDeg: number): void {
    this.currentAzimuthDeg = azimuthDeg;
    this.currentAltitudeDeg = altitudeDeg;
  }

  evaluate(query: BuildingShadowQuery): BuildingShadowResult {
    const input: BuildingShadowInput = {
      pointX: query.pointX,
      pointY: query.pointY,
      pointElevation: query.pointElevation,
      solarAzimuthDeg: query.solarAzimuthDeg,
      solarAltitudeDeg: query.solarAltitudeDeg,
    };
    const result: InternalResult = evaluateBuildingsShadow(
      this.obstacles,
      input,
      this.spatialGrid,
    );
    return {
      blocked: result.blocked,
      blockerId: result.blockerId,
      blockerDistanceMeters: result.blockerDistanceMeters,
      blockerAltitudeAngleDeg: result.blockerAltitudeAngleDeg,
    };
  }

  dispose(): void {
    // Nothing to clean up for CPU backend
  }
}
