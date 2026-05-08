import fs from "node:fs/promises";
import path from "node:path";

import { PROCESSED_ROOT } from "@/lib/storage/data-paths";

import type { AtlasDriftRecord } from "./atlas-drift-sink";

const PATCH_DIR = path.join(PROCESSED_ROOT, "precompute", "atlas-drift-patches");

/**
 * Run-level args needed to reproduce the precompute for the affected tiles
 * after the operator has cleared the stale tile artifacts.
 */
export interface PrecomputeRunMetadata {
  region: string;
  startDate: string;
  days: number;
  timezone: string;
  sampleEveryMinutes: number;
  gridStepMeters: number;
  startLocalTime: string;
  endLocalTime: string;
  buildingHeightBiasMeters: number;
  buildingsShadowMode: string | null;
  atlasResolutionDeg: number;
}

interface PatchTaskTile {
  region: string;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
  resolutionDeg: number;
  staleOutdoorCount: number;
  freshOutdoorCount: number;
  staleBucketCount: number;
  detectedAt: string;
}

function timestampSlug(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function dateRangeIter(startDate: string, days: number): string[] {
  const dates: string[] = [];
  const start = new Date(startDate + "T00:00:00Z");
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function tileArtifactPath(params: {
  region: string;
  modelVersionHash: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  date: string;
  startLocalTime: string;
  endLocalTime: string;
  tileId: string;
}): string {
  const tw =
    `t${params.startLocalTime.replace(":", "")}-${params.endLocalTime.replace(":", "")}`;
  return path.posix.join(
    "data/cache/sunlight",
    params.region,
    params.modelVersionHash,
    `g${params.gridStepMeters}`,
    `m${params.sampleEveryMinutes}`,
    params.date,
    tw,
    "tiles",
    `${params.tileId}.gz`,
  );
}

function selectionFilename(timestamp: string): string {
  return `atlas-drift-patch-${timestamp}.tiles.json`;
}

function scriptFilename(timestamp: string): string {
  return `atlas-drift-patch-${timestamp}.sh`;
}

/**
 * Produces a self-contained bash script + tile-selection JSON file that the
 * operator can run after a precompute run to fill the gaps left by Option A's
 * graceful invalidation. The script:
 *   1. Removes the stale per-day tile artifacts (.gz) for each affected tile
 *      across the run's date range.
 *   2. Re-runs `precompute-region-sunlight.ts` for those tiles only, which
 *      regenerates the tile artifacts under the current grid-metadata (and the
 *      atlas naturally repopulates via merge).
 *
 * Returns the path of the generated script, or `null` if no records.
 */
export async function writeAtlasDriftPatchScript(params: {
  records: AtlasDriftRecord[];
  run: PrecomputeRunMetadata;
}): Promise<string | null> {
  if (params.records.length === 0) return null;

  const now = new Date();
  const ts = timestampSlug(now);
  await fs.mkdir(PATCH_DIR, { recursive: true });

  const scriptPath = path.join(PATCH_DIR, scriptFilename(ts));
  const selectionPath = path.join(PATCH_DIR, selectionFilename(ts));

  // Group records by region (in case future runs span multiple regions).
  const byRegion = new Map<string, AtlasDriftRecord[]>();
  for (const r of params.records) {
    const list = byRegion.get(r.region) ?? [];
    list.push(r);
    byRegion.set(r.region, list);
  }

  // Tile selection JSON consumed by --tile-selection-file=...
  const tilesForSelection = params.records.map((r) => ({
    region: r.region,
    tileId: r.tileId,
  }));
  const selectionContent = {
    generatedAt: now.toISOString(),
    selectionVersion: 1,
    tileSizeMeters: 250,
    source: "Auto-generated atlas drift patch (Option A+ invalidation recovery)",
    labels: Object.fromEntries(
      params.records.map((r) => [r.tileId, `${r.region}-${r.tileId}`]),
    ),
    tiles: tilesForSelection,
  };
  await fs.writeFile(selectionPath, JSON.stringify(selectionContent, null, 2), "utf8");

  // Build the bash script.
  const lines: string[] = [];
  lines.push("#!/usr/bin/env bash");
  lines.push(`# Auto-generated atlas drift patch — ${now.toISOString()}`);
  lines.push(`# ${params.records.length} tile(s) affected, ${params.run.days} day(s) range.`);
  lines.push("#");
  lines.push("# This script fills the gaps left by Option A's graceful invalidation");
  lines.push("# in mergeBucketsIntoAtlas. It deletes the stale tile artifacts (.gz) for");
  lines.push("# the affected tiles across the original run's date range, then re-runs");
  lines.push("# the precompute for those tiles only. Idempotent: skip-existing protects");
  lines.push("# tile artifacts that have already been regenerated.");
  lines.push("#");
  lines.push("# References:");
  lines.push("#   - docs/architecture/adr-0014-* / adr-0018-*");
  lines.push("#   - mergeBucketsIntoAtlas (src/lib/precompute/sunlight-cache-atlas.ts)");
  lines.push("#   - project_atlas_outdoor_count_drift.md / project_zenith_shadow_non_deterministic.md");
  lines.push("");
  lines.push("set -euo pipefail");
  lines.push('cd "$(dirname "$0")/../../../.."');
  lines.push("");

  let tileIndex = 0;
  const dates = dateRangeIter(params.run.startDate, params.run.days);
  for (const r of params.records) {
    tileIndex++;
    lines.push(
      `echo "[${tileIndex}/${params.records.length}] ${r.region}/${r.tileId} — ` +
        `outdoor drift ${r.previousOutdoorCount} → ${r.newOutdoorCount} ` +
        `(${r.previousBucketCount} stale buckets dropped)"`,
    );
    lines.push(
      `echo "  Removing ${dates.length} stale tile artifact(s) for date range ${params.run.startDate} → ${dates[dates.length - 1]}..."`,
    );
    for (const date of dates) {
      const p = tileArtifactPath({
        region: r.region,
        modelVersionHash: r.modelVersionHash,
        gridStepMeters: r.gridStepMeters,
        sampleEveryMinutes: params.run.sampleEveryMinutes,
        date,
        startLocalTime: params.run.startLocalTime,
        endLocalTime: params.run.endLocalTime,
        tileId: r.tileId,
      });
      lines.push(`  rm -f "${p}"`);
    }
    lines.push("");
  }

  lines.push(
    `echo "Re-running precompute for ${params.records.length} affected tile(s)..."`,
  );
  const precomputeArgs = [
    `--region=${params.run.region}`,
    `--start-date=${params.run.startDate}`,
    `--days=${params.run.days}`,
    `--timezone=${params.run.timezone}`,
    `--sample-every-minutes=${params.run.sampleEveryMinutes}`,
    `--grid-step-meters=${params.run.gridStepMeters}`,
    `--start-local-time=${params.run.startLocalTime}`,
    `--end-local-time=${params.run.endLocalTime}`,
    `--building-height-bias-meters=${params.run.buildingHeightBiasMeters}`,
    `--atlas-resolution-deg=${params.run.atlasResolutionDeg}`,
    `--tile-selection-file=${path.posix.relative(process.cwd(), selectionPath).replace(/\\/g, "/")}`,
    `--skip-existing=true`,
  ];
  if (params.run.buildingsShadowMode) {
    precomputeArgs.push(`--buildings-shadow-mode=${params.run.buildingsShadowMode}`);
  }
  lines.push("npx tsx scripts/precompute/precompute-region-sunlight.ts \\");
  for (let i = 0; i < precomputeArgs.length; i++) {
    const tail = i < precomputeArgs.length - 1 ? " \\" : "";
    lines.push(`  ${precomputeArgs[i]}${tail}`);
  }
  lines.push("");
  lines.push('echo "✓ Patch complete. Atlas should now be coherent for affected tiles."');
  lines.push("");

  await fs.writeFile(scriptPath, lines.join("\n"), { encoding: "utf8", mode: 0o755 });

  return scriptPath;
}
