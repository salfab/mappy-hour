import fs from "node:fs/promises";

import { z } from "zod";

import { PROCESSED_BUILDINGS_INDEX_PATH } from "@/lib/storage/data-paths";

const footprintPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

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
  footprint: z.array(footprintPointSchema).optional(),
  footprintArea: z.number().optional(),
  sourceZip: z.string(),
});

const spatialGridSchema = z.object({
  version: z.number().int().min(1),
  cellSizeMeters: z.number().positive(),
  cells: z.record(z.string(), z.array(z.number().int().nonnegative())),
  stats: z
    .object({
      cellCount: z.number().int().nonnegative(),
      maxObstaclesPerCell: z.number().int().nonnegative(),
      avgObstaclesPerCell: z.number().nonnegative(),
    })
    .optional(),
});

const buildingIndexSchema = z.object({
  generatedAt: z.string(),
  method: z.string(),
  indexVersion: z.number().int().min(1).optional(),
  sourceDirectory: z.string(),
  zipFilesProcessed: z.number(),
  rawObstaclesCount: z.number(),
  uniqueObstaclesCount: z.number(),
  elapsedSeconds: z.number(),
  obstacles: z.array(obstacleSchema),
  spatialGrid: spatialGridSchema.optional(),
});

type BuildingObstacle = z.infer<typeof obstacleSchema>;
type BuildingObstacleIndex = z.infer<typeof buildingIndexSchema>;
type BuildingObstacleSpatialGrid = z.infer<typeof spatialGridSchema>;
type FootprintPoint = z.infer<typeof footprintPointSchema>;

export interface BuildingShadowInput {
  pointX: number;
  pointY: number;
  pointElevation: number;
  solarAzimuthDeg: number;
  solarAltitudeDeg: number;
  maxDistanceMeters?: number;
  observerHeightMeters?: number;
  buildingHeightBiasMeters?: number;
}

export interface BuildingShadowResult {
  blocked: boolean;
  blockerId: string | null;
  blockerDistanceMeters: number | null;
  blockerAltitudeAngleDeg: number | null;
  checkedObstaclesCount: number;
}

export interface BuildingContainmentResult {
  insideBuilding: boolean;
  buildingId: string | null;
}

let obstacleIndexCache: BuildingObstacleIndex | null | undefined;

const DEFAULT_SPATIAL_GRID_CELL_SIZE_METERS = 64;

export async function loadBuildingsObstacleIndex(): Promise<BuildingObstacleIndex | null> {
  if (obstacleIndexCache !== undefined) {
    return obstacleIndexCache;
  }

  try {
    const raw = await fs.readFile(PROCESSED_BUILDINGS_INDEX_PATH, "utf8");
    const parsed = buildingIndexSchema.parse(JSON.parse(raw));
    obstacleIndexCache = {
      ...parsed,
      spatialGrid: sanitizeSpatialGrid(parsed.spatialGrid, parsed.obstacles.length),
    };
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

function sanitizeSpatialGrid(
  spatialGrid: BuildingObstacleSpatialGrid | undefined,
  obstacleCount: number,
): BuildingObstacleSpatialGrid | undefined {
  if (!spatialGrid) {
    return undefined;
  }

  for (const indices of Object.values(spatialGrid.cells)) {
    for (const index of indices) {
      if (index < 0 || index >= obstacleCount) {
        return undefined;
      }
    }
  }

  return spatialGrid;
}

function buildCellKey(cellX: number, cellY: number): string {
  return `${cellX}:${cellY}`;
}

function collectObstacleIndicesInBounds(params: {
  spatialGrid: BuildingObstacleSpatialGrid;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}): Set<number> {
  const cellSizeMeters = params.spatialGrid.cellSizeMeters;
  const minCellX = Math.floor(params.minX / cellSizeMeters);
  const maxCellX = Math.floor(params.maxX / cellSizeMeters);
  const minCellY = Math.floor(params.minY / cellSizeMeters);
  const maxCellY = Math.floor(params.maxY / cellSizeMeters);
  const candidateIndices = new Set<number>();

  for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      const key = buildCellKey(cellX, cellY);
      const indices = params.spatialGrid.cells[key];
      if (!indices || indices.length === 0) {
        continue;
      }
      for (const obstacleIndex of indices) {
        candidateIndices.add(obstacleIndex);
      }
    }
  }

  return candidateIndices;
}

