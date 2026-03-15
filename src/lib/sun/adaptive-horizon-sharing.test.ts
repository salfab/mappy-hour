import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

function createMask(angleDeg: number) {
  return {
    generatedAt: "2026-03-15T00:00:00.000Z",
    method: "mock-horizon",
    center: { lat: 46.525, lon: 6.625 },
    radiusKm: 120,
    binsDeg: Array.from({ length: 360 }, () => angleDeg),
  };
}

describe("adaptive horizon sharing", () => {
  const originalDataRoot = process.env.MAPPY_DATA_ROOT;

  afterEach(async () => {
    process.env.MAPPY_DATA_ROOT = originalDataRoot;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("chooses shared mask when mismatch stays within budget", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mappy-horizon-share-"));
    process.env.MAPPY_DATA_ROOT = tempRoot;
    vi.resetModules();

    let callCount = 0;
    vi.doMock("./dynamic-horizon-mask", () => ({
      buildDynamicHorizonMask: vi.fn(async () => {
        callCount += 1;
        return createMask(5);
      }),
    }));

    const { resolveAdaptiveTerrainHorizonForTile } = await import(
      "./adaptive-horizon-sharing"
    );
    const resolution = await resolveAdaptiveTerrainHorizonForTile({
      region: "lausanne",
      modelVersionHash: "model-a",
      tile: {
        tileId: "e2538000_n1152000_s250",
        tileSizeMeters: 250,
        minEasting: 2_538_000,
        minNorthing: 1_152_000,
        maxEasting: 2_538_250,
        maxNorthing: 1_152_250,
        bbox: {
          minLon: 6.62,
          minLat: 46.52,
          maxLon: 6.63,
          maxLat: 46.53,
        },
      },
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      sampleEveryMinutes: 15,
      startLocalTime: "08:00",
      endLocalTime: "10:00",
      gridStepMeters: 5,
    });

    expect(resolution.strategy).toBe("shared");
    expect(resolution.horizonMask).not.toBeNull();
    expect(callCount).toBeGreaterThanOrEqual(2);

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("falls back to local mask when mismatch budget is exceeded", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mappy-horizon-local-"));
    process.env.MAPPY_DATA_ROOT = tempRoot;
    vi.resetModules();

    let callCount = 0;
    vi.doMock("./dynamic-horizon-mask", () => ({
      buildDynamicHorizonMask: vi.fn(async () => {
        callCount += 1;
        return callCount === 1 ? createMask(80) : createMask(-10);
      }),
    }));

    const { resolveAdaptiveTerrainHorizonForTile } = await import(
      "./adaptive-horizon-sharing"
    );
    const resolution = await resolveAdaptiveTerrainHorizonForTile({
      region: "lausanne",
      modelVersionHash: "model-b",
      tile: {
        tileId: "e2538250_n1152000_s250",
        tileSizeMeters: 250,
        minEasting: 2_538_250,
        minNorthing: 1_152_000,
        maxEasting: 2_538_500,
        maxNorthing: 1_152_250,
        bbox: {
          minLon: 6.63,
          minLat: 46.52,
          maxLon: 6.64,
          maxLat: 46.53,
        },
      },
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      sampleEveryMinutes: 15,
      startLocalTime: "08:00",
      endLocalTime: "12:00",
      gridStepMeters: 5,
    });

    expect(resolution.strategy).toBe("local");
    expect((resolution.diagnostics?.mismatchPointMinutes ?? 0) > 2).toBe(true);
    expect(resolution.horizonMask).not.toBeNull();

    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});
