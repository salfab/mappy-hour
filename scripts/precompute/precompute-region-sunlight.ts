import { performance } from "node:perf_hooks";

import { buildDynamicHorizonMask } from "../../src/lib/sun/dynamic-horizon-mask";
import { buildPointEvaluationContext } from "../../src/lib/sun/evaluation-context";
import { normalizeShadowCalibration } from "../../src/lib/sun/shadow-calibration";
import { evaluateInstantSunlight } from "../../src/lib/sun/solar";
import {
  buildRegionTiles,
  buildTilePoints,
  setMaskBit,
  writePrecomputedSunlightManifest,
  writePrecomputedSunlightTile,
  type PrecomputedRegionName,
  type PrecomputedSunlightManifest,
  type PrecomputedSunlightPoint,
} from "../../src/lib/precompute/sunlight-cache";
import { getZonedDayRangeUtc, zonedDateTimeToUtc } from "../../src/lib/time/zoned-date";

interface ParsedArgs {
  region: PrecomputedRegionName;
  startDate: string;
  days: number;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  tileSizeMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  observerHeightMeters: number;
  buildingHeightBiasMeters: number;
}

interface PreparedPoint {
  id: string;
  lat: number;
  lon: number;
  lv95Easting: number;
  lv95Northing: number;
  ix: number;
  iy: number;
  pointElevationMeters: number | null;
  horizonMask: Awaited<ReturnType<typeof buildPointEvaluationContext>>["horizonMask"];
  buildingShadowEvaluator: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["buildingShadowEvaluator"];
  vegetationShadowEvaluator: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["vegetationShadowEvaluator"];
}

