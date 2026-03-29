import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import AdmZip from "adm-zip";
import { normalizeBuildingFootprint } from "../../src/lib/sun/building-footprint";

import {
  PROCESSED_BUILDINGS_INDEX_PATH,
  RAW_BUILDINGS_DIR,
} from "../../src/lib/storage/data-paths";

interface Point2D {
  x: number;
  y: number;
}

interface Point3D {
  x: number;
  y: number;
  z: number;
}

interface BuildingObstacle {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  height: number;
  centerX: number;
  centerY: number;
  halfDiagonal: number;
  footprint: Point2D[];
  footprintArea: number;
  sourceZip: string;
}

interface BuildingSpatialGrid {
  version: number;
  cellSizeMeters: number;
  cells: Record<string, number[]>;
  cellMaxZ: Record<string, number>;
  stats: {
    cellCount: number;
    maxObstaclesPerCell: number;
    avgObstaclesPerCell: number;
  };
}

interface PolylineAccumulator {
  vertices: Point3D[];
}

interface VertexAccumulator {
  x?: number;
  y?: number;
  z?: number;
  flag?: number;
}

const GROUND_TOLERANCE_METERS = 0.6;
const FOOTPRINT_MIN_EDGE_METERS = 0.8;
const FOOTPRINT_COLLINEAR_TOLERANCE_METERS = 0.15;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function cross(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(points: Point2D[]): Point2D[] {
  if (points.length <= 1) {
    return points;
  }

  const sorted = [...points].sort((a, b) => {
    if (a.x !== b.x) {
      return a.x - b.x;
    }
    return a.y - b.y;
  });

  const lower: Point2D[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polygonArea(points: Point2D[]): number {
  if (points.length < 3) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function pointsAreEqual(a: Point2D, b: Point2D, epsilon = 1e-6): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distancePointToSegment(point: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) {
    return distance(point, a);
  }

  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared),
  );
  const projection = {
    x: a.x + t * dx,
    y: a.y + t * dy,
  };
  return distance(point, projection);
}

function dedupePoints(points: Point2D[]): Point2D[] {
  const unique = new Map<string, Point2D>();
  for (const point of points) {
    const key = `${round3(point.x)}:${round3(point.y)}`;
    if (!unique.has(key)) {
      unique.set(key, point);
    }
  }
  return Array.from(unique.values());
}

function simplifyRingPoints(points: Point2D[]): Point2D[] {
  const simplified: Point2D[] = [];
  for (const point of points) {
    const previous = simplified.at(-1);
    if (!previous || !pointsAreEqual(previous, point)) {
      simplified.push(point);
    }
  }

  if (simplified.length > 1 && pointsAreEqual(simplified[0], simplified.at(-1)!)) {
    simplified.pop();
  }

  return simplified;
}

function orientation(a: Point2D, b: Point2D, c: Point2D): number {
  const value = cross(a, b, c);
  if (Math.abs(value) < 1e-9) {
    return 0;
  }

  return value > 0 ? 1 : -1;
}

function onSegment(a: Point2D, b: Point2D, c: Point2D): boolean {
  return (
    Math.min(a.x, c.x) - 1e-9 <= b.x &&
    b.x <= Math.max(a.x, c.x) + 1e-9 &&
    Math.min(a.y, c.y) - 1e-9 <= b.y &&
    b.y <= Math.max(a.y, c.y) + 1e-9
  );
}

function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }

  if (o1 === 0 && onSegment(a, c, b)) {
    return true;
  }
  if (o2 === 0 && onSegment(a, d, b)) {
    return true;
  }
  if (o3 === 0 && onSegment(c, a, d)) {
    return true;
  }
  if (o4 === 0 && onSegment(c, b, d)) {
    return true;
  }

  return false;
}

function isSimplePolygon(points: Point2D[]): boolean {
  if (points.length < 3) {
    return false;
  }

  for (let i = 0; i < points.length; i += 1) {
    const a1 = points[i];
    const a2 = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j += 1) {
      const b1 = points[j];
      const b2 = points[(j + 1) % points.length];

      const sharesEndpoint =
        i === j ||
        (i + 1) % points.length === j ||
        i === (j + 1) % points.length;
      if (sharesEndpoint) {
        continue;
      }

      if (segmentsIntersect(a1, a2, b1, b2)) {
        return false;
      }
    }
  }

  return true;
}

function collectGroundVertices(vertices: Point3D[], minZ: number): Point2D[] {
  return vertices
    .filter((vertex) => Math.abs(vertex.z - minZ) <= GROUND_TOLERANCE_METERS)
    .map((vertex) => ({ x: vertex.x, y: vertex.y }));
}

