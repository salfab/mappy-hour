import { normalizeShadowCalibration } from "../../src/lib/sun/shadow-calibration";
import { getSunlightModelVersion } from "../../src/lib/precompute/model-version";
import {
  buildRegionTiles,
  writePrecomputedSunlightManifest,
  writePrecomputedSunlightTile,
  type PrecomputedRegionName,
  type PrecomputedSunlightManifest,
} from "../../src/lib/precompute/sunlight-cache";
import { CANONICAL_PRECOMPUTE_TILE_SIZE_METERS } from "../../src/lib/precompute/constants";
import { computeSunlightTileArtifact } from "../../src/lib/precompute/sunlight-tile-service";

interface ParsedArgs {
  region: PrecomputedRegionName;
  startDate: string;
  days: number;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  observerHeightMeters: number;
  buildingHeightBiasMeters: number;
}

const DEFAULT_ARGS: ParsedArgs = {
  region: "lausanne",
  startDate: "2026-03-08",
  days: 1,
  timezone: "Europe/Zurich",
  sampleEveryMinutes: 15,
  gridStepMeters: 1,
  startLocalTime: "00:00",
  endLocalTime: "23:59",
  observerHeightMeters: 0,
  buildingHeightBiasMeters: 0,
};

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { ...DEFAULT_ARGS };
  for (const arg of argv) {
    if (arg.startsWith("--region=")) {
      const region = arg.slice("--region=".length);
      if (region === "lausanne" || region === "nyon") {
        result.region = region;
      }
      continue;
    }
    if (arg.startsWith("--start-date=")) {
      result.startDate = arg.slice("--start-date=".length);
      continue;
    }
    if (arg.startsWith("--days=")) {
      const parsed = Number(arg.slice("--days=".length));
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 366) {
        result.days = parsed;
      }
      continue;
    }
    if (arg.startsWith("--timezone=")) {
      result.timezone = arg.slice("--timezone=".length);
      continue;
    }
    if (arg.startsWith("--sample-every-minutes=")) {
      const parsed = Number(arg.slice("--sample-every-minutes=".length));
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 60) {
        result.sampleEveryMinutes = parsed;
      }
      continue;
    }
    if (arg.startsWith("--grid-step-meters=")) {
      const parsed = Number(arg.slice("--grid-step-meters=".length));
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 2000) {
        result.gridStepMeters = parsed;
      }
      continue;
    }
    if (arg.startsWith("--tile-size-meters=")) {
      throw new Error(
        "The --tile-size-meters option was removed. Tile size is fixed to 250m.",
      );
    }
    if (arg.startsWith("--start-local-time=")) {
      result.startLocalTime = arg.slice("--start-local-time=".length);
      continue;
    }
    if (arg.startsWith("--end-local-time=")) {
      result.endLocalTime = arg.slice("--end-local-time=".length);
      continue;
    }
    if (arg.startsWith("--observer-height-meters=")) {
      result.observerHeightMeters = Number(arg.slice("--observer-height-meters=".length));
      continue;
    }
    if (arg.startsWith("--building-height-bias-meters=")) {
      result.buildingHeightBiasMeters = Number(
        arg.slice("--building-height-bias-meters=".length),
      );
    }
  }
  return result;
}

function addDays(dateInput: string, days: number): string {
  const date = new Date(`${dateInput}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date input: ${dateInput}`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tileSizeMeters = CANONICAL_PRECOMPUTE_TILE_SIZE_METERS;
  const tiles = buildRegionTiles(args.region, tileSizeMeters);
  const shadowCalibration = normalizeShadowCalibration({
    observerHeightMeters: args.observerHeightMeters,
    buildingHeightBiasMeters: args.buildingHeightBiasMeters,
  });
  const modelVersion = await getSunlightModelVersion(args.region, shadowCalibration);

  console.log(
    `[precompute] region=${args.region} model=${modelVersion.modelVersionHash} tiles=${tiles.length} gridStep=${args.gridStepMeters}m sampleEvery=${args.sampleEveryMinutes}min tileSize=${tileSizeMeters}m`,
  );

  for (let dayOffset = 0; dayOffset < args.days; dayOffset += 1) {
    const date = addDays(args.startDate, dayOffset);
    const succeededTileIds: string[] = [];
    const failedTileIds: string[] = [];

    console.log(`[precompute] date=${date} starting`);
    for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
      const tile = tiles[tileIndex];
      try {
        const artifact = await computeSunlightTileArtifact({
          region: args.region,
          modelVersionHash: modelVersion.modelVersionHash,
          algorithmVersion: modelVersion.algorithmVersion,
          date,
          timezone: args.timezone,
          sampleEveryMinutes: args.sampleEveryMinutes,
          gridStepMeters: args.gridStepMeters,
          startLocalTime: args.startLocalTime,
          endLocalTime: args.endLocalTime,
          tile,
          shadowCalibration,
        });
        await writePrecomputedSunlightTile(artifact);
        succeededTileIds.push(tile.tileId);
        console.log(
          `[precompute] date=${date} tile=${tileIndex + 1}/${tiles.length} ${tile.tileId} points=${artifact.stats.pointCount} frames=${artifact.frames.length} elapsedMs=${artifact.stats.elapsedMs}`,
        );
      } catch (error) {
        failedTileIds.push(tile.tileId);
        console.error(
          `[precompute] date=${date} tile=${tileIndex + 1}/${tiles.length} ${tile.tileId} failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }

    const manifest: PrecomputedSunlightManifest = {
      artifactFormatVersion: modelVersion.artifactFormatVersion,
      region: args.region,
      modelVersionHash: modelVersion.modelVersionHash,
      date,
      timezone: args.timezone,
      gridStepMeters: args.gridStepMeters,
      sampleEveryMinutes: args.sampleEveryMinutes,
      startLocalTime: args.startLocalTime,
      endLocalTime: args.endLocalTime,
      tileSizeMeters,
      tileIds: succeededTileIds.sort(),
      failedTileIds: failedTileIds.sort(),
      bbox: {
        minLon: Math.min(...tiles.map((tile) => tile.bbox.minLon)),
        minLat: Math.min(...tiles.map((tile) => tile.bbox.minLat)),
        maxLon: Math.max(...tiles.map((tile) => tile.bbox.maxLon)),
        maxLat: Math.max(...tiles.map((tile) => tile.bbox.maxLat)),
      },
      generatedAt: new Date().toISOString(),
      complete: failedTileIds.length === 0 && succeededTileIds.length === tiles.length,
    };

    await writePrecomputedSunlightManifest(manifest);
    console.log(
      `[precompute] date=${date} completed ok=${manifest.tileIds.length} failed=${manifest.failedTileIds.length} complete=${manifest.complete}`,
    );
  }
}

void main().catch((error) => {
  console.error(
    `[precompute] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});
