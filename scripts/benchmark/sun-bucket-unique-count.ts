/**
 * Count unique (az, alt) buckets visited by the sun at Lausanne center
 * over a given date range + clock window, for each candidate resolution.
 *
 * Then compare to the date-keyed frame count: days × frames_per_day.
 */

import SunCalc from "suncalc";

const LAT = 46.52;
const LON = 6.63;
const TIMEZONE_OFFSET_HOURS = 1; // assume CET (approximate — DST is ±1h, negligible for bucket count)

function parseArgs() {
  const args = {
    startDate: "2026-04-13",
    days: 200,
    startLocalTime: "06:00",
    endLocalTime: "21:00",
    sampleEveryMinutes: 15,
    resolutions: [0.25, 0.5, 1, 2],
  };
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.split("=");
    if (k === "--start-date") args.startDate = v;
    else if (k === "--days") args.days = Number(v);
    else if (k === "--start-local-time") args.startLocalTime = v;
    else if (k === "--end-local-time") args.endLocalTime = v;
    else if (k === "--sample-every-minutes") args.sampleEveryMinutes = Number(v);
    else if (k === "--resolutions") args.resolutions = v.split(",").map(Number);
  }
  return args;
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function main() {
  const args = parseArgs();
  const startParts = args.startDate.split("-").map(Number);
  const startDate = new Date(Date.UTC(startParts[0], startParts[1] - 1, startParts[2]));

  const startMin = timeToMinutes(args.startLocalTime);
  const endMin = timeToMinutes(args.endLocalTime);
  const framesPerDay = Math.floor((endMin - startMin) / args.sampleEveryMinutes) + 1;
  const totalFramesDateKeyed = args.days * framesPerDay;

  console.log(`Range: ${args.startDate} + ${args.days} days, window ${args.startLocalTime}-${args.endLocalTime}, sample ${args.sampleEveryMinutes}min`);
  console.log(`Frames per day: ${framesPerDay}`);
  console.log(`Date-keyed total (per tile): ${totalFramesDateKeyed.toLocaleString()}`);
  console.log();

  for (const step of args.resolutions) {
    const buckets = new Set<string>();
    let framesAboveHorizon = 0;
    let framesBelowHorizon = 0;
    for (let d = 0; d < args.days; d++) {
      const day = new Date(startDate);
      day.setUTCDate(day.getUTCDate() + d);
      for (let minOfDay = startMin; minOfDay <= endMin; minOfDay += args.sampleEveryMinutes) {
        const utc = new Date(Date.UTC(
          day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(),
          Math.floor(minOfDay / 60) - TIMEZONE_OFFSET_HOURS,
          minOfDay % 60, 0,
        ));
        const p = SunCalc.getPosition(utc, LAT, LON);
        const alt = p.altitude * 180 / Math.PI;
        if (alt <= 0) {
          framesBelowHorizon++;
          continue;
        }
        framesAboveHorizon++;
        let az = (p.azimuth * 180 / Math.PI + 180) % 360;
        if (az < 0) az += 360;
        const azB = Math.floor(az / step);
        const altB = Math.floor(alt / step);
        buckets.add(`${azB}:${altB}`);
      }
    }
    const unique = buckets.size;
    const dedupFactor = framesAboveHorizon / unique;
    console.log(`  Resolution ${step}°: ${unique.toLocaleString()} unique buckets  (from ${framesAboveHorizon.toLocaleString()} lit frames, ${framesBelowHorizon.toLocaleString()} below horizon) — dedup ${dedupFactor.toFixed(1)}x`);
  }

  console.log();
  console.log(`Per tile comparison (181 tiles total):`);
  console.log(`  Date-keyed: 181 × ${totalFramesDateKeyed.toLocaleString()} = ${(181 * totalFramesDateKeyed).toLocaleString()} frames`);
  for (const step of args.resolutions) {
    const buckets = new Set<string>();
    for (let d = 0; d < args.days; d++) {
      const day = new Date(startDate);
      day.setUTCDate(day.getUTCDate() + d);
      for (let minOfDay = startMin; minOfDay <= endMin; minOfDay += args.sampleEveryMinutes) {
        const utc = new Date(Date.UTC(
          day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(),
          Math.floor(minOfDay / 60) - TIMEZONE_OFFSET_HOURS,
          minOfDay % 60, 0,
        ));
        const p = SunCalc.getPosition(utc, LAT, LON);
        const alt = p.altitude * 180 / Math.PI;
        if (alt <= 0) continue;
        let az = (p.azimuth * 180 / Math.PI + 180) % 360;
        if (az < 0) az += 360;
        buckets.add(`${Math.floor(az / step)}:${Math.floor(alt / step)}`);
      }
    }
    const u = buckets.size;
    console.log(`  Angle-keyed ${step}°: 181 × ${u.toLocaleString()} = ${(181 * u).toLocaleString()} frames (${(100 * 181 * u / (181 * totalFramesDateKeyed)).toFixed(1)}% of date-keyed)`);
  }
}

main();
