import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import AdmZip from "adm-zip";

import {
  PROCESSED_BUILDINGS_INDEX_PATH,
  RAW_BUILDINGS_DIR,
} from "../../src/lib/storage/data-paths";

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
  sourceZip: string;
}

interface PolylineAccumulator {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  vertexCount: number;
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

function obstacleKey(obstacle: BuildingObstacle): string {
  return [
    round1(obstacle.minX),
    round1(obstacle.minY),
    round1(obstacle.maxX),
    round1(obstacle.maxY),
    round1(obstacle.maxZ),
  ].join("|");
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
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
    vertexCount: 0,
  };
}

function polylineToObstacle(
  polyline: PolylineAccumulator,
  sourceZip: string,
  obstacleId: number,
): BuildingObstacle | null {
  if (polyline.vertexCount < 3) {
    return null;
  }

  const width = polyline.maxX - polyline.minX;
  const depth = polyline.maxY - polyline.minY;
  const height = polyline.maxZ - polyline.minZ;
  if (width < 1 || depth < 1 || height < 1) {
    return null;
  }

  const centerX = (polyline.minX + polyline.maxX) / 2;
  const centerY = (polyline.minY + polyline.maxY) / 2;
  const halfDiagonal = Math.hypot(width, depth) / 2;

  return {
    id: `obs-${obstacleId}`,
    minX: round3(polyline.minX),
    minY: round3(polyline.minY),
    maxX: round3(polyline.maxX),
    maxY: round3(polyline.maxY),
    minZ: round3(polyline.minZ),
    maxZ: round3(polyline.maxZ),
    height: round3(height),
    centerX: round3(centerX),
    centerY: round3(centerY),
    halfDiagonal: round3(halfDiagonal),
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
      currentPolyline.minX = Math.min(currentPolyline.minX, currentVertex.x);
      currentPolyline.minY = Math.min(currentPolyline.minY, currentVertex.y);
      currentPolyline.minZ = Math.min(currentPolyline.minZ, currentVertex.z);
      currentPolyline.maxX = Math.max(currentPolyline.maxX, currentVertex.x);
      currentPolyline.maxY = Math.max(currentPolyline.maxY, currentVertex.y);
      currentPolyline.maxZ = Math.max(currentPolyline.maxZ, currentVertex.z);
      currentPolyline.vertexCount += 1;
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
    method: "dxf-polyline-bbox-v1",
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
