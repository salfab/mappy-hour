import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { DATA_ROOT } from "@/lib/storage/data-paths";
import { DEFAULT_SHADOW_CALIBRATION } from "@/lib/sun/shadow-calibration";
import { getSunlightModelVersion } from "@/lib/precompute/model-version";
import type { PrecomputedRegionName } from "@/lib/precompute/sunlight-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REGIONS: PrecomputedRegionName[] = [
  "lausanne",
  "nyon",
  "morges",
  "geneve",
  "vevey",
  "vevey_city",
  "neuchatel",
  "la_chaux_de_fonds",
  "bern",
  "zurich",
  "thun",
];

interface DiskHashEntry {
  hash: string;
  isCurrent: boolean;
  mtime: string | null;
}

async function listSubdirs(dir: string): Promise<Array<{ name: string; mtimeMs: number }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: Array<{ name: string; mtimeMs: number }> = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const st = await fs.stat(path.join(dir, e.name));
        out.push({ name: e.name, mtimeMs: st.mtimeMs });
      } catch {
        out.push({ name: e.name, mtimeMs: 0 });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function classify(
  entries: Array<{ name: string; mtimeMs: number }>,
  currentHash: string,
): DiskHashEntry[] {
  return entries
    .map((e) => ({
      hash: e.name,
      isCurrent: e.name === currentHash,
      mtime: e.mtimeMs > 0 ? new Date(e.mtimeMs).toISOString() : null,
    }))
    .sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return a.hash.localeCompare(b.hash);
    });
}

export async function GET() {
  try {
    const sunlightRoot = path.join(DATA_ROOT, "cache", "sunlight");
    const gridRoot = path.join(DATA_ROOT, "cache", "tile-grid-metadata");

    const regionsOut = await Promise.all(
      REGIONS.map(async (region) => {
        const version = await getSunlightModelVersion(region, DEFAULT_SHADOW_CALIBRATION);
        const [atlasDirs, gridDirs] = await Promise.all([
          listSubdirs(path.join(sunlightRoot, region)),
          listSubdirs(path.join(gridRoot, region)),
        ]);
        const atlasOnDisk = classify(atlasDirs, version.modelVersionHash);
        const gridOnDisk = classify(gridDirs, version.gridMetadataHash);
        return {
          region,
          modelVersionHash: version.modelVersionHash,
          gridMetadataHash: version.gridMetadataHash,
          algorithmVersion: version.algorithmVersion,
          artifactFormatVersion: version.artifactFormatVersion,
          atlasOnDisk: {
            currentPresent: atlasOnDisk.some((e) => e.isCurrent),
            count: atlasOnDisk.length,
            orphanCount: atlasOnDisk.filter((e) => !e.isCurrent).length,
            entries: atlasOnDisk,
          },
          gridOnDisk: {
            currentPresent: gridOnDisk.some((e) => e.isCurrent),
            count: gridOnDisk.length,
            orphanCount: gridOnDisk.filter((e) => !e.isCurrent).length,
            entries: gridOnDisk,
          },
          inputs: {
            calibration: version.inputs.calibration,
            terrainSelectionStrategy: version.inputs.terrainSelectionStrategy,
            terrainManifest: {
              path: version.inputs.terrainManifest.path,
              exists: version.inputs.terrainManifest.exists,
            },
            vegetationManifest: {
              path: version.inputs.vegetationManifest.path,
              exists: version.inputs.vegetationManifest.exists,
            },
            horizonManifest: {
              path: version.inputs.horizonManifest.path,
              exists: version.inputs.horizonManifest.exists,
            },
            buildingsSummaryKeys: Object.keys(version.inputs.buildings),
            adaptiveHorizonSharingKeys: Object.keys(version.inputs.adaptiveHorizonSharing),
          },
        };
      }),
    );

    return NextResponse.json({
      dataRoot: DATA_ROOT,
      regions: regionsOut,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to compute model versions diagnostic.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
