import { describe, expect, it, vi } from "vitest";

import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";

const { wgs84ToLv95Mock } = vi.hoisted(() => ({
  wgs84ToLv95Mock: vi.fn(() => ({ easting: 2_600_000, northing: 1_200_000 })),
}));

const {
  loadBuildingsObstacleIndexMock,
  findContainingBuildingMock,
  evaluateBuildingsShadowMock,
} = vi.hoisted(() => ({
  loadBuildingsObstacleIndexMock: vi.fn(),
  findContainingBuildingMock: vi.fn(),
  evaluateBuildingsShadowMock: vi.fn(),
}));

const { loadLausanneHorizonMaskMock } = vi.hoisted(() => ({
  loadLausanneHorizonMaskMock: vi.fn(),
}));

const { sampleSwissTerrainElevationLv95Mock } = vi.hoisted(() => ({
  sampleSwissTerrainElevationLv95Mock: vi.fn(),
}));

const {
  createVegetationShadowEvaluatorMock,
  loadVegetationSurfaceTilesForPointMock,
} = vi.hoisted(() => ({
  createVegetationShadowEvaluatorMock: vi.fn(() => vi.fn()),
  loadVegetationSurfaceTilesForPointMock: vi.fn(),
}));

vi.mock("@/lib/geo/projection", () => ({
  wgs84ToLv95: wgs84ToLv95Mock,
}));

vi.mock("@/lib/sun/buildings-shadow", () => ({
  loadBuildingsObstacleIndex: loadBuildingsObstacleIndexMock,
  findContainingBuilding: findContainingBuildingMock,
  evaluateBuildingsShadow: evaluateBuildingsShadowMock,
}));

vi.mock("@/lib/sun/horizon-mask", () => ({
  loadLausanneHorizonMask: loadLausanneHorizonMaskMock,
}));

vi.mock("@/lib/terrain/swiss-terrain", () => ({
  sampleSwissTerrainElevationLv95: sampleSwissTerrainElevationLv95Mock,
}));

vi.mock("@/lib/sun/vegetation-shadow", () => ({
  createVegetationShadowEvaluator: createVegetationShadowEvaluatorMock,
  loadVegetationSurfaceTilesForPoint: loadVegetationSurfaceTilesForPointMock,
  vegetationShadowMethod: "mock-vegetation",
}));

function createMockHorizonMask() {
  return {
    generatedAt: "2026-03-08T00:00:00.000Z",
    method: "mock-terrain",
    center: { lat: 46.5, lon: 6.6 },
    radiusKm: 80,
    binsDeg: Array.from({ length: 360 }, () => 0),
  };
}

describe("buildPointEvaluationContext vegetation warnings", () => {
  it("does not warn about missing vegetation raster when point is indoor", async () => {
    loadLausanneHorizonMaskMock.mockResolvedValue(createMockHorizonMask());
    loadBuildingsObstacleIndexMock.mockResolvedValue({
      method: "mock-buildings",
      obstacles: [],
    });
    findContainingBuildingMock.mockReturnValue({
      insideBuilding: true,
      buildingId: "b-1",
    });
    sampleSwissTerrainElevationLv95Mock.mockResolvedValue(510);
    loadVegetationSurfaceTilesForPointMock.mockResolvedValue(null);

    const context = await buildPointEvaluationContext(46.5, 6.6, {
      skipTerrainSamplingWhenIndoor: true,
    });

    expect(context.insideBuilding).toBe(true);
    expect(context.warnings.some((warning) => warning.includes("vegetation surface"))).toBe(
      false,
    );
    expect(loadVegetationSurfaceTilesForPointMock).not.toHaveBeenCalled();
  });

  it("warns when vegetation raster lookup is required but unavailable", async () => {
    loadLausanneHorizonMaskMock.mockResolvedValue(createMockHorizonMask());
    loadBuildingsObstacleIndexMock.mockResolvedValue({
      method: "mock-buildings",
      obstacles: [],
    });
    findContainingBuildingMock.mockReturnValue({
      insideBuilding: false,
      buildingId: null,
    });
    sampleSwissTerrainElevationLv95Mock.mockResolvedValue(510);
    loadVegetationSurfaceTilesForPointMock.mockResolvedValue(null);

    const context = await buildPointEvaluationContext(46.5, 6.6, {
      skipTerrainSamplingWhenIndoor: true,
    });

    expect(context.insideBuilding).toBe(false);
    expect(context.warnings.some((warning) => warning.includes("vegetation surface"))).toBe(
      true,
    );
    expect(loadVegetationSurfaceTilesForPointMock).toHaveBeenCalledTimes(1);
  });
});
