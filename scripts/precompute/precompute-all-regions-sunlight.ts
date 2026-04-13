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

const REGION_PRIORITY: string[] = ["lausanne", "morges", "nyon", "geneve"];

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
  console.log(`[precompute-all] régions détectées depuis le fichier : ${regions.join(", ")}`);

  let anyFailed = false;

  for (const region of regions) {
    const args = [...passthrough, `--region=${region}`];
    console.log(`\n[precompute-all] ▶ région=${region}  tsx ${REGION_SCRIPT} ${args.join(" ")}`);

    const result = spawnSync("npx", ["tsx", REGION_SCRIPT, ...args], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, MAPPY_BUILDINGS_SHADOW_MODE: "gpu-raster" },
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
