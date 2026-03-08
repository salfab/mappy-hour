import { describe, expect, it, vi } from "vitest";

import { isTerrainBlockedByHorizon } from "@/lib/sun/horizon-mask";

const { accessMock, readdirMock, fromFileMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  readdirMock: vi.fn(),
  fromFileMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    access: accessMock,
    readdir: readdirMock,
  },
  access: accessMock,
  readdir: readdirMock,
}));

vi.mock("geotiff", () => ({
  fromFile: fromFileMock,
}));

function buildSyntheticRaster(width: number, height: number): Float32Array {
  const raster = new Float32Array(width * height).fill(600);

  // Build a pronounced ridge east of the center to validate directional horizon detection.
  const ridgeCenterX = 130;
  const ridgeCenterY = 100;
  const ridgeRadius = 8;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - ridgeCenterX;
      const dy = y - ridgeCenterY;
      const insideRidge = dx * dx + dy * dy <= ridgeRadius * ridgeRadius;
      if (insideRidge) {
        raster[y * width + x] = 3200;
      }
    }
  }

  return raster;
}

describe("buildDynamicHorizonMask", () => {
  it("derives a higher horizon angle toward a DEM ridge and marks it as blocked", async () => {
    vi.resetModules();
    accessMock.mockReset();
    readdirMock.mockReset();
    fromFileMock.mockReset();

    const width = 201;
    const height = 201;
    const raster = buildSyntheticRaster(width, height);

    accessMock.mockResolvedValue(undefined);
    readdirMock.mockResolvedValue([
      {
        isFile: () => true,
        name: "synthetic.tif",
      },
    ]);
    fromFileMock.mockResolvedValue({
      getImage: async () => ({
        getBoundingBox: () => [5.9, 45.9, 6.1, 46.1] as [number, number, number, number],
        readRasters: async () => raster,
        getGDALNoData: () => null,
        getWidth: () => width,
        getHeight: () => height,
      }),
    });

    const { buildDynamicHorizonMask } = await import("./dynamic-horizon-mask");
    const mask = await buildDynamicHorizonMask({
      lat: 46,
      lon: 6,
      radiusKm: 8,
      stepMeters: 250,
      refractionCoefficient: 0,
    });

    expect(mask).not.toBeNull();
    if (!mask) {
      return;
    }

    const eastAngleDeg = mask.binsDeg[90];
    const westAngleDeg = mask.binsDeg[270];

    expect(eastAngleDeg).toBeGreaterThan(10);
    expect(eastAngleDeg).toBeGreaterThan(westAngleDeg + 5);

    expect(mask.ridgePoints).toBeDefined();
    expect(mask.ridgePoints?.length).toBe(360);
    const eastRidgePoint = mask.ridgePoints?.find((point) => point.azimuthDeg === 90);
    expect(eastRidgePoint).toBeDefined();
    expect(eastRidgePoint?.peakElevationMeters).toBeGreaterThan(2000);

    expect(isTerrainBlockedByHorizon(mask, 90, eastAngleDeg - 1)).toBe(true);
    expect(isTerrainBlockedByHorizon(mask, 90, eastAngleDeg + 3)).toBe(false);
  });
});
