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

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REGION_SCRIPT = path.resolve(
  process.cwd(),
  "scripts/precompute/precompute-region-sunlight.ts",
);

const GRID_METADATA_SCRIPT = path.resolve(
  process.cwd(),
  "scripts/precompute/precompute-tile-grid-metadata.ts",
);

const REGION_PRIORITY: string[] = ["lausanne", "morges", "nyon", "vevey", "geneve"];
type ExperimentalBuildingsShadowMode = "gpu-raster" | "rust-wgpu-vulkan";

function readRegionsFromSelectionFile(filePath: string): string[] {
  const raw = fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
  const data = JSON.parse(raw) as { tiles: Array<{ region: string }> };
  const found = Array.from(new Set(data.tiles.map((t) => t.region)));
  return [
    ...REGION_PRIORITY.filter((r) => found.includes(r)),
    ...found.filter((r) => !REGION_PRIORITY.includes(r)).sort(),
  ];
}

function countTilesPerRegion(filePath: string): Record<string, number> {
  const raw = fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
  const data = JSON.parse(raw) as { tiles: Array<{ region: string }> };
  const counts: Record<string, number> = {};
  for (const t of data.tiles) counts[t.region] = (counts[t.region] ?? 0) + 1;
  return counts;
}

function countTilesPerPassPerRegion(filePath: string): {
  topPriority: Record<string, number>;
  other: Record<string, number>;
} {
  const raw = fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
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

function printRunRecap(params: {
  selectionFile: string;
  regions: string[];
  tileCounts: Record<string, number>;
  passBreakdown: { topPriority: Record<string, number>; other: Record<string, number> };
  buildingsShadowMode: string;
  gridStepMeters: number;
  passthrough: string[];
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
  console.log(box.join("\n"));
  console.log(`  Tile selection   : ${params.selectionFile}`);
  console.log(`  Total tiles      : ${totalTiles}`);
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

/**
 * Preflight : garantit que la grid metadata est présente pour TOUTES les tuiles
 * de TOUTES les régions du fichier de sélection, AVANT de commencer quelque
 * précalcul que ce soit. Le script cible est idempotent : il saute les tuiles
 * déjà cachées et ne régénère que les manquantes.
 */
function ensureGridMetadataForAllRegions(
  regions: string[],
  selectionFile: string,
  gridStepMeters: number,
  buildingsShadowMode: ExperimentalBuildingsShadowMode,
): void {
  console.log(
    `\n[precompute-all] ▶ preflight grid-metadata : ${regions.length} région(s), grid=${gridStepMeters}m, fichier=${selectionFile}`,
  );
  const preflightStart = Date.now();

  for (const region of regions) {
    const args = [
      GRID_METADATA_SCRIPT,
      `--region=${region}`,
      `--tile-selection-file=${selectionFile}`,
      `--grid-step-meters=${gridStepMeters}`,
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
    if (result.status !== 0) {
      throw new Error(
        `grid-metadata preflight failed for région=${region} (exit ${result.status ?? "signal"}). Aucune région n'a été précalculée.`,
      );
    }
  }

  const elapsed = ((Date.now() - preflightStart) / 1000).toFixed(1);
  console.log(`[precompute-all] ✓ preflight grid-metadata terminé en ${elapsed}s\n`);
}

function main() {
  // pnpm passes a literal "--" separator when using `pnpm script -- args`, strip it
  const passthrough = process.argv
    .slice(2)
    .filter((a) => a !== "--" && !a.startsWith("--region="));

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

  printRunRecap({
    selectionFile,
    regions,
    tileCounts,
    passBreakdown,
    buildingsShadowMode,
    gridStepMeters,
    passthrough,
  });

  if (buildingsShadowMode === "rust-wgpu-vulkan") {
    console.warn(
      "[precompute-all] EXPERIMENTAL cachePolicy=shared-contract : les caches gpu-raster compatibles peuvent être réutilisés/skippés.",
    );
  }

  try {
    ensureGridMetadataForAllRegions(regions, selectionFile, gridStepMeters, buildingsShadowMode);
  } catch (err) {
    console.error(`[precompute-all] ✗ ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const computeStart = Date.now();
  console.log(
    `[precompute-all] [BENCH] compute_start ${new Date(computeStart).toISOString()} (preflight excluded)`,
  );

  let anyFailed = false;

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
        env: { ...process.env, MAPPY_BUILDINGS_SHADOW_MODE: buildingsShadowMode },
      });

      if (result.status !== 0) {
        console.error(
          `[precompute-all] ✗ pass=${pass.filter} région=${region} a échoué (exit ${result.status ?? "signal"})`,
        );
        anyFailed = true;
      } else {
        console.log(`[precompute-all] ✓ pass=${pass.filter} région=${region} terminée`);
      }
    }
  }

  const computeElapsed = ((Date.now() - computeStart) / 1000).toFixed(1);
  console.log(
    `[precompute-all] [BENCH] compute_end   ${new Date().toISOString()} — compute wall=${computeElapsed}s (preflight excluded)`,
  );

  if (anyFailed) {
    console.error("\n[precompute-all] Une ou plusieurs passes/régions ont échoué.");
    process.exitCode = 1;
  } else {
    console.log(
      `\n[precompute-all] 2 passes × ${regions.length} régions (${regions.join(", ")}) terminées avec succès.`,
    );
  }
}

main();
