/**
 * Lance precompute-region-sunlight pour chaque région présente dans un fichier
 * de sélection de tuiles, sans avoir à spécifier --region manuellement.
 *
 * Usage :
 *   pnpm precompute:all-regions -- \
 *     --tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json \
 *     --start-date=2026-04-11 --days=7
 *
 * Tous les autres arguments sont transmis tels quels à precompute-region-sunlight.ts.
 * L'argument --region= est ignoré s'il est fourni (les régions viennent du fichier).
 */

import { spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";

// Load .env.local into process.env (only vars not already set).
// tsx does not auto-load .env files, so this lets MAPPY_DATA_ROOT etc.
// be picked up without requiring the caller to export them manually.
try {
  const envLocal = fs.readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of envLocal.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_]\w*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1");
    }
  }
} catch {}

// Honour MAPPY_DATA_ROOT so that "data/..." paths resolve to the right place
// even when data/ is not a subdirectory of the project root.
const _envDataRoot = process.env.MAPPY_DATA_ROOT?.trim();
const DATA_ROOT =
  _envDataRoot && _envDataRoot.length > 0
    ? path.isAbsolute(_envDataRoot)
      ? _envDataRoot
      : path.resolve(process.cwd(), _envDataRoot)
    : path.join(process.cwd(), "data");

const CACHE_ROOT = path.join(DATA_ROOT, "cache");
const GRID_METADATA_DIR = path.join(CACHE_ROOT, "tile-grid-metadata");
const _envCacheSunlightDir = process.env.MAPPY_CACHE_SUNLIGHT_DIR?.trim();
const ATLAS_DIR =
  _envCacheSunlightDir && _envCacheSunlightDir.length > 0
    ? path.isAbsolute(_envCacheSunlightDir)
      ? _envCacheSunlightDir
      : path.resolve(process.cwd(), _envCacheSunlightDir)
    : path.join(CACHE_ROOT, "sunlight");


function resolveSelectionPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  if (filePath.startsWith("data/") || filePath.startsWith("data\\")) {
    return path.join(DATA_ROOT, filePath.slice("data/".length));
  }
  return path.resolve(process.cwd(), filePath);
}

const REGION_SCRIPT = path.resolve(
  process.cwd(),
  "scripts/precompute/precompute-region-sunlight.ts",
);

const GRID_METADATA_SCRIPT = path.resolve(
  process.cwd(),
  "scripts/precompute/precompute-tile-grid-metadata.ts",
);

const REGION_PRIORITY: string[] = ["lausanne", "morges", "nyon", "vevey", "vevey_city", "neuchatel", "la_chaux_de_fonds", "bern", "zurich", "thun", "geneve"];
type ExperimentalBuildingsShadowMode = "gpu-raster" | "rust-wgpu-vulkan";

function readRegionsFromSelectionFile(filePath: string): string[] {
  const raw = fs.readFileSync(resolveSelectionPath(filePath), "utf8");
  const data = JSON.parse(raw) as { tiles: Array<{ region: string }> };
  const found = Array.from(new Set(data.tiles.map((t) => t.region)));
  return [
    ...REGION_PRIORITY.filter((r) => found.includes(r)),
    ...found.filter((r) => !REGION_PRIORITY.includes(r)).sort(),
  ];
}

function countTilesPerRegion(filePath: string): Record<string, number> {
  const raw = fs.readFileSync(resolveSelectionPath(filePath), "utf8");
  const data = JSON.parse(raw) as { tiles: Array<{ region: string }> };
  const counts: Record<string, number> = {};
  for (const t of data.tiles) counts[t.region] = (counts[t.region] ?? 0) + 1;
  return counts;
}

function countTilesPerPassPerRegion(filePath: string): {
  topPriority: Record<string, number>;
  other: Record<string, number>;
} {
  const raw = fs.readFileSync(resolveSelectionPath(filePath), "utf8");
  const data = JSON.parse(raw) as { tiles: Array<{ region: string; group?: string }> };
  const topPriority: Record<string, number> = {};
  const other: Record<string, number> = {};
  for (const t of data.tiles) {
    const bucket = t.group === "top-priority" ? topPriority : other;
    bucket[t.region] = (bucket[t.region] ?? 0) + 1;
  }
  return { topPriority, other };
}