const DEFAULT_ARGS: ParsedArgs = {
  region: "lausanne",
  startDate: "2026-03-08",
  days: 1,
  timezone: "Europe/Zurich",
  sampleEveryMinutes: 15,
  gridStepMeters: 5,
  tileSizeMeters: 250,
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
      const parsed = Number(arg.slice("--tile-size-meters=".length));
      if (Number.isInteger(parsed) && parsed >= 10 && parsed <= 5000) {
        result.tileSizeMeters = parsed;
      }
      continue;
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
      result.observerHeightMeters = Number(
        arg.slice("--observer-height-meters=".length),
      );
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

function createUtcSamples(
  date: string,
  timeZone: string,
  sampleEveryMinutes: number,
  startLocalTime: string,
  endLocalTime: string,
): Date[] {
  const { startUtc: dayStartUtc, endUtc: dayEndUtc } = getZonedDayRangeUtc(date, timeZone);
  const rangeStartUtc = zonedDateTimeToUtc(date, startLocalTime, timeZone);
  const rangeEndUtc = zonedDateTimeToUtc(date, endLocalTime, timeZone);
  const startUtc = new Date(
    Math.max(dayStartUtc.getTime(), rangeStartUtc.getTime()),
  );
  const endUtc = new Date(Math.min(dayEndUtc.getTime(), rangeEndUtc.getTime()));

  if (endUtc.getTime() <= startUtc.getTime()) {
    return [];
  }

  const samples: Date[] = [];
  const sampleEveryMs = sampleEveryMinutes * 60_000;
  for (
    let cursor = startUtc.getTime();
    cursor < endUtc.getTime();
    cursor += sampleEveryMs
  ) {
    samples.push(new Date(cursor));
  }

  return samples;
}

async function precomputeTile(params: {
  region: PrecomputedRegionName;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  tile: ReturnType<typeof buildRegionTiles>[number];
  observerHeightMeters: number;
  buildingHeightBiasMeters: number;
}) {
  const started = performance.now();
  const shadowCalibration = normalizeShadowCalibration({
    observerHeightMeters: params.observerHeightMeters,
    buildingHeightBiasMeters: params.buildingHeightBiasMeters,
  });
  const rawTilePoints = buildTilePoints(params.tile, params.gridStepMeters);
  const warnings: string[] = [];
  let terrainMethod = "none";
  let buildingsMethod = "none";
  let vegetationMethod = "none";
  let indoorPointsExcluded = 0;
  let pointsWithElevation = 0;
  let terrainHorizonOverride:
    | Awaited<ReturnType<typeof buildDynamicHorizonMask>>
    | undefined;

  try {
    const tileCenterLat = (params.tile.bbox.minLat + params.tile.bbox.maxLat) / 2;
    const tileCenterLon = (params.tile.bbox.minLon + params.tile.bbox.maxLon) / 2;
    const dynamicMask = await buildDynamicHorizonMask({
      lat: tileCenterLat,
      lon: tileCenterLon,
    });
    if (dynamicMask) {
      terrainHorizonOverride = dynamicMask;
      terrainMethod = dynamicMask.method;
    } else {
      warnings.push(
        `Dynamic terrain horizon unavailable for tile ${params.tile.tileId}.`,
      );
    }
  } catch (error) {
    warnings.push(
      `Dynamic terrain horizon build failed for tile ${params.tile.tileId} (${error instanceof Error ? error.message : "unknown error"}).`,
    );
  }

  const preparedPoints: PreparedPoint[] = [];
  for (const point of rawTilePoints) {
    const context = await buildPointEvaluationContext(point.lat, point.lon, {
      skipTerrainSamplingWhenIndoor: true,
      terrainHorizonOverride: terrainHorizonOverride ?? undefined,
      shadowCalibration,
    });
    terrainMethod = context.terrainHorizonMethod;
    buildingsMethod = context.buildingsShadowMethod;
    vegetationMethod = context.vegetationShadowMethod ?? "none";
    warnings.push(...context.warnings);

    if (context.insideBuilding) {
      indoorPointsExcluded += 1;
      continue;
    }

    if (context.pointElevationMeters !== null) {
      pointsWithElevation += 1;
    }

    preparedPoints.push({
      id: point.id,
      lat: point.lat,
      lon: point.lon,
      lv95Easting: point.lv95Easting,
      lv95Northing: point.lv95Northing,
      ix: point.ix,
      iy: point.iy,
      pointElevationMeters: context.pointElevationMeters,
      horizonMask: context.horizonMask,
      buildingShadowEvaluator: context.buildingShadowEvaluator,
      vegetationShadowEvaluator: context.vegetationShadowEvaluator,
    });
  }

  const samples = createUtcSamples(
    params.date,
    params.timezone,
    params.sampleEveryMinutes,
    params.startLocalTime,
    params.endLocalTime,
  );
  if (samples.length === 0) {
    throw new Error(
      `No samples produced for ${params.date} ${params.startLocalTime}-${params.endLocalTime}.`,
    );
  }

  const frames = [];
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sampleDate = samples[sampleIndex];
    const sunnyMask = new Uint8Array(Math.ceil(preparedPoints.length / 8));
    const sunnyMaskNoVegetation = new Uint8Array(Math.ceil(preparedPoints.length / 8));
    const terrainMask = new Uint8Array(Math.ceil(preparedPoints.length / 8));
    const buildingsMask = new Uint8Array(Math.ceil(preparedPoints.length / 8));
    const vegetationMask = new Uint8Array(Math.ceil(preparedPoints.length / 8));
    let sunnyCount = 0;
    let sunnyCountNoVegetation = 0;
    let localTime = "";

    for (let pointIndex = 0; pointIndex < preparedPoints.length; pointIndex += 1) {
      const point = preparedPoints[pointIndex];
      const sample = evaluateInstantSunlight({
        lat: point.lat,
        lon: point.lon,
        utcDate: sampleDate,
        timeZone: params.timezone,
        horizonMask: point.horizonMask,
        buildingShadowEvaluator: point.buildingShadowEvaluator,
        vegetationShadowEvaluator: point.vegetationShadowEvaluator,
      });
      localTime = localTime || sample.localTime.slice(11, 16);

      const isSunnyNoVegetation =
        sample.aboveAstronomicalHorizon &&
        !sample.terrainBlocked &&
        !sample.buildingsBlocked;

      if (sample.terrainBlocked) {
        setMaskBit(terrainMask, pointIndex);
      }
      if (sample.buildingsBlocked) {
        setMaskBit(buildingsMask, pointIndex);
      }
      if (sample.vegetationBlocked) {
        setMaskBit(vegetationMask, pointIndex);
      }
      if (isSunnyNoVegetation) {
        setMaskBit(sunnyMaskNoVegetation, pointIndex);
        sunnyCountNoVegetation += 1;
      }
      if (sample.isSunny) {
        setMaskBit(sunnyMask, pointIndex);
        sunnyCount += 1;
      }
    }

    frames.push({
      index: sampleIndex,
      localTime,
      utcTime: sampleDate.toISOString(),
      sunnyCount,
      sunnyCountNoVegetation,
      sunMaskBase64: Buffer.from(sunnyMask).toString("base64"),
      sunMaskNoVegetationBase64: Buffer.from(sunnyMaskNoVegetation).toString(
        "base64",
      ),
      terrainBlockedMaskBase64: Buffer.from(terrainMask).toString("base64"),
      buildingsBlockedMaskBase64: Buffer.from(buildingsMask).toString("base64"),
      vegetationBlockedMaskBase64: Buffer.from(vegetationMask).toString("base64"),
    });
  }

  const artifact = {
    version: 1 as const,
    region: params.region,
    date: params.date,
    timezone: params.timezone,
    gridStepMeters: params.gridStepMeters,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    tile: params.tile,
    points: preparedPoints.map(
      (point): PrecomputedSunlightPoint => ({
        id: point.id,
        lat: point.lat,
        lon: point.lon,
        lv95Easting: point.lv95Easting,
        lv95Northing: point.lv95Northing,
        ix: point.ix,
        iy: point.iy,
        pointElevationMeters: point.pointElevationMeters,
      }),
    ),
    frames,
    model: {
      terrainHorizonMethod: terrainMethod,
      buildingsShadowMethod: buildingsMethod,
      vegetationShadowMethod: vegetationMethod,
      shadowCalibration,
    },
    warnings: Array.from(new Set(warnings)),
    stats: {
      gridPointCount: rawTilePoints.length,
      pointCount: preparedPoints.length,
      indoorPointsExcluded,
      pointsWithElevation,
      pointsWithoutElevation: preparedPoints.length - pointsWithElevation,
      totalEvaluations: preparedPoints.length * frames.length,
      elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
    },
  };

  await writePrecomputedSunlightTile(artifact);
  return artifact;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tiles = buildRegionTiles(args.region, args.tileSizeMeters);

  console.log(
    `[precompute] region=${args.region} tiles=${tiles.length} gridStep=${args.gridStepMeters}m sampleEvery=${args.sampleEveryMinutes}min tileSize=${args.tileSizeMeters}m`,
  );

  for (let dayOffset = 0; dayOffset < args.days; dayOffset += 1) {
    const date = addDays(args.startDate, dayOffset);
    const manifest: PrecomputedSunlightManifest = {
      version: 1,
      region: args.region,
      date,
      timezone: args.timezone,
      gridStepMeters: args.gridStepMeters,
      sampleEveryMinutes: args.sampleEveryMinutes,
      startLocalTime: args.startLocalTime,
      endLocalTime: args.endLocalTime,
      tileSizeMeters: args.tileSizeMeters,
      tileIds: [],
      failedTileIds: [],
      bbox: tiles.reduce(
        (accumulator, tile) => ({
          minLon: Math.min(accumulator.minLon, tile.bbox.minLon),
          minLat: Math.min(accumulator.minLat, tile.bbox.minLat),
          maxLon: Math.max(accumulator.maxLon, tile.bbox.maxLon),
          maxLat: Math.max(accumulator.maxLat, tile.bbox.maxLat),
        }),
        {
          minLon: Number.POSITIVE_INFINITY,
          minLat: Number.POSITIVE_INFINITY,
          maxLon: Number.NEGATIVE_INFINITY,
          maxLat: Number.NEGATIVE_INFINITY,
        },
      ),
      generatedAt: new Date().toISOString(),
    };

    console.log(`[precompute] date=${date} starting`);
    for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
      const tile = tiles[tileIndex];
      try {
        const artifact = await precomputeTile({
          region: args.region,
          date,
          timezone: args.timezone,
          sampleEveryMinutes: args.sampleEveryMinutes,
          gridStepMeters: args.gridStepMeters,
          startLocalTime: args.startLocalTime,
          endLocalTime: args.endLocalTime,
          tile,
          observerHeightMeters: args.observerHeightMeters,
          buildingHeightBiasMeters: args.buildingHeightBiasMeters,
        });
        manifest.tileIds.push(tile.tileId);
        console.log(
          `[precompute] date=${date} tile=${tileIndex + 1}/${tiles.length} ${tile.tileId} points=${artifact.stats.pointCount} frames=${artifact.frames.length} elapsedMs=${artifact.stats.elapsedMs}`,
        );
      } catch (error) {
        manifest.failedTileIds.push(tile.tileId);
        console.error(
          `[precompute] date=${date} tile=${tileIndex + 1}/${tiles.length} ${tile.tileId} failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }

    await writePrecomputedSunlightManifest(manifest);
    console.log(
      `[precompute] date=${date} completed ok=${manifest.tileIds.length} failed=${manifest.failedTileIds.length}`,
    );
  }
}

void main().catch((error) => {
  console.error(
    `[precompute] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});
