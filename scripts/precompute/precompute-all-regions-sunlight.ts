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

const REGION_PRIORITY: string[] = ["lausanne", "morges", "nyon", "geneve", "vevey"];
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
  const cliBuildingsShadowMode = parseBuildingsShadowModeArg(passthrough);
  const buildingsShadowMode =
    cliBuildingsShadowMode ??
    (process.env.MAPPY_BUILDINGS_SHADOW_MODE
      ? parseBuildingsShadowMode(process.env.MAPPY_BUILDINGS_SHADOW_MODE)
      : "gpu-raster");
  console.log(`[precompute-all] régions détectées depuis le fichier : ${regions.join(", ")}`);
  console.log(`[precompute-all] buildingsShadowMode=${buildingsShadowMode}`);
  if (buildingsShadowMode === "rust-wgpu-vulkan") {
    console.warn(
      "[precompute-all] EXPERIMENTAL cachePolicy=shared-contract : les caches gpu-raster compatibles peuvent être réutilisés/skippés.",
    );
  }

  const gridStepMeters = parseGridStepMetersArg(passthrough);

  try {
    ensureGridMetadataForAllRegions(regions, selectionFile, gridStepMeters, buildingsShadowMode);
  } catch (err) {
    console.error(`[precompute-all] ✗ ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let anyFailed = false;

  for (const region of regions) {
    const args = [...passthrough, `--region=${region}`];
    console.log(`\n[precompute-all] ▶ région=${region}  tsx ${REGION_SCRIPT} ${args.join(" ")}`);

    const result = spawnSync("npx", ["tsx", REGION_SCRIPT, ...args], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, MAPPY_BUILDINGS_SHADOW_MODE: buildingsShadowMode },
    });

    if (result.status !== 0) {
      console.error(`[precompute-all] ✗ région=${region} a échoué (exit ${result.status ?? "signal"})`);
      anyFailed = true;
    } else {
      console.log(`[precompute-all] ✓ région=${region} terminée`);
    }
  }

  if (anyFailed) {
    console.error("\n[precompute-all] Une ou plusieurs régions ont échoué.");
    process.exitCode = 1;
  } else {
    console.log(`\n[precompute-all] Toutes les régions (${regions.join(", ")}) terminées avec succès.`);
  }
}

main();
