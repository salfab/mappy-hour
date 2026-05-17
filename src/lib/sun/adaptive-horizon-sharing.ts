import fs from "node:fs/promises";
import path from "node:path";

import SunCalc from "suncalc";

import { lv95ToWgs84Precise } from "@/lib/geo/projection";
import type { PrecomputedRegionName, RegionTileSpec } from "@/lib/precompute/sunlight-cache";
import { PROCESSED_HORIZON_SHARING_DIR } from "@/lib/storage/data-paths";
import { HorizonMask, isTerrainBlockedByHorizon } from "@/lib/sun/horizon-mask";
import { getZonedDayRangeUtc, zonedDateTimeToUtc } from "@/lib/time/zoned-date";

import { buildDynamicHorizonMask } from "./dynamic-horizon-mask";

const RAD_TO_DEG = 180 / Math.PI;
const ADAPTIVE_HORIZON_SHARING_VERSION = 1;
const MACRO_CELL_EASTING_METERS = 2000;
const MACRO_CELL_NORTHING_METERS = 500;
const MAX_POINT_MINUTES_MISMATCH_PER_DAY = 2;
const MAX_MISMATCH_POINTS_RATIO = 0.005;

interface TileDecision {
  strategy: "shared" | "local";
  sharedCenterLat: number;
  sharedCenterLon: number;
  localCenterLat: number;
  localCenterLon: number;
  mismatchPointMinutes: number;
  mismatchRatio: number;
  sampledPoints: number;
  sampledFrames: number;
  generatedAt: string;
}

interface AdaptiveHorizonAssignment {
  version: number;
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  gridStepMeters: number;
  macroCellEastingMeters: number;
  macroCellNorthingMeters: number;
  maxPointMinutesMismatchPerDay: number;
  maxMismatchPointsRatio: number;
  tileDecisions: Record<string, TileDecision>;
  updatedAt: string;
}

export interface AdaptiveHorizonResolution {
  horizonMask: HorizonMask | null;
  strategy: "shared" | "local" | "none";
  terrainMethod: string;
  diagnostics: {
    mismatchPointMinutes: number;
    mismatchRatio: number;
    sampledPoints: number;
    sampledFrames: number;
  } | null;
  warnings: string[];
}

const assignmentCache = new Map<string, AdaptiveHorizonAssignment>();
const maskCache = new Map<string, HorizonMask | null>();

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function createAssignmentKey(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  gridStepMeters: number;
}): string {
  return JSON.stringify(params);
}

function assignmentPath(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  gridStepMeters: number;
}): string {
  return path.join(
    PROCESSED_HORIZON_SHARING_DIR,
    params.region,
    params.modelVersionHash,
    `g${params.gridStepMeters}`,
    `m${params.sampleEveryMinutes}`,
    params.date,
    `t${params.startLocalTime.replace(":", "")}-${params.endLocalTime.replace(":", "")}.json`,
  );
}

