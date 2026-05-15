/**
 * Cleanup orphan atlas + grid caches by quarantining them.
 *
 * Reads the live diagnostic endpoint `/api/admin/diag/model-versions` and
 * for each region:
 *   - Lists atlas hashes flagged `isCurrent: false` (sunlight cache orphans).
 *   - Lists grid hashes flagged `isCurrent: false` (tile-grid-metadata orphans).
 *
 * Both lists are moved (not deleted) to `<dataRoot>/_quarantine/<timestamp>/`,
 * preserving the relative path under `cache/`. Quarantine vs `rm` lets us
 * recover if the diagnostic mistakenly flagged something current as orphan.
 *
 * Dry-run by default. Pass `--apply` to actually move directories.
 *
 * Requires the dev server to be reachable at `http://localhost:3000` (or set
 * `MAPPY_DIAG_URL` to override).
 *
 * Usage:
 *   pnpm tsx scripts/diag/cleanup-orphan-caches.ts          # dry-run
 *   pnpm tsx scripts/diag/cleanup-orphan-caches.ts --apply  # really move
 */

import fs from "node:fs/promises";
import path from "node:path";

type DiskEntry = { hash: string; isCurrent: boolean; mtime: string | null };
type RegionPayload = {
  region: string;
  modelVersionHash: string;
  gridMetadataHash: string;
  atlasOnDisk: { count: number; orphanCount: number; entries: DiskEntry[] };
  gridOnDisk: { count: number; orphanCount: number; entries: DiskEntry[] };
};
type DiagPayload = {
  dataRoot: string;
  regions: RegionPayload[];
};

interface MoveJob {
  kind: "atlas" | "grid";
  region: string;
  hash: string;
  src: string;
  dest: string;
}

const DIAG_URL = process.env.MAPPY_DIAG_URL ?? "http://localhost:3000/api/admin/diag/model-versions";
const APPLY = process.argv.includes("--apply");

function timestampForQuarantine(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirSizeBytes(p);
    } else {
      try {
        const st = await fs.stat(p);
        total += st.size;
      } catch {
        // ignore
      }
    }
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function moveDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM") throw err;
    // Cross-device fallback: copy then remove.
    await copyDirRecursive(src, dest);
    await fs.rm(src, { recursive: true, force: true });
  }
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      await copyDirRecursive(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

async function main() {
  console.log(`[cleanup] fetching ${DIAG_URL}`);
  const resp = await fetch(DIAG_URL);
  if (!resp.ok) {
    console.error(`[cleanup] HTTP ${resp.status} from diag endpoint`);
    process.exit(1);
  }
  const data = (await resp.json()) as DiagPayload;
  const dataRoot = data.dataRoot;
  const ts = timestampForQuarantine();
  const quarantineRoot = path.join(dataRoot, "_quarantine", ts);
  console.log(`[cleanup] dataRoot=${dataRoot}`);
  console.log(`[cleanup] quarantineRoot=${quarantineRoot}`);
  console.log(`[cleanup] mode=${APPLY ? "APPLY (will move)" : "DRY-RUN (no changes)"}`);
  console.log();

  const jobs: MoveJob[] = [];
  for (const region of data.regions) {
    for (const entry of region.atlasOnDisk.entries) {
      if (entry.isCurrent) continue;
      jobs.push({
        kind: "atlas",
        region: region.region,
        hash: entry.hash,
        src: path.join(dataRoot, "cache", "sunlight", region.region, entry.hash),
        dest: path.join(quarantineRoot, "cache", "sunlight", region.region, entry.hash),
      });
    }
    for (const entry of region.gridOnDisk.entries) {
      if (entry.isCurrent) continue;
      jobs.push({
        kind: "grid",
        region: region.region,
        hash: entry.hash,
        src: path.join(dataRoot, "cache", "tile-grid-metadata", region.region, entry.hash),
        dest: path.join(quarantineRoot, "cache", "tile-grid-metadata", region.region, entry.hash),
      });
    }
  }

  if (jobs.length === 0) {
    console.log("[cleanup] No orphans found. Nothing to do.");
    return;
  }

  // Compute sizes for the dry-run report.
  let totalBytes = 0;
  console.log(`Plan: ${jobs.length} directories to quarantine`);
  console.log();
  console.log(`kind   region              hash                size`);
  console.log(`-----  ------------------- ------------------- ----------`);
  for (const job of jobs) {
    const bytes = await dirSizeBytes(job.src);
    totalBytes += bytes;
    console.log(
      `${job.kind.padEnd(5)}  ${job.region.padEnd(19)} ${job.hash.padEnd(19)} ${formatBytes(bytes).padStart(10)}`,
    );
  }
  console.log();
  console.log(`Total: ${jobs.length} dirs, ${formatBytes(totalBytes)}`);
  console.log();

  if (!APPLY) {
    console.log("[cleanup] DRY-RUN — pass --apply to actually move the directories.");
    return;
  }

  console.log("[cleanup] Moving directories to quarantine...");
  let moved = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await moveDirectory(job.src, job.dest);
      moved += 1;
      console.log(`  ✓ ${job.kind} ${job.region}/${job.hash}`);
    } catch (err) {
      failed += 1;
      console.error(
        `  ✗ ${job.kind} ${job.region}/${job.hash} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log();
  console.log(`[cleanup] done — moved ${moved}, failed ${failed}`);
  console.log(`[cleanup] quarantine root: ${quarantineRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