function simplifyFootprintGeometry(points: Point2D[]): Point2D[] {
  if (points.length < 4) {
    return points;
  }

  let ring = simplifyRingPoints(points);
  let changed = true;
  let guard = 0;

  while (changed && ring.length > 3 && guard < 256) {
    guard += 1;
    changed = false;
    const nextRing: Point2D[] = [];

    for (let i = 0; i < ring.length; i += 1) {
      const prev = ring[(i - 1 + ring.length) % ring.length];
      const curr = ring[i];
      const next = ring[(i + 1) % ring.length];
      const prevDist = distance(prev, curr);
      const nextDist = distance(curr, next);
      const collinearDistance = distancePointToSegment(curr, prev, next);
      const tinyCorner =
        prevDist <= FOOTPRINT_MIN_EDGE_METERS &&
        nextDist <= FOOTPRINT_MIN_EDGE_METERS;
      const nearlyCollinear =
        collinearDistance <= FOOTPRINT_COLLINEAR_TOLERANCE_METERS;

      if (tinyCorner || nearlyCollinear) {
        changed = true;
        continue;
      }

      nextRing.push(curr);
    }

    if (nextRing.length >= 3) {
      ring = nextRing;
    } else {
      break;
    }
  }

  return ring;
}

function extractGroundFootprint(vertices: Point3D[], minZ: number): Point2D[] | null {
  const groundVerticesRaw = collectGroundVertices(vertices, minZ);
  if (groundVerticesRaw.length < 3) {
    return null;
  }

  const groundVertices = dedupePoints(groundVerticesRaw);
  if (groundVertices.length < 3) {
    return null;
  }

  // Keep source order only when it already forms a simple ring.
  // Angle sorting can generate star-shaped spikes on complex polyfaces.
  const sourceOrdered = simplifyRingPoints(groundVertices);

  if (sourceOrdered.length >= 3 && isSimplePolygon(sourceOrdered)) {
    return sourceOrdered;
  }

  return null;
}

function chooseFootprint(vertices: Point3D[], minZ: number): Point2D[] | null {
  const groundFootprint = extractGroundFootprint(vertices, minZ);
  if (groundFootprint && polygonArea(groundFootprint) >= 4) {
    const simplified = simplifyFootprintGeometry(groundFootprint);
    const normalized = normalizeBuildingFootprint(simplified);
    if (
      normalized.footprint &&
      normalized.footprint.length >= 3 &&
      polygonArea(normalized.footprint) >= 4
    ) {
      return normalized.footprint;
    }
    if (isSimplePolygon(simplified)) {
      return simplified;
    }
  }

  const groundVertices = collectGroundVertices(vertices, minZ);
  if (groundVertices.length >= 3) {
    const groundHull = convexHull(dedupePoints(groundVertices));
    const normalizedHull = normalizeBuildingFootprint(groundHull);
    if (
      normalizedHull.footprint &&
      normalizedHull.footprint.length >= 3 &&
      polygonArea(normalizedHull.footprint) >= 4
    ) {
      return normalizedHull.footprint;
    }
  }

  const allHull = convexHull(vertices.map((vertex) => ({ x: vertex.x, y: vertex.y })));
  if (allHull.length < 3) {
    return null;
  }

  const normalizedAllHull = normalizeBuildingFootprint(allHull);
  return normalizedAllHull.footprint;
}

function obstacleKey(obstacle: BuildingObstacle): string {
  const footprintKey = obstacle.footprint
    .map((point) => `${round1(point.x)},${round1(point.y)}`)
    .join(";");
  return `${footprintKey}|${round1(obstacle.maxZ)}`;
}

function buildCellKey(cellX: number, cellY: number): string {
  return `${cellX}:${cellY}`;
}

