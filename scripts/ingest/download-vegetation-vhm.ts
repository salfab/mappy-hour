/**
 * Ingest VHM (Vegetationshöhenmodell NFI) for a region.
 *
 * Orchestrates two Python scripts — the heavy lifting stays in Python for
 * access to the LERC codec that our GDAL/Node stack does not support:
 *   1. `download-vhm.py` → fetches raw vegetation heights from the EnviDat
 *      COG, writes `swisssurface3d-raster_vhm_raw_<e>-<n>/...tif`
 *   2. `compose-vhm-canopy.py` → reads the raw tiles + local SwissALTI3D
 *      terrain, writes pre-composed `swisssurface3d-raster_vhm_<e>-<n>/...tif`
 *
 * Both kinds land in `data/raw/swisstopo/swisssurface3d_raster/` and are
 * picked up by `vegetation-shadow.ts`:
 *   - default: the composed `vhm_*` wins (Option A, ADR-0016)
 *   - MAPPY_VHM_SHADER_COMPOSE=1: the raw `vhm_raw_*` wins; the shader
 *     composes `canopy_abs = terrain + max(0, vhm)` at sample time
 *     (Option B, ADR-0016 update 2026-04-23)
 *
 * Usage: npx tsx scripts/ingest/download-vegetation-vhm.ts --region=nyon
 *        npx tsx scripts/ingest/download-vegetation-vhm.ts --region=all
 *        npx tsx scripts/ingest/download-vegetation-vhm.ts --region=nyon --overwrite
 *        npx tsx scripts/ingest/download-vegetation-vhm.ts --region=nyon --skip-compose
 *
 * Requires: Python 3 + rasterio (pip install rasterio). Override the Python
 * path with MAPPY_VHM_PYTHON if needed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PrecomputedRegionName } from "../../src/lib/regions/regions";

const DEFAULT_PYTHON =
  "C:\\Users\\fabio.salvalai\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";

const REGIONS = ["lausanne", "morges", "nyon", "geneve", "vevey", "vevey_city", "neuchatel", "la_chaux_de_fonds", "bern", "zurich", "thun"] as const satisfies readonly PrecomputedRegionName[];
type Region = typeof REGIONS[number];

export interface RunForRegionArgs {
  overwrite?: boolean;
  skipCompose?: boolean;
  dryRun?: boolean;
}

export interface RunForRegionResult {
  region: Region;
  status: "ok" | "skipped-dry-run";
}

function terrainAvailableForRegion(region: Region): boolean {
  const manifest = path.join(
    process.cwd(),
    "data",
    "raw",
    "swisstopo",
    "swissalti3d_2m",
    `manifest-${region}.json`,
  );
  return fs.existsSync(manifest);
}

function runPython(python: string, scriptName: string, region: string, overwrite: boolean): boolean {
  const script = path.join(process.cwd(), "scripts", "ingest", scriptName);
  const args = [script, `--region=${region}`];
  if (overwrite) args.push("--overwrite");
  console.log(
    `[vhm:${region}] python ${scriptName} --region=${region}${overwrite ? " --overwrite" : ""}`,
  );
  const result = spawnSync(python, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[vhm:${region}] ${scriptName} failed with code ${result.status}`);
    return false;
  }
  return true;
}

export async function runForRegion(
  region: PrecomputedRegionName,
  args: RunForRegionArgs = {},
): Promise<RunForRegionResult> {
  if (!REGIONS.includes(region as Region)) {
    throw new Error(`Unknown region: ${region}. Expected one of: ${REGIONS.join(", ")}.`);
  }
  const { overwrite = false, skipCompose = false, dryRun = false } = args;

  if (dryRun) {
    console.log(`[vhm:${region}] dry-run: would download VHM${skipCompose ? "" : " + compose canopy"}`);
    return { region: region as Region, status: "skipped-dry-run" };
  }

  // VHM compose needs terrain (canopy_abs = terrain + max(0, vhm)).
  // We only need terrain when compose is on; raw-only ingest does not need it.
  if (!skipCompose && !terrainAvailableForRegion(region as Region)) {
    throw new Error(
      `[vhm:${region}] VHM compose needs terrain manifest at data/raw/swisstopo/swissalti3d_2m/manifest-${region}.json — run --source=terrain,vhm or download terrain first.`,
    );
  }

  const python = process.env.MAPPY_VHM_PYTHON ?? DEFAULT_PYTHON;

  if (!runPython(python, "download-vhm.py", region, overwrite)) {
    throw new Error(`[vhm:${region}] download-vhm.py failed`);
  }
  if (!skipCompose) {
    if (!runPython(python, "compose-vhm-canopy.py", region, overwrite)) {
      throw new Error(`[vhm:${region}] compose-vhm-canopy.py failed`);
    }
  }
  return { region: region as Region, status: "ok" };
}

function parseArgs(argv: string[]): {
  regions: Region[];
  overwrite: boolean;
  skipCompose: boolean;
  dryRun: boolean;
} {
  const regionArg = argv.find((a) => a.startsWith("--region="))?.slice(9) ?? "";
  const overwrite = argv.includes("--overwrite");
  const skipCompose = argv.includes("--skip-compose");
  const dryRun = argv.includes("--dry-run");
  if (!regionArg) {
    console.error(
      `Usage: --region=${REGIONS.join("|")}|all [--overwrite] [--skip-compose] [--dry-run]`,
    );
    process.exit(1);
  }
  const regions: Region[] = regionArg === "all"
    ? [...REGIONS]
    : [regionArg as Region];
  for (const r of regions) {
    if (!REGIONS.includes(r)) {
      console.error(`Unknown region: ${r}. Expected one of: ${REGIONS.join(", ")} or 'all'.`);
      process.exit(1);
    }
  }
  return { regions, overwrite, skipCompose, dryRun };
}

async function main(): Promise<void> {
  const { regions, overwrite, skipCompose, dryRun } = parseArgs(process.argv.slice(2));
  for (const region of regions) {
    await runForRegion(region, { overwrite, skipCompose, dryRun });
  }
}

const isDirectInvocation =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectInvocation) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
