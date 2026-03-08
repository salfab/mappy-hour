import fs from "node:fs/promises";

import { z } from "zod";

import { PROCESSED_BUILDINGS_INDEX_PATH } from "@/lib/storage/data-paths";

const obstacleSchema = z.object({
  id: z.string(),
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
  minZ: z.number(),
  maxZ: z.number(),
  height: z.number(),
  centerX: z.number(),
  centerY: z.number(),
  halfDiagonal: z.number(),
  sourceZip: z.string(),
});

const buildingIndexSchema = z.object({
  generatedAt: z.string(),
  method: z.string(),
  sourceDirectory: z.string(),
  zipFilesProcessed: z.number(),
  rawObstaclesCount: z.number(),
  uniqueObstaclesCount: z.number(),
  elapsedSeconds: z.number(),
  obstacles: z.array(obstacleSchema),
});

type BuildingObstacle = z.infer<typeof obstacleSchema>;
type BuildingObstacleIndex = z.infer<typeof buildingIndexSchema>;

export interface BuildingShadowInput {
  pointX: number;
  pointY: number;
  pointElevation: number;
  solarAzimuthDeg: number;
  solarAltitudeDeg: number;
  maxDistanceMeters?: number;
}

export interface BuildingShadowResult {
  blocked: boolean;
  blockerId: string | null;
  blockerDistanceMeters: number | null;
  blockerAltitudeAngleDeg: number | null;
  checkedObstaclesCount: number;
}

let obstacleIndexCache: BuildingObstacleIndex | null | undefined;

export async function loadBuildingsObstacleIndex(): Promise<BuildingObstacleIndex | null> {
  if (obstacleIndexCache !== undefined) {
    return obstacleIndexCache;
  }

  try {
    const raw = await fs.readFile(PROCESSED_BUILDINGS_INDEX_PATH, "utf8");
    obstacleIndexCache = buildingIndexSchema.parse(JSON.parse(raw));
    return obstacleIndexCache;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      obstacleIndexCache = null;
      return null;
    }

    throw error;
  }
}

function rayBoxIntersectionDistance(
  pointX: number,
  pointY: number,
  dirX: number,
  dirY: number,
  obstacle: BuildingObstacle,
): number | null {
  let tMin = 0;
  let tMax = Number.POSITIVE_INFINITY;

  if (Math.abs(dirX) < 1e-9) {
    if (pointX < obstacle.minX || pointX > obstacle.maxX) {
      return null;
    }
  } else {
    const tx1 = (obstacle.minX - pointX) / dirX;
    const tx2 = (obstacle.maxX - pointX) / dirX;
    const txMin = Math.min(tx1, tx2);
    const txMax = Math.max(tx1, tx2);
    tMin = Math.max(tMin, txMin);
    tMax = Math.min(tMax, txMax);
    if (tMin > tMax) {
      return null;
    }
  }

  if (Math.abs(dirY) < 1e-9) {
    if (pointY < obstacle.minY || pointY > obstacle.maxY) {
      return null;
    }
  } else {
    const ty1 = (obstacle.minY - pointY) / dirY;
    const ty2 = (obstacle.maxY - pointY) / dirY;
    const tyMin = Math.min(ty1, ty2);
    const tyMax = Math.max(ty1, ty2);
    tMin = Math.max(tMin, tyMin);
    tMax = Math.min(tMax, tyMax);
    if (tMin > tMax) {
      return null;
    }
  }

  if (tMax < 0) {
    return null;
  }

  return Math.max(0, tMin);
}

export function evaluateBuildingsShadow(
  obstacles: BuildingObstacle[],
  input: BuildingShadowInput,
): BuildingShadowResult {
  if (input.solarAltitudeDeg <= 0) {
    return {
      blocked: false,
      blockerId: null,
      blockerDistanceMeters: null,
      blockerAltitudeAngleDeg: null,
      checkedObstaclesCount: 0,
    };
  }

  const maxDistanceMeters = input.maxDistanceMeters ?? 2500;
  const azimuthRad = (input.solarAzimuthDeg * Math.PI) / 180;
  const dirX = Math.sin(azimuthRad);
  const dirY = Math.cos(azimuthRad);

  let blockerId: string | null = null;
  let blockerDistanceMeters: number | null = null;
  let blockerAltitudeAngleDeg: number | null = null;
  let checkedObstaclesCount = 0;

  for (const obstacle of obstacles) {
    const centerDistance = Math.hypot(
      obstacle.centerX - input.pointX,
      obstacle.centerY - input.pointY,
    );
    if (centerDistance > maxDistanceMeters + obstacle.halfDiagonal) {
      continue;
    }

    checkedObstaclesCount += 1;

    const intersectionDistance = rayBoxIntersectionDistance(
      input.pointX,
      input.pointY,
      dirX,
      dirY,
      obstacle,
    );

    if (intersectionDistance === null || intersectionDistance > maxDistanceMeters) {
      continue;
    }

    const verticalClearance = obstacle.maxZ - input.pointElevation;
    if (verticalClearance <= 0) {
      continue;
    }

    const altitudeAngleDeg =
      (Math.atan2(verticalClearance, Math.max(1, intersectionDistance)) * 180) /
      Math.PI;
    if (input.solarAltitudeDeg > altitudeAngleDeg) {
      continue;
    }

    if (blockerDistanceMeters === null || intersectionDistance < blockerDistanceMeters) {
      blockerId = obstacle.id;
      blockerDistanceMeters = intersectionDistance;
      blockerAltitudeAngleDeg = altitudeAngleDeg;
    }
  }

  return {
    blocked: blockerId !== null,
    blockerId,
    blockerDistanceMeters:
      blockerDistanceMeters === null
        ? null
        : Math.round(blockerDistanceMeters * 1000) / 1000,
    blockerAltitudeAngleDeg:
      blockerAltitudeAngleDeg === null
        ? null
        : Math.round(blockerAltitudeAngleDeg * 1000) / 1000,
    checkedObstaclesCount,
  };
}
