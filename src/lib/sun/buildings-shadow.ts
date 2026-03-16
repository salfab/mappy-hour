import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import AdmZip from "adm-zip";
import { z } from "zod";
import {
  normalizeBuildingFootprint,
  polygonArea,
  type FootprintPoint as NormalizedFootprintPoint,
} from "@/lib/sun/building-footprint";

import {
  PROCESSED_BUILDINGS_INDEX_PATH,
  RAW_BUILDINGS_DIR,
} from "@/lib/storage/data-paths";

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
  cellMaxZ: z.record(z.string(), z.number().finite()).optional(),
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

interface SpatialGridCellEntry {
  key: string;
  cellY: number;
  obstacleIndices: number[];
  cellMaxZ: number | undefined;
}

export interface BuildingShadowInput {
  pointX: number;
  pointY: number;
  pointElevation: number;
  solarAzimuthDeg: number;
  solarAltitudeDeg: number;
  maxDistanceMeters?: number;
  buildingHeightBiasMeters?: number;
  allowedBlockerIds?: ReadonlySet<string>;
  excludedBlockerIds?: ReadonlySet<string>;
  debugCollector?: (debug: BuildingShadowDebugPass) => void;
}

export interface BuildingShadowResult {
  blocked: boolean;
  blockerId: string | null;
  blockerDistanceMeters: number | null;
  blockerAltitudeAngleDeg: number | null;
  checkedObstaclesCount: number;
  profiling?: {
    mode: "base" | "two-level";
    basePasses: number;
    nearThresholdHits: number;
    detailedVerifierCalls: number;
    detailedVerifierBlocked: number;
    detailedVerifierCleared: number;
    fallbackPassUsed: boolean;
  };
}

export interface BuildingContainmentResult {
  insideBuilding: boolean;
  buildingId: string | null;
}

