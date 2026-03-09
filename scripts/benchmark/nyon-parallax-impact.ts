import fs from "node:fs/promises";
import path from "node:path";

import { buildGridFromBbox } from "../../src/lib/geo/grid";
import { LAUSANNE_CENTER } from "../../src/lib/config/lausanne";
import { NYON_CENTER } from "../../src/lib/config/nyon";
import { buildDynamicHorizonMask } from "../../src/lib/sun/dynamic-horizon-mask";
import { evaluateInstantSunlight } from "../../src/lib/sun/solar";
import { zonedDateTimeToUtc } from "../../src/lib/time/zoned-date";

interface ParsedArgs {
  date: string;
  timezone: string;
  localTime: string;
  sampleStepMinutes: number;
}

const DEFAULT_ARGS: ParsedArgs = {
  date: "2026-03-08",
  timezone: "Europe/Zurich",
  localTime: "17:00",
  sampleStepMinutes: 1,
};

const BENCHMARK_OUTPUT_DIR = path.join(
  process.cwd(),
  "docs",
  "progress",
  "benchmarks",
);

function parseArgs(argv: string[]): ParsedArgs {
  const parsed = { ...DEFAULT_ARGS };

  for (const arg of argv) {
    if (arg.startsWith("--date=")) {
      parsed.date = arg.slice("--date=".length);
      continue;
    }
    if (arg.startsWith("--timezone=")) {
      parsed.timezone = arg.slice("--timezone=".length);
      continue;
    }
    if (arg.startsWith("--local-time=")) {
      parsed.localTime = arg.slice("--local-time=".length);
      continue;
    }
    if (arg.startsWith("--sample-step-minutes=")) {
      const value = Number(arg.slice("--sample-step-minutes=".length));
      if (Number.isInteger(value) && value >= 1 && value <= 30) {
        parsed.sampleStepMinutes = value;
      }
    }
  }

  return parsed;
}

function metersBetween(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): number {
  const dLat = (latB - latA) * 111_320;
  const avgLat = (latA + latB) / 2;
  const dLon = (lonB - lonA) * (111_320 * Math.cos((avgLat * Math.PI) / 180));
  return Math.hypot(dLat, dLon);
}

function minutesToClock(minutes: number): string {
  const hour = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const minute = (minutes % 60).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}

function normalizeAzimuth(azimuthDeg: number): number {
  const rounded = Math.round(azimuthDeg) % 360;
  return rounded >= 0 ? rounded : rounded + 360;
}

function bboxAroundPointMeters(
  lat: number,
  lon: number,
  halfSizeMeters: number,
): [number, number, number, number] {
  const deltaLat = halfSizeMeters / 111_320;
  const metersPerLonDegree =
    111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const deltaLon = halfSizeMeters / metersPerLonDegree;
  return [lon - deltaLon, lat - deltaLat, lon + deltaLon, lat + deltaLat];
}

function shadowLengthMeters(obstacleHeightMeters: number, angleDeg: number): number {
  const tangent = Math.tan((angleDeg * Math.PI) / 180);
  return tangent <= 0 ? Number.POSITIVE_INFINITY : obstacleHeightMeters / tangent;
}

function findEveningBlockOnset(
  records: Array<{ minute: number; terrainBlocked: boolean }>,
): number | null {
  for (let i = 1; i < records.length; i += 1) {
    const previous = records[i - 1];
    const current = records[i];
    if (previous.minute < 12 * 60 || current.minute < 12 * 60) {
      continue;
    }
    if (!previous.terrainBlocked && current.terrainBlocked) {
      return current.minute;
    }
  }
  return null;
}

