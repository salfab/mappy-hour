import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  encodeTileAtlasToBinary,
  type BinaryTileAtlas,
  type TileAtlasMetadata,
} from "./sunlight-cache-atlas";
import {
  classifyAtlasMetaHealth,
  scanAndQuarantineAtlases,
} from "./preflight-atlas-health";

const gzip = promisify(gzipCb);

const POINT_COUNT = 1;
const OUTDOOR_POINT_COUNT = 1;
const MASK_BYTES = 4;
const BUCKET_COUNT = 1;

function makeAtlas(
  meta: TileAtlasMetadata,
): BinaryTileAtlas {
  // Single bucket, single point — the absolute minimum that round-trips
  // through encode/decode. The preflight only cares about meta.
  return {
    meta,
    pointCount: POINT_COUNT,
    bucketCount: BUCKET_COUNT,
    outdoorPointCount: OUTDOOR_POINT_COUNT,
    maskBytesPerBucket: MASK_BYTES,
    resolutionDegAz: 0.75,
    resolutionDegAlt: 0.75,
    pointLon: new Float64Array([6.6]),
    pointLat: new Float64Array([46.5]),
    pointIx: new Int32Array([0]),
    pointIy: new Int32Array([0]),
    pointOutdoorIndex: new Int32Array([0]),
    pointFlags: new Uint32Array([0]),
    bucketAz: new Uint16Array([10]),
    bucketAlt: new Uint16Array([20]),
    bucketDataIndex: new Uint32Array([0]),
    maskBuffer: new Uint8Array(BUCKET_COUNT * 5 * MASK_BYTES),
  };
}

function makeMeta(
  overrides: Partial<{
    terrainHorizonMethod: string;
    warnings: string[];
  }> = {},
): TileAtlasMetadata {
  return {
    atlasFormatVersion: 1,
    region: "lausanne",
    modelVersionHash: "test-hash",
    gridStepMeters: 1,
    resolutionDegAz: 0.75,
    resolutionDegAlt: 0.75,
    tile: {
      tileId: "e0_n0_s250",
      tileSizeMeters: 250,
      minEasting: 0,
      minNorthing: 0,
      maxEasting: 250,
      maxNorthing: 250,
      bbox: { minLon: 6.5, minLat: 46.5, maxLon: 6.51, maxLat: 46.51 },
    },
    model: {
      terrainHorizonMethod: overrides.terrainHorizonMethod ?? "copernicus-dem30-runtime-raycast-v1",
      buildingsShadowMethod: "gpu-raster",
      vegetationShadowMethod: "swissurface3d-raster",
    },
    warnings: overrides.warnings ?? [],
    stats: {
      bucketCount: BUCKET_COUNT,
      pointCount: POINT_COUNT,
      outdoorPointCount: OUTDOOR_POINT_COUNT,
      sourceFramesTotal: 1,
    },
  };
}