function createEmptyAssignment(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  gridStepMeters: number;
}): AdaptiveHorizonAssignment {
  return {
    version: ADAPTIVE_HORIZON_SHARING_VERSION,
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    date: params.date,
    timezone: params.timezone,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    gridStepMeters: params.gridStepMeters,
    macroCellEastingMeters: MACRO_CELL_EASTING_METERS,
    macroCellNorthingMeters: MACRO_CELL_NORTHING_METERS,
    maxPointMinutesMismatchPerDay: MAX_POINT_MINUTES_MISMATCH_PER_DAY,
    maxMismatchPointsRatio: MAX_MISMATCH_POINTS_RATIO,
    tileDecisions: {},
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Quarantine a corrupt assignment file by renaming it with a `.corrupt-<ISO>`
 * suffix. The suffix has no `.json` extension so the file is no longer picked
 * up by readers/scanners that filter on `*.json`. The original path is left
 * empty so the next `persistAssignment()` call will write a clean file.
 *
 * Returns the quarantine path (best-effort: if the rename itself fails, we
 * just log and move on — the read path still falls back to a fresh assignment
 * so the run does not stall on a stuck file).
 */
async function quarantineCorruptAssignment(
  targetPath: string,
  reason: string,
): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = `${targetPath}.corrupt-${stamp}`;
  try {
    await fs.rename(targetPath, quarantinePath);
    console.warn(
      `[adaptive-horizon] quarantined corrupt assignment (${reason}): ${targetPath} -> ${quarantinePath}`,
    );
    return quarantinePath;
  } catch (renameError) {
    console.warn(
      `[adaptive-horizon] failed to quarantine corrupt assignment ${targetPath} (${reason}): ${(renameError as Error).message}. Continuing with empty assignment.`,
    );
    return null;
  }
}

async function loadAssignment(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  gridStepMeters: number;
}): Promise<AdaptiveHorizonAssignment> {
  const key = createAssignmentKey(params);
  const cached = assignmentCache.get(key);
  if (cached) {
    return cached;
  }

  const targetPath = assignmentPath(params);
  let raw: string;
  try {
    raw = await fs.readFile(targetPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const fresh = createEmptyAssignment(params);
      assignmentCache.set(key, fresh);
      return fresh;
    }
    throw error;
  }

  let parsed: AdaptiveHorizonAssignment;
  try {
    parsed = JSON.parse(raw) as AdaptiveHorizonAssignment;
  } catch (parseError) {
    // Corrupt JSON on disk — most likely the result of a non-atomic write
    // interrupted by a crash or two concurrent writers (pre-ADR-0019). Move
    // the bad file aside (so it doesn't keep poisoning every reader) and
    // return a fresh assignment so the run can rebuild it cleanly via the
    // atomic-write path in persistAssignment().
    await quarantineCorruptAssignment(
      targetPath,
      (parseError as Error).message,
    );
    const fresh = createEmptyAssignment(params);
    assignmentCache.set(key, fresh);
    return fresh;
  }

  if (parsed.version !== ADAPTIVE_HORIZON_SHARING_VERSION) {
    const fresh = createEmptyAssignment(params);
    assignmentCache.set(key, fresh);
    return fresh;
  }
  assignmentCache.set(key, parsed);
  return parsed;
}

/**
 * Atomic write of an assignment JSON. Writes to a sibling `.tmp` file in the
 * same directory (so the final `fs.rename` stays on a single filesystem and
 * is atomic — POSIX guarantees this, and on Windows `fs.rename` maps to
 * `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`). Readers therefore see
 * either the old content or the new content, never a half-written/truncated
 * file — which was the root cause of the
 * "Unexpected non-whitespace character after JSON" warnings (ADR-0023).
 *
 * Mirrors the retry policy of `writeFileAtomic` in
 * `src/lib/precompute/sunlight-cache-atlas.ts` to absorb the brief
 * Windows AV / indexer handle on freshly-created files.
 */
