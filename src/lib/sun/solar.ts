import SunCalc from "suncalc";

import {
  getHorizonAngleForAzimuth,
  HorizonMask,
  isTerrainBlockedByHorizon,
} from "@/lib/sun/horizon-mask";
import { getZonedDayRangeUtc } from "@/lib/time/zoned-date";

const RAD_TO_DEG = 180 / Math.PI;
const TERRAIN_HORIZON_SKIP_MARGIN_DEG = 0.25;
const horizonMaxAngleCache = new WeakMap<HorizonMask, number>();

export interface PointSunlightInput {
  lat: number;
  lon: number;
  date: string;
  timeZone: string;
  sampleEveryMinutes: number;
  horizonMask: HorizonMask | null;
  buildingShadowEvaluator?: (sample: {
    azimuthDeg: number;
    altitudeDeg: number;
    utcDate: Date;
  }) => {
    blocked: boolean;
    blockerId: string | null;
    blockerDistanceMeters: number | null;
    blockerAltitudeAngleDeg: number | null;
    checkedObstaclesCount: number;
  };
  vegetationShadowEvaluator?: (sample: {
    azimuthDeg: number;
    altitudeDeg: number;
    utcDate: Date;
  }) => {
    blocked: boolean;
    blockerDistanceMeters: number | null;
    blockerAltitudeAngleDeg: number | null;
    blockerSurfaceElevationMeters: number | null;
    blockerClearanceMeters: number | null;
    checkedSamplesCount: number;
  };
}

export interface SunSample {
  utcTime: string;
  localTime: string;
  azimuthDeg: number;
  altitudeDeg: number;
  horizonAngleDeg: number | null;
  aboveAstronomicalHorizon: boolean;
  terrainBlocked: boolean;
  buildingsBlocked: boolean;
  vegetationBlocked: boolean;
  buildingBlockerId: string | null;
  buildingBlockerDistanceMeters: number | null;
  buildingBlockerAltitudeAngleDeg: number | null;
  vegetationBlockerDistanceMeters: number | null;
  vegetationBlockerAltitudeAngleDeg: number | null;
  vegetationBlockerSurfaceElevationMeters: number | null;
  vegetationBlockerClearanceMeters: number | null;
  isSunny: boolean;
}

export interface SunnyWindow {
  startLocalTime: string;
  endLocalTime: string;
  durationMinutes: number;
}

export interface PointSunlightResult {
  date: string;
  timeZone: string;
  sampleEveryMinutes: number;
  sunriseLocalTime: string | null;
  sunsetLocalTime: string | null;
  sunnyWindows: SunnyWindow[];
  samples: SunSample[];
}

export interface InstantSunlightInput {
  lat: number;
  lon: number;
  utcDate: Date;
  timeZone: string;
  localDateTimeOverride?: string;
  horizonMask: HorizonMask | null;
  buildingShadowEvaluator?: PointSunlightInput["buildingShadowEvaluator"];
  vegetationShadowEvaluator?: PointSunlightInput["vegetationShadowEvaluator"];
  evaluateAllBlockers?: boolean;
  profiler?: InstantSunlightProfiler;
}

export interface InstantSunlightProfiler {
  evaluations: number;
  totalMs: number;
  solarPositionMs: number;
  terrainMs: number;
  buildingsMs: number;
  vegetationMs: number;
  finalizeMs: number;
  belowAstronomicalHorizonCount: number;
  terrainCheckNeededCount: number;
  terrainBlockedCount: number;
  secondarySkippedByTerrainCount: number;
  buildingsEvaluatorCalls: number;
  vegetationEvaluatorCalls: number;
}

function normalizeAzimuthDegrees(azimuthDegreesFromSunCalc: number): number {
  const fromNorth = (azimuthDegreesFromSunCalc + 180) % 360;
  return fromNorth >= 0 ? fromNorth : fromNorth + 360;
}

function formatLocalTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDateTimeLocal(date: Date, timeZone: string): string {
  const datePart = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const timePart = formatLocalTime(date, timeZone);
  return `${datePart} ${timePart}`;
}

