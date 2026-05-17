/**
 * Supprime les fichiers grid-metadata dont indoorCount === 0.
 * Ces fichiers ont été générés avant que les buildings index soient disponibles
 * et seront recalculés correctement au prochain preflight.
 *
 * Usage:
 *   npx tsx scripts/diag/delete-zero-indoor-tiles.ts [--dry-run] [--region=zurich]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(zlib.gunzip);

const GRID_METADATA_DIR = process.env.MAPPY_DATA_ROOT
  ? path.join(process.env.MAPPY_DATA_ROOT.trim(), "cache", "tile-grid-metadata")
  : path.join(process.cwd(), "data", "cache", "tile-grid-metadata");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const regionFilter = args.find(a => a.startsWith("--region="))?.slice(9) ?? null;

async function scanDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".gz")) results.push(full);
    }
  }
  return results;
}

async function main() {
  console.log(`[delete-zero-indoor] GRID_METADATA_DIR=${GRID_METADATA_DIR}`);
  if (dryRun) console.log("[delete-zero-indoor] MODE: dry-run (aucune suppression)");
  if (regionFilter) console.log(`[delete-zero-indoor] Filtre région: ${regionFilter}`);

  const regions = fs.readdirSync(GRID_METADATA_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && (!regionFilter || e.name === regionFilter))
    .map(e => e.name);

  console.log(`[delete-zero-indoor] Régions: ${regions.join(", ")}`);

  let totalScanned = 0, totalDeleted = 0, totalErrors = 0;

  for (const region of regions) {
    const regionDir = path.join(GRID_METADATA_DIR, region);
    const files = await scanDir(regionDir);
    let regionDeleted = 0;

    for (const file of files) {
      totalScanned++;
      try {
        const compressed = fs.readFileSync(file);
        const raw = await gunzip(compressed);
        const data = JSON.parse(raw.toString("utf8")) as { indoorCount: number; tileId?: string };
        if (data.indoorCount === 0) {
          if (!dryRun) fs.unlinkSync(file);
          regionDeleted++;
          totalDeleted++;
          console.log(`[delete-zero-indoor] ${dryRun ? "[DRY]" : "DEL"} ${region}/${path.basename(file)}`);
        }
      } catch {
        totalErrors++;
      }
    }

    if (regionDeleted > 0) {
      console.log(`[delete-zero-indoor] ${region}: ${regionDeleted}/${files.length} fichiers supprimés`);
    } else {
      console.log(`[delete-zero-indoor] ${region}: aucun fichier 0-indoor sur ${files.length} tuiles`);
    }
  }

  console.log(`\n[delete-zero-indoor] ✓ Total: ${totalDeleted} supprimés / ${totalScanned} scannés / ${totalErrors} erreurs`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