async function persistAssignment(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  gridStepMeters: number;
}, assignment: AdaptiveHorizonAssignment): Promise<void> {
  const targetPath = assignmentPath(params);
  assignment.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const payload = JSON.stringify(assignment, null, 2);
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, payload, "utf8");

    const transientCodes = new Set(["EPERM", "EBUSY", "EACCES"]);
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await fs.rename(tmpPath, targetPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || !transientCodes.has(code) || attempt === maxAttempts) {
          throw error;
        }
        const delayMs = 50 * 2 ** (attempt - 1); // 50, 100, 200, 400, 800, 1600
        console.warn(
          `[adaptive-horizon] rename ${code} on ${path.basename(targetPath)} (attempt ${attempt}/${maxAttempts}) — retry in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

function normalizeAzimuthDegrees(azimuthDegreesFromSunCalc: number): number {
  const fromNorth = (azimuthDegreesFromSunCalc + 180) % 360;
  return fromNorth >= 0 ? fromNorth : fromNorth + 360;
}

function buildUtcSamples(params: {
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}): Date[] {
  const { startUtc: dayStartUtc, endUtc: dayEndUtc } = getZonedDayRangeUtc(
    params.date,
    params.timezone,
  );
  const rangeStartUtc = zonedDateTimeToUtc(
    params.date,
    params.startLocalTime,
    params.timezone,
  );
  const rangeEndUtc = zonedDateTimeToUtc(
    params.date,
    params.endLocalTime,
    params.timezone,
  );
  const startUtc = new Date(
    Math.max(dayStartUtc.getTime(), rangeStartUtc.getTime()),
  );
  const endUtc = new Date(Math.min(dayEndUtc.getTime(), rangeEndUtc.getTime()));
  if (endUtc.getTime() <= startUtc.getTime()) {
    return [];
  }

  const samples: Date[] = [];
  const stepMs = params.sampleEveryMinutes * 60_000;
  for (let cursor = startUtc.getTime(); cursor < endUtc.getTime(); cursor += stepMs) {
    samples.push(new Date(cursor));
  }

  return samples;
}

function buildSamplePoints(tile: RegionTileSpec): Array<{ lat: number; lon: number }> {
  const ratios = [0.2, 0.5, 0.8];
  const points: Array<{ lat: number; lon: number }> = [];

  for (const ratioY of ratios) {
    for (const ratioX of ratios) {
      const easting =
        tile.minEasting + ratioX * (tile.maxEasting - tile.minEasting);
      const northing =
        tile.minNorthing + ratioY * (tile.maxNorthing - tile.minNorthing);
      const wgs84 = lv95ToWgs84Precise(easting, northing);
      points.push({
        lat: wgs84.lat,
        lon: wgs84.lon,
      });
    }
  }

  return points;
}

function buildMaskCacheKey(lat: number, lon: number): string {
  return `${round6(lat)}:${round6(lon)}`;
}

// Horizon cache stats — quantifies how often shared/local masks are reused.
// Reset at process start; queried once at end of run to estimate the
// headroom a smarter sharing policy would unlock.
const horizonCacheStats = {
  hits: 0,
  misses: 0,
  totalBuildMs: 0,
  totalHitLookupMs: 0,
};

export function getHorizonCacheStats(): {
  hits: number;
  misses: number;
  totalBuildMs: number;
  totalHitLookupMs: number;
  hitRatio: number;
} {
  const total = horizonCacheStats.hits + horizonCacheStats.misses;
  return {
    ...horizonCacheStats,
    hitRatio: total === 0 ? 0 : horizonCacheStats.hits / total,
  };
}

async function buildMaskCached(lat: number, lon: number): Promise<HorizonMask | null> {
  const key = buildMaskCacheKey(lat, lon);
  if (maskCache.has(key)) {
    const t0 = performance.now();
    const cached = maskCache.get(key) ?? null;
    horizonCacheStats.hits++;
    horizonCacheStats.totalHitLookupMs += performance.now() - t0;
    return cached;
  }
  const t0 = performance.now();
  const mask = await buildDynamicHorizonMask({ lat, lon });
  horizonCacheStats.misses++;
  horizonCacheStats.totalBuildMs += performance.now() - t0;
  maskCache.set(key, mask);
  return mask;
}

function macroCenterForTile(tile: RegionTileSpec): { lat: number; lon: number } {
  const centerEasting = (tile.minEasting + tile.maxEasting) / 2;
  const centerNorthing = (tile.minNorthing + tile.maxNorthing) / 2;
  const macroCenterEasting =
    Math.floor(centerEasting / MACRO_CELL_EASTING_METERS) *
      MACRO_CELL_EASTING_METERS +
    MACRO_CELL_EASTING_METERS / 2;
  const macroCenterNorthing =
    Math.floor(centerNorthing / MACRO_CELL_NORTHING_METERS) *
      MACRO_CELL_NORTHING_METERS +
    MACRO_CELL_NORTHING_METERS / 2;
  const wgs84 = lv95ToWgs84Precise(macroCenterEasting, macroCenterNorthing);
  return {
    lat: round6(wgs84.lat),
    lon: round6(wgs84.lon),
  };
}

function tileCenter(tile: RegionTileSpec): { lat: number; lon: number } {
  return {
    lat: round6((tile.bbox.minLat + tile.bbox.maxLat) / 2),
    lon: round6((tile.bbox.minLon + tile.bbox.maxLon) / 2),
  };
}

function terrainBlocked(mask: HorizonMask, lat: number, lon: number, utcDate: Date): boolean {
  const position = SunCalc.getPosition(utcDate, lat, lon);
  const altitudeDeg = position.altitude * RAD_TO_DEG;
  if (altitudeDeg <= 0) {
    return false;
  }
  const azimuthDeg = normalizeAzimuthDegrees(position.azimuth * RAD_TO_DEG);
  return isTerrainBlockedByHorizon(mask, azimuthDeg, altitudeDeg);
}

function compareMasks(params: {
  localMask: HorizonMask;
  sharedMask: HorizonMask;
  tile: RegionTileSpec;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}): {
  mismatchPointMinutes: number;
  mismatchRatio: number;
  sampledPoints: number;
  sampledFrames: number;
} {
  const points = buildSamplePoints(params.tile);
  const samples = buildUtcSamples({
    date: params.date,
    timezone: params.timezone,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
  });
  if (points.length === 0 || samples.length === 0) {
    return {
      mismatchPointMinutes: 0,
      mismatchRatio: 0,
      sampledPoints: points.length,
      sampledFrames: samples.length,
    };
  }

  let mismatches = 0;
  const total = points.length * samples.length;
  for (const point of points) {
    for (const sample of samples) {
      const localBlocked = terrainBlocked(
        params.localMask,
        point.lat,
        point.lon,
        sample,
      );
      const sharedBlocked = terrainBlocked(
        params.sharedMask,
        point.lat,
        point.lon,
        sample,
      );
      if (localBlocked !== sharedBlocked) {
        mismatches += 1;
      }
    }
  }

  return {
    mismatchPointMinutes: mismatches * params.sampleEveryMinutes,
    mismatchRatio: total === 0 ? 0 : mismatches / total,
    sampledPoints: points.length,
    sampledFrames: samples.length,
  };
}

export async function resolveAdaptiveTerrainHorizonForTile(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  tile: RegionTileSpec;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
  gridStepMeters: number;
}): Promise<AdaptiveHorizonResolution> {
  const assignmentParams = {
    region: params.region,
    modelVersionHash: params.modelVersionHash,
    date: params.date,
    timezone: params.timezone,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
    gridStepMeters: params.gridStepMeters,
  };
  const assignment = await loadAssignment(assignmentParams);
  const existingDecision = assignment.tileDecisions[params.tile.tileId];

  const localCenter = tileCenter(params.tile);
  if (existingDecision) {
    if (existingDecision.strategy === "shared") {
      const sharedMask = await buildMaskCached(
        existingDecision.sharedCenterLat,
        existingDecision.sharedCenterLon,
      );
      if (sharedMask) {
        return {
          horizonMask: sharedMask,
          strategy: "shared",
          terrainMethod: `${sharedMask.method}|adaptive-shared-v1`,
          diagnostics: {
            mismatchPointMinutes: existingDecision.mismatchPointMinutes,
            mismatchRatio: existingDecision.mismatchRatio,
            sampledPoints: existingDecision.sampledPoints,
            sampledFrames: existingDecision.sampledFrames,
          },
          warnings: [],
        };
      }
    }

    const localMask = await buildMaskCached(
      existingDecision.localCenterLat,
      existingDecision.localCenterLon,
    );
    if (localMask) {
      return {
        horizonMask: localMask,
        strategy: "local",
        terrainMethod: `${localMask.method}|adaptive-local-v1`,
        diagnostics: {
          mismatchPointMinutes: existingDecision.mismatchPointMinutes,
          mismatchRatio: existingDecision.mismatchRatio,
          sampledPoints: existingDecision.sampledPoints,
          sampledFrames: existingDecision.sampledFrames,
        },
        warnings: [],
      };
    }

    return {
      horizonMask: null,
      strategy: "none",
      terrainMethod: "none",
      diagnostics: null,
      warnings: ["Adaptive horizon decision exists but no dynamic mask could be built."],
    };
  }

  const sharedCenter = macroCenterForTile(params.tile);
  const [localMask, sharedMask] = await Promise.all([
    buildMaskCached(localCenter.lat, localCenter.lon),
    buildMaskCached(sharedCenter.lat, sharedCenter.lon),
  ]);

  if (!localMask && !sharedMask) {
    return {
      horizonMask: null,
      strategy: "none",
      terrainMethod: "none",
      diagnostics: null,
      warnings: ["Dynamic terrain horizon unavailable for local and shared centers."],
    };
  }

  if (!localMask && sharedMask) {
    assignment.tileDecisions[params.tile.tileId] = {
      strategy: "shared",
      sharedCenterLat: sharedCenter.lat,
      sharedCenterLon: sharedCenter.lon,
      localCenterLat: localCenter.lat,
      localCenterLon: localCenter.lon,
      mismatchPointMinutes: 0,
      mismatchRatio: 0,
      sampledPoints: 0,
      sampledFrames: 0,
      generatedAt: new Date().toISOString(),
    };
    await persistAssignment(assignmentParams, assignment);
    return {
      horizonMask: sharedMask,
      strategy: "shared",
      terrainMethod: `${sharedMask.method}|adaptive-shared-v1`,
      diagnostics: {
        mismatchPointMinutes: 0,
        mismatchRatio: 0,
        sampledPoints: 0,
        sampledFrames: 0,
      },
      warnings: [
        "Local terrain horizon unavailable; using shared adaptive horizon mask.",
      ],
    };
  }

  if (localMask && !sharedMask) {
    assignment.tileDecisions[params.tile.tileId] = {
      strategy: "local",
      sharedCenterLat: sharedCenter.lat,
      sharedCenterLon: sharedCenter.lon,
      localCenterLat: localCenter.lat,
      localCenterLon: localCenter.lon,
      mismatchPointMinutes: 0,
      mismatchRatio: 0,
      sampledPoints: 0,
      sampledFrames: 0,
      generatedAt: new Date().toISOString(),
    };
    await persistAssignment(assignmentParams, assignment);
    return {
      horizonMask: localMask,
      strategy: "local",
      terrainMethod: `${localMask.method}|adaptive-local-v1`,
      diagnostics: {
        mismatchPointMinutes: 0,
        mismatchRatio: 0,
        sampledPoints: 0,
        sampledFrames: 0,
      },
      warnings: [],
    };
  }

  const diagnostics = compareMasks({
    localMask: localMask!,
    sharedMask: sharedMask!,
    tile: params.tile,
    date: params.date,
    timezone: params.timezone,
    sampleEveryMinutes: params.sampleEveryMinutes,
    startLocalTime: params.startLocalTime,
    endLocalTime: params.endLocalTime,
  });
  const useShared =
    diagnostics.mismatchPointMinutes <= MAX_POINT_MINUTES_MISMATCH_PER_DAY &&
    diagnostics.mismatchRatio <= MAX_MISMATCH_POINTS_RATIO;
  assignment.tileDecisions[params.tile.tileId] = {
    strategy: useShared ? "shared" : "local",
    sharedCenterLat: sharedCenter.lat,
    sharedCenterLon: sharedCenter.lon,
    localCenterLat: localCenter.lat,
    localCenterLon: localCenter.lon,
    mismatchPointMinutes: diagnostics.mismatchPointMinutes,
    mismatchRatio: diagnostics.mismatchRatio,
    sampledPoints: diagnostics.sampledPoints,
    sampledFrames: diagnostics.sampledFrames,
    generatedAt: new Date().toISOString(),
  };
  await persistAssignment(assignmentParams, assignment);

  if (useShared) {
    return {
      horizonMask: sharedMask!,
      strategy: "shared",
      terrainMethod: `${sharedMask!.method}|adaptive-shared-v1`,
      diagnostics,
      warnings: [],
    };
  }

  return {
    horizonMask: localMask!,
    strategy: "local",
    terrainMethod: `${localMask!.method}|adaptive-local-v1`,
    diagnostics,
    warnings: [],
  };
}

export const adaptiveHorizonSharingConfig = {
  version: `adaptive-horizon-sharing-v${ADAPTIVE_HORIZON_SHARING_VERSION}`,
  macroCellEastingMeters: MACRO_CELL_EASTING_METERS,
  macroCellNorthingMeters: MACRO_CELL_NORTHING_METERS,
  maxPointMinutesMismatchPerDay: MAX_POINT_MINUTES_MISMATCH_PER_DAY,
  maxMismatchPointsRatio: MAX_MISMATCH_POINTS_RATIO,
};