function parseArgValue(argv: string[], prefix: string): string | null {
  for (const arg of argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

interface RegionHashes {
  atlasHash: string;
  gridHash: string;
  atlasExists: boolean;
  gridExists: boolean;
}

function printRunRecap(params: {
  selectionFile: string;
  regions: string[];
  tileCounts: Record<string, number>;
  passBreakdown: { topPriority: Record<string, number>; other: Record<string, number> };
  buildingsShadowMode: string;
  gridStepMeters: number;
  passthrough: string[];
  regionHashes: Record<string, RegionHashes | null>;
}): void {
  const startDate = parseArgValue(params.passthrough, "--start-date=") ?? "(today)";
  const days = parseArgValue(params.passthrough, "--days=") ?? "1";
  const startLocalTime = parseArgValue(params.passthrough, "--start-local-time=") ?? "(dawn)";
  const endLocalTime = parseArgValue(params.passthrough, "--end-local-time=") ?? "(dusk)";
  const sampleEvery = parseArgValue(params.passthrough, "--sample-every-minutes=") ?? "15";
  const skipExisting = parseArgValue(params.passthrough, "--skip-existing=") ?? "true";
  const totalTiles = Object.values(params.tileCounts).reduce((a, b) => a + b, 0);
  const topTotal = Object.values(params.passBreakdown.topPriority).reduce((a, b) => a + b, 0);
  const otherTotal = Object.values(params.passBreakdown.other).reduce((a, b) => a + b, 0);

  const box = [
    "",
    "╔═══════════════════════════════════════════════════════════════════════╗",
    "║                    PRECOMPUTE RUN RECAP                               ║",
    "╚═══════════════════════════════════════════════════════════════════════╝",
  ];
  let gitHash = "(unknown)";
  try { gitHash = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch {}
  const nodeOpts = process.env.NODE_OPTIONS ?? "(not set)";
  const startedAt = new Date().toISOString().replace("T", " ").slice(0, 19);

  console.log(box.join("\n"));
  console.log(`  Started          : ${startedAt}`);
  console.log(`  Commit           : ${gitHash}`);
  console.log(`  NODE_OPTIONS     : ${nodeOpts}`);
  console.log(`  Tile selection   : ${params.selectionFile}`);
  console.log(`  Grid metadata    : ${GRID_METADATA_DIR}`);
  console.log(`  Atlas cache      : ${ATLAS_DIR}`);
  console.log(`  Total tiles      : ${totalTiles}`);
  console.log("");
  console.log("  Hashes par région :");
  for (const region of params.regions) {
    const h = params.regionHashes[region];
    const atlasStr = h ? `${h.atlasExists ? "✅" : "🆕"} ${h.atlasHash}` : "(non calculable)";
    const gridStr  = h ? `${h.gridExists  ? "✅" : "🆕"} ${h.gridHash}`  : "(non calculable)";
    console.log(`    • ${region.padEnd(18)} atlas=${atlasStr}  grid=${gridStr}`);
  }
  console.log(`  Regions (${params.regions.length})      : ${params.regions.join(" → ")}`);
  console.log("");
  console.log(`  Passe 1/2 — Top priority (${topTotal} tuiles) :`);
  for (const region of params.regions) {
    const count = params.passBreakdown.topPriority[region] ?? 0;
    if (count === 0) continue;
    const bar = "█".repeat(Math.max(1, Math.round((count / Math.max(topTotal, 1)) * 30)));
    console.log(`    • ${region.padEnd(10)} ${count.toString().padStart(5)} tiles  ${bar}`);
  }
  console.log(`  Passe 2/2 — Couverture étendue (${otherTotal} tuiles) :`);
  for (const region of params.regions) {
    const count = params.passBreakdown.other[region] ?? 0;
    if (count === 0) continue;
    const bar = "█".repeat(Math.max(1, Math.round((count / Math.max(otherTotal, 1)) * 30)));
    console.log(`    • ${region.padEnd(10)} ${count.toString().padStart(5)} tiles  ${bar}`);
  }
  console.log("");
  console.log(`  Date range       : ${startDate} (+ ${days} day${days === "1" ? "" : "s"})`);
  console.log(`  Local time win.  : ${startLocalTime} → ${endLocalTime}, every ${sampleEvery} min`);
  console.log(`  Buildings mode   : ${params.buildingsShadowMode}`);
  console.log(`  Grid step        : ${params.gridStepMeters} m`);
  console.log(`  Skip existing    : ${skipExisting}`);
  console.log("───────────────────────────────────────────────────────────────────────\n");
}

function parseSelectionFileArg(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith("--tile-selection-file=")) {
      return arg.slice("--tile-selection-file=".length);
    }
  }
  return null;
}

function parseBuildingsShadowMode(value: string): ExperimentalBuildingsShadowMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "gpu-raster" || normalized === "rust-wgpu-vulkan") {
    return normalized;
  }
  throw new Error(
    `Invalid --buildings-shadow-mode=${value}. Expected gpu-raster or rust-wgpu-vulkan.`,
  );
}

