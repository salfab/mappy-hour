import fs from "node:fs/promises";
import path from "node:path";

type ModeName = "gpu-raster" | "rust-wgpu-vulkan" | "detailed";

type Args = {
  summaryDir: string;
  leftMode: ModeName;
  rightMode: ModeName;
  leftPath: string | null;
  rightPath: string | null;
  tileId: string | null;
  mask: MaskName | "all";
  frame: number | "all";
  out: string;
  summaryOut: string | null;
  maxFeatures: number | "all";
};

type MaskName =
  | "sunMaskBase64"
  | "sunMaskNoVegetationBase64"
  | "terrainBlockedMaskBase64"
  | "buildingsBlockedMaskBase64"
  | "vegetationBlockedMaskBase64";

type ValueSummaryPoint = {
  outdoorIndex: number;
  id: string;
  lat: number;
  lon: number;
  lv95Easting: number;
  lv95Northing: number;
  pointElevationMeters: number | null;
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
  mode: ModeName;
  region: string;
  tileId: string;
  date: string;
  timezone?: string;
  stats: {
    pointCount: number;
    gridPointCount: number;
  };
  points?: ValueSummaryPoint[];
  frames: ValueSummaryFrame[];
};

type DivergenceSummary = {
  generatedAt: string;
  leftMode: ModeName;
  rightMode: ModeName;
  leftPath: string;
  rightPath: string;
  region: string;
  tileId: string;
  date: string;
  timezone: string | null;
  pointCount: number;
  frameCount: number;
  masks: Array<{
    maskName: MaskName;
    diffBits: number;
    leftOnlyBits: number;
    rightOnlyBits: number;
  }>;
  featureCount: number;
  truncated: boolean;
  lv95Bounds: {
    minEasting: number | null;
    minNorthing: number | null;
    maxEasting: number | null;
    maxNorthing: number | null;
  };
};

type GeoJsonFeature = {
  type: "Feature";
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
  properties: Record<string, string | number | boolean | null>;
};

const DEFAULT_SUMMARY_DIR = path.join(
  "data",
  "processed",
  "wgpu-vulkan-probe",
  "hot-tiles-value-summaries-divergence-fulltile-1frame",
);

const MASK_NAMES: MaskName[] = [
  "sunMaskBase64",
  "sunMaskNoVegetationBase64",
  "terrainBlockedMaskBase64",
  "buildingsBlockedMaskBase64",
  "vegetationBlockedMaskBase64",
];

function parseArgs(argv: string[]): Args {
  const args: Args = {
    summaryDir: DEFAULT_SUMMARY_DIR,
    leftMode: "gpu-raster",
    rightMode: "rust-wgpu-vulkan",
    leftPath: null,
    rightPath: null,
    tileId: null,
    mask: "buildingsBlockedMaskBase64",
    frame: "all",
    out: path.join(
      "data",
      "processed",
      "wgpu-vulkan-probe",
      "divergence-gpu-raster-vs-rust-wgpu-vulkan-buildings.geojson",
    ),
    summaryOut: null,
    maxFeatures: "all",
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  pnpm exec tsx scripts/benchmark/export-precompute-divergence-geojson.ts -- --left-mode=gpu-raster --right-mode=rust-wgpu-vulkan",
        "",
        "Options:",
        "  --summary-dir=data/processed/wgpu-vulkan-probe/hot-tiles-value-summaries-divergence-fulltile-1frame",
        "  --left-mode=gpu-raster|rust-wgpu-vulkan|detailed",
        "  --right-mode=gpu-raster|rust-wgpu-vulkan|detailed",
        "  --left=path/to/left.values.json",
        "  --right=path/to/right.values.json",
        "  --tile-id=e2538000_n1152500_s250",
        "  --mask=buildingsBlockedMaskBase64|sunMaskBase64|all",
        "  --frame=all|0",
        "  --out=data/processed/wgpu-vulkan-probe/divergence.geojson",
        "  --summary-out=data/processed/wgpu-vulkan-probe/divergence.summary.json",
        "  --summary-out=none",
        "  --max-features=all|1000",
      ].join("\n"));
      process.exit(0);
    }

    const [key, value] = splitArg(arg);
    if (key === "--summary-dir") args.summaryDir = value;
    else if (key === "--left-mode") args.leftMode = parseMode(value);
    else if (key === "--right-mode") args.rightMode = parseMode(value);
    else if (key === "--left") args.leftPath = value;
    else if (key === "--right") args.rightPath = value;
    else if (key === "--tile-id") args.tileId = value;
    else if (key === "--mask") args.mask = parseMask(value);
    else if (key === "--frame") args.frame = parseFrame(value);
    else if (key === "--out") args.out = value;
    else if (key === "--summary-out") args.summaryOut = value === "none" ? null : value;
    else if (key === "--max-features") args.maxFeatures = parseMaxFeatures(value);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function splitArg(arg: string): [string, string] {
  const index = arg.indexOf("=");
  if (index === -1) throw new Error(`Expected --key=value, got ${arg}`);
  return [arg.slice(0, index), arg.slice(index + 1)];
}

