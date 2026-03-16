import { describe, expect, it } from "vitest";

import {
  type BuildingShadowDebugPass,
  evaluateBuildingsShadow,
  evaluateBuildingsShadowTwoLevel,
  findContainingBuilding,
} from "./buildings-shadow";

interface TestObstacle {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  height: number;
  centerX: number;
  centerY: number;
  halfDiagonal: number;
  footprint: Array<{ x: number; y: number }>;
  footprintArea: number;
  sourceZip: string;
}

function createRectangleObstacle(params: {
  id: string;
  centerX: number;
  centerY: number;
  width: number;
  depth: number;
  maxZ: number;
}): TestObstacle {
  const minX = params.centerX - params.width / 2;
  const maxX = params.centerX + params.width / 2;
  const minY = params.centerY - params.depth / 2;
  const maxY = params.centerY + params.depth / 2;
  return {
    id: params.id,
    minX,
    minY,
    maxX,
    maxY,
    minZ: 0,
    maxZ: params.maxZ,
    height: params.maxZ,
    centerX: params.centerX,
    centerY: params.centerY,
    halfDiagonal: Math.hypot(params.width, params.depth) / 2,
    footprint: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
    footprintArea: params.width * params.depth,
    sourceZip: "test.zip",
  };
}

function buildSpatialGrid(obstacles: TestObstacle[], cellSizeMeters: number) {
  const cells: Record<string, number[]> = {};
  for (let i = 0; i < obstacles.length; i += 1) {
    const obstacle = obstacles[i];
    const minCellX = Math.floor(obstacle.minX / cellSizeMeters);
    const maxCellX = Math.floor(obstacle.maxX / cellSizeMeters);
    const minCellY = Math.floor(obstacle.minY / cellSizeMeters);
    const maxCellY = Math.floor(obstacle.maxY / cellSizeMeters);
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const key = `${cellX}:${cellY}`;
        if (!cells[key]) {
          cells[key] = [];
        }
        cells[key].push(i);
      }
    }
  }

  return {
    version: 1,
    cellSizeMeters,
    cells,
  };
}