export interface BuildingShadowDebugPass {
  candidateCellKeys: string[];
  candidateObstacleCount: number;
  checkedObstacleIds: string[];
  checkedObstaclesCount: number;
  blockerId: string | null;
  stats?: {
    skippedDisallowedBlockerId: number;
    skippedExcludedBlockerId: number;
    skippedDistance: number;
    skippedLateral: number;
    skippedBBoxMissOrTooFar: number;
    skippedByExistingCloserBlocker: number;
    skippedBelowRayAltitude: number;
    rejectedNoIntersection: number;
    rejectedIntersectionTooFar: number;
    rejectedVerticalClearance: number;
    rejectedByAltitudeAngle: number;
    wouldBlockButFarther: number;
    acceptedAsBlocker: number;
  };
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface RawVertex {
  x?: number;
  y?: number;
  z?: number;
  flag?: number;
  i1?: number;
  i2?: number;
  i3?: number;
  i4?: number;
}

interface Polyface {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  vertices: Vec3[];
  faces: number[][];
}

interface DetailedObstacleMesh {
  obstacleId: string;
  triangles: PreparedTriangle[];
  bvh: TriangleBvhNode | null;
}

interface PreparedTriangle {
  a: Vec3;
  edge1: Vec3;
  edge2: Vec3;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  centroidX: number;
  centroidY: number;
  centroidZ: number;
}

interface TriangleBvhNode {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  left: TriangleBvhNode | null;
  right: TriangleBvhNode | null;
  triangleIndices: number[] | null;
}

export interface DetailedBuildingShadowVerificationInput {
  blockerId: string;
  pointX: number;
  pointY: number;
  pointElevation: number;
  solarAzimuthDeg: number;
  solarAltitudeDeg: number;
  maxDistanceMeters: number;
}

export interface DetailedBuildingShadowVerificationResult {
  blocked: boolean;
  blockerDistanceMeters: number | null;
}

export interface BuildingsShadowTwoLevelOptions {
  nearThresholdDegrees?: number;
  maxRefinementSteps?: number;
  detailedVerifier?: (
    input: DetailedBuildingShadowVerificationInput,
  ) => DetailedBuildingShadowVerificationResult;
}


let obstacleIndexCache: BuildingObstacleIndex | null | undefined;
let buildingZipPathByNameCache: Map<string, string> | null = null;
const zipPolyfaceCache = new Map<string, Polyface[]>();
const detailedMeshCacheByObstacleId = new Map<string, DetailedObstacleMesh | null>();
const spatialGridColumnsCache = new WeakMap<
  BuildingObstacleSpatialGrid,
  Map<number, SpatialGridCellEntry[]>
>();

const DEFAULT_SPATIAL_GRID_CELL_SIZE_METERS = 64;
const BUILDINGS_TWO_LEVEL_NEAR_THRESHOLD_DEGREES = 2;
const BUILDINGS_TWO_LEVEL_MAX_REFINEMENT_STEPS = 3;
const DETAILED_MESH_BVH_LEAF_TRIANGLE_COUNT = 12;

export async function loadBuildingsObstacleIndex(): Promise<BuildingObstacleIndex | null> {
  if (obstacleIndexCache !== undefined) {
    return obstacleIndexCache;
  }

  try {
    const raw = await fs.readFile(PROCESSED_BUILDINGS_INDEX_PATH, "utf8");
    const parsed = buildingIndexSchema.parse(JSON.parse(raw));
    let sanitizedFootprintsCount = 0;
    const sanitizedObstacles = parsed.obstacles.map((obstacle) => {
      const sanitized = sanitizeObstacleFootprint(obstacle);
      if (sanitized.wasSanitized) {
        sanitizedFootprintsCount += 1;
      }
      return sanitized.obstacle;
    });
    obstacleIndexCache = {
      ...parsed,
      method:
        sanitizedFootprintsCount > 0
          ? `${parsed.method}|runtime-footprint-sanitize-v1(${sanitizedFootprintsCount})`
          : parsed.method,
      obstacles: sanitizedObstacles,
      spatialGrid: sanitizeSpatialGrid(parsed.spatialGrid, sanitizedObstacles),
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
  obstacles: BuildingObstacle[],
): BuildingObstacleSpatialGrid | undefined {
  if (!spatialGrid) {
    return undefined;
  }

  for (const indices of Object.values(spatialGrid.cells)) {
    for (const index of indices) {
      if (index < 0 || index >= obstacles.length) {
        return undefined;
      }
    }
  }

  const computedCellMaxZ: Record<string, number> = {};
  for (const [key, indices] of Object.entries(spatialGrid.cells)) {
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const index of indices) {
      const obstacle = obstacles[index];
      if (!obstacle) {
        continue;
      }
      maxZ = Math.max(maxZ, obstacle.maxZ);
    }
    if (Number.isFinite(maxZ)) {
      computedCellMaxZ[key] = Math.round(maxZ * 1000) / 1000;
    }
  }

  const validProvidedCellMaxZ =
    spatialGrid.cellMaxZ &&
    Object.entries(spatialGrid.cellMaxZ).every(
      ([key, value]) => Number.isFinite(value) && key in spatialGrid.cells,
    )
      ? spatialGrid.cellMaxZ
      : null;

  return {
    ...spatialGrid,
    cellMaxZ: validProvidedCellMaxZ ?? computedCellMaxZ,
  };
}

function sanitizeObstacleFootprint(
  obstacle: BuildingObstacle,
): { obstacle: BuildingObstacle; wasSanitized: boolean } {
  if (!obstacle.footprint || obstacle.footprint.length < 3) {
    return {
      obstacle,
      wasSanitized: false,
    };
  }

  const normalized = normalizeBuildingFootprint(
    obstacle.footprint as NormalizedFootprintPoint[],
  );
  if (!normalized.footprint || normalized.footprint.length < 3) {
    return {
      obstacle: {
        ...obstacle,
        footprint: undefined,
        footprintArea: undefined,
      },
      wasSanitized: true,
    };
  }

  if (!normalized.usedConvexHullFallback) {
    return {
      obstacle,
      wasSanitized: false,
    };
  }

  return {
    obstacle: {
      ...obstacle,
      footprint: normalized.footprint.map((point) => ({
        x: Math.round(point.x * 1000) / 1000,
        y: Math.round(point.y * 1000) / 1000,
      })),
      footprintArea: Math.round(polygonArea(normalized.footprint) * 1000) / 1000,
    },
    wasSanitized: true,
  };
}

function buildCellKey(cellX: number, cellY: number): string {
  return `${cellX}:${cellY}`;
}

function normalizeAzimuthDeg(value: number): number {
  const normalized = value % 360;
  return normalized >= 0 ? normalized : normalized + 360;
}

function lowerBoundCellY(entries: SpatialGridCellEntry[], targetCellY: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (entries[mid].cellY < targetCellY) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function buildSpatialGridColumns(
  spatialGrid: BuildingObstacleSpatialGrid,
): Map<number, SpatialGridCellEntry[]> {
  const cached = spatialGridColumnsCache.get(spatialGrid);
  if (cached) {
    return cached;
  }

  const columns = new Map<number, SpatialGridCellEntry[]>();
  for (const [key, obstacleIndices] of Object.entries(spatialGrid.cells)) {
    const separatorIndex = key.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= key.length - 1) {
      continue;
    }
    const cellX = Number.parseInt(key.slice(0, separatorIndex), 10);
    const cellY = Number.parseInt(key.slice(separatorIndex + 1), 10);
    if (!Number.isFinite(cellX) || !Number.isFinite(cellY)) {
      continue;
    }

    const entry: SpatialGridCellEntry = {
      key,
      cellY,
      obstacleIndices,
      cellMaxZ: spatialGrid.cellMaxZ?.[key],
    };
    const column = columns.get(cellX);
    if (column) {
      column.push(entry);
    } else {
      columns.set(cellX, [entry]);
    }
  }

  for (const column of columns.values()) {
    column.sort((left, right) => left.cellY - right.cellY);
  }
  spatialGridColumnsCache.set(spatialGrid, columns);
  return columns;
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
  pointElevation: number;
  buildingHeightBiasMeters: number;
  solarAltitudeTan: number;
  collectCandidateCellKeys?: boolean;
}): { indices: number[]; candidateCellKeys: string[] } {
  const cellSizeMeters = params.spatialGrid.cellSizeMeters;
  if (!Number.isFinite(cellSizeMeters) || cellSizeMeters <= 0) {
    return {
      indices: params.obstacles.map((_, index) => index),
      candidateCellKeys: [],
    };
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
  const minCellX = Math.floor(minX / cellSizeMeters);
  const maxCellX = Math.floor(maxX / cellSizeMeters);
  const minCellY = Math.floor(minY / cellSizeMeters);
  const maxCellY = Math.floor(maxY / cellSizeMeters);
  const candidateIndices = new Set<number>();
  const candidateCellKeys: string[] = [];
  const cellHalfDiagonal = (Math.SQRT2 * cellSizeMeters) / 2;
  const corridorHalfWidth = cellHalfDiagonal + maxHalfDiagonal;
  const spatialGridColumns = buildSpatialGridColumns(params.spatialGrid);
  const canUseAltitudeCulling =
    Number.isFinite(params.solarAltitudeTan) &&
    params.solarAltitudeTan > 0 &&
    Number.isFinite(params.pointElevation);

  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    const column = spatialGridColumns.get(cellX);
    if (!column || column.length === 0) {
      continue;
    }

    for (
      let columnIndex = lowerBoundCellY(column, minCellY);
      columnIndex < column.length && column[columnIndex].cellY <= maxCellY;
      columnIndex += 1
    ) {
      const cell = column[columnIndex];
      const centerX = (cellX + 0.5) * cellSizeMeters;
      const centerY = (cell.cellY + 0.5) * cellSizeMeters;
      const dx = centerX - params.pointX;
      const dy = centerY - params.pointY;
      const dot = dx * params.dirX + dy * params.dirY;
      if (dot < -cellHalfDiagonal) {
        continue;
      }
      const lateral = Math.abs(dx * params.dirY - dy * params.dirX);
      if (lateral > corridorHalfWidth) {
        continue;
      }
      const centerDistance = Math.hypot(dx, dy);
      if (centerDistance > params.maxDistanceMeters + cellHalfDiagonal) {
        continue;
      }

      if (canUseAltitudeCulling && cell.cellMaxZ !== undefined) {
        const minRayDistance = Math.max(0, dot - cellHalfDiagonal);
        const requiredTop = params.pointElevation + minRayDistance * params.solarAltitudeTan;
        if (cell.cellMaxZ + params.buildingHeightBiasMeters < requiredTop) {
          continue;
        }
      }
      if (params.collectCandidateCellKeys) {
        candidateCellKeys.push(cell.key);
      }

      for (const obstacleIndex of cell.obstacleIndices) {
        candidateIndices.add(obstacleIndex);
      }
    }
  }
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
    const lateral = Math.abs(dx * params.dirY - dy * params.dirX);
    if (lateral > obstacle.halfDiagonal) {
      continue;
    }
    const centerDistance = Math.hypot(dx, dy);
    if (centerDistance > params.maxDistanceMeters + obstacle.halfDiagonal) {
      continue;
    }
    if (canUseAltitudeCulling) {
      const minRayDistance = Math.max(0, dot - obstacle.halfDiagonal);
      const requiredTop =
        params.pointElevation + minRayDistance * params.solarAltitudeTan;
      if (obstacle.maxZ + params.buildingHeightBiasMeters < requiredTop) {
        continue;
      }
    }
    filteredIndices.push(obstacleIndex);
  }

