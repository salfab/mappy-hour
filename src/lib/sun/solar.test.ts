import { describe, expect, it, vi } from "vitest";

import type { HorizonMask } from "@/lib/sun/horizon-mask";

import { evaluateInstantSunlight, type InstantSunlightProfiler } from "./solar";

function createUniformHorizonMask(angleDeg: number): HorizonMask {
  return {
    generatedAt: "2026-03-14T00:00:00.000Z",
    method: "unit-test",
    center: {
      lat: 46.52,
      lon: 6.63,
    },
    radiusKm: 40,
    binsDeg: Array.from({ length: 360 }, () => angleDeg),
  };
}

function createBuildingEvaluator(blocked: boolean) {
  return vi.fn(() => ({
    blocked,
    blockerId: blocked ? "b1" : null,
    blockerDistanceMeters: blocked ? 12 : null,
    blockerAltitudeAngleDeg: blocked ? 24 : null,
    checkedObstaclesCount: 7,
  }));
}

function createVegetationEvaluator(blocked: boolean) {
  return vi.fn(() => ({
    blocked,
    blockerDistanceMeters: blocked ? 8 : null,
    blockerAltitudeAngleDeg: blocked ? 18 : null,
    blockerSurfaceElevationMeters: blocked ? 520 : null,
    blockerClearanceMeters: blocked ? 2.3 : null,
    checkedSamplesCount: 6,
  }));
}

describe("evaluateInstantSunlight", () => {
  it("skips building and vegetation evaluators when sun is below astronomical horizon", () => {
    const buildingEvaluator = createBuildingEvaluator(true);
    const vegetationEvaluator = createVegetationEvaluator(true);

    const sample = evaluateInstantSunlight({
      lat: 46.52,
      lon: 6.63,
      utcDate: new Date("2026-01-01T00:00:00.000Z"),
      timeZone: "Europe/Zurich",
      horizonMask: createUniformHorizonMask(30),
      buildingShadowEvaluator: buildingEvaluator,
      vegetationShadowEvaluator: vegetationEvaluator,
    });

    expect(sample.aboveAstronomicalHorizon).toBe(false);
    expect(buildingEvaluator).not.toHaveBeenCalled();
    expect(vegetationEvaluator).not.toHaveBeenCalled();
  });

  it("short-circuits secondary blockers when terrain already blocks", () => {
    const buildingEvaluator = createBuildingEvaluator(true);
    const vegetationEvaluator = createVegetationEvaluator(true);

    const sample = evaluateInstantSunlight({
      lat: 46.52,
      lon: 6.63,
      utcDate: new Date("2026-06-21T12:00:00.000Z"),
      timeZone: "Europe/Zurich",
      horizonMask: createUniformHorizonMask(89),
      buildingShadowEvaluator: buildingEvaluator,
      vegetationShadowEvaluator: vegetationEvaluator,
    });

    expect(sample.aboveAstronomicalHorizon).toBe(true);
    expect(sample.terrainBlocked).toBe(true);
    expect(buildingEvaluator).not.toHaveBeenCalled();
    expect(vegetationEvaluator).not.toHaveBeenCalled();
    expect(sample.buildingsBlocked).toBe(false);
    expect(sample.vegetationBlocked).toBe(false);
    expect(sample.isSunny).toBe(false);
  });

  it("can still evaluate all blockers in explicit diagnostics mode", () => {
    const buildingEvaluator = createBuildingEvaluator(true);
    const vegetationEvaluator = createVegetationEvaluator(true);

    const sample = evaluateInstantSunlight({
      lat: 46.52,
      lon: 6.63,
      utcDate: new Date("2026-06-21T12:00:00.000Z"),
      timeZone: "Europe/Zurich",
      horizonMask: createUniformHorizonMask(89),
      buildingShadowEvaluator: buildingEvaluator,
      vegetationShadowEvaluator: vegetationEvaluator,
      evaluateAllBlockers: true,
    });

    expect(sample.terrainBlocked).toBe(true);
    expect(buildingEvaluator).toHaveBeenCalledTimes(1);
    expect(vegetationEvaluator).toHaveBeenCalledTimes(1);
    expect(sample.buildingsBlocked).toBe(true);
    expect(sample.vegetationBlocked).toBe(true);
    expect(sample.isSunny).toBe(false);
  });

  it("evaluates secondary blockers when terrain does not block", () => {
    const buildingEvaluator = createBuildingEvaluator(false);
    const vegetationEvaluator = createVegetationEvaluator(true);

    const sample = evaluateInstantSunlight({
      lat: 46.52,
      lon: 6.63,
      utcDate: new Date("2026-06-21T12:00:00.000Z"),
      timeZone: "Europe/Zurich",
      horizonMask: createUniformHorizonMask(-10),
      buildingShadowEvaluator: buildingEvaluator,
      vegetationShadowEvaluator: vegetationEvaluator,
    });

    expect(sample.terrainBlocked).toBe(false);
    expect(buildingEvaluator).toHaveBeenCalledTimes(1);
    expect(vegetationEvaluator).toHaveBeenCalledTimes(1);
    expect(sample.buildingsBlocked).toBe(false);
    expect(sample.vegetationBlocked).toBe(true);
    expect(sample.isSunny).toBe(false);
  });

  it("collects per-component profiling counters when profiler is provided", () => {
    const buildingEvaluator = createBuildingEvaluator(false);
    const vegetationEvaluator = createVegetationEvaluator(false);
    const profiler: InstantSunlightProfiler = {
      evaluations: 0,
      totalMs: 0,
      solarPositionMs: 0,
      terrainMs: 0,
      buildingsMs: 0,
      vegetationMs: 0,
      finalizeMs: 0,
      belowAstronomicalHorizonCount: 0,
      terrainCheckNeededCount: 0,
      terrainBlockedCount: 0,
      secondarySkippedByTerrainCount: 0,
      buildingsEvaluatorCalls: 0,
      vegetationEvaluatorCalls: 0,
    };

    evaluateInstantSunlight({
      lat: 46.52,
      lon: 6.63,
      utcDate: new Date("2026-06-21T12:00:00.000Z"),
      timeZone: "Europe/Zurich",
      horizonMask: createUniformHorizonMask(-10),
      buildingShadowEvaluator: buildingEvaluator,
      vegetationShadowEvaluator: vegetationEvaluator,
      profiler,
    });

    expect(profiler.evaluations).toBe(1);
    expect(profiler.totalMs).toBeGreaterThanOrEqual(0);
    expect(profiler.solarPositionMs).toBeGreaterThanOrEqual(0);
    expect(profiler.terrainMs).toBeGreaterThanOrEqual(0);
    expect(profiler.buildingsMs).toBeGreaterThanOrEqual(0);
    expect(profiler.vegetationMs).toBeGreaterThanOrEqual(0);
    expect(profiler.finalizeMs).toBeGreaterThanOrEqual(0);
    expect(profiler.buildingsEvaluatorCalls).toBe(1);
    expect(profiler.vegetationEvaluatorCalls).toBe(1);
  });

  it("uses localDateTimeOverride when provided", () => {
    const sample = evaluateInstantSunlight({
      lat: 46.52,
      lon: 6.63,
      utcDate: new Date("2026-06-21T12:00:00.000Z"),
      timeZone: "Europe/Zurich",
      localDateTimeOverride: "2099-12-31 23:59:59",
      horizonMask: createUniformHorizonMask(-10),
    });

    expect(sample.localTime).toBe("2099-12-31 23:59:59");
  });
});
