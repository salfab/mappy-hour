import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPointEvaluationContext,
  buildSharedPointEvaluationSources,
} from "@/lib/sun/evaluation-context";

const { wgs84ToLv95Mock } = vi.hoisted(() => ({
  wgs84ToLv95Mock: vi.fn(() => ({ easting: 2_600_000, northing: 1_200_000 })),
}));

const {
  loadBuildingsObstacleIndexMock,
  findContainingBuildingMock,
  evaluateBuildingsShadowMock,
  evaluateBuildingsShadowTwoLevelMock,
  createDetailedBuildingShadowVerifierMock,
} = vi.hoisted(() => ({
  loadBuildingsObstacleIndexMock: vi.fn(),
  findContainingBuildingMock: vi.fn(),
  evaluateBuildingsShadowMock: vi.fn(),
  evaluateBuildingsShadowTwoLevelMock: vi.fn(),
  createDetailedBuildingShadowVerifierMock: vi.fn(() => vi.fn()),
}));

const { loadLausanneHorizonMaskMock } = vi.hoisted(() => ({
  loadLausanneHorizonMaskMock: vi.fn(),
}));

const {
  sampleSwissTerrainElevationLv95Mock,
  loadTerrainTilesForBoundsMock,
  sampleSwissTerrainElevationLv95FromTilesMock,
} = vi.hoisted(() => ({
  sampleSwissTerrainElevationLv95Mock: vi.fn(),
  loadTerrainTilesForBoundsMock: vi.fn(),
  sampleSwissTerrainElevationLv95FromTilesMock: vi.fn(),
}));

const {
  createVegetationShadowEvaluatorMock,
  loadVegetationSurfaceTilesForPointMock,
  loadVegetationSurfaceTilesForBoundsMock,
} = vi.hoisted(() => ({
  createVegetationShadowEvaluatorMock: vi.fn(() => vi.fn()),
  loadVegetationSurfaceTilesForPointMock: vi.fn(),
  loadVegetationSurfaceTilesForBoundsMock: vi.fn(),
}));

vi.mock("@/lib/geo/projection", () => ({
  wgs84ToLv95: wgs84ToLv95Mock,
}));

vi.mock("@/lib/sun/buildings-shadow", () => ({
  loadBuildingsObstacleIndex: loadBuildingsObstacleIndexMock,
  findContainingBuilding: findContainingBuildingMock,
  evaluateBuildingsShadow: evaluateBuildingsShadowMock,
  evaluateBuildingsShadowTwoLevel: evaluateBuildingsShadowTwoLevelMock,
  createDetailedBuildingShadowVerifier: createDetailedBuildingShadowVerifierMock,
}));

vi.mock("@/lib/sun/horizon-mask", () => ({
  loadLausanneHorizonMask: loadLausanneHorizonMaskMock,
}));

vi.mock("@/lib/terrain/swiss-terrain", () => ({
  sampleSwissTerrainElevationLv95: sampleSwissTerrainElevationLv95Mock,
  loadTerrainTilesForBounds: loadTerrainTilesForBoundsMock,
  sampleSwissTerrainElevationLv95FromTiles:
    sampleSwissTerrainElevationLv95FromTilesMock,
}));