  return {
    indices: filteredIndices,
    candidateCellKeys,
  };
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

function parseNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFaceRecord(flag: number | undefined): boolean {
  if (flag === undefined) {
    return false;
  }
  return (flag & 128) !== 0 && (flag & 64) === 0;
}

function isCoordinateVertex(flag: number | undefined): boolean {
  return !isFaceRecord(flag);
}

function finalizePolyface(rawVertices: RawVertex[]): Polyface | null {
  const coordVertices: Vec3[] = [];
  const faces: number[][] = [];

  for (const vertex of rawVertices) {
    if (isFaceRecord(vertex.flag)) {
      const indices = [vertex.i1, vertex.i2, vertex.i3, vertex.i4]
        .filter((value): value is number => Number.isFinite(value))
        .map((value) => Math.trunc(value))
        .filter((value) => value !== 0)
        .map((value) => Math.abs(value));
      if (indices.length >= 3) {
        faces.push(indices);
      }
      continue;
    }
    if (
      isCoordinateVertex(vertex.flag) &&
      vertex.x !== undefined &&
      vertex.y !== undefined &&
      vertex.z !== undefined
    ) {
      coordVertices.push({
        x: vertex.x,
        y: vertex.y,
        z: vertex.z,
      });
    }
  }

  if (coordVertices.length < 3 || faces.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const vertex of coordVertices) {
    minX = Math.min(minX, vertex.x);
    minY = Math.min(minY, vertex.y);
    minZ = Math.min(minZ, vertex.z);
    maxX = Math.max(maxX, vertex.x);
    maxY = Math.max(maxY, vertex.y);
    maxZ = Math.max(maxZ, vertex.z);
  }

  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    vertices: coordVertices,
    faces,
  };
}

