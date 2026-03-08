import SunCalc from "suncalc";

import {
  getHorizonAngleForAzimuth,
  HorizonMask,
  isTerrainBlockedByHorizon,
} from "@/lib/sun/horizon-mask";
import { getZonedDayRangeUtc } from "@/lib/time/zoned-date";

const RAD_TO_DEG = 180 / Math.PI;

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
  buildingBlockerId: string | null;
  buildingBlockerDistanceMeters: number | null;
  buildingBlockerAltitudeAngleDeg: number | null;
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
    const position = SunCalc.getPosition(sampleDate, input.lat, input.lon);

    const altitudeDeg = position.altitude * RAD_TO_DEG;
    const azimuthDeg = normalizeAzimuthDegrees(position.azimuth * RAD_TO_DEG);
    const aboveAstronomicalHorizon = altitudeDeg > 0;
    const horizonAngleDeg = input.horizonMask
      ? getHorizonAngleForAzimuth(input.horizonMask, azimuthDeg)
      : null;
    const terrainBlocked =
      aboveAstronomicalHorizon &&
      input.horizonMask !== null &&
      isTerrainBlockedByHorizon(input.horizonMask, azimuthDeg, altitudeDeg);
    const buildingShadow = input.buildingShadowEvaluator
      ? input.buildingShadowEvaluator({
          azimuthDeg,
          altitudeDeg,
          utcDate: sampleDate,
        })
      : null;
    const buildingsBlocked = aboveAstronomicalHorizon
      ? (buildingShadow?.blocked ?? false)
      : false;
    const isSunny = aboveAstronomicalHorizon && !terrainBlocked && !buildingsBlocked;

    samples.push({
      utcTime: sampleDate.toISOString(),
      localTime: formatDateTimeLocal(sampleDate, input.timeZone),
      azimuthDeg,
      altitudeDeg,
      horizonAngleDeg,
      aboveAstronomicalHorizon,
      terrainBlocked,
      buildingsBlocked,
      buildingBlockerId: buildingShadow?.blockerId ?? null,
      buildingBlockerDistanceMeters: buildingShadow?.blockerDistanceMeters ?? null,
      buildingBlockerAltitudeAngleDeg:
        buildingShadow?.blockerAltitudeAngleDeg ?? null,
      isSunny,
    });
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
