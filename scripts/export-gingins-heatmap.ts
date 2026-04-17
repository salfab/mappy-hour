/**
 * Export a solar heatmap for the Château Blanc tile (Gingins).
 *
 * Reads precomputed sunlight artifacts from the cache for a full year,
 * accumulates sunny hours per pixel, and writes a JSON file for the
 * blog visualization.
 *
 * RESUMABLE: skips days already accumulated. Re-run safely.
 *
 * Prerequisites:
 *   pnpm precompute:all-regions:vulkan -- \
 *     --tile-selection-file=data/processed/precompute/gingins-tile.json \
 *     --start-date=2026-01-01 --days=365 \
 *     --start-local-time=06:00 --end-local-time=21:00
 *
 * Usage:
 *   npx tsx scripts/export-gingins-heatmap.ts
 *   npx tsx scripts/export-gingins-heatmap.ts --days-available  (just check)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);

const TILE_ID = "e2502750_n1141000_s250";
const REGION = "nyon";
const GRID_STEP = 1;
const SAMPLE_EVERY = 15; // minutes
const CACHE_ROOT = path.join(process.cwd(), "data", "cache", "sunlight");
const OUTPUT_PATH = path.join("C:", "sources", "seesharpch", "assets", "data", "gingins-heatmap.json");

// Find the model version hash that has g1/m15 data
async function findModelVersionHash(): Promise<string | null> {
  const regionDir = path.join(CACHE_ROOT, REGION);
  try {
    const entries = await fs.readdir(regionDir);
    for (const entry of entries) {
      const stat = await fs.stat(path.join(regionDir, entry));
      if (!stat.isDirectory() || entry.length < 8) continue;
      // Check if this hash has the right grid/sample params
      const paramDir = path.join(regionDir, entry, `g${GRID_STEP}`, `m${SAMPLE_EVERY}`);
      try {
        await fs.access(paramDir);
        return entry;
      } catch { /* wrong params, try next */ }
    }
  } catch { /* */ }
  return null;
}

/** Find the time-window subdir that contains our tile file (prefer t0600-2100 over t0000-2359) */
async function findTimeWindowDir(modelHash: string, date: string): Promise<string | null> {
  const dateDir = path.join(CACHE_ROOT, REGION, modelHash, `g${GRID_STEP}`, `m${SAMPLE_EVERY}`, date);
  try {
    const entries = await fs.readdir(dateDir);
    const tDirs = entries.filter((e) => e.startsWith("t")).sort().reverse(); // prefer widest/latest
    for (const tDir of tDirs) {
      const tilePath = path.join(dateDir, tDir, "tiles", `${TILE_ID}.json.gz`);
      try { await fs.access(tilePath); return path.join(dateDir, tDir); } catch { /* try next */ }
    }
  } catch { /* */ }
  return null;
}

function buildTilePath(timeWindowDir: string): string {
  return path.join(timeWindowDir, "tiles", `${TILE_ID}.json.gz`);
}

interface SunlightArtifact {
  points: Array<{ insideBuilding: boolean; outdoorIndex: number | null; lv95Easting: number; lv95Northing: number }>;
  frames: Array<{
    localTime: string;
    sunnyCount: number;
    sunnyCountNoVegetation: number;
    sunMaskBase64: string;
    sunMaskNoVegetationBase64: string;
  }>;
  tile: { minEasting: number; minNorthing: number; maxEasting: number; maxNorthing: number };
}

async function readArtifact(filePath: string): Promise<SunlightArtifact | null> {
  try {
    const compressed = await fs.readFile(filePath);
    const json = await gunzipAsync(compressed);
    return JSON.parse(json.toString("utf8"));
  } catch {
    return null;
  }
}

function decodeMask(base64: string, pointCount: number): Uint8Array {
  const buf = Buffer.from(base64, "base64");
  // Buffer.from() may return a Buffer backed by a SHARED pool ArrayBuffer.
  // Ignoring buf.byteOffset/byteLength would read random pool data instead
  // of the actual decoded bytes. Use the 3-arg Uint8Array ctor or copy.
  return new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, Math.ceil(pointCount / 8)));
}

function isBitSet(mask: Uint8Array, index: number): boolean {
  return ((mask[index >> 3] >> (index & 7)) & 1) === 1;
}

