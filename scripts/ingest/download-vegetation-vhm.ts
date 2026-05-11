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
 * The compose pass is only needed for the CPU ray-march (which reads the
 * raster as absolute altitude) and for the default GPU path. Pass
 * `--skip-compose` to ingest raw only.
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
import path from "node:path";

const DEFAULT_PYTHON =
  "C:\\Users\\fabio.salvalai\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";

const REGIONS = ["lausanne", "morges", "nyon", "geneve", "vevey", "vevey_city"] as const;
type Region = typeof REGIONS[number];

function parseArgs(argv: string[]): {
  regions: Region[];
  overwrite: boolean;
  skipCompose: boolean;
} {
  const regionArg = argv.find((a) => a.startsWith("--region="))?.slice(9) ?? "";
  const overwrite = argv.includes("--overwrite");
  const skipCompose = argv.includes("--skip-compose");
  if (!regionArg) {
    console.error(
      `Usage: --region=${REGIONS.join("|")}|all [--overwrite] [--skip-compose]`,
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
  return { regions, overwrite, skipCompose };
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

function main(): void {
  const { regions, overwrite, skipCompose } = parseArgs(process.argv.slice(2));
  const python = process.env.MAPPY_VHM_PYTHON ?? DEFAULT_PYTHON;

  for (const region of regions) {
    if (!runPython(python, "download-vhm.py", region, overwrite)) {
      process.exitCode = 1;
      return;
    }
    if (!skipCompose) {
      if (!runPython(python, "compose-vhm-canopy.py", region, overwrite)) {
        process.exitCode = 1;
        return;
      }
    }
  }
}

main();