function parsePolyfacesFromZip(zipPath: string): Polyface[] {
  const zip = new AdmZip(zipPath);
  const dxfEntry = zip
    .getEntries()
    .find((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".dxf"));
  if (!dxfEntry) {
    return [];
  }

  const lines = dxfEntry.getData().toString("latin1").split(/\r?\n/);
  const polyfaces: Polyface[] = [];
  let pendingSectionName = false;
  let inEntities = false;
  let inPolyline = false;
  let currentVertices: RawVertex[] = [];
  let currentVertex: RawVertex | null = null;

  const flushVertex = () => {
    if (!currentVertex) {
      return;
    }
    currentVertices.push(currentVertex);
    currentVertex = null;
  };

  const flushPolyline = () => {
    flushVertex();
    const polyface = finalizePolyface(currentVertices);
    if (polyface) {
      polyfaces.push(polyface);
    }
    currentVertices = [];
    inPolyline = false;
  };

  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = lines[index].trim();
    const value = lines[index + 1].trim();

    if (code === "0") {
      flushVertex();
      if (value === "SECTION") {
        pendingSectionName = true;
        continue;
      }
      if (value === "ENDSEC") {
        pendingSectionName = false;
        if (inPolyline) {
          flushPolyline();
        }
        inEntities = false;
        continue;
      }
      if (!inEntities) {
        continue;
      }
      if (value === "POLYLINE") {
        if (inPolyline) {
          flushPolyline();
        }
        inPolyline = true;
        currentVertices = [];
        continue;
      }
      if (value === "VERTEX" && inPolyline) {
        currentVertex = {};
        continue;
      }
      if (value === "SEQEND" && inPolyline) {
        flushPolyline();
        continue;
      }
      if (inPolyline) {
        flushPolyline();
      }
      continue;
    }

    if (pendingSectionName && code === "2") {
      inEntities = value === "ENTITIES";
      pendingSectionName = false;
      continue;
    }

    if (!inEntities || !inPolyline || !currentVertex) {
      continue;
    }

    if (code === "10") {
      currentVertex.x = parseNumber(value) ?? undefined;
      continue;
    }
    if (code === "20") {
      currentVertex.y = parseNumber(value) ?? undefined;
      continue;
    }
    if (code === "30") {
      currentVertex.z = parseNumber(value) ?? undefined;
      continue;
    }
    if (code === "70") {
      const parsed = parseNumber(value);
      currentVertex.flag = parsed === null ? undefined : Math.trunc(parsed);
      continue;
    }
    if (code === "71") {
      const parsed = parseNumber(value);
      currentVertex.i1 = parsed === null ? undefined : Math.trunc(parsed);
      continue;
    }
    if (code === "72") {
      const parsed = parseNumber(value);
      currentVertex.i2 = parsed === null ? undefined : Math.trunc(parsed);
      continue;
    }
    if (code === "73") {
      const parsed = parseNumber(value);
      currentVertex.i3 = parsed === null ? undefined : Math.trunc(parsed);
      continue;
    }
    if (code === "74") {
      const parsed = parseNumber(value);
      currentVertex.i4 = parsed === null ? undefined : Math.trunc(parsed);
    }
  }

  if (inPolyline) {
    flushPolyline();
  }

  return polyfaces;
}

function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function subVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  };
}

function rayPreparedTriangleIntersectionDistance(
  origin: Vec3,
  direction: Vec3,
  triangle: PreparedTriangle,
): number | null {
  const epsilon = 1e-9;
  const h = crossVec3(direction, triangle.edge2);
  const det = dotVec3(triangle.edge1, h);
  if (Math.abs(det) < epsilon) {
    return null;
  }
  const invDet = 1 / det;
  const s = subVec3(origin, triangle.a);
  const u = invDet * dotVec3(s, h);
  if (u < 0 || u > 1) {
    return null;
  }
  const q = crossVec3(s, triangle.edge1);
  const v = invDet * dotVec3(direction, q);
  if (v < 0 || u + v > 1) {
    return null;
  }
  const t = invDet * dotVec3(triangle.edge2, q);
  if (t <= epsilon) {
    return null;
  }
  return t;
}

function prepareTriangle(a: Vec3, b: Vec3, c: Vec3): PreparedTriangle {
  const edge1 = subVec3(b, a);
  const edge2 = subVec3(c, a);
  const minX = Math.min(a.x, b.x, c.x);
  const minY = Math.min(a.y, b.y, c.y);
  const minZ = Math.min(a.z, b.z, c.z);
  const maxX = Math.max(a.x, b.x, c.x);
  const maxY = Math.max(a.y, b.y, c.y);
  const maxZ = Math.max(a.z, b.z, c.z);
  return {
    a,
    edge1,
    edge2,
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    centroidX: (a.x + b.x + c.x) / 3,
    centroidY: (a.y + b.y + c.y) / 3,
    centroidZ: (a.z + b.z + c.z) / 3,
  };
}

function toPreparedTriangles(polyface: Polyface): PreparedTriangle[] {
  const triangles: PreparedTriangle[] = [];
  for (const face of polyface.faces) {
    const valid = face
      .map((index) => polyface.vertices[index - 1] ?? null)
      .filter((value): value is Vec3 => value !== null);
    if (valid.length < 3) {
      continue;
    }
    if (valid.length === 3) {
      triangles.push(prepareTriangle(valid[0], valid[1], valid[2]));
      continue;
    }
    triangles.push(prepareTriangle(valid[0], valid[1], valid[2]));
    triangles.push(prepareTriangle(valid[0], valid[2], valid[3]));
  }
  return triangles;
}