describe("buildings shadow spatial index", () => {
  it("keeps shadow decision equivalent while reducing checked obstacles", () => {
    const blocker = createRectangleObstacle({
      id: "blocker",
      centerX: 0,
      centerY: 50,
      width: 20,
      depth: 20,
      maxZ: 35,
    });
    const distractors = Array.from({ length: 200 }, (_, index) =>
      createRectangleObstacle({
        id: `d${index}`,
        centerX: 300 + (index % 20) * 30,
        centerY: -300 - Math.floor(index / 20) * 30,
        width: 18,
        depth: 18,
        maxZ: 25,
      }),
    );
    const obstacles = [blocker, ...distractors];
    const spatialGrid = buildSpatialGrid(obstacles, 64);

    const baseline = evaluateBuildingsShadow(obstacles, {
      pointX: 0,
      pointY: 0,
      pointElevation: 0,
      solarAzimuthDeg: 0,
      solarAltitudeDeg: 15,
      maxDistanceMeters: 1200,
    });
    const indexed = evaluateBuildingsShadow(
      obstacles,
      {
        pointX: 0,
        pointY: 0,
        pointElevation: 0,
        solarAzimuthDeg: 0,
        solarAltitudeDeg: 15,
        maxDistanceMeters: 1200,
      },
      spatialGrid,
    );

    expect(indexed.blocked).toBe(baseline.blocked);
    expect(indexed.blockerId).toBe(baseline.blockerId);
    expect(indexed.blockerDistanceMeters).toBe(baseline.blockerDistanceMeters);
    expect(indexed.checkedObstaclesCount).toBeLessThanOrEqual(
      baseline.checkedObstaclesCount,
    );
  });

  it("keeps containment detection equivalent with and without spatial grid", () => {
    const obstacles = [
      createRectangleObstacle({
        id: "inside",
        centerX: 500,
        centerY: 500,
        width: 40,
        depth: 40,
        maxZ: 18,
      }),
      createRectangleObstacle({
        id: "other",
        centerX: 1200,
        centerY: 500,
        width: 40,
        depth: 40,
        maxZ: 18,
      }),
    ];
    const spatialGrid = buildSpatialGrid(obstacles, 64);

    const baseline = findContainingBuilding(obstacles, 500, 500);
    const indexed = findContainingBuilding(obstacles, 500, 500, spatialGrid);

    expect(indexed).toEqual(baseline);
    expect(indexed.insideBuilding).toBe(true);
    expect(indexed.buildingId).toBe("inside");
  });

  it("two-level refinement drops near-threshold false blocker when detailed verifier says clear", () => {
    const blocker = createRectangleObstacle({
      id: "blocker",
      centerX: 0,
      centerY: 50,
      width: 20,
      depth: 20,
      maxZ: 35,
    });

    const refined = evaluateBuildingsShadowTwoLevel(
      [blocker],
      {
        pointX: 0,
        pointY: 0,
        pointElevation: 0,
        solarAzimuthDeg: 0,
        solarAltitudeDeg: 40.5,
        maxDistanceMeters: 1200,
      },
      undefined,
      {
        nearThresholdDegrees: 2,
        detailedVerifier: () => ({
          blocked: false,
          blockerDistanceMeters: null,
        }),
      },
    );

    expect(refined.blocked).toBe(false);
    expect(refined.blockerId).toBe(null);
  });

  it("two-level refinement falls back to second blocker if first near-threshold blocker is rejected", () => {
    const first = createRectangleObstacle({
      id: "first",
      centerX: 0,
      centerY: 50,
      width: 20,
      depth: 20,
      maxZ: 35,
    });
    const second = createRectangleObstacle({
      id: "second",
      centerX: 0,
      centerY: 90,
      width: 20,
      depth: 20,
      maxZ: 85,
    });

    const refined = evaluateBuildingsShadowTwoLevel(
      [first, second],
      {
        pointX: 0,
        pointY: 0,
        pointElevation: 0,
        solarAzimuthDeg: 0,
        solarAltitudeDeg: 40.5,
        maxDistanceMeters: 1200,
      },
      undefined,
      {
        nearThresholdDegrees: 2,
        detailedVerifier: ({ blockerId }) => ({
          blocked: blockerId !== "first",
          blockerDistanceMeters: blockerId === "first" ? null : 90,
        }),
      },
    );

    expect(refined.blocked).toBe(true);
    expect(refined.blockerId).toBe("second");
  });

  it("altitude bound culling keeps decision while reducing checked obstacles", () => {
    const lowObstacles = Array.from({ length: 240 }, (_, index) =>
      createRectangleObstacle({
        id: `low-${index}`,
        centerX: -80 + (index % 24) * 8,
        centerY: 30 + Math.floor(index / 24) * 14,
        width: 6,
        depth: 6,
        maxZ: 502,
      }),
    );
    const tallBlocker = createRectangleObstacle({
      id: "tall-blocker",
      centerX: 0,
      centerY: 220,
      width: 20,
      depth: 20,
      maxZ: 800,
    });
    const obstacles = [...lowObstacles, tallBlocker];
    const spatialGrid = buildSpatialGrid(obstacles, 64);

    const noGrid = evaluateBuildingsShadow(obstacles, {
      pointX: 0,
      pointY: 0,
      pointElevation: 500,
      solarAzimuthDeg: 0,
      solarAltitudeDeg: 20,
      maxDistanceMeters: 1200,
    });
    const indexed = evaluateBuildingsShadow(
      obstacles,
      {
        pointX: 0,
        pointY: 0,
        pointElevation: 500,
        solarAzimuthDeg: 0,
        solarAltitudeDeg: 20,
        maxDistanceMeters: 1200,
      },
      spatialGrid,
    );

    expect(indexed.blocked).toBe(noGrid.blocked);
    expect(indexed.blockerId).toBe(noGrid.blockerId);
    expect(indexed.blocked).toBe(true);
    expect(indexed.blockerId).toBe("tall-blocker");
    expect(indexed.checkedObstaclesCount).toBeLessThanOrEqual(noGrid.checkedObstaclesCount);
    expect(indexed.checkedObstaclesCount).toBeLessThan(6);
  });

  it("emits debug stats for blockers skipped behind a closer blocker", () => {
    const near = createRectangleObstacle({
      id: "near",
      centerX: 0,
      centerY: 50,
      width: 18,
      depth: 18,
      maxZ: 40,
    });
    const far = createRectangleObstacle({
      id: "far",
      centerX: 0,
      centerY: 95,
      width: 18,
      depth: 18,
      maxZ: 60,
    });
    const obstacles = [near, far];
    const spatialGrid = buildSpatialGrid(obstacles, 64);
    const debugPasses: BuildingShadowDebugPass[] = [];

    const result = evaluateBuildingsShadow(
      obstacles,
      {
        pointX: 0,
        pointY: 0,
        pointElevation: 0,
        solarAzimuthDeg: 0,
        solarAltitudeDeg: 10,
        maxDistanceMeters: 1200,
        debugCollector: (debug) => {
          debugPasses.push(debug);
        },
      },
      spatialGrid,
    );

    expect(result.blocked).toBe(true);
    expect(result.blockerId).toBe("near");
    const debugPass = debugPasses.at(-1);
    if (!debugPass) {
      throw new Error("Expected debug collector to capture one pass.");
    }
    expect(debugPass.stats).toBeDefined();
    const skippedByCloser = debugPass.stats?.skippedByExistingCloserBlocker ?? 0;
    const wouldBlockButFarther = debugPass.stats?.wouldBlockButFarther ?? 0;
    expect(skippedByCloser + wouldBlockButFarther).toBeGreaterThan(0);
  });
});
