import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

const gzip = promisify(gzipCallback);

describe("sunlight cache storage", () => {
  const originalDataRoot = process.env.MAPPY_DATA_ROOT;

  afterEach(async () => {
    process.env.MAPPY_DATA_ROOT = originalDataRoot;
    vi.resetModules();
  });

  it("writes and reloads manifest and tile artifacts", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mappy-hour-cache-"));
    process.env.MAPPY_DATA_ROOT = tempRoot;
    vi.resetModules();

    const cache = await import("./sunlight-cache");
    const modelVersionHash = "model-hash-1234";

    await cache.writePrecomputedSunlightManifest({
      artifactFormatVersion: 2,
      region: "lausanne",
      modelVersionHash,
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
      tileSizeMeters: 250,
      tileIds: ["tile-a"],
      failedTileIds: [],
      bbox: {
        minLon: 6.54,
        minLat: 46.49,
        maxLon: 6.74,
        maxLat: 46.62,
      },
      generatedAt: "2026-03-14T09:00:00.000Z",
      complete: false,
    });

    await cache.writePrecomputedSunlightTile({
      artifactFormatVersion: 2,
      region: "lausanne",
      modelVersionHash,
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
      tile: {
        tileId: "tile-a",
        tileSizeMeters: 250,
        minEasting: 2538000,
        minNorthing: 1152000,
        maxEasting: 2538250,
        maxNorthing: 1152250,
        bbox: {
          minLon: 6.60,
          minLat: 46.52,
          maxLon: 6.61,
          maxLat: 46.53,
        },
      },
      points: [
        {
          id: "ix1-iy2",
          lat: 46.5225,
          lon: 6.6005,
          lv95Easting: 2538000.5,
          lv95Northing: 1152000.5,
          ix: 1,
          iy: 2,
          insideBuilding: false,
          indoorBuildingId: null,
          outdoorIndex: 0,
          pointElevationMeters: 520,
        },
      ],
      frames: [
        {
          index: 0,
          localTime: "09:15",
          utcTime: "2026-03-08T08:15:00.000Z",
          sunnyCount: 1,
          sunnyCountNoVegetation: 1,
          sunMask: new Uint8Array([1]),
          sunMaskNoVegetation: new Uint8Array([1]),
          terrainBlockedMask: new Uint8Array([0]),
          buildingsBlockedMask: new Uint8Array([0]),
          vegetationBlockedMask: new Uint8Array([0]),
          diagnostics: {
            horizonAngleDegByPoint: [null],
            buildingBlockerIdByPoint: [null],
            buildingBlockerDistanceMetersByPoint: [null],
            vegetationBlockerDistanceMetersByPoint: [null],
          },
        },
      ],
      model: {
        terrainHorizonMethod: "mock-terrain",
        buildingsShadowMethod: "mock-buildings",
        vegetationShadowMethod: "mock-vegetation",
        algorithmVersion: "sunlight-cache-v2",
        shadowCalibration: {
          buildingHeightBiasMeters: 0,
        },
      },
      warnings: [],
      stats: {
        gridPointCount: 1,
        pointCount: 1,
        indoorPointsExcluded: 0,
        pointsWithElevation: 1,
        pointsWithoutElevation: 0,
        totalEvaluations: 1,
        elapsedMs: 1,
      },
    });

    const manifest = await cache.loadPrecomputedSunlightManifest({
      region: "lausanne",
      modelVersionHash,
      date: "2026-03-08",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
    });
    const tile = await cache.loadPrecomputedSunlightTile({
      region: "lausanne",
      modelVersionHash,
      date: "2026-03-08",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
      tileId: "tile-a",
    });

    expect(manifest?.tileIds).toEqual(["tile-a"]);
    expect(tile?.points[0]?.id).toBe("ix1-iy2");
    expect(tile?.frames[0]?.localTime).toBe("09:15");

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("detects atlas-only shard caches as model candidates", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mappy-hour-cache-"));
    process.env.MAPPY_DATA_ROOT = tempRoot;
    vi.resetModules();

    const cache = await import("./sunlight-cache");
    const atlasDir = path.join(
      tempRoot,
      "cache",
      "sunlight",
      "geneve",
      "model-sharded",
      "g1",
      "atlas",
      "r0.75",
    );
    await fs.mkdir(atlasDir, { recursive: true });
    await fs.writeFile(
      path.join(atlasDir, "e2500000_n1118000_s250.atlas.shards.json"),
      "{}",
    );

    await expect(
      cache.findCachedModelVersionHash({
        region: "geneve",
        date: "2026-05-11",
        gridStepMeters: 1,
        sampleEveryMinutes: 15,
        startLocalTime: "06:00",
        endLocalTime: "21:00",
      }),
    ).resolves.toEqual([
      {
        modelVersionHash: "model-sharded",
        timeWindows: [{ startLocalTime: "06:00", endLocalTime: "21:00" }],
      },
    ]);
  });

  it("returns null when the lookup model version does not match stored artifacts", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mappy-hour-cache-"));
    process.env.MAPPY_DATA_ROOT = tempRoot;
    vi.resetModules();

    const cache = await import("./sunlight-cache");
    const modelVersionHash = "model-hash-1234";

    await cache.writePrecomputedSunlightManifest({
      artifactFormatVersion: 2,
      region: "lausanne",
      modelVersionHash,
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
      tileSizeMeters: 250,
      tileIds: ["tile-a"],
      failedTileIds: [],
      bbox: {
        minLon: 6.54,
        minLat: 46.49,
        maxLon: 6.74,
        maxLat: 46.62,
      },
      generatedAt: "2026-03-14T09:00:00.000Z",
      complete: true,
    });

    await cache.writePrecomputedSunlightTile({
      artifactFormatVersion: 2,
      region: "lausanne",
      modelVersionHash,
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
      tile: {
        tileId: "tile-a",
        tileSizeMeters: 250,
        minEasting: 2538000,
        minNorthing: 1152000,
        maxEasting: 2538250,
        maxNorthing: 1152250,
        bbox: {
          minLon: 6.60,
          minLat: 46.52,
          maxLon: 6.61,
          maxLat: 46.53,
        },
      },
      points: [],
      frames: [],
      model: {
        terrainHorizonMethod: "mock-terrain",
        buildingsShadowMethod: "mock-buildings",
        vegetationShadowMethod: "mock-vegetation",
        algorithmVersion: "sunlight-cache-v2",
        shadowCalibration: {
          buildingHeightBiasMeters: 0,
        },
      },
      warnings: [],
      stats: {
        gridPointCount: 0,
        pointCount: 0,
        indoorPointsExcluded: 0,
        pointsWithElevation: 0,
        pointsWithoutElevation: 0,
        totalEvaluations: 0,
        elapsedMs: 0,
      },
    });

    const manifest = await cache.loadPrecomputedSunlightManifest({
      region: "lausanne",
      modelVersionHash: "other-model-version",
      date: "2026-03-08",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
    });
    const tile = await cache.loadPrecomputedSunlightTile({
      region: "lausanne",
      modelVersionHash: "other-model-version",
      date: "2026-03-08",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
      tileId: "tile-a",
    });

    expect(manifest).toBeNull();
    expect(tile).toBeNull();

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("returns null when manifest or tile format versions are incompatible", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mappy-hour-cache-"));
    process.env.MAPPY_DATA_ROOT = tempRoot;
    vi.resetModules();

    const cache = await import("./sunlight-cache");
    const { getSunlightCacheStorage } = await import("./sunlight-cache-storage");
    const storage = getSunlightCacheStorage();

    const manifestPath = cache.getPrecomputedSunlightManifestPath({
      region: "lausanne",
      modelVersionHash: "model-hash-1234",
      date: "2026-03-08",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
    });
    const tilePath = cache.getPrecomputedSunlightTilePath({
      region: "lausanne",
      modelVersionHash: "model-hash-1234",
      date: "2026-03-08",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
      tileId: "tile-a",
    });

    await storage.writeText(
      manifestPath,
      JSON.stringify({
        artifactFormatVersion: 1,
        region: "lausanne",
        modelVersionHash: "model-hash-1234",
        date: "2026-03-08",
        timezone: "Europe/Zurich",
        gridStepMeters: 5,
        sampleEveryMinutes: 15,
        startLocalTime: "00:00",
        endLocalTime: "23:59",
        tileSizeMeters: 250,
        tileIds: ["tile-a"],
        failedTileIds: [],
        bbox: {
          minLon: 6.54,
          minLat: 46.49,
          maxLon: 6.74,
          maxLat: 46.62,
        },
        generatedAt: "2026-03-14T09:00:00.000Z",
        complete: true,
      }),
    );
    await storage.writeBuffer(
      tilePath,
      await gzip(
        Buffer.from(
          JSON.stringify({
            artifactFormatVersion: 1,
            region: "lausanne",
            modelVersionHash: "model-hash-1234",
            date: "2026-03-08",
            timezone: "Europe/Zurich",
            gridStepMeters: 5,
            sampleEveryMinutes: 15,
            startLocalTime: "00:00",
            endLocalTime: "23:59",
            tile: {
              tileId: "tile-a",
              tileSizeMeters: 250,
              minEasting: 2538000,
              minNorthing: 1152000,
              maxEasting: 2538250,
              maxNorthing: 1152250,
              bbox: {
                minLon: 6.60,
                minLat: 46.52,
                maxLon: 6.61,
                maxLat: 46.53,
              },
            },
            points: [],
            frames: [],
            model: {
              terrainHorizonMethod: "mock-terrain",
              buildingsShadowMethod: "mock-buildings",
              vegetationShadowMethod: "mock-vegetation",
              algorithmVersion: "sunlight-cache-v1",
              shadowCalibration: {
                buildingHeightBiasMeters: 0,
              },
            },
            warnings: [],
            stats: {
              gridPointCount: 0,
              pointCount: 0,
              indoorPointsExcluded: 0,
              pointsWithElevation: 0,
              pointsWithoutElevation: 0,
              totalEvaluations: 0,
              elapsedMs: 0,
            },
          }),
        ),
      ),
    );

    const manifest = await cache.loadPrecomputedSunlightManifest({
      region: "lausanne",
      modelVersionHash: "model-hash-1234",
      date: "2026-03-08",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
    });
    const tile = await cache.loadPrecomputedSunlightTile({
      region: "lausanne",
      modelVersionHash: "model-hash-1234",
      date: "2026-03-08",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "00:00",
      endLocalTime: "23:59",
      tileId: "tile-a",
    });

    expect(manifest).toBeNull();
    expect(tile).toBeNull();

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  // ── Atlas-only fallback selects multiple orphan hashes, current must win ──
  //
  // Regression coverage for the silent bug that fed cache-only SSE requests
  // an atlas precomputed under a degraded pipeline (`terrainHorizonMethod="none"`,
  // no horizon mask). When `m{sample}/` is absent for every hash on disk,
  // `findCachedModelVersionHash` falls back to scanning `atlas/r*/` and
  // returns every hash that has at least one atlas file — including orphans
  // alongside the current hash. The caller (streamTilesForBbox, places/windows)
  // then has to know which hash is "the right one".
  //
  // These tests pin the contract:
  //   (a) findCachedModelVersionHash returns the orphan candidates so the
  //       caller has the option to fall through if the current hash isn't
  //       covering the bbox at all.
  //   (b) promoteCurrentHashCandidate must reorder so the current hash leads,
  //       independent of `fs.readdir` order (which is non-portable).
  describe("findCachedModelVersionHash + promoteCurrentHashCandidate", () => {
    it("returns every hash with atlas files when no m{sample}/ matches", async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mappy-hour-cache-"));
      process.env.MAPPY_DATA_ROOT = tempRoot;
      vi.resetModules();

      const cache = await import("./sunlight-cache");

      // Three hashes for "lausanne", each with an atlas file but no m30/ dir.
      // Hash names chosen so alphabetical sort would put orphans first — this
      // reproduces our real-world Windows fs.readdir ordering trap.
      const hashes = ["aaa-orphan", "bbb-orphan", "fff-current"];
      for (const hash of hashes) {
        const atlasDir = path.join(
          tempRoot,
          "cache",
          "sunlight",
          "lausanne",
          hash,
          "g1",
          "atlas",
          "r0.75",
        );
        await fs.mkdir(atlasDir, { recursive: true });
        await fs.writeFile(
          path.join(atlasDir, "e2538250_n1152250_s250.atlas.bin.gz"),
          Buffer.alloc(0),
        );
      }

      const candidates = await cache.findCachedModelVersionHash({
        region: "lausanne",
        date: "2029-12-16",
        gridStepMeters: 1,
        sampleEveryMinutes: 30,
        startLocalTime: "06:00",
        endLocalTime: "21:00",
      });

      // All three are returned — caller has full visibility into orphans.
      expect(candidates.map((c) => c.modelVersionHash).sort()).toEqual([
        "aaa-orphan",
        "bbb-orphan",
        "fff-current",
      ]);
      // Each candidate uses the requested time window as a stand-in (atlas
      // is date-agnostic, so we trust the caller's range).
      for (const c of candidates) {
        expect(c.timeWindows).toEqual([
          { startLocalTime: "06:00", endLocalTime: "21:00" },
        ]);
      }

      await fs.rm(tempRoot, { recursive: true, force: true });
    });

    it("promoteCurrentHashCandidate moves the current hash to index 0", async () => {
      const { promoteCurrentHashCandidate } = await import("./sunlight-cache");
      const input = [
        { modelVersionHash: "aaa-orphan", timeWindows: [] },
        { modelVersionHash: "bbb-orphan", timeWindows: [] },
        { modelVersionHash: "fff-current", timeWindows: [] },
      ];
      const out = promoteCurrentHashCandidate(input, "fff-current");
      expect(out.map((c) => c.modelVersionHash)).toEqual([
        "fff-current",
        "aaa-orphan",
        "bbb-orphan",
      ]);
      // Input must NOT be mutated — the caller may still want the original
      // ordering for diagnostics.
      expect(input.map((c) => c.modelVersionHash)).toEqual([
        "aaa-orphan",
        "bbb-orphan",
        "fff-current",
      ]);
    });

    it("promoteCurrentHashCandidate is a no-op when current hash is already first", async () => {
      const { promoteCurrentHashCandidate } = await import("./sunlight-cache");
      const input = [
        { modelVersionHash: "fff-current", timeWindows: [] },
        { modelVersionHash: "aaa-orphan", timeWindows: [] },
      ];
      const out = promoteCurrentHashCandidate(input, "fff-current");
      expect(out.map((c) => c.modelVersionHash)).toEqual([
        "fff-current",
        "aaa-orphan",
      ]);
    });

    it("promoteCurrentHashCandidate is a no-op when current hash is absent", async () => {
      const { promoteCurrentHashCandidate } = await import("./sunlight-cache");
      const input = [
        { modelVersionHash: "aaa-orphan", timeWindows: [] },
        { modelVersionHash: "bbb-orphan", timeWindows: [] },
      ];
      const out = promoteCurrentHashCandidate(input, "zzz-not-on-disk");
      expect(out.map((c) => c.modelVersionHash)).toEqual([
        "aaa-orphan",
        "bbb-orphan",
      ]);
    });

    it("promoteCurrentHashCandidate is a no-op when currentHash is null or empty", async () => {
      // Reproduces the cache-only-deploy code path where
      // `getSunlightModelVersion` may throw (manifests absent) and the caller
      // falls back to the original candidate ordering.
      const { promoteCurrentHashCandidate } = await import("./sunlight-cache");
      const input = [
        { modelVersionHash: "aaa-orphan", timeWindows: [] },
        { modelVersionHash: "fff-current", timeWindows: [] },
      ];
      expect(
        promoteCurrentHashCandidate(input, null).map((c) => c.modelVersionHash),
      ).toEqual(["aaa-orphan", "fff-current"]);
      expect(
        promoteCurrentHashCandidate(input, "").map((c) => c.modelVersionHash),
      ).toEqual(["aaa-orphan", "fff-current"]);
    });
  });
});