function safeFormatDateTimeLocal(date: Date, timeZone: string): string | null {
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return formatDateTimeLocal(date, timeZone);
}

function getMaxHorizonAngle(horizonMask: HorizonMask): number {
  const cached = horizonMaxAngleCache.get(horizonMask);
  if (cached !== undefined) {
    return cached;
  }

  let max = Number.NEGATIVE_INFINITY;
  for (const angle of horizonMask.binsDeg) {
    if (angle > max) {
      max = angle;
    }
  }
  horizonMaxAngleCache.set(horizonMask, max);
  return max;
}

function buildSunnyWindows(
  samples: SunSample[],
  sampleEveryMinutes: number,
  timeZone: string,
): SunnyWindow[] {
  const windows: SunnyWindow[] = [];
  let currentStart: string | null = null;
  let currentDuration = 0;

  for (const sample of samples) {
    if (sample.isSunny) {
      if (!currentStart) {
        currentStart = sample.localTime;
      }
      currentDuration += sampleEveryMinutes;
      continue;
    }

    if (currentStart) {
      windows.push({
        startLocalTime: currentStart,
        endLocalTime: sample.localTime,
        durationMinutes: currentDuration,
      });
      currentStart = null;
      currentDuration = 0;
    }
  }

  if (currentStart) {
    const lastSample = samples.at(-1);
    const endLocalTime = lastSample
      ? formatDateTimeLocal(
          new Date(Date.parse(lastSample.utcTime) + sampleEveryMinutes * 60_000),
          timeZone,
        )
      : currentStart;

    windows.push({
      startLocalTime: currentStart,
      endLocalTime,
      durationMinutes: currentDuration,
    });
  }

  return windows;
}

