import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { POST as areaPost } from "../../src/app/api/sunlight/area/route";

interface ParsedArgs {
  bbox: [number, number, number, number];
  date: string;
  timezone: string;
  mode: "instant" | "daily";
  localTime: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  maxPoints: number;
  ignoreVegetation: boolean;
  outputName: string;
}

const DEFAULT_ARGS: ParsedArgs = {
  bbox: [6.599447, 46.522107, 6.601426, 46.523137],
  date: "2026-03-08",
  timezone: "Europe/Zurich",
  mode: "instant",
  localTime: "17:00",
  sampleEveryMinutes: 15,
  gridStepMeters: 5,
  maxPoints: 3000,
  ignoreVegetation: false,
  outputName: "cache-hit-vs-warm",
};

const OUTPUT_DIR = path.join(process.cwd(), "docs", "progress", "benchmarks");

function parseBbox(raw: string): [number, number, number, number] {
  const parts = raw.split(",").map((value) => Number(value.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid bbox: ${raw}`);
  }
  return parts as [number, number, number, number];
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { ...DEFAULT_ARGS };

  for (const arg of argv) {
    if (arg.startsWith("--bbox=")) {
      result.bbox = parseBbox(arg.slice("--bbox=".length));
      continue;
    }
    if (arg.startsWith("--date=")) {
      result.date = arg.slice("--date=".length);
      continue;
    }
    if (arg.startsWith("--timezone=")) {
      result.timezone = arg.slice("--timezone=".length);
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const mode = arg.slice("--mode=".length);
      if (mode === "instant" || mode === "daily") {
        result.mode = mode;
      }
      continue;
    }
    if (arg.startsWith("--local-time=")) {
      result.localTime = arg.slice("--local-time=".length);
      continue;
    }
    if (arg.startsWith("--sample-every-minutes=")) {
      result.sampleEveryMinutes = Number(arg.slice("--sample-every-minutes=".length));
      continue;
    }
    if (arg.startsWith("--grid-step-meters=")) {
      result.gridStepMeters = Number(arg.slice("--grid-step-meters=".length));
      continue;
    }
    if (arg.startsWith("--max-points=")) {
      result.maxPoints = Number(arg.slice("--max-points=".length));
      continue;
    }
    if (arg === "--ignore-vegetation") {
      result.ignoreVegetation = true;
      continue;
    }
    if (arg.startsWith("--output-name=")) {
      result.outputName = arg.slice("--output-name=".length);
    }
  }

  return result;
}

async function callArea(args: ParsedArgs) {
  const request = new Request("http://localhost/api/sunlight/area", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      bbox: args.bbox,
      date: args.date,
      timezone: args.timezone,
      mode: args.mode,
      localTime: args.localTime,
      sampleEveryMinutes: args.sampleEveryMinutes,
      gridStepMeters: args.gridStepMeters,
      maxPoints: args.maxPoints,
      ignoreVegetation: args.ignoreVegetation,
    }),
  });

  const started = performance.now();
  const response = await areaPost(request);
  const wallMs = performance.now() - started;
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `Request failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  }

  return {
    wallMs: Math.round(wallMs * 1000) / 1000,
    payload,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const cold = await callArea(args);
  const warm = await callArea(args);

  const result = {
    generatedAt: new Date().toISOString(),
    benchmarkVersion: "v1",
    args,
    cold: {
      wallMs: cold.wallMs,
      cache: cold.payload.cache ?? null,
      pointCount: cold.payload.pointCount ?? null,
      gridPointCount: cold.payload.gridPointCount ?? null,
      elapsedMs: cold.payload.stats?.elapsedMs ?? null,
    },
    warm: {
      wallMs: warm.wallMs,
      cache: warm.payload.cache ?? null,
      pointCount: warm.payload.pointCount ?? null,
      gridPointCount: warm.payload.gridPointCount ?? null,
      elapsedMs: warm.payload.stats?.elapsedMs ?? null,
    },
    ratios: {
      warmVsColdWallTime:
        cold.wallMs > 0 ? Math.round(((warm.wallMs / cold.wallMs) * 1000)) / 1000 : null,
      warmVsColdApiElapsed:
        cold.payload.stats?.elapsedMs > 0
          ? Math.round(((warm.payload.stats.elapsedMs / cold.payload.stats.elapsedMs) * 1000)) /
            1000
          : null,
    },
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(
    OUTPUT_DIR,
    `${args.outputName}-${args.date}-${args.mode}-g${args.gridStepMeters}.json`,
  );
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log(`[benchmark] Output written: ${outputPath}`);
  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error) => {
  console.error(
    `[benchmark] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