function parseBuildingsShadowModeArg(argv: string[]): ExperimentalBuildingsShadowMode | null {
  for (const arg of argv) {
    if (arg.startsWith("--buildings-shadow-mode=")) {
      return parseBuildingsShadowMode(arg.slice("--buildings-shadow-mode=".length));
    }
  }
  return null;
}

function parseGridStepMetersArg(argv: string[]): number {
  for (const arg of argv) {
    if (arg.startsWith("--grid-step-meters=")) {
      const parsed = Number(arg.slice("--grid-step-meters=".length));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return 1;
}

function parseSkipPreflightArg(argv: string[]): boolean {
  // Accept both `--skip-preflight` and `--skip-preflight=true|false`.
  for (const arg of argv) {
    if (arg === "--skip-preflight") return true;
    if (arg.startsWith("--skip-preflight=")) {
      const v = arg.slice("--skip-preflight=".length).trim().toLowerCase();
      return v === "true" || v === "1" || v === "yes";
    }
  }
  return false;
}

/**
 * Preflight : garantit que la grid metadata est présente pour TOUTES les tuiles
 * de TOUTES les régions du fichier de sélection, AVANT de commencer quelque
 * précalcul que ce soit. Le script cible est idempotent : il saute les tuiles
 * déjà cachées et ne régénère que les manquantes.
 *
 * Retourne l'ensemble des régions skippées (buildings index manquant ou autre
 * erreur preflight). Ces régions seront exclues du precompute mais n'abortent
 * pas les autres.
 */
function ensureGridMetadataForAllRegions(
  regions: string[],
  selectionFile: string,
  gridStepMeters: number,
  buildingsShadowMode: ExperimentalBuildingsShadowMode,
  allowZeroIndoor: boolean,
): Set<string> {
  console.log(
    `\n[precompute-all] ▶ preflight grid-metadata : ${regions.length} région(s), grid=${gridStepMeters}m, fichier=${selectionFile}`,
  );
  const preflightStart = Date.now();
  const skipped = new Set<string>();

  for (const region of regions) {
    const args = [
      GRID_METADATA_SCRIPT,
      `--region=${region}`,
      `--tile-selection-file=${selectionFile}`,
      `--grid-step-meters=${gridStepMeters}`,
      ...(allowZeroIndoor ? ["--allow-zero-indoor"] : []),
    ];
    console.log(`[precompute-all]   · grid-metadata région=${region}`);
    // The preflight renders a zenith shadow map to classify indoor/outdoor;
    // it evaluates one point at a time through BuildingShadowBackend.evaluate,
    // which only gpu-raster implements. The Vulkan backend is batch-only and
    // has no single-point path, so we force gpu-raster here regardless of the
    // main compute mode — the metadata produced is backend-agnostic.
    const result = spawnSync("npx", ["tsx", ...args], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, MAPPY_BUILDINGS_SHADOW_MODE: "gpu-raster" },
    });
    if (result.error) {
      console.error(
        `\x1b[31m\x1b[1m[precompute-all] ✗ grid-metadata spawn error pour région=${region}: ${result.error.message}\x1b[0m`,
      );
      console.warn(
        `\x1b[33m[precompute-all] ⚠ région=${region} skippée (erreur preflight grid-metadata)\x1b[0m`,
      );
      skipped.add(region);
      continue;
    }
    if (result.status !== 0 || result.signal) {
      const detail = result.signal ? `signal=${result.signal}` : `exit=${result.status}`;
      console.error(
        `\x1b[31m\x1b[1m[precompute-all] ✗ grid-metadata preflight échoué pour région=${region} (${detail})\x1b[0m`,
      );
      console.warn(
        `\x1b[33m[precompute-all] ⚠ région=${region} skippée — vérifiez que les buildings sont ingérés :\x1b[0m`,
      );
      console.warn(
        `\x1b[33m[precompute-all]   npx tsx scripts/preprocess/build-buildings-index.ts --region=${region}\x1b[0m`,
      );
      skipped.add(region);
      continue;
    }
  }

  const elapsed = ((Date.now() - preflightStart) / 1000).toFixed(1);
  if (skipped.size > 0) {
    console.warn(
      `\x1b[33m[precompute-all] ⚠ preflight grid-metadata terminé en ${elapsed}s — ${skipped.size} région(s) skippée(s) : ${[...skipped].join(", ")}\x1b[0m\n`,
    );
  } else {
    console.log(`[precompute-all] ✓ preflight grid-metadata terminé en ${elapsed}s\n`);
  }
  return skipped;
}

