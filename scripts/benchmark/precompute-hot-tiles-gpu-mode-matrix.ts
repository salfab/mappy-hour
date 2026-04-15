/**
 * Compare gpu-raster vs Rust/wgpu Vulkan on the same hot-tile dry-run path.
 *
 * This wraps scripts/precompute/precompute-rust-wgpu-vulkan-dry-run.ts, so it
 * exercises computeSunlightTileArtifact without writing the normal sunlight
 * cache.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { loadTileSelectionForRegion } from "@/lib/precompute/tile-selection-file";
import type { PrecomputedRegionName } from "@/lib/precompute/sunlight-cache";

type DryRunMode = "gpu-raster" | "rust-wgpu-vulkan" | "detailed";

type Args = {
  region: PrecomputedRegionName;
  tileSelectionFile: string;
  maxTiles: number;
  date: string;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  focusMarginMeters: number;
  maxOutdoorPoints: string;
  modes: DryRunMode[];
  reportPath: string | null;
  showChildOutput: boolean;
  compareValues: boolean;
  valueSummaryDir: string | null;
};

type TileSummary = {
  tileId: string;
  totalSeconds: number;
  horizonSeconds: number;
  sourcesSeconds: number;
  pointsSeconds: number;
  evalSeconds: number;
  evalCount: number;
  microsecondsPerEval: number;
  gridPoints: number;
  outdoorPoints: number;
  indoorPoints: number;
};

type RunSummary = {
  mode: DryRunMode;
  tileId: string;
  exitCode: number | null;
  wallSeconds: number;
  tileSummary: TileSummary | null;
  frames: number | null;
  model: string | null;
  valueSummaryPath: string | null;
};

type ValueSummaryFrame = {
  index: number;
  localTime: string;
  utcTime: string;
  sunnyCount: number;
  sunnyCountNoVegetation: number;
  sunMaskBase64: string;
  sunMaskNoVegetationBase64: string;
  terrainBlockedMaskBase64: string;
  buildingsBlockedMaskBase64: string;
  vegetationBlockedMaskBase64: string;
};

type ValueSummary = {
  mode: DryRunMode;
  region: PrecomputedRegionName;
  tileId: string;
  date: string;
  stats: {
    pointCount: number;
    gridPointCount: number;
  };
  points?: ValueSummaryPoint[];
  frames: ValueSummaryFrame[];
};

type ValueSummaryPoint = {
  outdoorIndex: number;
  id: string;
  lat: number;
  lon: number;
  lv95Easting: number;
  lv95Northing: number;
  pointElevationMeters: number | null;
};

type MaskDiff = {
  diffBits: number;
  diffPct: number;
  leftOnlyBits: number;
  rightOnlyBits: number;
};

type MaskBitDifference = {
  outdoorIndex: number;
  leftBit: boolean;
  rightBit: boolean;
};

type DivergenceSample = {
  maskName: string;
  frameIndex: number;
  localTime: string;
  utcTime: string;
  outdoorIndex: number;
  leftBit: boolean;
  rightBit: boolean;
  point: ValueSummaryPoint | null;
};

type DivergentPointSummary = ValueSummaryPoint & {
  count: number;
  maskNames: string[];
  frameIndexes: number[];
};

type ValueComparison = {
  leftMode: DryRunMode;
  rightMode: DryRunMode;
  pointCount: number;
  frameCount: number;
  totalPointFrames: number;
  masks: Record<string, MaskDiff>;
  frames: Array<{
    index: number;
    localTime: string;
    utcTime: string;
    masks: Record<string, MaskDiff>;
    sunnyCountDelta: number;
    sunnyCountNoVegetationDelta: number;
  }>;
  topDivergentPoints: DivergentPointSummary[];
  divergenceSamples: DivergenceSample[];
  sunnyCountDeltaAbs: number;
  sunnyCountNoVegetationDeltaAbs: number;
};

type TileReport = {
  tileId: string;
  modes: Record<string, RunSummary>;
  rustVsRasterTotalSpeedup: number | null;
  rustVsRasterEvalSpeedup: number | null;
  valueComparison: ValueComparison | null;
  valueComparisons: Record<string, ValueComparison>;
};

const DEFAULT_SELECTION_FILE = path.join(
  "data",
  "processed",
  "precompute",
  "high-value-tile-selection.top-priority.json",
);
const MAX_DIVERGENCE_SAMPLES = 1000;
const MAX_TOP_DIVERGENT_POINTS = 500;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    region: "lausanne",
    tileSelectionFile: DEFAULT_SELECTION_FILE,
    maxTiles: 3,
    date: "2026-04-13",
    timezone: "Europe/Zurich",
    sampleEveryMinutes: 15,
    gridStepMeters: 1,
    startLocalTime: "12:00",
    endLocalTime: "15:00",
    focusMarginMeters: 500,
    maxOutdoorPoints: "all",
    modes: ["gpu-raster", "rust-wgpu-vulkan"],
    reportPath: path.join("data", "processed", "wgpu-vulkan-probe", "hot-tiles-gpu-mode-matrix.json"),
    showChildOutput: false,
    compareValues: true,
    valueSummaryDir: path.join("data", "processed", "wgpu-vulkan-probe", "hot-tiles-value-summaries"),
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  pnpm exec tsx scripts/benchmark/precompute-hot-tiles-gpu-mode-matrix.ts -- --max-tiles=3",
        "",
        "Options:",
        "  --region=lausanne|nyon|morges|geneve",
        "  --tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json",
        "  --max-tiles=3",
        "  --date=2026-04-13",
        "  --timezone=Europe/Zurich",
        "  --sample-every-minutes=15",
        "  --grid-step-meters=1",
        "  --start-local-time=12:00",
        "  --end-local-time=15:00",
        "  --focus-margin-meters=500",
        "  --max-outdoor-points=all|2048",
        "  --modes=gpu-raster,rust-wgpu-vulkan,detailed",
        "  --report=data/processed/wgpu-vulkan-probe/hot-tiles-gpu-mode-matrix.json",
        "  --report=none",
        "  --show-child-output=true|false",
        "  --compare-values=true|false",
        "  --value-summary-dir=data/processed/wgpu-vulkan-probe/hot-tiles-value-summaries",
        "  --value-summary-dir=none",
      ].join("\n"));
      process.exit(0);
    }

    const [key, value] = splitArg(arg);
    if (key === "--region") args.region = parseRegion(value);
    else if (key === "--tile-selection-file") args.tileSelectionFile = value;
    else if (key === "--max-tiles") args.maxTiles = parsePositiveInteger(value, key);
    else if (key === "--date") args.date = value;
    else if (key === "--timezone") args.timezone = value;
    else if (key === "--sample-every-minutes") args.sampleEveryMinutes = parsePositiveInteger(value, key);
    else if (key === "--grid-step-meters") args.gridStepMeters = parsePositiveNumber(value, key);
    else if (key === "--start-local-time") args.startLocalTime = value;
    else if (key === "--end-local-time") args.endLocalTime = value;
    else if (key === "--focus-margin-meters") args.focusMarginMeters = parseNonNegativeNumber(value, key);
    else if (key === "--max-outdoor-points") args.maxOutdoorPoints = parseMaxOutdoorPoints(value);
    else if (key === "--modes") args.modes = parseModes(value);
    else if (key === "--report") args.reportPath = value === "none" ? null : value;
    else if (key === "--show-child-output") args.showChildOutput = parseBoolean(value, key);
    else if (key === "--compare-values") args.compareValues = parseBoolean(value, key);
    else if (key === "--value-summary-dir") args.valueSummaryDir = value === "none" ? null : value;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function splitArg(arg: string): [string, string] {
  const index = arg.indexOf("=");
  if (index === -1) throw new Error(`Expected --key=value argument, got ${arg}`);
  return [arg.slice(0, index), arg.slice(index + 1)];
}

function parseRegion(value: string): PrecomputedRegionName {
  if (value === "lausanne" || value === "nyon" || value === "morges" || value === "geneve") {
    return value;
  }
  throw new Error(`Unsupported region: ${value}`);
}

function parseModes(value: string): DryRunMode[] {
  const modes = value.split(",").map((mode) => mode.trim()).filter(Boolean);
  if (modes.length === 0) throw new Error("--modes cannot be empty");
  for (const mode of modes) {
    if (mode !== "gpu-raster" && mode !== "rust-wgpu-vulkan" && mode !== "detailed") {
      throw new Error(`Unsupported mode: ${mode}`);
    }
  }
  return modes as DryRunMode[];
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

function parsePositiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${value}`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got ${value}`);
  }
  return parsed;
}

function parseMaxOutdoorPoints(value: string): string {
  if (value === "all") return value;
  parsePositiveInteger(value, "--max-outdoor-points");
  return value;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`${name} must be true or false, got ${value}`);
}

function selectHotTiles(
  entries: Awaited<ReturnType<typeof loadTileSelectionForRegion>>["entries"],
  maxTiles: number,
): string[] {
  const ranked = [...entries].sort((left, right) => {
    const rightOutdoor = right.counts?.outdoorSeating ?? 0;
    const leftOutdoor = left.counts?.outdoorSeating ?? 0;
    if (rightOutdoor !== leftOutdoor) return rightOutdoor - leftOutdoor;
    const rightScore = right.score ?? 0;
    const leftScore = left.score ?? 0;
    if (rightScore !== leftScore) return rightScore - leftScore;
    return left.tileId.localeCompare(right.tileId);
  });
  return Array.from(new Set(ranked.map((entry) => entry.tileId))).slice(0, maxTiles);
}

function makeValueSummaryPath(args: Args, mode: DryRunMode, tileId: string): string | null {
  if (!args.compareValues || !args.valueSummaryDir) {
    return null;
  }
  const timeWindow = `${args.startLocalTime}-${args.endLocalTime}`.replaceAll(":", "");
  return path.join(
    args.valueSummaryDir,
    `${args.region}-${tileId}-${args.date}-t${timeWindow}-g${args.gridStepMeters}-m${args.sampleEveryMinutes}-${mode}.values.json`,
  );
}

function dryRunArgs(args: Args, mode: DryRunMode, tileId: string, valueSummaryPath: string | null): string[] {
  const childArgs = [
    "scripts/precompute/precompute-rust-wgpu-vulkan-dry-run.ts",
    `--mode=${mode}`,
    `--region=${args.region}`,
    `--tile-id=${tileId}`,
    `--date=${args.date}`,
    `--timezone=${args.timezone}`,
    `--sample-every-minutes=${args.sampleEveryMinutes}`,
    `--grid-step-meters=${args.gridStepMeters}`,
    `--start-local-time=${args.startLocalTime}`,
    `--end-local-time=${args.endLocalTime}`,
    `--focus-margin-meters=${args.focusMarginMeters}`,
    `--max-outdoor-points=${args.maxOutdoorPoints}`,
  ];
  if (valueSummaryPath) {
    childArgs.push(`--write-value-summary=${valueSummaryPath}`);
  }
  return childArgs;
}

async function runDryRun(args: Args, mode: DryRunMode, tileId: string): Promise<RunSummary> {
  const started = performance.now();
  const valueSummaryPath = makeValueSummaryPath(args, mode, tileId);
  const childArgs = [...process.execArgv, ...dryRunArgs(args, mode, tileId, valueSummaryPath)];
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    if (args.showChildOutput) process.stdout.write(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    if (args.showChildOutput) process.stderr.write(text);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  const parsed = parseDryRunOutput(stdout, mode, tileId);
  const summary: RunSummary = {
    mode,
    tileId,
    exitCode,
    wallSeconds: round2((performance.now() - started) / 1000),
    valueSummaryPath,
    ...parsed,
  };
  if (exitCode !== 0) {
    const tail = [stdout, stderr]
      .join("\n")
      .split(/\r?\n/)
      .slice(-40)
      .join("\n");
    throw new Error(`Dry-run failed for ${mode}/${tileId} with exitCode=${exitCode}\n${tail}`);
  }
  return summary;
}

function parseDryRunOutput(
  stdout: string,
  mode: DryRunMode,
  tileId: string,
): Pick<RunSummary, "tileSummary" | "frames" | "model"> {
  const tileLine = stdout.match(
    /\[tile ([^\]]+)\] ([\d.]+)s total . horizon ([\d.]+)s, sources ([\d.]+)s, points ([\d.]+)s, eval ([\d.]+)s \((\d+) evals, (\d+) .*?s\/eval\) . (\d+) grid pts, (\d+) outdoor, (\d+) indoor/,
  );
  const doneLine = stdout.match(/\[precompute-gpu-dry-run\] done in [\d.]+s frames=(\d+) outdoor=\d+ model=(.+)/);

  if (!tileLine) {
    return { tileSummary: null, frames: doneLine ? Number(doneLine[1]) : null, model: doneLine?.[2] ?? null };
  }

  const parsedTileId = tileLine[1];
  if (parsedTileId !== tileId) {
    throw new Error(`Parsed tile mismatch for ${mode}: expected ${tileId}, got ${parsedTileId}`);
  }

  return {
    tileSummary: {
      tileId: parsedTileId,
      totalSeconds: Number(tileLine[2]),
      horizonSeconds: Number(tileLine[3]),
      sourcesSeconds: Number(tileLine[4]),
      pointsSeconds: Number(tileLine[5]),
      evalSeconds: Number(tileLine[6]),
      evalCount: Number(tileLine[7]),
      microsecondsPerEval: Number(tileLine[8]),
      gridPoints: Number(tileLine[9]),
      outdoorPoints: Number(tileLine[10]),
      indoorPoints: Number(tileLine[11]),
    },
    frames: doneLine ? Number(doneLine[1]) : null,
    model: doneLine?.[2] ?? null,
  };
}

async function readValueSummary(filePath: string): Promise<ValueSummary> {
  return JSON.parse(await fs.readFile(path.resolve(process.cwd(), filePath), "utf8")) as ValueSummary;
}

function isMaskBitSet(mask: Buffer, index: number): boolean {
  return ((mask[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
}

function compareMaskBase64Detailed(
  leftBase64: string,
  rightBase64: string,
  bitCount: number,
): { diff: MaskDiff; differences: MaskBitDifference[] } {
  const left = Buffer.from(leftBase64, "base64");
  const right = Buffer.from(rightBase64, "base64");
  let diffBits = 0;
  let leftOnlyBits = 0;
  let rightOnlyBits = 0;
  const differences: MaskBitDifference[] = [];

  for (let bit = 0; bit < bitCount; bit += 1) {
    const leftBit = isMaskBitSet(left, bit);
    const rightBit = isMaskBitSet(right, bit);
    if (leftBit === rightBit) {
      continue;
    }
    diffBits += 1;
    if (leftBit) leftOnlyBits += 1;
    else rightOnlyBits += 1;
    differences.push({
      outdoorIndex: bit,
      leftBit,
      rightBit,
    });
  }

  return {
    diff: {
      diffBits,
      diffPct: bitCount === 0 ? 0 : round6((diffBits / bitCount) * 100),
      leftOnlyBits,
      rightOnlyBits,
    },
    differences,
  };
}

function addMaskDiff(target: MaskDiff, diff: MaskDiff): void {
  target.diffBits += diff.diffBits;
  target.leftOnlyBits += diff.leftOnlyBits;
  target.rightOnlyBits += diff.rightOnlyBits;
}

function emptyMaskDiff(): MaskDiff {
  return {
    diffBits: 0,
    diffPct: 0,
    leftOnlyBits: 0,
    rightOnlyBits: 0,
  };
}

function pointAt(points: ValueSummaryPoint[] | undefined, outdoorIndex: number): ValueSummaryPoint | null {
  if (!points) return null;
  return points[outdoorIndex] ?? points.find((point) => point.outdoorIndex === outdoorIndex) ?? null;
}

function addDivergentPoint(
  counts: Map<number, {
    count: number;
    maskNames: Set<string>;
    frameIndexes: Set<number>;
  }>,
  outdoorIndex: number,
  maskName: string,
  frameIndex: number,
): void {
  const current = counts.get(outdoorIndex) ?? {
    count: 0,
    maskNames: new Set<string>(),
    frameIndexes: new Set<number>(),
  };
  current.count += 1;
  current.maskNames.add(maskName);
  current.frameIndexes.add(frameIndex);
  counts.set(outdoorIndex, current);
}

function summarizeDivergentPoints(
  counts: Map<number, {
    count: number;
    maskNames: Set<string>;
    frameIndexes: Set<number>;
  }>,
  points: ValueSummaryPoint[] | undefined,
  limit = MAX_TOP_DIVERGENT_POINTS,
): DivergentPointSummary[] {
  return Array.from(counts.entries())
    .sort((left, right) => {
      const countDelta = right[1].count - left[1].count;
      if (countDelta !== 0) return countDelta;
      return left[0] - right[0];
    })
    .slice(0, limit)
    .map(([outdoorIndex, value]) => {
      const point = pointAt(points, outdoorIndex);
      return {
        outdoorIndex,
        id: point?.id ?? `outdoor-${outdoorIndex}`,
        lat: point?.lat ?? Number.NaN,
        lon: point?.lon ?? Number.NaN,
        lv95Easting: point?.lv95Easting ?? Number.NaN,
        lv95Northing: point?.lv95Northing ?? Number.NaN,
        pointElevationMeters: point?.pointElevationMeters ?? null,
        count: value.count,
        maskNames: Array.from(value.maskNames).sort(),
        frameIndexes: Array.from(value.frameIndexes).sort((a, b) => a - b),
      };
    });
}

async function compareValueSummaries(
  leftMode: DryRunMode,
  leftPath: string | null,
  rightMode: DryRunMode,
  rightPath: string | null,
): Promise<ValueComparison | null> {
  if (!leftPath || !rightPath) {
    return null;
  }
  const [left, right] = await Promise.all([
    readValueSummary(leftPath),
    readValueSummary(rightPath),
  ]);

  if (left.tileId !== right.tileId) {
    throw new Error(`Value summary tile mismatch: ${left.tileId} != ${right.tileId}`);
  }
  if (left.stats.pointCount !== right.stats.pointCount) {
    throw new Error(`Value summary point mismatch for ${left.tileId}: ${left.stats.pointCount} != ${right.stats.pointCount}`);
  }
  if (left.frames.length !== right.frames.length) {
    throw new Error(`Value summary frame mismatch for ${left.tileId}: ${left.frames.length} != ${right.frames.length}`);
  }

  const maskNames = [
    "sunMaskBase64",
    "sunMaskNoVegetationBase64",
    "terrainBlockedMaskBase64",
    "buildingsBlockedMaskBase64",
    "vegetationBlockedMaskBase64",
  ] as const;
  const masks = Object.fromEntries(maskNames.map((name) => [name, emptyMaskDiff()])) as Record<string, MaskDiff>;
  const frames: ValueComparison["frames"] = [];
  const divergentPointCounts = new Map<number, {
    count: number;
    maskNames: Set<string>;
    frameIndexes: Set<number>;
  }>();
  const divergenceSamples: DivergenceSample[] = [];
  let sunnyCountDeltaAbs = 0;
  let sunnyCountNoVegetationDeltaAbs = 0;

  for (let index = 0; index < left.frames.length; index += 1) {
    const leftFrame = left.frames[index];
    const rightFrame = right.frames[index];
    if (
      leftFrame.index !== rightFrame.index ||
      leftFrame.utcTime !== rightFrame.utcTime ||
      leftFrame.localTime !== rightFrame.localTime
    ) {
      throw new Error(`Value summary frame mismatch for ${left.tileId} at index ${index}`);
    }

    sunnyCountDeltaAbs += Math.abs(leftFrame.sunnyCount - rightFrame.sunnyCount);
    sunnyCountNoVegetationDeltaAbs += Math.abs(
      leftFrame.sunnyCountNoVegetation - rightFrame.sunnyCountNoVegetation,
    );

    const frameMasks = Object.fromEntries(maskNames.map((name) => [name, emptyMaskDiff()])) as Record<string, MaskDiff>;
    for (const maskName of maskNames) {
      const detailedDiff = compareMaskBase64Detailed(leftFrame[maskName], rightFrame[maskName], left.stats.pointCount);
      const frameDiff = detailedDiff.diff;
      addMaskDiff(masks[maskName], frameDiff);
      frameMasks[maskName] = frameDiff;

      if (maskName === "buildingsBlockedMaskBase64" || maskName === "sunMaskBase64") {
        for (const difference of detailedDiff.differences) {
          addDivergentPoint(divergentPointCounts, difference.outdoorIndex, maskName, leftFrame.index);
          if (divergenceSamples.length < MAX_DIVERGENCE_SAMPLES) {
            divergenceSamples.push({
              maskName,
              frameIndex: leftFrame.index,
              localTime: leftFrame.localTime,
              utcTime: leftFrame.utcTime,
              outdoorIndex: difference.outdoorIndex,
              leftBit: difference.leftBit,
              rightBit: difference.rightBit,
              point: pointAt(left.points, difference.outdoorIndex),
            });
          }
        }
      }
    }
    frames.push({
      index: leftFrame.index,
      localTime: leftFrame.localTime,
      utcTime: leftFrame.utcTime,
      masks: frameMasks,
      sunnyCountDelta: leftFrame.sunnyCount - rightFrame.sunnyCount,
      sunnyCountNoVegetationDelta: leftFrame.sunnyCountNoVegetation - rightFrame.sunnyCountNoVegetation,
    });
  }

  const totalPointFrames = left.stats.pointCount * left.frames.length;
  for (const diff of Object.values(masks)) {
    diff.diffPct = totalPointFrames === 0 ? 0 : round6((diff.diffBits / totalPointFrames) * 100);
  }

  return {
    leftMode,
    rightMode,
    pointCount: left.stats.pointCount,
    frameCount: left.frames.length,
    totalPointFrames,
    masks,
    frames,
    topDivergentPoints: summarizeDivergentPoints(divergentPointCounts, left.points),
    divergenceSamples,
    sunnyCountDeltaAbs,
    sunnyCountNoVegetationDeltaAbs,
  };
}

async function summarizeTile(tileId: string, runs: RunSummary[]): Promise<TileReport> {
  const byMode = new Map(runs.map((run) => [run.mode, run]));
  const raster = byMode.get("gpu-raster")?.tileSummary;
  const rust = byMode.get("rust-wgpu-vulkan")?.tileSummary;
  const valueComparisons: Record<string, ValueComparison> = {};
  for (let leftIndex = 0; leftIndex < runs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < runs.length; rightIndex += 1) {
      const left = runs[leftIndex];
      const right = runs[rightIndex];
      const comparison = await compareValueSummaries(
        left.mode,
        left.valueSummaryPath,
        right.mode,
        right.valueSummaryPath,
      );
      if (comparison) {
        valueComparisons[comparisonKey(left.mode, right.mode)] = comparison;
      }
    }
  }
  return {
    tileId,
    modes: Object.fromEntries(runs.map((run) => [run.mode, run])),
    rustVsRasterTotalSpeedup: raster && rust ? round2(raster.totalSeconds / Math.max(rust.totalSeconds, 0.01)) : null,
    rustVsRasterEvalSpeedup: raster && rust ? round2(raster.evalSeconds / Math.max(rust.evalSeconds, 0.01)) : null,
    valueComparison: valueComparisons[comparisonKey("gpu-raster", "rust-wgpu-vulkan")] ?? null,
    valueComparisons,
  };
}

function comparisonKey(leftMode: DryRunMode, rightMode: DryRunMode): string {
  return `${leftMode}__vs__${rightMode}`;
}

function findValueComparison(
  comparisons: Record<string, ValueComparison>,
  leftMode: DryRunMode,
  rightMode: DryRunMode,
): ValueComparison | null {
  return (
    comparisons[comparisonKey(leftMode, rightMode)] ??
    comparisons[comparisonKey(rightMode, leftMode)] ??
    null
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function formatComparisonSummary(comparison: ValueComparison | null): string {
  const sun = comparison?.masks.sunMaskBase64;
  const buildings = comparison?.masks.buildingsBlockedMaskBase64;
  if (!comparison || !sun || !buildings) {
    return "n/a";
  }
  return `sun=${sun.diffBits}/${comparison.totalPointFrames} (${sun.diffPct}%) buildings=${buildings.diffBits}/${comparison.totalPointFrames} (${buildings.diffPct}%)`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selection = await loadTileSelectionForRegion({
    filePath: args.tileSelectionFile,
    region: args.region,
  });
  const tileIds = selectHotTiles(selection.entries, args.maxTiles);
  if (tileIds.length === 0) {
    throw new Error(`No selected tiles for ${args.region} in ${selection.filePath}`);
  }

  console.log(
    `[hot-tiles-gpu-matrix] region=${args.region} tiles=${tileIds.length} modes=${args.modes.join(",")} window=${args.startLocalTime}-${args.endLocalTime} date=${args.date}`,
  );

  const runs: RunSummary[] = [];
  const started = performance.now();
  for (const tileId of tileIds) {
    for (const mode of args.modes) {
      console.log(`[hot-tiles-gpu-matrix] run mode=${mode} tile=${tileId}`);
      const run = await runDryRun(args, mode, tileId);
      runs.push(run);
      const tile = run.tileSummary;
      console.log(
        `[hot-tiles-gpu-matrix] done mode=${mode} tile=${tileId} total=${tile?.totalSeconds ?? "?"}s eval=${tile?.evalSeconds ?? "?"}s frames=${run.frames ?? "?"} wall=${run.wallSeconds}s`,
      );
    }
  }

  const byTile: TileReport[] = [];
  for (const tileId of tileIds) {
    byTile.push(await summarizeTile(
      tileId,
      runs.filter((run) => run.tileId === tileId),
    ));
  }
  const report = {
    generatedAt: new Date().toISOString(),
    args,
    selection: {
      filePath: selection.filePath,
      generatedAt: selection.generatedAt,
      tileSizeMeters: selection.tileSizeMeters,
    },
    tileIds,
    elapsedSeconds: round2((performance.now() - started) / 1000),
    tiles: byTile,
  };

  if (args.reportPath) {
    const reportPath = path.resolve(process.cwd(), args.reportPath);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[hot-tiles-gpu-matrix] report=${reportPath}`);
  }

  for (const tile of byTile) {
    const rasterVsRust = findValueComparison(tile.valueComparisons, "gpu-raster", "rust-wgpu-vulkan");
    const rasterVsDetailed = findValueComparison(tile.valueComparisons, "gpu-raster", "detailed");
    const rustVsDetailed = findValueComparison(tile.valueComparisons, "rust-wgpu-vulkan", "detailed");
    console.log(
      `[hot-tiles-gpu-matrix] summary tile=${tile.tileId} totalSpeedup=${tile.rustVsRasterTotalSpeedup ?? "n/a"}x evalSpeedup=${tile.rustVsRasterEvalSpeedup ?? "n/a"}x rasterVsRust=${formatComparisonSummary(rasterVsRust)} rasterVsDetailed=${formatComparisonSummary(rasterVsDetailed)} rustVsDetailed=${formatComparisonSummary(rustVsDetailed)}`,
    );
  }
}

void main().catch((error) => {
  console.error(`[hot-tiles-gpu-matrix] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
