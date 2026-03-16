import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

interface ParsedArgs {
  baselineDir: string;
  candidateDir: string;
  output: string;
}

interface TileArtifactFrame {
  sunMaskBase64: string;
  sunMaskNoVegetationBase64: string;
  terrainBlockedMaskBase64: string;
  buildingsBlockedMaskBase64: string;
  vegetationBlockedMaskBase64: string;
  diagnostics: {
    horizonAngleDegByPoint: Array<number | null>;
    buildingBlockerIdByPoint: Array<string | null>;
    buildingBlockerDistanceMetersByPoint: Array<number | null>;
  };
}

interface TileArtifact {
  modelVersionHash: string;
  points: unknown[];
  frames: TileArtifactFrame[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const values: Partial<ParsedArgs> = {};
  for (const arg of argv) {
    if (arg.startsWith("--baseline-dir=")) {
      values.baselineDir = arg.slice("--baseline-dir=".length);
      continue;
    }
    if (arg.startsWith("--candidate-dir=")) {
      values.candidateDir = arg.slice("--candidate-dir=".length);
      continue;
    }
    if (arg.startsWith("--output=")) {
      values.output = arg.slice("--output=".length);
      continue;
    }
  }

  if (!values.baselineDir || !values.candidateDir || !values.output) {
    throw new Error(
      "Missing required args. Use --baseline-dir=... --candidate-dir=... --output=...",
    );
  }

  return values as ParsedArgs;
}

function absoluteFromCwd(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);
}

async function readManifest(runDir: string): Promise<{ tileIds: string[]; modelVersionHash: string }> {
  const manifestPath = path.join(runDir, "manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as {
    tileIds?: string[];
    modelVersionHash?: string;
  };
  return {
    tileIds: Array.isArray(parsed.tileIds) ? parsed.tileIds : [],
    modelVersionHash:
      typeof parsed.modelVersionHash === "string" ? parsed.modelVersionHash : "unknown",
  };
}

async function readTileArtifact(runDir: string, tileId: string): Promise<TileArtifact> {
  const tilePath = path.join(runDir, "tiles", `${tileId}.json.gz`);
  const compressed = await fs.readFile(tilePath);
  const json = zlib.gunzipSync(compressed).toString("utf8");
  return JSON.parse(json) as TileArtifact;
}

function byteAt(buffer: Buffer, index: number): number {
  return index < 0 || index >= buffer.length ? 0 : buffer[index];
}

function countBitDifferences(aBase64: string, bBase64: string): number {
  const a = Buffer.from(aBase64, "base64");
  const b = Buffer.from(bBase64, "base64");
  const maxLength = Math.max(a.length, b.length);
  let differences = 0;

  for (let i = 0; i < maxLength; i += 1) {
    const xor = byteAt(a, i) ^ byteAt(b, i);
    differences += BIT_COUNTS[xor];
  }

  return differences;
}

function almostEqual(a: number | null, b: number | null, epsilon = 1e-9): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return Math.abs(a - b) <= epsilon;
}