async function writeAtlasFile(
  cacheRoot: string,
  region: "lausanne",
  modelHash: string,
  gridStep: number,
  resDeg: number,
  tileId: string,
  atlas: BinaryTileAtlas,
): Promise<string> {
  const dir = path.join(
    cacheRoot,
    region,
    modelHash,
    `g${gridStep}`,
    "atlas",
    `r${resDeg}`,
  );
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${tileId}.atlas.bin.gz`);
  const bin = encodeTileAtlasToBinary(atlas);
  const compressed = await gzip(bin, { level: 1 });
  await fs.writeFile(filePath, compressed);
  return filePath;
}

describe("classifyAtlasMetaHealth", () => {
  it("flags terrainHorizonMethod=none as unhealthy", () => {
    const check = classifyAtlasMetaHealth({
      model: { terrainHorizonMethod: "none" },
      warnings: [],
    });
    expect(check).toEqual({ healthy: false, reason: "none" });
  });

  it("flags a 'No horizon mask' warning as unhealthy even when terrainHorizonMethod is set", () => {
    // The warning is informational. We treat its presence as a robust signal
    // that the atlas was produced without the terrain horizon component, even
    // if `terrainHorizonMethod` happens to be set to something non-"none"
    // (defensive: the two markers can drift independently).
    const check = classifyAtlasMetaHealth({
      model: { terrainHorizonMethod: "copernicus-dem30-runtime-raycast-v1" },
      warnings: [
        "No horizon mask. Callers should supply `terrainHorizonOverride` (live API: buildDynamicHorizonMask; precompute: resolveAdaptiveTerrainHorizonForTile). Far-horizon blocking will be ignored.",
      ],
    });
    expect(check).toEqual({ healthy: false, reason: "warning" });
  });

  it("flags healthy when terrain method is real and no horizon warning", () => {
    const check = classifyAtlasMetaHealth({
      model: { terrainHorizonMethod: "copernicus-dem30-runtime-raycast-v1" },
      warnings: ["Some other unrelated warning."],
    });
    expect(check).toEqual({ healthy: true, reason: null });
  });

  it("treats missing model/warnings defensively (healthy)", () => {
    const check = classifyAtlasMetaHealth({});
    // No information = no actionable signal. Better to leave the atlas alone
    // than wipe out healthy data on a parsing edge case.
    expect(check).toEqual({ healthy: true, reason: null });
  });
});

describe("scanAndQuarantineAtlases", () => {
  let tmpRoot: string;
  let cacheRoot: string;
  let quarantineRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-test-"));
    cacheRoot = path.join(tmpRoot, "cache", "sunlight");
    quarantineRoot = path.join(tmpRoot, "_quarantine", "test-run");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("quarantines an atlas with terrainHorizonMethod=none, leaves healthy untouched", async () => {
    const unhealthyAtlas = makeAtlas(makeMeta({ terrainHorizonMethod: "none" }));
    const healthyAtlas = makeAtlas(makeMeta());

    const unhealthyPath = await writeAtlasFile(
      cacheRoot,
      "lausanne",
      "bff55b407db8426b",
      1,
      0.75,
      "e2538500_n1152250_s250",
      unhealthyAtlas,
    );
    const healthyPath = await writeAtlasFile(
      cacheRoot,
      "lausanne",
      "f0dc41e3ff51095d",
      1,
      0.75,
      "e2538250_n1152250_s250",
      healthyAtlas,
    );

    // Drop a sidecar `.atlas.idx` next to the unhealthy file so we can assert
    // it also gets quarantined (orphan sidecars would mislead skip-existing).
    const sidecarPath = unhealthyPath.replace(/\.atlas\.bin\.gz$/, ".atlas.idx");
    await fs.writeFile(sidecarPath, Buffer.from([1, 2, 3, 4]));

    const result = await scanAndQuarantineAtlases("lausanne", {
      cacheRootOverride: cacheRoot,
      quarantineRootOverride: quarantineRoot,
      logger: () => {},
    });

    expect(result.scanned).toBe(2);
    expect(result.healthy).toBe(1);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0].reason).toBe("none");
    expect(result.quarantined[0].modelVersionHash).toBe("bff55b407db8426b");
    expect(result.quarantined[0].tileId).toBe("e2538500_n1152250_s250");

    // Unhealthy atlas and sidecar are moved off the cache tree.
    await expect(fs.access(unhealthyPath)).rejects.toThrow();
    await expect(fs.access(sidecarPath)).rejects.toThrow();

    // ...and land under the dated quarantine folder, preserving structure.
    const destAtlas = path.join(
      quarantineRoot,
      "cache",
      "sunlight",
      "lausanne",
      "bff55b407db8426b",
      "g1",
      "atlas",
      "r0.75",
      "e2538500_n1152250_s250.atlas.bin.gz",
    );
    const destSidecar = destAtlas.replace(/\.atlas\.bin\.gz$/, ".atlas.idx");
    await expect(fs.access(destAtlas)).resolves.toBeUndefined();
    await expect(fs.access(destSidecar)).resolves.toBeUndefined();

    // Healthy atlas stays in place.
    await expect(fs.access(healthyPath)).resolves.toBeUndefined();
  });

  it("quarantines atlas with 'No horizon mask' warning even when method is non-none", async () => {
    const atlas = makeAtlas(
      makeMeta({
        terrainHorizonMethod: "copernicus-dem30-runtime-raycast-v1",
        warnings: [
          "No horizon mask. Callers should supply `terrainHorizonOverride` (...). Far-horizon blocking will be ignored.",
        ],
      }),
    );
    await writeAtlasFile(
      cacheRoot,
      "lausanne",
      "deadbeefcafebabe",
      1,
      0.75,
      "e2538500_n1152500_s250",
      atlas,
    );

    const result = await scanAndQuarantineAtlases("lausanne", {
      cacheRootOverride: cacheRoot,
      quarantineRootOverride: quarantineRoot,
      logger: () => {},
    });

    expect(result.scanned).toBe(1);
    expect(result.healthy).toBe(0);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0].reason).toBe("warning");
  });

  it("returns zero-scan when the region cache directory does not exist", async () => {
    // Fresh machine: no atlases produced yet. Must not throw.
    const result = await scanAndQuarantineAtlases("lausanne", {
      cacheRootOverride: cacheRoot,
      quarantineRootOverride: quarantineRoot,
      logger: () => {},
    });
    expect(result).toMatchObject({
      scanned: 0,
      healthy: 0,
      quarantined: [],
      unreadable: [],
    });
  });

  it("idempotent: a second run on a cleaned cache finds nothing to quarantine", async () => {
    const unhealthyAtlas = makeAtlas(makeMeta({ terrainHorizonMethod: "none" }));
    await writeAtlasFile(
      cacheRoot,
      "lausanne",
      "bff55b407db8426b",
      1,
      0.75,
      "e2538500_n1152250_s250",
      unhealthyAtlas,
    );

    const first = await scanAndQuarantineAtlases("lausanne", {
      cacheRootOverride: cacheRoot,
      quarantineRootOverride: quarantineRoot,
      logger: () => {},
    });
    expect(first.quarantined).toHaveLength(1);

    const second = await scanAndQuarantineAtlases("lausanne", {
      cacheRootOverride: cacheRoot,
      quarantineRootOverride: quarantineRoot,
      logger: () => {},
    });
    expect(second.scanned).toBe(0);
    expect(second.quarantined).toHaveLength(0);
  });
});
