/**
 * Ingest orchestrator — one region, all sources, in-process.
 *
 * Usage:
 *   npx tsx scripts/ingest/run.ts --region=morges
 *   npx tsx scripts/ingest/run.ts --region=lausanne --source=terrain,vhm
 *   npx tsx scripts/ingest/run.ts --region=geneve --dry-run
 *   npx tsx scripts/ingest/run.ts --region=nyon --continue-on-error
 *
 * Sources are executed in a fixed order so dependencies hold (VHM compose
 * needs terrain on disk). Each source is idempotent by default (skip if file
 * present); pass `--overwrite` to force re-download.
 *
 * Flags:
 *   --region=<name>          (required) one of the 11 precomputed regions
 *   --source=<csv>           subset of sources to run (default: all)
 *   --overwrite              force re-download of existing files
 *   --dry-run                resolve plan, log intent, write nothing
 *   --continue-on-error      keep going after a source fails (default: fail fast)
 *   --max-items=N            cap STAC items (smoke-test)
 *
 * Architectural note: this is the orchestrator. The actual per-source logic
 * lives in each `download-<source>.ts` file as an exported `runForRegion()`.
 * Those files also expose a standalone CLI so they keep working on their own.
 */
import { pathToFileURL } from "node:url";

import type { PrecomputedRegionName } from "../../src/lib/regions/regions";
import { PRECOMPUTED_REGION_NAMES } from "../../src/lib/regions/regions";

import * as buildings from "./download-buildings";
import * as terrain from "./download-terrain";
import * as vegetation from "./download-vegetation";
import * as vhm from "./download-vegetation-vhm";
import * as horizonDem from "./download-horizon-dem";
import * as places from "./download-places-osm";

type Source =
  | "terrain"
  | "buildings"
  | "vegetation"
  | "vhm"
  | "horizon-dem"
  | "places";

// Fixed order: VHM compose reads the terrain raster from disk, so terrain
// MUST run first. Everything else is independent — order is purely for
// predictable logs.
const SOURCES_IN_ORDER: readonly Source[] = [
  "terrain",
  "buildings",
  "vegetation",
  "vhm",
  "horizon-dem",
  "places",
] as const;

interface OrchestratorArgs {
  region: PrecomputedRegionName;
  sources: Source[];
  overwrite: boolean;
  dryRun: boolean;
  continueOnError: boolean;
  maxItems?: number;
}

interface SourceOutcome {
  source: Source;
  status: "ok" | "failed" | "skipped";
  errorMessage?: string;
  durationMs: number;
}

function parseArgs(argv: string[]): OrchestratorArgs {
  let region: string | undefined;
  let sources: Source[] = [...SOURCES_IN_ORDER];
  let overwrite = false;
  let dryRun = false;
  let continueOnError = false;
  let maxItems: number | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--region=")) {
      region = arg.slice("--region=".length);
    } else if (arg.startsWith("--source=")) {
      const requested = arg
        .slice("--source=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as Source[];
      for (const s of requested) {
        if (!SOURCES_IN_ORDER.includes(s)) {
          throw new Error(
            `Unknown source "${s}". Known: ${SOURCES_IN_ORDER.join(", ")}`,
          );
        }
      }
      // Preserve canonical order.
      sources = SOURCES_IN_ORDER.filter((s) => requested.includes(s));
    } else if (arg === "--overwrite") {
      overwrite = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--continue-on-error") {
      continueOnError = true;
    } else if (arg.startsWith("--max-items=")) {
      const parsed = Number(arg.slice("--max-items=".length));
      if (Number.isFinite(parsed) && parsed > 0) maxItems = Math.floor(parsed);
    }
  }

  if (!region) {
    throw new Error(
      `Missing --region=<name>. Known: ${PRECOMPUTED_REGION_NAMES.join(", ")}`,
    );
  }
  if (!PRECOMPUTED_REGION_NAMES.includes(region as PrecomputedRegionName)) {
    throw new Error(
      `Unknown region "${region}". Known: ${PRECOMPUTED_REGION_NAMES.join(", ")}`,
    );
  }
  if (sources.length === 0) {
    throw new Error(
      `Empty source set after filtering. Known: ${SOURCES_IN_ORDER.join(", ")}`,
    );
  }

  return {
    region: region as PrecomputedRegionName,
    sources,
    overwrite,
    dryRun,
    continueOnError,
    maxItems,
  };
}