const BIT_COUNTS = Array.from({ length: 256 }, (_, value) => {
  let bits = 0;
  let current = value;
  while (current > 0) {
    bits += current & 1;
    current >>= 1;
  }
  return bits;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselineDir = absoluteFromCwd(args.baselineDir);
  const candidateDir = absoluteFromCwd(args.candidateDir);
  const outputPath = absoluteFromCwd(args.output);

  const [baselineManifest, candidateManifest] = await Promise.all([
    readManifest(baselineDir),
    readManifest(candidateDir),
  ]);

  const baselineTiles = new Set(baselineManifest.tileIds);
  const candidateTiles = new Set(candidateManifest.tileIds);
  const commonTileIds = baselineManifest.tileIds.filter((tileId) =>
    candidateTiles.has(tileId),
  );

  let totalPointFrames = 0;
  let sunMaskBits = 0;
  let sunMaskNoVegetationBits = 0;
  let terrainBlockedBits = 0;
  let buildingsBlockedBits = 0;
  let vegetationBlockedBits = 0;
  let buildingBlockerIdEntries = 0;
  let horizonAngleEntries = 0;
  let buildingBlockerDistanceEntries = 0;

  for (const tileId of commonTileIds) {
    const [baseline, candidate] = await Promise.all([
      readTileArtifact(baselineDir, tileId),
      readTileArtifact(candidateDir, tileId),
    ]);

    if (baseline.points.length !== candidate.points.length) {
      throw new Error(
        `Point count mismatch on tile ${tileId}: ${baseline.points.length} != ${candidate.points.length}`,
      );
    }
    if (baseline.frames.length !== candidate.frames.length) {
      throw new Error(
        `Frame count mismatch on tile ${tileId}: ${baseline.frames.length} != ${candidate.frames.length}`,
      );
    }

    totalPointFrames += baseline.points.length * baseline.frames.length;

    for (let frameIndex = 0; frameIndex < baseline.frames.length; frameIndex += 1) {
      const baselineFrame = baseline.frames[frameIndex];
      const candidateFrame = candidate.frames[frameIndex];

      sunMaskBits += countBitDifferences(
        baselineFrame.sunMaskBase64,
        candidateFrame.sunMaskBase64,
      );
      sunMaskNoVegetationBits += countBitDifferences(
        baselineFrame.sunMaskNoVegetationBase64,
        candidateFrame.sunMaskNoVegetationBase64,
      );
      terrainBlockedBits += countBitDifferences(
        baselineFrame.terrainBlockedMaskBase64,
        candidateFrame.terrainBlockedMaskBase64,
      );
      buildingsBlockedBits += countBitDifferences(
        baselineFrame.buildingsBlockedMaskBase64,
        candidateFrame.buildingsBlockedMaskBase64,
      );
      vegetationBlockedBits += countBitDifferences(
        baselineFrame.vegetationBlockedMaskBase64,
        candidateFrame.vegetationBlockedMaskBase64,
      );

      const baselineDiagnostics = baselineFrame.diagnostics;
      const candidateDiagnostics = candidateFrame.diagnostics;
      const pointsCount = baseline.points.length;

      for (let pointIndex = 0; pointIndex < pointsCount; pointIndex += 1) {
        if (
          baselineDiagnostics.buildingBlockerIdByPoint[pointIndex] !==
          candidateDiagnostics.buildingBlockerIdByPoint[pointIndex]
        ) {
          buildingBlockerIdEntries += 1;
        }
        if (
          !almostEqual(
            baselineDiagnostics.horizonAngleDegByPoint[pointIndex] ?? null,
            candidateDiagnostics.horizonAngleDegByPoint[pointIndex] ?? null,
          )
        ) {
          horizonAngleEntries += 1;
        }
        if (
          !almostEqual(
            baselineDiagnostics.buildingBlockerDistanceMetersByPoint[pointIndex] ?? null,
            candidateDiagnostics.buildingBlockerDistanceMetersByPoint[pointIndex] ?? null,
            1e-6,
          )
        ) {
          buildingBlockerDistanceEntries += 1;
        }
      }
    }
  }

  const output = {
    comparedAt: new Date().toISOString(),
    baselineRun: {
      modelVersionHash: baselineManifest.modelVersionHash,
      path: baselineDir.replaceAll("\\", "/"),
    },
    candidateRun: {
      modelVersionHash: candidateManifest.modelVersionHash,
      path: candidateDir.replaceAll("\\", "/"),
    },
    tileCount: commonTileIds.length,
    skippedTileCount:
      baselineTiles.size + candidateTiles.size - commonTileIds.length * 2,
    totalPointFrames,
    differences: {
      sunMaskBits,
      sunMaskNoVegetationBits,
      terrainBlockedBits,
      buildingsBlockedBits,
      vegetationBlockedBits,
      buildingBlockerIdEntries,
      horizonAngleEntries,
      buildingBlockerDistanceEntries,
    },
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`[compare-precomputed-run-directories] wrote ${outputPath}`);
}

void main().catch((error) => {
  console.error(
    `[compare-precomputed-run-directories] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});