vi.mock("@/lib/sun/vegetation-shadow", () => ({
  createVegetationShadowEvaluator: createVegetationShadowEvaluatorMock,
  loadVegetationSurfaceTilesForPoint: loadVegetationSurfaceTilesForPointMock,
  loadVegetationSurfaceTilesForBounds: loadVegetationSurfaceTilesForBoundsMock,
  DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS: 120,
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("reuses shared tile sources without per-point vegetation lookup", async () => {
    loadLausanneHorizonMaskMock.mockResolvedValue(createMockHorizonMask());
    loadBuildingsObstacleIndexMock.mockResolvedValue({
      method: "mock-buildings",
      obstacles: [],
      spatialGrid: undefined,
    });
    findContainingBuildingMock.mockReturnValue({
      insideBuilding: false,
      buildingId: null,
    });
    loadTerrainTilesForBoundsMock.mockResolvedValue([
      {
        filePath: "tile.tif",
        minX: 2_599_000,
        minY: 1_199_000,
        maxX: 2_601_000,
        maxY: 1_201_000,
        width: 100,
        height: 100,
        nodata: null,
        raster: new Float32Array(10_000).fill(510),
      },
    ]);
    sampleSwissTerrainElevationLv95FromTilesMock.mockReturnValue(510);
    loadVegetationSurfaceTilesForBoundsMock.mockResolvedValue([]);

    const sharedSources = await buildSharedPointEvaluationSources({
      lv95Bounds: {
        minX: 2_599_900,
        minY: 1_199_900,
        maxX: 2_600_100,
        maxY: 1_200_100,
      },
    });

    await buildPointEvaluationContext(46.5, 6.6, {
      skipTerrainSamplingWhenIndoor: true,
      sharedSources,
    });

    expect(loadTerrainTilesForBoundsMock).toHaveBeenCalledTimes(1);
    expect(sampleSwissTerrainElevationLv95FromTilesMock).toHaveBeenCalledTimes(1);
    expect(loadVegetationSurfaceTilesForPointMock).not.toHaveBeenCalled();
    expect(sampleSwissTerrainElevationLv95Mock).not.toHaveBeenCalled();
  });

  it("uses detailed building verification by default", async () => {
    loadLausanneHorizonMaskMock.mockResolvedValue(createMockHorizonMask());
    loadBuildingsObstacleIndexMock.mockResolvedValue({
      method: "mock-buildings",
      obstacles: [],
      spatialGrid: undefined,
    });
    findContainingBuildingMock.mockReturnValue({
      insideBuilding: false,
      buildingId: null,
    });
    sampleSwissTerrainElevationLv95Mock.mockResolvedValue(510);
    loadVegetationSurfaceTilesForPointMock.mockResolvedValue(null);
    evaluateBuildingsShadowTwoLevelMock.mockReturnValue({
      blocked: false,
      blockerId: null,
      blockerDistanceMeters: null,
      blockerAltitudeAngleDeg: null,
      checkedObstaclesCount: 0,
    });

    const context = await buildPointEvaluationContext(46.5, 6.6, {
      skipTerrainSamplingWhenIndoor: true,
    });

    expect(context.buildingShadowEvaluator).toBeDefined();
    context.buildingShadowEvaluator?.({ azimuthDeg: 180, altitudeDeg: 20 });

    expect(createDetailedBuildingShadowVerifierMock).toHaveBeenCalledTimes(1);
    expect(evaluateBuildingsShadowTwoLevelMock).toHaveBeenCalledTimes(1);
    expect(evaluateBuildingsShadowMock).not.toHaveBeenCalled();
    expect(context.buildingsShadowMethod).toContain("detailed-direct-v1");
  });

  it("forwards allowed blocker ids into the building evaluator", async () => {
    loadLausanneHorizonMaskMock.mockResolvedValue(createMockHorizonMask());
    loadBuildingsObstacleIndexMock.mockResolvedValue({
      method: "mock-buildings",
      obstacles: [],
      spatialGrid: undefined,
    });
    findContainingBuildingMock.mockReturnValue({
      insideBuilding: false,
      buildingId: null,
    });
    sampleSwissTerrainElevationLv95Mock.mockResolvedValue(510);
    loadVegetationSurfaceTilesForPointMock.mockResolvedValue(null);
    evaluateBuildingsShadowTwoLevelMock.mockReturnValue({
      blocked: false,
      blockerId: null,
      blockerDistanceMeters: null,
      blockerAltitudeAngleDeg: null,
      checkedObstaclesCount: 0,
    });
    const allowed = new Set(["b-1"]);

    const context = await buildPointEvaluationContext(46.5, 6.6, {
      skipTerrainSamplingWhenIndoor: true,
      buildingShadowAllowedIds: allowed,
    });

    context.buildingShadowEvaluator?.({ azimuthDeg: 190, altitudeDeg: 18 });
    expect(evaluateBuildingsShadowTwoLevelMock).toHaveBeenCalledTimes(1);
    expect(evaluateBuildingsShadowTwoLevelMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        allowedBlockerIds: allowed,
      }),
    );
  });
});