function collectCandidateObstacleIndices(params: {
  obstacles: BuildingObstacle[];
  spatialGrid: BuildingObstacleSpatialGrid;
  pointX: number;
  pointY: number;
  dirX: number;
  dirY: number;
  maxDistanceMeters: number;
}): number[] {
  const cellSizeMeters = params.spatialGrid.cellSizeMeters;
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters <= 0) {
    return params.obstacles.map((_, index) => index);
  }

  const maxHalfDiagonal = params.obstacles.reduce(
    (max, obstacle) => Math.max(max, obstacle.halfDiagonal),
    0,
  );
  const corridorPadding = maxHalfDiagonal + cellSizeMeters;
  const endX = params.pointX + params.dirX * params.maxDistanceMeters;
  const endY = params.pointY + params.dirY * params.maxDistanceMeters;
  const minX = Math.min(params.pointX, endX) - corridorPadding;
  const maxX = Math.max(params.pointX, endX) + corridorPadding;
  const minY = Math.min(params.pointY, endY) - corridorPadding;
  const maxY = Math.max(params.pointY, endY) + corridorPadding;
  const candidateIndices = collectObstacleIndicesInBounds({
    spatialGrid: params.spatialGrid,
    minX,
    maxX,
    minY,
    maxY,
  });
  const filteredIndices: number[] = [];

  for (const obstacleIndex of candidateIndices) {
    const obstacle = params.obstacles[obstacleIndex];
    if (!obstacle) {
      continue;
    }
    const dx = obstacle.centerX - params.pointX;
    const dy = obstacle.centerY - params.pointY;
    const dot = dx * params.dirX + dy * params.dirY;
    if (dot < -obstacle.halfDiagonal) {
      continue;
    }
    const centerDistance = Math.hypot(dx, dy);
    if (centerDistance > params.maxDistanceMeters + obstacle.halfDiagonal) {
      continue;
    }
    filteredIndices.push(obstacleIndex);
  }

  return filteredIndices;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function pointInPolygon(pointX: number, pointY: number, polygon: FootprintPoint[]): boolean {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const deltaY = yj - yi;
    if (Math.abs(deltaY) < 1e-12) {
      continue;
    }

    const intersects =
      yi > pointY !== yj > pointY &&
      pointX < ((xj - xi) * (pointY - yi)) / deltaY + xi;
    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function raySegmentIntersectionDistance(
  pointX: number,
  pointY: number,
  dirX: number,
  dirY: number,
  a: FootprintPoint,
  b: FootprintPoint,
): number | null {
  const segX = b.x - a.x;
  const segY = b.y - a.y;
  const denominator = cross(dirX, dirY, segX, segY);

  if (Math.abs(denominator) < 1e-9) {
    return null;
  }

  const ax = a.x - pointX;
  const ay = a.y - pointY;
  const t = cross(ax, ay, segX, segY) / denominator;
  const u = cross(ax, ay, dirX, dirY) / denominator;

  if (t >= 0 && u >= 0 && u <= 1) {
    return t;
  }

  return null;
}

function rayPolygonIntersectionDistance(
  pointX: number,
  pointY: number,
  dirX: number,
  dirY: number,
  polygon: FootprintPoint[],
): number | null {
  if (polygon.length < 3) {
    return null;
  }

  if (pointInPolygon(pointX, pointY, polygon)) {
    return 0;
  }

  let minDistance: number | null = null;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const distance = raySegmentIntersectionDistance(pointX, pointY, dirX, dirY, a, b);
    if (distance === null) {
      continue;
    }

    if (minDistance === null || distance < minDistance) {
      minDistance = distance;
    }
  }

  return minDistance;
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

function isPointInsideBoundingBox(
  pointX: number,
  pointY: number,
  obstacle: BuildingObstacle,
): boolean {
  return (
    pointX >= obstacle.minX &&
    pointX <= obstacle.maxX &&
    pointY >= obstacle.minY &&
    pointY <= obstacle.maxY
  );
}

export function findContainingBuilding(
  obstacles: BuildingObstacle[],
  pointX: number,
  pointY: number,
  spatialGrid?: BuildingObstacleSpatialGrid,
): BuildingContainmentResult {
  const candidateIndices = spatialGrid
    ? Array.from(
        collectObstacleIndicesInBounds({
          spatialGrid,
          minX: pointX - DEFAULT_SPATIAL_GRID_CELL_SIZE_METERS,
          maxX: pointX + DEFAULT_SPATIAL_GRID_CELL_SIZE_METERS,
          minY: pointY - DEFAULT_SPATIAL_GRID_CELL_SIZE_METERS,
          maxY: pointY + DEFAULT_SPATIAL_GRID_CELL_SIZE_METERS,
        }),
      )
    : obstacles.map((_, index) => index);

  for (const obstacleIndex of candidateIndices) {
    const obstacle = obstacles[obstacleIndex];
    if (!obstacle) {
      continue;
    }
    if (!isPointInsideBoundingBox(pointX, pointY, obstacle)) {
      continue;
    }

    if (
      obstacle.footprint &&
      obstacle.footprint.length >= 3 &&
      !pointInPolygon(pointX, pointY, obstacle.footprint)
    ) {
      continue;
    }

    return {
      insideBuilding: true,
      buildingId: obstacle.id,
    };
  }

  return {
    insideBuilding: false,
    buildingId: null,
  };
}

export function evaluateBuildingsShadow(
  obstacles: BuildingObstacle[],
  input: BuildingShadowInput,
  spatialGrid?: BuildingObstacleSpatialGrid,
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
  const observerHeightMeters = input.observerHeightMeters ?? 0;
  const buildingHeightBiasMeters = input.buildingHeightBiasMeters ?? 0;
  const effectivePointElevation = input.pointElevation + observerHeightMeters;
  const azimuthRad = (input.solarAzimuthDeg * Math.PI) / 180;
  const dirX = Math.sin(azimuthRad);
  const dirY = Math.cos(azimuthRad);

  let blockerId: string | null = null;
  let blockerDistanceMeters: number | null = null;
  let blockerAltitudeAngleDeg: number | null = null;
  let checkedObstaclesCount = 0;
  const candidateIndices = spatialGrid
    ? collectCandidateObstacleIndices({
        obstacles,
        spatialGrid,
        pointX: input.pointX,
        pointY: input.pointY,
        dirX,
        dirY,
        maxDistanceMeters,
      })
    : obstacles.map((_, index) => index);

  for (const obstacleIndex of candidateIndices) {
    const obstacle = obstacles[obstacleIndex];
    if (!obstacle) {
      continue;
    }
    const centerDistance = Math.hypot(
      obstacle.centerX - input.pointX,
      obstacle.centerY - input.pointY,
    );
    if (centerDistance > maxDistanceMeters + obstacle.halfDiagonal) {
      continue;
    }

    checkedObstaclesCount += 1;

    const intersectionDistance =
      obstacle.footprint && obstacle.footprint.length >= 3
        ? rayPolygonIntersectionDistance(
            input.pointX,
            input.pointY,
            dirX,
            dirY,
            obstacle.footprint,
          )
        : rayBoxIntersectionDistance(input.pointX, input.pointY, dirX, dirY, obstacle);

    if (intersectionDistance === null || intersectionDistance > maxDistanceMeters) {
      continue;
    }

    const effectiveObstacleTop = obstacle.maxZ + buildingHeightBiasMeters;
    const verticalClearance = effectiveObstacleTop - effectivePointElevation;
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