function rayAabbIntersectionDistance(
  origin: Vec3,
  direction: Vec3,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  maxDistance: number,
): number | null {
  let tMin = 0;
  let tMax = maxDistance;
  const epsilon = 1e-12;

  if (Math.abs(direction.x) < epsilon) {
    if (origin.x < minX || origin.x > maxX) {
      return null;
    }
  } else {
    const tx1 = (minX - origin.x) / direction.x;
    const tx2 = (maxX - origin.x) / direction.x;
    tMin = Math.max(tMin, Math.min(tx1, tx2));
    tMax = Math.min(tMax, Math.max(tx1, tx2));
    if (tMin > tMax) {
      return null;
    }
  }

  if (Math.abs(direction.y) < epsilon) {
    if (origin.y < minY || origin.y > maxY) {
      return null;
    }
  } else {
    const ty1 = (minY - origin.y) / direction.y;
    const ty2 = (maxY - origin.y) / direction.y;
    tMin = Math.max(tMin, Math.min(ty1, ty2));
    tMax = Math.min(tMax, Math.max(ty1, ty2));
    if (tMin > tMax) {
      return null;
    }
  }

  if (Math.abs(direction.z) < epsilon) {
    if (origin.z < minZ || origin.z > maxZ) {
      return null;
    }
  } else {
    const tz1 = (minZ - origin.z) / direction.z;
    const tz2 = (maxZ - origin.z) / direction.z;
    tMin = Math.max(tMin, Math.min(tz1, tz2));
    tMax = Math.min(tMax, Math.max(tz1, tz2));
    if (tMin > tMax) {
      return null;
    }
  }

  if (tMax < 0) {
    return null;
  }
  return Math.max(0, tMin);
}

function buildTriangleBvhNode(
  triangles: PreparedTriangle[],
  indices: number[],
): TriangleBvhNode {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const index of indices) {
    const triangle = triangles[index];
    minX = Math.min(minX, triangle.minX);
    minY = Math.min(minY, triangle.minY);
    minZ = Math.min(minZ, triangle.minZ);
    maxX = Math.max(maxX, triangle.maxX);
    maxY = Math.max(maxY, triangle.maxY);
    maxZ = Math.max(maxZ, triangle.maxZ);
  }

  if (indices.length <= DETAILED_MESH_BVH_LEAF_TRIANGLE_COUNT) {
    return {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      left: null,
      right: null,
      triangleIndices: indices,
    };
  }

  const extentX = maxX - minX;
  const extentY = maxY - minY;
  const extentZ = maxZ - minZ;
  const splitAxis: "x" | "y" | "z" =
    extentX >= extentY && extentX >= extentZ
      ? "x"
      : extentY >= extentZ
        ? "y"
        : "z";

  const sorted = [...indices].sort((leftIndex, rightIndex) => {
    const leftTriangle = triangles[leftIndex];
    const rightTriangle = triangles[rightIndex];
    if (splitAxis === "x") {
      return leftTriangle.centroidX - rightTriangle.centroidX;
    }
    if (splitAxis === "y") {
      return leftTriangle.centroidY - rightTriangle.centroidY;
    }
    return leftTriangle.centroidZ - rightTriangle.centroidZ;
  });
  const mid = Math.floor(sorted.length / 2);
  const leftIndices = sorted.slice(0, mid);
  const rightIndices = sorted.slice(mid);

  if (leftIndices.length === 0 || rightIndices.length === 0) {
    return {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      left: null,
      right: null,
      triangleIndices: indices,
    };
  }

  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    left: buildTriangleBvhNode(triangles, leftIndices),
    right: buildTriangleBvhNode(triangles, rightIndices),
    triangleIndices: null,
  };
}

function buildTriangleBvh(triangles: PreparedTriangle[]): TriangleBvhNode | null {
  if (triangles.length === 0) {
    return null;
  }
  const indices = Array.from({ length: triangles.length }, (_, index) => index);
  return buildTriangleBvhNode(triangles, indices);
}

function listZipFilesByBasenameSync(): Map<string, string> {
  if (buildingZipPathByNameCache !== null) {
    return buildingZipPathByNameCache;
  }

  const result = new Map<string, string>();
  const stack = [RAW_BUILDINGS_DIR];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fsSync.existsSync(current)) {
      continue;
    }
    const entries = fsSync.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        result.set(entry.name, fullPath);
      }
    }
  }

  buildingZipPathByNameCache = result;
  return result;
}

function matchPolyfaceToObstacle(
  obstacle: BuildingObstacle,
  polyfaces: Polyface[],
): Polyface | null {
  let best: { score: number; polyface: Polyface } | null = null;
  for (const polyface of polyfaces) {
    const score =
      Math.abs(polyface.minX - obstacle.minX) +
      Math.abs(polyface.minY - obstacle.minY) +
      Math.abs(polyface.maxX - obstacle.maxX) +
      Math.abs(polyface.maxY - obstacle.maxY) +
      Math.abs(polyface.minZ - obstacle.minZ) * 0.15;
    if (score > 6) {
      continue;
    }
    if (!best || score < best.score) {
      best = {
        score,
        polyface,
      };
    }
  }
  return best?.polyface ?? null;
}

function getObstacleById(
  obstacles: BuildingObstacle[],
  obstacleId: string,
): BuildingObstacle | null {
  for (const obstacle of obstacles) {
    if (obstacle.id === obstacleId) {
      return obstacle;
    }
  }
  return null;
}

