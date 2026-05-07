/**
 * How many consecutive days share the same (az, alt) bucket at a given
 * clock time? Answer depends on season AND time of day.
 *
 * For each (day_of_year, clock_time_of_day) pair, compute the sun
 * position at Lausanne center, round to bucket, and count the run-length
 * of consecutive days with the same bucket.
 */

import SunCalc from "suncalc";

const LAT = 46.52;
const LON = 6.63;
const TIMEZONE_OFFSET_HOURS = 1; // UTC+1 (we'll ignore DST for this analysis — error < 1 day/side)
const BUCKETS = [2, 1, 0.5, 0.25];
const YEAR = 2026;
const CLOCK_TIMES = ["08:00", "12:00", "15:00", "18:00"];

function sunPositionAt(dateUtc: Date): { az: number; alt: number } {
  const p = SunCalc.getPosition(dateUtc, LAT, LON);
  let az = (p.azimuth * 180 / Math.PI + 180) % 360;
  if (az < 0) az += 360;
  return { az, alt: p.altitude * 180 / Math.PI };
}

function dayOfYearToUtcDate(dayOfYear: number, clockHHmm: string): Date {
  const [h, m] = clockHHmm.split(":").map(Number);
  const ms = Date.UTC(YEAR, 0, 1 + (dayOfYear - 1), h - TIMEZONE_OFFSET_HOURS, m, 0);
  return new Date(ms);
}

function bucketKey(az: number, alt: number, step: number): string {
  const azBucket = Math.floor(az / step);
  const altBucket = Math.floor(alt / step);
  return `${azBucket}:${altBucket}`;
}

// For each clock time, for each day, compute the bucket. Then measure:
//   - For each day N, how many consecutive days N, N+1, N+2, ... share the same bucket?
type RunStats = {
  step: number;
  clockTime: string;
  meanRun: number;
  minRun: number;
  maxRun: number;
  median: number;
  runs: number[]; // per day, the run-length starting at day N (forward-looking)
};

function runLengthsForwardAt(clockTime: string, step: number): number[] {
  const buckets: string[] = [];
  for (let day = 1; day <= 365; day++) {
    const { az, alt } = sunPositionAt(dayOfYearToUtcDate(day, clockTime));
    buckets.push(bucketKey(az, alt, step));
  }
  const runs: number[] = new Array(365).fill(0);
  for (let i = 0; i < 365; i++) {
    let j = i;
    while (j < 365 && buckets[j] === buckets[i]) j++;
    runs[i] = j - i;
  }
  return runs;
}

function summarize(runs: number[]): { mean: number; min: number; max: number; median: number } {
  const sum = runs.reduce((a, b) => a + b, 0);
  const mean = sum / runs.length;
  const sorted = [...runs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { mean, min: sorted[0], max: sorted[sorted.length - 1], median };
}

console.log(`Lausanne, ${YEAR}, consecutive-day bucket sharing`);
console.log();

for (const step of BUCKETS) {
  console.log(`=== Bucket resolution: ${step}° ===`);
  console.log(`clock time | mean run | median | min | max`);
  console.log(`-----------+----------+--------+-----+----`);
  for (const clock of CLOCK_TIMES) {
    const runs = runLengthsForwardAt(clock, step);
    const s = summarize(runs);
    console.log(`${clock.padEnd(10)} | ${s.mean.toFixed(1).padStart(8)} | ${String(s.median).padStart(6)} | ${String(s.min).padStart(3)} | ${String(s.max).padStart(3)}`);
  }
  console.log();
}

// Also show how it varies across the year at 1° bucket, noon
console.log(`=== Run length at 12:00, 1° bucket, sampled across year ===`);
const runsNoon1 = runLengthsForwardAt("12:00", 1);
for (let month = 0; month < 12; month++) {
  const dayStart = Math.floor(month * 30) + 1;
  const run = runsNoon1[dayStart - 1];
  const label = new Date(YEAR, month, 1).toLocaleString("en", { month: "short" });
  console.log(`  ~${label} ${String(dayStart).padStart(3)}: ${run} consecutive days share bucket`);
}