function buildSpatialGrid(
  obstacles: BuildingObstacle[],
  cellSizeMeters: number,
): BuildingSpatialGrid {
  const cells = new Map<string, number[]>();

  for (let obstacleIndex = 0; obstacleIndex < obstacles.length; obstacleIndex += 1) {
    const obstacle = obstacles[obstacleIndex];
    const minCellX = Math.floor(obstacle.minX / cellSizeMeters);
    const maxCellX = Math.floor(obstacle.maxX / cellSizeMeters);
    const minCellY = Math.floor(obstacle.minY / cellSizeMeters);
    const maxCellY = Math.floor(obstacle.maxY / cellSizeMeters);

    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const key = buildCellKey(cellX, cellY);
        const bucket = cells.get(key);
        if (bucket) {
          bucket.push(obstacleIndex);
        } else {
          cells.set(key, [obstacleIndex]);
        }
      }
    }
  }

  const serializedCells: Record<string, number[]> = {};
  const cellMaxZ: Record<string, number> = {};
  let maxObstaclesPerCell = 0;
  let sumObstaclesPerCell = 0;
  for (const [key, bucket] of cells.entries()) {
    serializedCells[key] = bucket;
    maxObstaclesPerCell = Math.max(maxObstaclesPerCell, bucket.length);
    sumObstaclesPerCell += bucket.length;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const obstacleIndex of bucket) {
      const obstacle = obstacles[obstacleIndex];
      if (!obstacle) {
        continue;
      }
      maxZ = Math.max(maxZ, obstacle.maxZ);
    }
    if (Number.isFinite(maxZ)) {
      cellMaxZ[key] = round3(maxZ);
    }
  }

  return {
    version: 1,
    cellSizeMeters,
    cells: serializedCells,
    cellMaxZ,
    stats: {
      cellCount: cells.size,
      maxObstaclesPerCell,
      avgObstaclesPerCell:
        cells.size === 0 ? 0 : round3(sumObstaclesPerCell / cells.size),
    },
  };
}

async function listZipFilesRecursively(rootDirectory: string): Promise<string[]> {
  const result: string[] = [];
  const stack = [rootDirectory];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        result.push(fullPath);
      }
    }
  }

  result.sort();
  return result;
}

function selectLatestZipByTile(zipFiles: string[]): string[] {
  const latestByTile = new Map<
    string,
    {
      filePath: string;
      version: string;
    }
  >();
  const passthrough: string[] = [];

  for (const filePath of zipFiles) {
    const fileName = path.basename(filePath);
    const match =
      /^swissbuildings3d_2_(\d{4}-\d{2})_(\d{4}-\d{2}_2056_5728\.dxf\.zip)$/i.exec(
        fileName,
      );
    if (!match) {
      passthrough.push(filePath);
      continue;
    }

    const version = match[1];
    const tileKey = match[2].toLowerCase();
    const current = latestByTile.get(tileKey);
    if (!current || version > current.version) {
      latestByTile.set(tileKey, {
        filePath,
        version,
      });
    }
  }

  const selected = [
    ...passthrough,
    ...Array.from(latestByTile.values()).map((entry) => entry.filePath),
  ];
  selected.sort();
  return selected;
}

function parseNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCoordinateVertexFlag(flag: number | undefined): boolean {
  if (flag === undefined) {
    return true;
  }

  const isFaceRecord = (flag & 128) !== 0 && (flag & 64) === 0;
  return !isFaceRecord;
}

function emptyPolylineAccumulator(): PolylineAccumulator {
  return {
    vertices: [],
  };
}

function polylineToObstacle(
  polyline: PolylineAccumulator,
  sourceZip: string,
  obstacleId: number,
): BuildingObstacle | null {
  if (polyline.vertices.length < 4) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const vertex of polyline.vertices) {
    minX = Math.min(minX, vertex.x);
    minY = Math.min(minY, vertex.y);
    minZ = Math.min(minZ, vertex.z);
    maxX = Math.max(maxX, vertex.x);
    maxY = Math.max(maxY, vertex.y);
    maxZ = Math.max(maxZ, vertex.z);
  }

  const width = maxX - minX;
  const depth = maxY - minY;
  const height = maxZ - minZ;
  if (width < 1 || depth < 1 || height < 1) {
    return null;
  }

  const footprint = chooseFootprint(polyline.vertices, minZ);
  if (!footprint || footprint.length < 3) {
    return null;
  }
  const area = polygonArea(footprint);
  if (area < 4) {
    return null;
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const halfDiagonal = Math.hypot(width, depth) / 2;

  return {
    id: `obs-${obstacleId}`,
    minX: round3(minX),
    minY: round3(minY),
    maxX: round3(maxX),
    maxY: round3(maxY),
    minZ: round3(minZ),
    maxZ: round3(maxZ),
    height: round3(height),
    centerX: round3(centerX),
    centerY: round3(centerY),
    halfDiagonal: round3(halfDiagonal),
    footprint: footprint.map((point) => ({
      x: round3(point.x),
      y: round3(point.y),
    })),
    footprintArea: round3(area),
    sourceZip: path.basename(sourceZip),
  };
}