async function runSource(
  source: Source,
  region: PrecomputedRegionName,
  args: { overwrite: boolean; dryRun: boolean; maxItems?: number },
): Promise<void> {
  switch (source) {
    case "buildings":
      await buildings.runForRegion(region, args);
      return;
    case "terrain":
      await terrain.runForRegion(region, args);
      return;
    case "vegetation":
      await vegetation.runForRegion(region, args);
      return;
    case "vhm":
      await vhm.runForRegion(region, {
        overwrite: args.overwrite,
        dryRun: args.dryRun,
      });
      return;
    case "horizon-dem":
      await horizonDem.runForRegion(region, args);
      return;
    case "places":
      await places.runForRegion(region, { dryRun: args.dryRun });
      return;
  }
}

async function orchestrate(args: OrchestratorArgs): Promise<{
  outcomes: SourceOutcome[];
  failedCount: number;
}> {
  console.log(
    `[ingest:run] starting region=${args.region} sources=${args.sources.join(",")}${args.dryRun ? " (dry-run)" : ""}${args.overwrite ? " (overwrite)" : ""}`,
  );

  // Fail-fast precondition: vhm without terrain when terrain not on disk.
  // (Cheap check that surfaces a clear error before downloads start.)
  if (
    args.sources.includes("vhm") &&
    !args.sources.includes("terrain") &&
    !args.dryRun
  ) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const terrainManifest = path.join(
      process.cwd(),
      "data",
      "raw",
      "swisstopo",
      "swissalti3d_2m",
      `manifest-${args.region}.json`,
    );
    if (!fs.existsSync(terrainManifest)) {
      throw new Error(
        `[ingest:run] --source=vhm requires terrain on disk; manifest not found at ${terrainManifest}. ` +
          `Run with --source=terrain,vhm or omit --source.`,
      );
    }
  }

  const outcomes: SourceOutcome[] = [];
  let failedCount = 0;

  for (const source of args.sources) {
    const started = Date.now();
    try {
      await runSource(source, args.region, {
        overwrite: args.overwrite,
        dryRun: args.dryRun,
        maxItems: args.maxItems,
      });
      const durationMs = Date.now() - started;
      console.log(`[ingest:${source}] ok (${durationMs} ms)`);
      outcomes.push({ source, status: "ok", durationMs });
    } catch (error) {
      const durationMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      failedCount += 1;
      console.error(`[ingest:${source}] failed (${durationMs} ms): ${message}`);
      outcomes.push({
        source,
        status: "failed",
        errorMessage: message,
        durationMs,
      });
      if (!args.continueOnError) {
        throw error;
      }
    }
  }

  return { outcomes, failedCount };
}

function printSummary(args: OrchestratorArgs, outcomes: SourceOutcome[]): void {
  console.log(`[ingest:run] summary region=${args.region}`);
  for (const o of outcomes) {
    const tag = o.status === "ok" ? "OK" : o.status === "failed" ? "FAIL" : "SKIP";
    const err = o.errorMessage ? ` — ${o.errorMessage}` : "";
    console.log(`  - ${o.source.padEnd(12)} ${tag.padEnd(4)} ${o.durationMs} ms${err}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { outcomes, failedCount } = await orchestrate(args);
  printSummary(args, outcomes);
  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

const isDirectInvocation =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectInvocation) {
  main().catch((error) => {
    console.error(
      `[ingest:run] Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exitCode = 1;
  });
}