function loadObstacleMeshSync(
  obstacles: BuildingObstacle[],
  blockerId: string,
): DetailedObstacleMesh | null {
  const cached = detailedMeshCacheByObstacleId.get(blockerId);
  if (cached !== undefined) {
    return cached;
  }

  const obstacle = getObstacleById(obstacles, blockerId);
  if (!obstacle) {
    detailedMeshCacheByObstacleId.set(blockerId, null);
    return null;
  }

  const zipsByBasename = listZipFilesByBasenameSync();
  const zipPath = zipsByBasename.get(obstacle.sourceZip);
  if (!zipPath) {
    detailedMeshCacheByObstacleId.set(blockerId, null);
    return null;
  }

  let polyfaces = zipPolyfaceCache.get(zipPath);
  if (!polyfaces) {
    polyfaces = parsePolyfacesFromZip(zipPath);
    zipPolyfaceCache.set(zipPath, polyfaces);
  }
  const matched = matchPolyfaceToObstacle(obstacle, polyfaces);
  if (!matched) {
    detailedMeshCacheByObstacleId.set(blockerId, null);
    return null;
  }

  const mesh: DetailedObstacleMesh = {
    obstacleId: blockerId,
    triangles: toPreparedTriangles(matched),
    bvh: null,
  };
  mesh.bvh = buildTriangleBvh(mesh.triangles);
  detailedMeshCacheByObstacleId.set(blockerId, mesh);
  return mesh;
}

function findNearestIntersectionInMesh(
  mesh: DetailedObstacleMesh,
  point: Vec3,
  direction: Vec3,
  maxT: number,
): number | null {
  if (mesh.triangles.length === 0) {
    return null;
  }

  const root = mesh.bvh;
  if (!root) {
    let bestT: number | null = null;
    for (const triangle of mesh.triangles) {
      const t = rayPreparedTriangleIntersectionDistance(point, direction, triangle);
      if (t === null || t > maxT) {
        continue;
      }
      if (bestT === null || t < bestT) {
        bestT = t;
      }
    }
    return bestT;
  }

  const rootEntry = rayAabbIntersectionDistance(
    point,
    direction,
    root.minX,
    root.minY,
    root.minZ,
    root.maxX,
    root.maxY,
    root.maxZ,
    maxT,
  );
  if (rootEntry === null) {
    return null;
  }

  const stack: TriangleBvhNode[] = [root];
  let bestT: number | null = null;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const maxDistanceForNode = bestT === null ? maxT : Math.min(maxT, bestT);

    if (current.triangleIndices) {
      for (const triangleIndex of current.triangleIndices) {
        const triangle = mesh.triangles[triangleIndex];
        const t = rayPreparedTriangleIntersectionDistance(point, direction, triangle);
        if (t === null || t > maxDistanceForNode) {
          continue;
        }
        if (bestT === null || t < bestT) {
          bestT = t;
        }
      }
      continue;
    }

    const left = current.left;
    const right = current.right;
    const leftEntry =
      left &&
      rayAabbIntersectionDistance(
        point,
        direction,
        left.minX,
        left.minY,
        left.minZ,
        left.maxX,
        left.maxY,
        left.maxZ,
        maxDistanceForNode,
      );
    const rightEntry =
      right &&
      rayAabbIntersectionDistance(
        point,
        direction,
        right.minX,
        right.minY,
        right.minZ,
        right.maxX,
        right.maxY,
        right.maxZ,
        maxDistanceForNode,
      );

    if (left && right && leftEntry !== null && rightEntry !== null) {
      if (leftEntry <= rightEntry) {
        stack.push(right);
        stack.push(left);
      } else {
        stack.push(left);
        stack.push(right);
      }
    } else if (left && leftEntry !== null) {
      stack.push(left);
    } else if (right && rightEntry !== null) {
      stack.push(right);
    }
  }

  return bestT;
}