function findMorningRelease(
  records: Array<{ minute: number; terrainBlocked: boolean }>,
): number | null {
  for (let i = 1; i < records.length; i += 1) {
    const previous = records[i - 1];
    const current = records[i];
    if (current.minute > 12 * 60) {
      break;
    }
    if (previous.terrainBlocked && !current.terrainBlocked) {
      return current.minute;
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const utcAtReference = zonedDateTimeToUtc(
    args.date,
    args.localTime,
    args.timezone,
  );

  const [lausanneMask, nyonMask] = await Promise.all([
    buildDynamicHorizonMask({
      lat: LAUSANNE_CENTER.lat,
      lon: LAUSANNE_CENTER.lon,
    }),
    buildDynamicHorizonMask({
      lat: NYON_CENTER.lat,
      lon: NYON_CENTER.lon,
    }),
  ]);
  if (!lausanneMask || !nyonMask) {
    throw new Error("Unable to build Lausanne and/or Nyon horizon mask.");
  }

  const centerDistanceMeters = metersBetween(
    LAUSANNE_CENTER.lat,
    LAUSANNE_CENTER.lon,
    NYON_CENTER.lat,
    NYON_CENTER.lon,
  );

  const sampleLausanneMask = evaluateInstantSunlight({
    lat: NYON_CENTER.lat,
    lon: NYON_CENTER.lon,
    utcDate: utcAtReference,
    timeZone: args.timezone,
    horizonMask: lausanneMask,
  });
  const sampleNyonMask = evaluateInstantSunlight({
    lat: NYON_CENTER.lat,
    lon: NYON_CENTER.lon,
    utcDate: utcAtReference,
    timeZone: args.timezone,
    horizonMask: nyonMask,
  });

  const azimuthIndex = normalizeAzimuth(sampleNyonMask.azimuthDeg);
  const ridgeLausanne = lausanneMask.ridgePoints?.find(
    (point) => point.azimuthDeg === azimuthIndex,
  );
  const ridgeNyon = nyonMask.ridgePoints?.find(
    (point) => point.azimuthDeg === azimuthIndex,
  );

  const dailyRecordsLausanneMask: Array<{ minute: number; terrainBlocked: boolean }> =
    [];
  const dailyRecordsNyonMask: Array<{ minute: number; terrainBlocked: boolean }> = [];
  let mismatchMinutes = 0;

  for (let minute = 0; minute < 24 * 60; minute += args.sampleStepMinutes) {
    const localTime = minutesToClock(minute);
    const utcDate = zonedDateTimeToUtc(args.date, localTime, args.timezone);
    const withLausanneMask = evaluateInstantSunlight({
      lat: NYON_CENTER.lat,
      lon: NYON_CENTER.lon,
      utcDate,
      timeZone: args.timezone,
      horizonMask: lausanneMask,
    });
    const withNyonMask = evaluateInstantSunlight({
      lat: NYON_CENTER.lat,
      lon: NYON_CENTER.lon,
      utcDate,
      timeZone: args.timezone,
      horizonMask: nyonMask,
    });

    dailyRecordsLausanneMask.push({
      minute,
      terrainBlocked: withLausanneMask.terrainBlocked,
    });
    dailyRecordsNyonMask.push({
      minute,
      terrainBlocked: withNyonMask.terrainBlocked,
    });

    if (withLausanneMask.terrainBlocked !== withNyonMask.terrainBlocked) {
      mismatchMinutes += args.sampleStepMinutes;
    }
  }

  const eveningOnsetLausanne = findEveningBlockOnset(dailyRecordsLausanneMask);
  const eveningOnsetNyon = findEveningBlockOnset(dailyRecordsNyonMask);
  const morningReleaseLausanne = findMorningRelease(dailyRecordsLausanneMask);
  const morningReleaseNyon = findMorningRelease(dailyRecordsNyonMask);

  const nyon100mBbox = bboxAroundPointMeters(
    NYON_CENTER.lat,
    NYON_CENTER.lon,
    50,
  );
  const nyon100mGrid = buildGridFromBbox(
    {
      minLon: nyon100mBbox[0],
      minLat: nyon100mBbox[1],
      maxLon: nyon100mBbox[2],
      maxLat: nyon100mBbox[3],
    },
    10,
  );
  const cellAreaM2 = 100;

  let maxDisagreementPoints = 0;
  let maxDisagreementTime: string | null = null;
  let mismatchPointMinutes = 0;

  for (let minute = 0; minute < 24 * 60; minute += args.sampleStepMinutes) {
    const localTime = minutesToClock(minute);
    const utcDate = zonedDateTimeToUtc(args.date, localTime, args.timezone);
    let disagreementPointsAtMinute = 0;

    for (const point of nyon100mGrid) {
      const withLausanneMask = evaluateInstantSunlight({
        lat: point.lat,
        lon: point.lon,
        utcDate,
        timeZone: args.timezone,
        horizonMask: lausanneMask,
      });
      const withNyonMask = evaluateInstantSunlight({
        lat: point.lat,
        lon: point.lon,
        utcDate,
        timeZone: args.timezone,
        horizonMask: nyonMask,
      });

      if (withLausanneMask.terrainBlocked !== withNyonMask.terrainBlocked) {
        disagreementPointsAtMinute += 1;
      }
    }

    mismatchPointMinutes += disagreementPointsAtMinute * args.sampleStepMinutes;
    if (disagreementPointsAtMinute > maxDisagreementPoints) {
      maxDisagreementPoints = disagreementPointsAtMinute;
      maxDisagreementTime = localTime;
    }
  }

  const horizonDeltaDeg =
    sampleNyonMask.horizonAngleDeg !== null &&
    sampleLausanneMask.horizonAngleDeg !== null
      ? sampleNyonMask.horizonAngleDeg - sampleLausanneMask.horizonAngleDeg
      : null;

  const result = {
    generatedAt: new Date().toISOString(),
    benchmarkVersion: "v1",
    inputs: args,
    baseline: {
      lausanneCenter: LAUSANNE_CENTER,
      nyonCenter: NYON_CENTER,
      centerDistanceMeters: Number(centerDistanceMeters.toFixed(3)),
    },
    referenceTimeSample: {
      localTime: args.localTime,
      nyonPointWithLausanneMask: {
        terrainBlocked: sampleLausanneMask.terrainBlocked,
        horizonAngleDeg: sampleLausanneMask.horizonAngleDeg,
        altitudeDeg: sampleLausanneMask.altitudeDeg,
        azimuthDeg: sampleLausanneMask.azimuthDeg,
        ridgeDistanceMeters: ridgeLausanne?.distanceMeters ?? null,
      },
      nyonPointWithNyonMask: {
        terrainBlocked: sampleNyonMask.terrainBlocked,
        horizonAngleDeg: sampleNyonMask.horizonAngleDeg,
        altitudeDeg: sampleNyonMask.altitudeDeg,
        azimuthDeg: sampleNyonMask.azimuthDeg,
        ridgeDistanceMeters: ridgeNyon?.distanceMeters ?? null,
      },
      deltas: {
        horizonAngleDeg:
          horizonDeltaDeg === null ? null : Number(horizonDeltaDeg.toFixed(6)),
        ridgeDistanceMeters:
          ridgeLausanne?.distanceMeters !== undefined &&
          ridgeNyon?.distanceMeters !== undefined
            ? Number(
                (ridgeLausanne.distanceMeters - ridgeNyon.distanceMeters).toFixed(3),
              )
            : null,
      },
      equivalentShadowLengthDeltaMeters: {
        obstacleHeight5m:
          sampleLausanneMask.horizonAngleDeg !== null &&
          sampleNyonMask.horizonAngleDeg !== null
            ? Number(
                (
                  shadowLengthMeters(5, sampleLausanneMask.horizonAngleDeg) -
                  shadowLengthMeters(5, sampleNyonMask.horizonAngleDeg)
                ).toFixed(3),
              )
            : null,
        obstacleHeight10m:
          sampleLausanneMask.horizonAngleDeg !== null &&
          sampleNyonMask.horizonAngleDeg !== null
            ? Number(
                (
                  shadowLengthMeters(10, sampleLausanneMask.horizonAngleDeg) -
                  shadowLengthMeters(10, sampleNyonMask.horizonAngleDeg)
                ).toFixed(3),
              )
            : null,
        obstacleHeight20m:
          sampleLausanneMask.horizonAngleDeg !== null &&
          sampleNyonMask.horizonAngleDeg !== null
            ? Number(
                (
                  shadowLengthMeters(20, sampleLausanneMask.horizonAngleDeg) -
                  shadowLengthMeters(20, sampleNyonMask.horizonAngleDeg)
                ).toFixed(3),
              )
            : null,
      },
    },
    dailyTerrainOnlyDisagreement: {
      mismatchMinutes,
      mismatchPctOfDay: Number((mismatchMinutes / (24 * 60) * 100).toFixed(3)),
      eveningOnsetLocalTime: {
        withLausanneMask:
          eveningOnsetLausanne === null ? null : minutesToClock(eveningOnsetLausanne),
        withNyonMask:
          eveningOnsetNyon === null ? null : minutesToClock(eveningOnsetNyon),
      },
      eveningOnsetDeltaMinutes:
        eveningOnsetLausanne !== null && eveningOnsetNyon !== null
          ? eveningOnsetNyon - eveningOnsetLausanne
          : null,
      morningReleaseLocalTime: {
        withLausanneMask:
          morningReleaseLausanne === null ? null : minutesToClock(morningReleaseLausanne),
        withNyonMask:
          morningReleaseNyon === null ? null : minutesToClock(morningReleaseNyon),
      },
      morningReleaseDeltaMinutes:
        morningReleaseNyon !== null && morningReleaseLausanne !== null
          ? morningReleaseNyon - morningReleaseLausanne
          : null,
    },
    nyon100mPointImpact: {
      gridStepMeters: 10,
      pointCount: nyon100mGrid.length,
      maxDisagreementPointsAtOneMinute: maxDisagreementPoints,
      maxDisagreementAreaM2: maxDisagreementPoints * cellAreaM2,
      maxDisagreementLocalTime: maxDisagreementTime,
      totalPointMinutesInDisagreement: mismatchPointMinutes,
      equivalentPointHoursInDisagreement: Number((mismatchPointMinutes / 60).toFixed(3)),
    },
  };

  await fs.mkdir(BENCHMARK_OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(
    BENCHMARK_OUTPUT_DIR,
    `nyon-parallax-impact-${args.date.replaceAll("-", "")}-${args.localTime.replace(":", "")}.json`,
  );
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`[benchmark] Output written: ${outputPath}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    `[benchmark] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