function parseMode(value: string): ModeName {
  if (value === "gpu-raster" || value === "rust-wgpu-vulkan" || value === "detailed") {
    return value;
  }
  throw new Error(`Invalid mode: ${value}`);
}

function parseMask(value: string): MaskName | "all" {
  if (value === "all") return value;
  if ((MASK_NAMES as string[]).includes(value)) return value as MaskName;
  throw new Error(`Invalid mask: ${value}`);
}

function parseFrame(value: string): number | "all" {
  if (value === "all") return value;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw new Error(`Invalid frame: ${value}`);
}

function parseMaxFeatures(value: string): number | "all" {
  if (value === "all") return value;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new Error(`Invalid max features: ${value}`);
}

async function findSummaryPath(args: Args, mode: ModeName): Promise<string> {
  const explicitPath = mode === args.leftMode ? args.leftPath : args.rightPath;
  if (explicitPath) return explicitPath;

  const entries = await fs.readdir(path.resolve(process.cwd(), args.summaryDir), {
    withFileTypes: true,
  });
  const matches = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(`-${mode}.values.json`))
    .filter((name) => !args.tileId || name.includes(args.tileId))
    .sort();

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one value summary for mode=${mode}, found ${matches.length}: ${matches.join(", ")}`,
    );
  }

  return path.join(args.summaryDir, matches[0]);
}

async function readValueSummary(filePath: string): Promise<ValueSummary> {
  const absolutePath = path.resolve(process.cwd(), filePath);
  return JSON.parse(await fs.readFile(absolutePath, "utf8")) as ValueSummary;
}

function isMaskBitSet(mask: Buffer, index: number): boolean {
  return ((mask[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
}

function pointAt(points: ValueSummaryPoint[] | undefined, outdoorIndex: number): ValueSummaryPoint | null {
  if (!points) return null;
  return points[outdoorIndex] ?? points.find((point) => point.outdoorIndex === outdoorIndex) ?? null;
}

function assertCompatible(left: ValueSummary, right: ValueSummary): void {
  if (left.tileId !== right.tileId) {
    throw new Error(`Tile mismatch: ${left.tileId} != ${right.tileId}`);
  }
  if (left.date !== right.date) {
    throw new Error(`Date mismatch: ${left.date} != ${right.date}`);
  }
  if (left.stats.pointCount !== right.stats.pointCount) {
    throw new Error(`Point count mismatch: ${left.stats.pointCount} != ${right.stats.pointCount}`);
  }
  if (left.frames.length !== right.frames.length) {
    throw new Error(`Frame count mismatch: ${left.frames.length} != ${right.frames.length}`);
  }
  for (let index = 0; index < left.frames.length; index += 1) {
    const leftFrame = left.frames[index];
    const rightFrame = right.frames[index];
    if (
      leftFrame.index !== rightFrame.index ||
      leftFrame.localTime !== rightFrame.localTime ||
      leftFrame.utcTime !== rightFrame.utcTime
    ) {
      throw new Error(`Frame mismatch at array index ${index}`);
    }
  }
}

function selectedMasks(mask: MaskName | "all"): MaskName[] {
  return mask === "all" ? MASK_NAMES : [mask];
}

function selectedFrames(summary: ValueSummary, frame: number | "all"): ValueSummaryFrame[] {
  if (frame === "all") return summary.frames;
  const selected = summary.frames.find((candidate) => candidate.index === frame);
  if (!selected) throw new Error(`Frame ${frame} not found`);
  return [selected];
}

function makeFeature(params: {
  left: ValueSummary;
  right: ValueSummary;
  leftFrame: ValueSummaryFrame;
  rightFrame: ValueSummaryFrame;
  maskName: MaskName;
  outdoorIndex: number;
  leftBit: boolean;
  rightBit: boolean;
  point: ValueSummaryPoint;
}): GeoJsonFeature {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [params.point.lon, params.point.lat],
    },
    properties: {
      region: params.left.region,
      tileId: params.left.tileId,
      date: params.left.date,
      frameIndex: params.leftFrame.index,
      localTime: params.leftFrame.localTime,
      utcTime: params.leftFrame.utcTime,
      maskName: params.maskName,
      leftMode: params.left.mode,
      rightMode: params.right.mode,
      leftBit: params.leftBit,
      rightBit: params.rightBit,
      direction: params.leftBit ? "left-only" : "right-only",
      outdoorIndex: params.outdoorIndex,
      pointId: params.point.id,
      lat: params.point.lat,
      lon: params.point.lon,
      lv95Easting: params.point.lv95Easting,
      lv95Northing: params.point.lv95Northing,
      pointElevationMeters: params.point.pointElevationMeters,
    },
  };
}

function updateBounds(
  bounds: DivergenceSummary["lv95Bounds"],
  point: ValueSummaryPoint,
): void {
  bounds.minEasting = bounds.minEasting === null ? point.lv95Easting : Math.min(bounds.minEasting, point.lv95Easting);
  bounds.maxEasting = bounds.maxEasting === null ? point.lv95Easting : Math.max(bounds.maxEasting, point.lv95Easting);
  bounds.minNorthing =
    bounds.minNorthing === null ? point.lv95Northing : Math.min(bounds.minNorthing, point.lv95Northing);
  bounds.maxNorthing =
    bounds.maxNorthing === null ? point.lv95Northing : Math.max(bounds.maxNorthing, point.lv95Northing);
}

function collectDivergences(
  args: Args,
  left: ValueSummary,
  right: ValueSummary,
  leftPath: string,
  rightPath: string,
): { features: GeoJsonFeature[]; summary: DivergenceSummary } {
  const masks = selectedMasks(args.mask);
  const frames = selectedFrames(left, args.frame);
  const maxFeatures = args.maxFeatures === "all" ? Number.POSITIVE_INFINITY : args.maxFeatures;
  const features: GeoJsonFeature[] = [];
  const maskSummaries = masks.map((maskName) => ({
    maskName,
    diffBits: 0,
    leftOnlyBits: 0,
    rightOnlyBits: 0,
  }));
  const maskSummaryByName = new Map(maskSummaries.map((summary) => [summary.maskName, summary]));
  const lv95Bounds: DivergenceSummary["lv95Bounds"] = {
    minEasting: null,
    minNorthing: null,
    maxEasting: null,
    maxNorthing: null,
  };
  let truncated = false;

  for (const leftFrame of frames) {
    const rightFrame = right.frames.find((candidate) => candidate.index === leftFrame.index);
    if (!rightFrame) throw new Error(`Frame ${leftFrame.index} not found on right summary`);

    for (const maskName of masks) {
      const leftMask = Buffer.from(leftFrame[maskName], "base64");
      const rightMask = Buffer.from(rightFrame[maskName], "base64");
      const maskSummary = maskSummaryByName.get(maskName);
      if (!maskSummary) throw new Error(`Internal mask summary mismatch: ${maskName}`);

      for (let outdoorIndex = 0; outdoorIndex < left.stats.pointCount; outdoorIndex += 1) {
        const leftBit = isMaskBitSet(leftMask, outdoorIndex);
        const rightBit = isMaskBitSet(rightMask, outdoorIndex);
        if (leftBit === rightBit) continue;

        maskSummary.diffBits += 1;
        if (leftBit) maskSummary.leftOnlyBits += 1;
        else maskSummary.rightOnlyBits += 1;

        const point = pointAt(left.points, outdoorIndex);
        if (!point) continue;
        updateBounds(lv95Bounds, point);

        if (features.length < maxFeatures) {
          features.push(makeFeature({
            left,
            right,
            leftFrame,
            rightFrame,
            maskName,
            outdoorIndex,
            leftBit,
            rightBit,
            point,
          }));
        } else {
          truncated = true;
        }
      }
    }
  }

  return {
    features,
    summary: {
      generatedAt: new Date().toISOString(),
      leftMode: left.mode,
      rightMode: right.mode,
      leftPath,
      rightPath,
      region: left.region,
      tileId: left.tileId,
      date: left.date,
      timezone: left.timezone ?? null,
      pointCount: left.stats.pointCount,
      frameCount: frames.length,
      masks: maskSummaries,
      featureCount: features.length,
      truncated,
      lv95Bounds,
    },
  };
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(process.cwd(), filePath)), { recursive: true });
  await fs.writeFile(path.resolve(process.cwd(), filePath), `${JSON.stringify(value, null, 2)}\n`);
}

function defaultSummaryOut(outPath: string): string {
  const parsed = path.parse(outPath);
  return path.join(parsed.dir, `${parsed.name}.summary.json`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [leftPath, rightPath] = await Promise.all([
    findSummaryPath(args, args.leftMode),
    findSummaryPath(args, args.rightMode),
  ]);
  const [left, right] = await Promise.all([
    readValueSummary(leftPath),
    readValueSummary(rightPath),
  ]);

  assertCompatible(left, right);
  const { features, summary } = collectDivergences(args, left, right, leftPath, rightPath);
  const featureCollection = {
    type: "FeatureCollection",
    name: `${left.tileId}_${left.mode}_vs_${right.mode}`,
    features,
  };

  await writeJsonFile(args.out, featureCollection);
  await writeJsonFile(args.summaryOut ?? defaultSummaryOut(args.out), summary);
  console.log([
    `[divergence-geojson] ${left.mode} vs ${right.mode}`,
    `tile=${left.tileId}`,
    `date=${left.date}`,
    `masks=${summary.masks.map((mask) => `${mask.maskName}:${mask.diffBits}`).join(",")}`,
    `features=${features.length}`,
    `out=${args.out}`,
  ].join(" "));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
