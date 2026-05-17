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

  it("persists the assignment atomically with no leftover .tmp file (ADR-0023)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mappy-horizon-atomic-"));
    process.env.MAPPY_DATA_ROOT = tempRoot;
    vi.resetModules();

    vi.doMock("./dynamic-horizon-mask", () => ({
      buildDynamicHorizonMask: vi.fn(async () => createMask(5)),
    }));

    const { resolveAdaptiveTerrainHorizonForTile } = await import(
      "./adaptive-horizon-sharing"
    );
    await resolveAdaptiveTerrainHorizonForTile({
      region: "lausanne",
      modelVersionHash: "model-atomic",
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

    // Walk the assignment tree, assert no .tmp residue and assert the final
    // JSON file is valid (the assignment was written atomically).
    const allFiles: string[] = [];
    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          allFiles.push(full);
        }
      }
    }
    await walk(tempRoot);

    const tmpLeftovers = allFiles.filter((p) => p.endsWith(".tmp"));
    expect(tmpLeftovers).toEqual([]);

    const jsonFiles = allFiles.filter((p) => p.endsWith(".json"));
    expect(jsonFiles.length).toBeGreaterThan(0);
    for (const jsonPath of jsonFiles) {
      const raw = await fs.readFile(jsonPath, "utf8");
      // Must round-trip cleanly — this is what was broken before ADR-0023.
      expect(() => JSON.parse(raw)).not.toThrow();
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("quarantines a corrupt assignment JSON on read and returns a fresh empty one (ADR-0023)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mappy-horizon-corrupt-"));
    process.env.MAPPY_DATA_ROOT = tempRoot;
    vi.resetModules();

    vi.doMock("./dynamic-horizon-mask", () => ({
      buildDynamicHorizonMask: vi.fn(async () => createMask(5)),
    }));

    const { resolveAdaptiveTerrainHorizonForTile } = await import(
      "./adaptive-horizon-sharing"
    );

    // First call: produces a clean assignment file.
    const tile = {
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
    };
    const commonParams = {
      region: "lausanne" as const,
      modelVersionHash: "model-corrupt",
      tile,
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      sampleEveryMinutes: 15,
      startLocalTime: "08:00",
      endLocalTime: "10:00",
      gridStepMeters: 5,
    };

    await resolveAdaptiveTerrainHorizonForTile(commonParams);

    // Locate the written .json file.
    const allFiles: string[] = [];
    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          allFiles.push(full);
        }
      }
    }
    await walk(tempRoot);
    const jsonFiles = allFiles.filter((p) => p.endsWith(".json"));
    expect(jsonFiles.length).toBe(1);
    const jsonPath = jsonFiles[0];

    // Append trailing garbage to simulate the legacy non-atomic-write
    // corruption pattern ("Unexpected non-whitespace character after JSON").
    await fs.appendFile(jsonPath, "{trailing-garbage}", "utf8");

    // Reset module cache so the in-memory assignmentCache is empty and the
    // next call hits the corrupt file from disk.
    vi.resetModules();
    vi.doMock("./dynamic-horizon-mask", () => ({
      buildDynamicHorizonMask: vi.fn(async () => createMask(5)),
    }));
    const reloaded = await import("./adaptive-horizon-sharing");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolution = await reloaded.resolveAdaptiveTerrainHorizonForTile(
      commonParams,
    );

    // The run should not throw and should produce a usable mask.
    expect(resolution.horizonMask).not.toBeNull();

    // The corrupt file must have been renamed with a `.corrupt-<stamp>`
    // suffix and have no `.json` extension on the new name.
    const afterFiles: string[] = [];
    await (async function walk2(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk2(full);
        } else {
          afterFiles.push(full);
        }
      }
    })(tempRoot);

    const quarantined = afterFiles.filter((p) => /\.corrupt-/.test(p));
    expect(quarantined.length).toBe(1);
    expect(quarantined[0].endsWith(".json")).toBe(false);

    // A fresh, valid JSON file should have been written in place of the
    // corrupt one (via the atomic write path).
    const liveJson = afterFiles.filter((p) => p.endsWith(".json"));
    expect(liveJson.length).toBe(1);
    const raw = await fs.readFile(liveJson[0], "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

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