async function main() {
  // pnpm passes a literal "--" separator when using `pnpm script -- args`, strip it.
  // Also strip --region= (we iterate regions ourselves) and --skip-preflight
  // (this orchestrator consumes it; child precompute scripts don't know it).
  const rawArgs = process.argv.slice(2).filter((a) => a !== "--");
  const skipPreflight = parseSkipPreflightArg(rawArgs);
  const allowZeroIndoor = rawArgs.includes("--allow-zero-indoor");
  const passthrough = rawArgs.filter(
    (a) =>
      !a.startsWith("--region=") &&
      a !== "--skip-preflight" &&
      !a.startsWith("--skip-preflight=") &&
      a !== "--allow-zero-indoor",
  );

  const selectionFile = parseSelectionFileArg(passthrough);
  if (!selectionFile) {
    console.error(
      "[precompute-all] --tile-selection-file= est requis pour détecter les régions.",
    );
    process.exitCode = 1;
    return;
  }

  const regions = readRegionsFromSelectionFile(selectionFile);
  const tileCounts = countTilesPerRegion(selectionFile);
  const passBreakdown = countTilesPerPassPerRegion(selectionFile);
  const cliBuildingsShadowMode = parseBuildingsShadowModeArg(passthrough);
  const buildingsShadowMode =
    cliBuildingsShadowMode ??
    (process.env.MAPPY_BUILDINGS_SHADOW_MODE
      ? parseBuildingsShadowMode(process.env.MAPPY_BUILDINGS_SHADOW_MODE)
      : "gpu-raster");

  const gridStepMeters = parseGridStepMetersArg(passthrough);

  // Import dynamique : data-paths.ts doit être chargé APRÈS le bloc .env.local
  // ci-dessus (les imports statiques s'exécutent avant ce bloc et manqueraient MAPPY_DATA_ROOT).
  const { getSunlightModelVersion } = await import("../../src/lib/precompute/model-version");

  const regionHashes: Record<string, RegionHashes | null> = {};
  await Promise.all(
    regions.map(async (region) => {
      try {
        const v = await getSunlightModelVersion(region as Parameters<typeof getSunlightModelVersion>[0], { buildingHeightBiasMeters: 0 });
        regionHashes[region] = {
          atlasHash: v.modelVersionHash,
          gridHash: v.gridMetadataHash,
          atlasExists: fs.existsSync(path.join(ATLAS_DIR, region, v.modelVersionHash)),
          gridExists: fs.existsSync(path.join(GRID_METADATA_DIR, region, v.gridMetadataHash)),
        };
      } catch {
        regionHashes[region] = null;
      }
    }),
  );

  printRunRecap({
    selectionFile,
    regions,
    tileCounts,
    passBreakdown,
    buildingsShadowMode,
    gridStepMeters,
    passthrough,
    regionHashes,
  });

  if (buildingsShadowMode === "rust-wgpu-vulkan") {
    console.warn(
      "[precompute-all] EXPERIMENTAL cachePolicy=shared-contract : les caches gpu-raster compatibles peuvent être réutilisés/skippés.",
    );
  }

  const skippedDueToPreflight = new Set<string>();

  if (skipPreflight) {
    console.warn(
      "\x1b[1;93m[precompute-all] ⚠ --skip-preflight : la grid-metadata ne sera PAS régénérée.\x1b[0m\n" +
        "[precompute-all]   Suppose que tile-grid-metadata/<region>/<gridMetadataHash>/g<step>/ contient\n" +
        "[precompute-all]   déjà les fichiers requis. Si une tuile manque, le précompute en aval échouera.",
    );
  } else {
    const gridMetadataSkipped = ensureGridMetadataForAllRegions(
      regions, selectionFile, gridStepMeters, buildingsShadowMode, allowZeroIndoor,
    );
    for (const r of gridMetadataSkipped) skippedDueToPreflight.add(r);
    if (gridMetadataSkipped.size > 0) process.exitCode = 1;
  }

  // Atlas-health preflight, per region, before any precompute work. Two
  // outcomes per region:
  //   - manifest horizon DEM missing -> skip region (with warning), but other
  //     regions still get a chance to run.
  //   - manifest present -> scan existing atlases, quarantine any that were
  //     generated without terrain horizon (terrainHorizonMethod=none or
  //     "No horizon mask" warning).
  // See src/lib/precompute/preflight-atlas-health.ts.
  {
    const { runPreflight } = await import("../../src/lib/precompute/preflight-atlas-health");
    console.log(`\n[precompute-all] ▶ preflight atlas-health : ${regions.length} région(s)`);
    for (const region of regions) {
      console.log(`[precompute-all] atlas-health région=${region}…`);
      const outcome = await runPreflight(region as PrecomputedRegionName);
      if (!outcome.ok) {
        console.warn(
          `\x1b[1;33m[precompute-all] ⚠ skip région=${region} : ${outcome.reason}\x1b[0m`,
        );
        skippedDueToPreflight.add(region);
      } else if (outcome.scan) {
        const s = outcome.scan;
        if (s.quarantined.length > 0) {
          console.warn(
            `[precompute-all] région=${region} preflight: ${s.quarantined.length} atlas quarantainé(s) → ${s.quarantineRoot}`,
          );
        }
      }
    }
    console.log(`[precompute-all] ✓ preflight atlas-health terminé\n`);
  }

  const computeStart = Date.now();
  console.log(
    `[precompute-all] [BENCH] compute_start ${new Date(computeStart).toISOString()} (preflight excluded)`,
  );

  const failures: Array<{ pass: string; region: string; exit: string }> = [];

  // Two-pass iteration: top-priority tiles across every region first, then
  // the "other" group tiles (lausanne-west, lausanne-east, geneva, etc.)
  // across every region. Inside each pass, regions follow REGION_PRIORITY.
  const PASSES: Array<{ label: string; filter: "top-priority" | "other" }> = [
    { label: "1/2 Top-priority (places-density)", filter: "top-priority" },
    { label: "2/2 Couverture étendue",            filter: "other" },
  ];

  for (const pass of PASSES) {
    console.log(`\n[precompute-all] ▶▶ Passe ${pass.label}`);
    for (const region of regions) {
      if (skippedDueToPreflight.has(region)) {
        console.warn(
          `[precompute-all] ⏭ pass=${pass.filter} région=${region} sautée (preflight)`,
        );
        continue;
      }
      const args = [
        ...passthrough,
        `--region=${region}`,
        `--group-filter=${pass.filter}`,
      ];
      console.log(
        `\n[precompute-all] ▶ pass=${pass.filter} région=${region}  tsx ${REGION_SCRIPT} ${args.join(" ")}`,
      );

      const result = spawnSync("npx", ["tsx", REGION_SCRIPT, ...args], {
        stdio: "inherit",
        shell: process.platform === "win32",
        // MAPPY_PREFLIGHT_DONE=1 tells the child script to skip its own atlas-
        // health preflight — the orchestrator already ran it above.
        env: {
          ...process.env,
          MAPPY_BUILDINGS_SHADOW_MODE: buildingsShadowMode,
          MAPPY_PREFLIGHT_DONE: "1",
        },
      });

      if (result.error || result.status !== 0 || result.signal) {
        let detail: string;
        if (result.error) detail = `spawn-error: ${result.error.message}`;
        else if (result.signal) detail = `killed by signal=${result.signal}`;
        else detail = `exit=${result.status}`;
        console.error(
          `[precompute-all] ✗ pass=${pass.filter} région=${region} a échoué (${detail})`,
        );
        failures.push({ pass: pass.filter, region, exit: detail });
      } else {
        console.log(`[precompute-all] ✓ pass=${pass.filter} région=${region} terminée`);
      }
    }
  }

  const computeElapsed = ((Date.now() - computeStart) / 1000).toFixed(1);
  console.log(
    `[precompute-all] [BENCH] compute_end   ${new Date().toISOString()} — compute wall=${computeElapsed}s (preflight excluded)`,
  );

  if (failures.length > 0) {
    console.error(
      `\n[precompute-all] ✗ ${failures.length} échec(s) sur ${PASSES.length * regions.length} runs :`,
    );
    for (const f of failures) {
      console.error(`[precompute-all]   · pass=${f.pass} région=${f.region} (exit ${f.exit})`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `\n[precompute-all] 2 passes × ${regions.length} régions (${regions.join(", ")}) terminées avec succès.`,
    );
  }
}

void main().catch((e) => { console.error(e); process.exitCode = 1; });
