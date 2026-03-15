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
          sunMaskBase64: "AQ==",
          sunMaskNoVegetationBase64: "AQ==",
          terrainBlockedMaskBase64: "AA==",
          buildingsBlockedMaskBase64: "AA==",
          vegetationBlockedMaskBase64: "AA==",
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
});