export function createDetailedBuildingShadowVerifier(
  obstacles: BuildingObstacle[],
): (
  input: DetailedBuildingShadowVerificationInput,
) => DetailedBuildingShadowVerificationResult {
  return (input: DetailedBuildingShadowVerificationInput) => {
    if (input.solarAltitudeDeg <= 0) {
      return {
        blocked: false,
        blockerDistanceMeters: null,
      };
    }

    const mesh = loadObstacleMeshSync(obstacles, input.blockerId);
    if (!mesh) {
      return {
        blocked: true,
        blockerDistanceMeters: null,
      };
    }

    const azimuthRad = (input.solarAzimuthDeg * Math.PI) / 180;
    const altitudeRad = (input.solarAltitudeDeg * Math.PI) / 180;
    const cosAlt = Math.cos(altitudeRad);
    const direction: Vec3 = {
      x: Math.sin(azimuthRad) * cosAlt,
      y: Math.cos(azimuthRad) * cosAlt,
      z: Math.sin(altitudeRad),
    };
    const maxT =
      cosAlt <= 1e-6 ? Number.POSITIVE_INFINITY : input.maxDistanceMeters / cosAlt;
    const point: Vec3 = {
      x: input.pointX,
      y: input.pointY,
      z: input.pointElevation,
    };

    const bestT = findNearestIntersectionInMesh(mesh, point, direction, maxT);

    if (bestT === null) {
      return {
        blocked: false,
        blockerDistanceMeters: null,
      };
    }

    return {
      blocked: true,
      blockerDistanceMeters: Math.round(bestT * cosAlt * 1000) / 1000,
    };
  };
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
      profiling: {
        mode: "base",
        basePasses: 1,
        nearThresholdHits: 0,
        detailedVerifierCalls: 0,
        detailedVerifierBlocked: 0,
        detailedVerifierCleared: 0,
        fallbackPassUsed: false,
      },
    };
  }

  const maxDistanceMeters = input.maxDistanceMeters ?? 2500;
  const buildingHeightBiasMeters = input.buildingHeightBiasMeters ?? 0;
  const effectivePointElevation = input.pointElevation;
  const azimuthRad = (input.solarAzimuthDeg * Math.PI) / 180;
  const dirX = Math.sin(azimuthRad);
  const dirY = Math.cos(azimuthRad);
  const solarAltitudeTan = Math.tan((input.solarAltitudeDeg * Math.PI) / 180);

  let blockerId: string | null = null;
  let blockerDistanceMeters: number | null = null;
  let blockerAltitudeAngleDeg: number | null = null;
  let checkedObstaclesCount = 0;
  const collectDebug = typeof input.debugCollector === "function";
  const checkedObstacleIds: string[] = [];
  const debugStats = collectDebug
    ? {
        skippedDisallowedBlockerId: 0,
        skippedExcludedBlockerId: 0,
        skippedDistance: 0,
        skippedLateral: 0,
        skippedBBoxMissOrTooFar: 0,
        skippedByExistingCloserBlocker: 0,
        skippedBelowRayAltitude: 0,
        rejectedNoIntersection: 0,
        rejectedIntersectionTooFar: 0,
        rejectedVerticalClearance: 0,
        rejectedByAltitudeAngle: 0,
        wouldBlockButFarther: 0,
        acceptedAsBlocker: 0,
      }
    : null;
  const candidateSelection = spatialGrid
    ? collectCandidateObstacleIndices({
        obstacles,
        spatialGrid,
        pointX: input.pointX,
        pointY: input.pointY,
        dirX,
        dirY,
        maxDistanceMeters,
        pointElevation: effectivePointElevation,
        buildingHeightBiasMeters,
        solarAltitudeTan,
        collectCandidateCellKeys: collectDebug,
      })
    : {
        indices: obstacles.map((_, index) => index),
        candidateCellKeys: [],
      };
  const candidateIndices = candidateSelection.indices;

  for (const obstacleIndex of candidateIndices) {
    const obstacle = obstacles[obstacleIndex];
    if (!obstacle) {
      continue;
    }
    if (input.allowedBlockerIds && !input.allowedBlockerIds.has(obstacle.id)) {
      if (debugStats) {
        debugStats.skippedDisallowedBlockerId += 1;
      }
      continue;
    }
    if (input.excludedBlockerIds?.has(obstacle.id)) {
      if (debugStats) {
        debugStats.skippedExcludedBlockerId += 1;
      }
      continue;
    }
    const centerDistance = Math.hypot(
      obstacle.centerX - input.pointX,
      obstacle.centerY - input.pointY,
    );
    if (centerDistance > maxDistanceMeters + obstacle.halfDiagonal) {
      if (debugStats) {
        debugStats.skippedDistance += 1;
      }
      continue;
    }
    const lateral = Math.abs(
      (obstacle.centerX - input.pointX) * dirY -
        (obstacle.centerY - input.pointY) * dirX,
    );
    if (lateral > obstacle.halfDiagonal) {
      if (debugStats) {
        debugStats.skippedLateral += 1;
      }
      continue;
    }
    const bboxEntryDistance = rayBoxIntersectionDistance(
      input.pointX,
      input.pointY,
      dirX,
      dirY,
      obstacle,
    );
    if (bboxEntryDistance === null || bboxEntryDistance > maxDistanceMeters) {
      if (debugStats) {
        debugStats.skippedBBoxMissOrTooFar += 1;
      }
      continue;
    }
    if (blockerDistanceMeters !== null && bboxEntryDistance >= blockerDistanceMeters) {
      if (debugStats) {
        debugStats.skippedByExistingCloserBlocker += 1;
      }
      continue;
    }
    if (Number.isFinite(solarAltitudeTan) && solarAltitudeTan > 0) {
      const minRayDistance = Math.max(0, bboxEntryDistance);
      const requiredTop = effectivePointElevation + minRayDistance * solarAltitudeTan;
      if (obstacle.maxZ + buildingHeightBiasMeters < requiredTop) {
        if (debugStats) {
          debugStats.skippedBelowRayAltitude += 1;
        }
        continue;
      }
    }

    checkedObstaclesCount += 1;
    if (collectDebug) {
      checkedObstacleIds.push(obstacle.id);
    }

    const intersectionDistance =
      obstacle.footprint && obstacle.footprint.length >= 3
        ? rayPolygonIntersectionDistance(
            input.pointX,
            input.pointY,
            dirX,
            dirY,
            obstacle.footprint,
          )
        : bboxEntryDistance;

    if (intersectionDistance === null) {
      if (debugStats) {
        debugStats.rejectedNoIntersection += 1;
      }
      continue;
    }

    if (intersectionDistance > maxDistanceMeters) {
      if (debugStats) {
        debugStats.rejectedIntersectionTooFar += 1;
      }
      continue;
    }

    const effectiveObstacleTop = obstacle.maxZ + buildingHeightBiasMeters;
    const verticalClearance = effectiveObstacleTop - effectivePointElevation;
    if (verticalClearance <= 0) {
      if (debugStats) {
        debugStats.rejectedVerticalClearance += 1;
      }
      continue;
    }

    const altitudeAngleDeg =
      (Math.atan2(verticalClearance, Math.max(1, intersectionDistance)) * 180) /
      Math.PI;
    if (input.solarAltitudeDeg > altitudeAngleDeg) {
      if (debugStats) {
        debugStats.rejectedByAltitudeAngle += 1;
      }
      continue;
    }

    if (blockerDistanceMeters === null || intersectionDistance < blockerDistanceMeters) {
      blockerId = obstacle.id;
      blockerDistanceMeters = intersectionDistance;
      blockerAltitudeAngleDeg = altitudeAngleDeg;
      if (debugStats) {
        debugStats.acceptedAsBlocker += 1;
      }
    } else if (debugStats) {
      debugStats.wouldBlockButFarther += 1;
    }
  }

  if (collectDebug) {
    input.debugCollector?.({
      candidateCellKeys: candidateSelection.candidateCellKeys,
      candidateObstacleCount: candidateIndices.length,
      checkedObstacleIds,
      checkedObstaclesCount,
      blockerId,
      stats: debugStats ?? undefined,
    });
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
    profiling: {
      mode: "base",
      basePasses: 1,
      nearThresholdHits: 0,
      detailedVerifierCalls: 0,
      detailedVerifierBlocked: 0,
      detailedVerifierCleared: 0,
      fallbackPassUsed: false,
    },
  };
}