async function main() {
  const justCheck = process.argv.includes("--days-available");

  const modelHash = await findModelVersionHash();
  if (!modelHash) {
    console.error("No model version hash found in cache. Run precompute first.");
    process.exit(1);
  }
  console.log(`Model hash: ${modelHash}`);

  // Generate all dates for 2026 (string-based to avoid timezone issues)
  const dates: string[] = [];
  for (let m = 0; m < 12; m++) {
    const daysInMonth = new Date(2026, m + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      dates.push(`2026-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  }

  // Check which days are available
  const available: string[] = [];
  const missing: string[] = [];
  for (const date of dates) {
    const twDir = await findTimeWindowDir(modelHash, date);
    if (twDir) {
      const tilePath = buildTilePath(twDir);
      try {
        await fs.access(tilePath);
        available.push(date);
        continue;
      } catch { /* tile file missing */ }
    }
    missing.push(date);
  }
  console.log(`Available: ${available.length}/365 days, missing: ${missing.length}`);

  if (justCheck) {
    if (missing.length > 0) {
      console.log(`First 10 missing: ${missing.slice(0, 10).join(", ")}`);
    }
    process.exit(0);
  }

  if (available.length === 0) {
    console.error("No precomputed days available. Run precompute first:");
    console.error("  pnpm precompute:all-regions:vulkan -- \\");
    console.error("    --tile-selection-file=data/processed/precompute/gingins-tile.json \\");
    console.error("    --start-date=2026-01-01 --days=365");
    process.exit(1);
  }

  // Load progress file (resumable)
  const progressPath = path.join(process.cwd(), "data", "tmp", "gingins-heatmap-progress.json");
  let progress: { processedDates: string[]; sunnyMinutes: number[]; sunnyNoVegMinutes: number[]; pointCount: number } | null = null;
  try {
    progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
    console.log(`Resuming: ${progress!.processedDates.length} days already processed`);
  } catch { /* start fresh */ }

  // First artifact to get point layout
  const firstTwDir = await findTimeWindowDir(modelHash, available[0]);
  const firstArtifact = firstTwDir ? await readArtifact(buildTilePath(firstTwDir)) : null;
  if (!firstArtifact) {
    console.error(`Cannot read first artifact: ${available[0]}`);
    process.exit(1);
  }
  const pointCount = firstArtifact.points.length;
  const outdoorCount = firstArtifact.points.filter((p) => !p.insideBuilding).length;
  console.log(`Tile: ${TILE_ID}, ${pointCount} points (${outdoorCount} outdoor)`);

  // Initialize accumulators
  let sunnyMinutes = new Float64Array(pointCount);
  let sunnyNoVegMinutes = new Float64Array(pointCount);
  let processedDates = new Set<string>();

  if (progress && progress.pointCount === pointCount) {
    sunnyMinutes = new Float64Array(progress.sunnyMinutes);
    sunnyNoVegMinutes = new Float64Array(progress.sunnyNoVegMinutes);
    processedDates = new Set(progress.processedDates);
  }

  // Process each available day
  let newDays = 0;
  for (const date of available) {
    if (processedDates.has(date)) continue;

    const twDir = await findTimeWindowDir(modelHash, date);
    const artifact = twDir ? await readArtifact(buildTilePath(twDir)) : null;
    if (!artifact) { console.warn(`  skip ${date} (unreadable)`); continue; }

    for (const frame of artifact.frames) {
      const sunnyMask = decodeMask(frame.sunMaskBase64, pointCount);
      const sunnyNoVegMask = decodeMask(frame.sunMaskNoVegetationBase64, pointCount);
      for (let i = 0; i < pointCount; i++) {
        if (isBitSet(sunnyMask, i)) sunnyMinutes[i] += SAMPLE_EVERY;
        if (isBitSet(sunnyNoVegMask, i)) sunnyNoVegMinutes[i] += SAMPLE_EVERY;
      }
    }

    processedDates.add(date);
    newDays++;

    // Save progress every 10 days
    if (newDays % 10 === 0) {
      await fs.mkdir(path.dirname(progressPath), { recursive: true });
      await fs.writeFile(progressPath, JSON.stringify({
        processedDates: [...processedDates],
        sunnyMinutes: Array.from(sunnyMinutes),
        sunnyNoVegMinutes: Array.from(sunnyNoVegMinutes),
        pointCount,
      }));
      process.stdout.write(`${processedDates.size}`);
    } else {
      process.stdout.write(".");
    }
  }

  console.log(`\nProcessed ${newDays} new days, total ${processedDates.size}/${dates.length}`);

  // Save final progress
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  await fs.writeFile(progressPath, JSON.stringify({
    processedDates: [...processedDates],
    sunnyMinutes: Array.from(sunnyMinutes),
    sunnyNoVegMinutes: Array.from(sunnyNoVegMinutes),
    pointCount,
  }));

  // Export heatmap JSON for the blog
  // Convert minutes to hours, round to 0.1h
  const sunnyHours = Array.from(sunnyMinutes).map((m) => Math.round(m / 6) / 10); // /60 * 10 / 10
  const sunnyNoVegHours = Array.from(sunnyNoVegMinutes).map((m) => Math.round(m / 6) / 10);

  const tile = firstArtifact.tile;
  const gridSize = Math.round(Math.sqrt(pointCount)); // 250 for 1m step in 250m tile

  const heatmap = {
    tileId: TILE_ID,
    region: REGION,
    daysProcessed: processedDates.size,
    daysTotal: 365,
    gridSize,
    minEasting: tile.minEasting,
    minNorthing: tile.minNorthing,
    maxEasting: tile.maxEasting,
    maxNorthing: tile.maxNorthing,
    // Per-point: annual sunny hours (with and without vegetation)
    sunnyHours,
    sunnyNoVegHours,
    // Indoor points have 0 hours
    indoor: firstArtifact.points.map((p) => p.insideBuilding),
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(heatmap));
  const sizeMB = (Buffer.byteLength(JSON.stringify(heatmap)) / 1024 / 1024).toFixed(1);
  console.log(`Exported ${OUTPUT_PATH} (${sizeMB} MB, ${gridSize}x${gridSize} grid, ${processedDates.size} days)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