function parseZipObstacles(
  zipPath: string,
  obstacleStartId: number,
): { obstacles: BuildingObstacle[]; nextId: number } {
  const zip = new AdmZip(zipPath);
  const dxfEntry = zip
    .getEntries()
    .find((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".dxf"));

  if (!dxfEntry) {
    return { obstacles: [], nextId: obstacleStartId };
  }

  const content = dxfEntry.getData().toString("latin1");
  const lines = content.split(/\r?\n/);
  const obstacles: BuildingObstacle[] = [];

  let pendingSectionName = false;
  let inEntities = false;
  let inPolyline = false;
  let currentPolyline: PolylineAccumulator | null = null;
  let currentVertex: VertexAccumulator | null = null;
  let nextObstacleId = obstacleStartId;

  const flushVertex = () => {
    if (!currentVertex || !currentPolyline) {
      currentVertex = null;
      return;
    }

    if (
      isCoordinateVertexFlag(currentVertex.flag) &&
      currentVertex.x !== undefined &&
      currentVertex.y !== undefined &&
      currentVertex.z !== undefined
    ) {
      currentPolyline.vertices.push({
        x: currentVertex.x,
        y: currentVertex.y,
        z: currentVertex.z,
      });
    }

    currentVertex = null;
  };

  const flushPolyline = () => {
    flushVertex();
    if (!currentPolyline) {
      inPolyline = false;
      return;
    }

    const obstacle = polylineToObstacle(currentPolyline, zipPath, nextObstacleId);
    if (obstacle) {
      obstacles.push(obstacle);
      nextObstacleId += 1;
    }

    currentPolyline = null;
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
        currentPolyline = emptyPolylineAccumulator();
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
    }
  }

  if (inPolyline) {
    flushPolyline();
  }

  return {
    obstacles,
    nextId: nextObstacleId,
  };
}

async function main() {
  const startedAt = performance.now();
  const allZipFiles = await listZipFilesRecursively(RAW_BUILDINGS_DIR);
  const zipFiles = selectLatestZipByTile(allZipFiles);

  if (zipFiles.length === 0) {
    throw new Error(
      `No building zip files found in ${RAW_BUILDINGS_DIR}. Run ingest:lausanne:buildings first.`,
    );
  }

  if (zipFiles.length !== allZipFiles.length) {
    console.log(
      `[buildings-index] Keeping latest zip per tile: ${zipFiles.length}/${allZipFiles.length} files selected.`,
    );
  }

  const deduped = new Map<string, BuildingObstacle>();
  let obstacleId = 1;
  let rawObstaclesCount = 0;

  for (let i = 0; i < zipFiles.length; i += 1) {
    const zipPath = zipFiles[i];
    const parsed = parseZipObstacles(zipPath, obstacleId);
    obstacleId = parsed.nextId;
    rawObstaclesCount += parsed.obstacles.length;

    for (const obstacle of parsed.obstacles) {
      const key = obstacleKey(obstacle);
      const existing = deduped.get(key);

      if (!existing) {
        deduped.set(key, obstacle);
        continue;
      }

      if (obstacle.maxZ > existing.maxZ) {
        deduped.set(key, obstacle);
      }
    }

    if ((i + 1) % 5 === 0 || i + 1 === zipFiles.length) {
      console.log(
        `[buildings-index] Parsed ${i + 1}/${zipFiles.length} zip files. Raw obstacles: ${rawObstaclesCount}.`,
      );
    }
  }

  const obstacles = Array.from(deduped.values()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const spatialGrid = buildSpatialGrid(obstacles, 64);
  const elapsedSeconds = round3((performance.now() - startedAt) / 1000);
  const payload = {
    generatedAt: new Date().toISOString(),
    method: "dxf-footprint-prism-v5-source-order-hull-cell-maxz",
    indexVersion: 5,
    sourceSelectionStrategy: "latest-zip-per-tile",
    sourceDirectory: RAW_BUILDINGS_DIR,
    zipFilesProcessed: zipFiles.length,
    zipFilesDiscovered: allZipFiles.length,
    rawObstaclesCount,
    uniqueObstaclesCount: obstacles.length,
    elapsedSeconds,
    obstacles,
    spatialGrid,
  };

  await fs.mkdir(path.dirname(PROCESSED_BUILDINGS_INDEX_PATH), {
    recursive: true,
  });
  await fs.writeFile(
    PROCESSED_BUILDINGS_INDEX_PATH,
    JSON.stringify(payload, null, 2),
    "utf8",
  );

  console.log(
    `[buildings-index] Wrote ${PROCESSED_BUILDINGS_INDEX_PATH} with ${obstacles.length} unique obstacles.`,
  );
}

main().catch((error) => {
  console.error(
    `[buildings-index] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