export function evaluateInstantSunlight(
  input: InstantSunlightInput,
): SunSample {
  if (!input.profiler) {
    const position = SunCalc.getPosition(input.utcDate, input.lat, input.lon);

    const altitudeDeg = position.altitude * RAD_TO_DEG;
    const azimuthDeg = normalizeAzimuthDegrees(position.azimuth * RAD_TO_DEG);
    const aboveAstronomicalHorizon = altitudeDeg > 0;
    const horizonAngleDeg = input.horizonMask
      ? getHorizonAngleForAzimuth(input.horizonMask, azimuthDeg)
      : null;
    const terrainCheckNeeded =
      aboveAstronomicalHorizon &&
      input.horizonMask !== null &&
      altitudeDeg <=
        getMaxHorizonAngle(input.horizonMask) + TERRAIN_HORIZON_SKIP_MARGIN_DEG;
    const terrainBlocked =
      terrainCheckNeeded &&
      input.horizonMask !== null &&
      isTerrainBlockedByHorizon(input.horizonMask, azimuthDeg, altitudeDeg);
    const evaluateSecondaryBlockers =
      aboveAstronomicalHorizon &&
      (input.evaluateAllBlockers === true || !terrainBlocked);
    const shouldEvaluateBuildings =
      evaluateSecondaryBlockers &&
      !!input.buildingShadowEvaluator;
    const buildingShadow =
      shouldEvaluateBuildings
        ? input.buildingShadowEvaluator!({
            azimuthDeg,
            altitudeDeg,
            utcDate: input.utcDate,
          })
        : null;
    const buildingsBlocked = aboveAstronomicalHorizon
      ? (buildingShadow?.blocked ?? false)
      : false;
    const vegetationShadow =
      evaluateSecondaryBlockers && input.vegetationShadowEvaluator
        ? input.vegetationShadowEvaluator({
            azimuthDeg,
            altitudeDeg,
            utcDate: input.utcDate,
          })
        : null;
    const vegetationBlocked = aboveAstronomicalHorizon
      ? (vegetationShadow?.blocked ?? false)
      : false;
    const isSunny =
      aboveAstronomicalHorizon &&
      !terrainBlocked &&
      !buildingsBlocked &&
      !vegetationBlocked;

    const localDateTime =
      input.localDateTimeOverride ??
      formatDateTimeLocal(input.utcDate, input.timeZone);

    return {
      utcTime: input.utcDate.toISOString(),
      localTime: localDateTime,
      azimuthDeg,
      altitudeDeg,
      horizonAngleDeg,
      aboveAstronomicalHorizon,
      terrainBlocked,
      buildingsBlocked,
      vegetationBlocked,
      buildingBlockerId: buildingShadow?.blockerId ?? null,
      buildingBlockerDistanceMeters: buildingShadow?.blockerDistanceMeters ?? null,
      buildingBlockerAltitudeAngleDeg:
        buildingShadow?.blockerAltitudeAngleDeg ?? null,
      vegetationBlockerDistanceMeters:
        vegetationShadow?.blockerDistanceMeters ?? null,
      vegetationBlockerAltitudeAngleDeg:
        vegetationShadow?.blockerAltitudeAngleDeg ?? null,
      vegetationBlockerSurfaceElevationMeters:
        vegetationShadow?.blockerSurfaceElevationMeters ?? null,
      vegetationBlockerClearanceMeters:
        vegetationShadow?.blockerClearanceMeters ?? null,
      isSunny,
    };
  }

  const profiler = input.profiler;
  const evaluationStarted = performance.now();
  const solarStarted = performance.now();
  const position = SunCalc.getPosition(input.utcDate, input.lat, input.lon);
  const solarElapsedMs = performance.now() - solarStarted;

  const altitudeDeg = position.altitude * RAD_TO_DEG;
  const azimuthDeg = normalizeAzimuthDegrees(position.azimuth * RAD_TO_DEG);
  const aboveAstronomicalHorizon = altitudeDeg > 0;
  const terrainStarted = performance.now();
  const horizonAngleDeg =
    input.horizonMask === null
      ? null
      : getHorizonAngleForAzimuth(input.horizonMask, azimuthDeg);
  const terrainCheckNeeded = (() => {
    if (!aboveAstronomicalHorizon || input.horizonMask === null) {
      return false;
    }
    return (
      altitudeDeg <=
      getMaxHorizonAngle(input.horizonMask) + TERRAIN_HORIZON_SKIP_MARGIN_DEG
    );
  })();
  const terrainBlocked = (() => {
    if (!terrainCheckNeeded || input.horizonMask === null) {
      return false;
    }
    return isTerrainBlockedByHorizon(input.horizonMask, azimuthDeg, altitudeDeg);
  })();
  const terrainElapsedMs = performance.now() - terrainStarted;
  const evaluateSecondaryBlockers =
    aboveAstronomicalHorizon &&
    (input.evaluateAllBlockers === true || !terrainBlocked);
  const shouldEvaluateBuildings =
    evaluateSecondaryBlockers &&
    !!input.buildingShadowEvaluator;
  const buildingsStarted = performance.now();
  const buildingShadow = (() => {
    if (!shouldEvaluateBuildings) {
      return null;
    }
    return input.buildingShadowEvaluator!({
      azimuthDeg,
      altitudeDeg,
      utcDate: input.utcDate,
    });
  })();
  const buildingsElapsedMs = performance.now() - buildingsStarted;
  const buildingsBlocked = aboveAstronomicalHorizon
    ? (buildingShadow?.blocked ?? false)
    : false;
  const vegetationStarted = performance.now();
  const vegetationShadow = (() => {
    if (!evaluateSecondaryBlockers || !input.vegetationShadowEvaluator) {
      return null;
    }
    return input.vegetationShadowEvaluator({
      azimuthDeg,
      altitudeDeg,
      utcDate: input.utcDate,
    });
  })();
  const vegetationElapsedMs = performance.now() - vegetationStarted;
  const vegetationBlocked = aboveAstronomicalHorizon
    ? (vegetationShadow?.blocked ?? false)
    : false;
  const isSunny =
    aboveAstronomicalHorizon &&
    !terrainBlocked &&
    !buildingsBlocked &&
    !vegetationBlocked;
  const finalizeStarted = performance.now();
  const localDateTime =
    input.localDateTimeOverride ??
    formatDateTimeLocal(input.utcDate, input.timeZone);

  const result: SunSample = {
    utcTime: input.utcDate.toISOString(),
    localTime: localDateTime,
    azimuthDeg,
    altitudeDeg,
    horizonAngleDeg,
    aboveAstronomicalHorizon,
    terrainBlocked,
    buildingsBlocked,
    vegetationBlocked,
    buildingBlockerId: buildingShadow?.blockerId ?? null,
    buildingBlockerDistanceMeters: buildingShadow?.blockerDistanceMeters ?? null,
    buildingBlockerAltitudeAngleDeg:
      buildingShadow?.blockerAltitudeAngleDeg ?? null,
    vegetationBlockerDistanceMeters:
      vegetationShadow?.blockerDistanceMeters ?? null,
    vegetationBlockerAltitudeAngleDeg:
      vegetationShadow?.blockerAltitudeAngleDeg ?? null,
    vegetationBlockerSurfaceElevationMeters:
      vegetationShadow?.blockerSurfaceElevationMeters ?? null,
    vegetationBlockerClearanceMeters:
      vegetationShadow?.blockerClearanceMeters ?? null,
    isSunny,
  };
  const finalizeElapsedMs = performance.now() - finalizeStarted;
  const totalElapsedMs = performance.now() - evaluationStarted;

  profiler.evaluations += 1;
  profiler.totalMs += totalElapsedMs;
  profiler.solarPositionMs += solarElapsedMs;
  profiler.terrainMs += terrainElapsedMs;
  profiler.buildingsMs += buildingsElapsedMs;
  profiler.vegetationMs += vegetationElapsedMs;
  profiler.finalizeMs += finalizeElapsedMs;
  if (!aboveAstronomicalHorizon) {
    profiler.belowAstronomicalHorizonCount += 1;
  }
  if (terrainCheckNeeded) {
    profiler.terrainCheckNeededCount += 1;
  }
  if (terrainBlocked) {
    profiler.terrainBlockedCount += 1;
  }
  if (
    aboveAstronomicalHorizon &&
    terrainBlocked &&
    input.evaluateAllBlockers !== true
  ) {
    profiler.secondarySkippedByTerrainCount += 1;
  }
  if (shouldEvaluateBuildings) {
    profiler.buildingsEvaluatorCalls += 1;
  }
  if (evaluateSecondaryBlockers && input.vegetationShadowEvaluator) {
    profiler.vegetationEvaluatorCalls += 1;
  }

  return result;
}

