import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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

    await cache.writePrecomputedSunlightManifest({
      version: 1,
      region: "lausanne",
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
    });

    await cache.writePrecomputedSunlightTile({
      version: 1,
      region: "lausanne",
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
        },
      ],
      model: {
        terrainHorizonMethod: "mock-terrain",
        buildingsShadowMethod: "mock-buildings",
        vegetationShadowMethod: "mock-vegetation",
        shadowCalibration: {
          observerHeightMeters: 0,
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
      date: "2026-03-08",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
    });
    const tile = await cache.loadPrecomputedSunlightTile({
      region: "lausanne",
      date: "2026-03-08",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      tileId: "tile-a",
    });

    expect(manifest?.tileIds).toEqual(["tile-a"]);
    expect(tile?.points[0]?.id).toBe("ix1-iy2");
    expect(tile?.frames[0]?.localTime).toBe("09:15");

    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});
