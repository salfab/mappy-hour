import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import AdmZip from "adm-zip";

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

interface PolylineAccumulator {
  vertices: Point3D[];
}

interface VertexAccumulator {
  x?: number;
  y?: number;
  z?: number;
  flag?: number;
}

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

function obstacleKey(obstacle: BuildingObstacle): string {
  const footprintKey = obstacle.footprint
    .map((point) => `${round1(point.x)},${round1(point.y)}`)
    .join(";");
  return `${footprintKey}|${round1(obstacle.maxZ)}`;
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

  const footprintHull = convexHull(
    polyline.vertices.map((vertex) => ({ x: vertex.x, y: vertex.y })),
  );
  if (footprintHull.length < 3) {
    return null;
  }

  const area = polygonArea(footprintHull);
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
    footprint: footprintHull.map((point) => ({
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
  const zipFiles = await listZipFilesRecursively(RAW_BUILDINGS_DIR);

  if (zipFiles.length === 0) {
    throw new Error(
      `No building zip files found in ${RAW_BUILDINGS_DIR}. Run ingest:lausanne:buildings first.`,
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
  const elapsedSeconds = round3((performance.now() - startedAt) / 1000);
  const payload = {
    generatedAt: new Date().toISOString(),
    method: "dxf-footprint-prism-v1",
    sourceDirectory: RAW_BUILDINGS_DIR,
    zipFilesProcessed: zipFiles.length,
    rawObstaclesCount,
    uniqueObstaclesCount: obstacles.length,
    elapsedSeconds,
    obstacles,
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