export function evaluatePointSunlight(
  input: PointSunlightInput,
): PointSunlightResult {
  const { startUtc, endUtc } = getZonedDayRangeUtc(input.date, input.timeZone);
  const sampleEveryMs = input.sampleEveryMinutes * 60_000;
  const samples: SunSample[] = [];

  for (
    let cursor = startUtc.getTime();
    cursor < endUtc.getTime();
    cursor += sampleEveryMs
  ) {
    const sampleDate = new Date(cursor);
    samples.push(
      evaluateInstantSunlight({
        lat: input.lat,
        lon: input.lon,
        utcDate: sampleDate,
        timeZone: input.timeZone,
        horizonMask: input.horizonMask,
        buildingShadowEvaluator: input.buildingShadowEvaluator,
        vegetationShadowEvaluator: input.vegetationShadowEvaluator,
      }),
    );
  }

  const noonUtc = new Date((startUtc.getTime() + endUtc.getTime()) / 2);
  const times = SunCalc.getTimes(noonUtc, input.lat, input.lon);
  const sunriseLocalTime = safeFormatDateTimeLocal(times.sunrise, input.timeZone);
  const sunsetLocalTime = safeFormatDateTimeLocal(times.sunset, input.timeZone);

  return {
    date: input.date,
    timeZone: input.timeZone,
    sampleEveryMinutes: input.sampleEveryMinutes,
    sunriseLocalTime,
    sunsetLocalTime,
    sunnyWindows: buildSunnyWindows(
      samples,
      input.sampleEveryMinutes,
      input.timeZone,
    ),
    samples,
  };
}