export function evaluateBuildingsShadowTwoLevel(
  obstacles: BuildingObstacle[],
  input: BuildingShadowInput,
  spatialGrid?: BuildingObstacleSpatialGrid,
  options: BuildingsShadowTwoLevelOptions = {},
): BuildingShadowResult {
  const nearThresholdDegrees =
    options.nearThresholdDegrees ?? BUILDINGS_TWO_LEVEL_NEAR_THRESHOLD_DEGREES;
  const maxRefinementSteps =
    options.maxRefinementSteps ?? BUILDINGS_TWO_LEVEL_MAX_REFINEMENT_STEPS;
  let basePasses = 0;
  let nearThresholdHits = 0;
  let detailedVerifierCalls = 0;
  let detailedVerifierBlocked = 0;
  let detailedVerifierCleared = 0;
  let fallbackPassUsed = false;
  const withTwoLevelProfiling = (result: BuildingShadowResult): BuildingShadowResult => ({
    ...result,
    profiling: {
      mode: "two-level",
      basePasses,
      nearThresholdHits,
      detailedVerifierCalls,
      detailedVerifierBlocked,
      detailedVerifierCleared,
      fallbackPassUsed,
    },
  });

  if (!options.detailedVerifier || nearThresholdDegrees <= 0 || maxRefinementSteps <= 0) {
    const base = evaluateBuildingsShadow(obstacles, input, spatialGrid);
    basePasses = 1;
    return withTwoLevelProfiling(base);
  }

  const excludedBlockerIds = new Set<string>(input.excludedBlockerIds ?? []);
  let totalCheckedObstaclesCount = 0;

  for (let step = 0; step <= maxRefinementSteps; step += 1) {
    const base = evaluateBuildingsShadow(
      obstacles,
      {
        ...input,
        excludedBlockerIds,
      },
      spatialGrid,
    );
    basePasses += 1;
    totalCheckedObstaclesCount += base.checkedObstaclesCount;

    if (!base.blocked || !base.blockerId || base.blockerAltitudeAngleDeg === null) {
      return withTwoLevelProfiling({
        ...base,
        checkedObstaclesCount: totalCheckedObstaclesCount,
      });
    }

    const marginDeg = base.blockerAltitudeAngleDeg - input.solarAltitudeDeg;
    if (marginDeg > nearThresholdDegrees) {
      return withTwoLevelProfiling({
        ...base,
        checkedObstaclesCount: totalCheckedObstaclesCount,
      });
    }
    nearThresholdHits += 1;

    detailedVerifierCalls += 1;
    const detailed = options.detailedVerifier({
      blockerId: base.blockerId,
      pointX: input.pointX,
      pointY: input.pointY,
      pointElevation: input.pointElevation,
      solarAzimuthDeg: input.solarAzimuthDeg,
      solarAltitudeDeg: input.solarAltitudeDeg,
      maxDistanceMeters: input.maxDistanceMeters ?? 2500,
    });

    if (detailed.blocked) {
      detailedVerifierBlocked += 1;
      return withTwoLevelProfiling({
        ...base,
        checkedObstaclesCount: totalCheckedObstaclesCount,
      });
    }
    detailedVerifierCleared += 1;

    excludedBlockerIds.add(base.blockerId);
  }

  fallbackPassUsed = true;
  const fallback = evaluateBuildingsShadow(
    obstacles,
    {
      ...input,
      excludedBlockerIds,
    },
    spatialGrid,
  );
  basePasses += 1;

  return withTwoLevelProfiling({
    ...fallback,
    checkedObstaclesCount: totalCheckedObstaclesCount + fallback.checkedObstaclesCount,
  });
}
