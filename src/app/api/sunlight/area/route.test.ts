import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  aggregateDailyAreaFromArtifacts,
  aggregateInstantAreaFromArtifacts,
  resolveSunlightTilesForBbox,
} from "@/lib/precompute/sunlight-tile-service";
import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import type { HorizonMask } from "@/lib/sun/horizon-mask";

import { POST } from "./route";

interface MockContextOverrides {
  insideBuilding?: boolean;
  indoorBuildingId?: string | null;
  pointElevationMeters?: number | null;
  terrainHorizonMethod?: string;
  horizonMask?: HorizonMask | null;
}

function createMockContext(
  lat: number,
  lon: number,
  overrides: MockContextOverrides = {},
) {
  return {
    pointLv95: {
      easting: lon * 100_000,
      northing: lat * 100_000,
    },
    insideBuilding: overrides.insideBuilding ?? false,
    indoorBuildingId: overrides.indoorBuildingId ?? null,
    pointElevationMeters: overrides.pointElevationMeters ?? 520,
    terrainHorizonMethod: overrides.terrainHorizonMethod ?? "mock-terrain",
    buildingsShadowMethod: "mock-buildings",
    warnings: [],
    horizonMask: overrides.horizonMask ?? null,
    buildingShadowEvaluator: undefined,
    vegetationShadowEvaluator: undefined,
  };
}

vi.mock("@/lib/precompute/sunlight-tile-service", () => ({
  resolveSunlightTilesForBbox: vi.fn(async () => null),
  aggregateInstantAreaFromArtifacts: vi.fn(),
  aggregateDailyAreaFromArtifacts: vi.fn(),
}));

vi.mock("@/lib/sun/evaluation-context", () => ({
  buildPointEvaluationContext: vi.fn(async (lat: number, lon: number) =>
    createMockContext(lat, lon),
  ),
}));

vi.mock("@/lib/sun/dynamic-horizon-mask", () => ({
  buildDynamicHorizonMask: vi.fn(async () => null),
}));

describe("POST /api/sunlight/area", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveSunlightTilesForBbox).mockResolvedValue(null);
  });

  it(
    "returns a valid daily area payload without running a web server",
    async () => {
    vi.mocked(buildPointEvaluationContext).mockImplementation(async (lat, lon) =>
      createMockContext(lat, lon),
    );

    const payload = {
      bbox: [6.599447, 46.522107, 6.601426, 46.523137],
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      mode: "daily",
      sampleEveryMinutes: 30,
      gridStepMeters: 10,
      maxPoints: 3000,
    };

    const request = new Request("http://localhost/api/sunlight/area", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const response = await POST(request);
    const json = (await response.json()) as {
      error?: string;
      mode: string;
      pointCount: number;
      points: Array<{
        sunnyMinutes: number;
      }>;
      stats: {
        elapsedMs: number;
      };
    };

    expect(response.status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.mode).toBe("daily");
    expect(json.pointCount).toBeGreaterThan(0);
    expect(json.pointCount).toBe(json.points.length);
    expect(json.points[0].sunnyMinutes).toBeGreaterThanOrEqual(0);
    expect(json.stats.elapsedMs).toBeGreaterThanOrEqual(0);
    },
    15_000,
  );

  it("returns a valid instant area payload without running a web server", async () => {
    vi.mocked(buildPointEvaluationContext).mockImplementation(async (lat, lon) =>
      createMockContext(lat, lon),
    );

    const payload = {
      bbox: [6.599447, 46.522107, 6.601426, 46.523137],
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      mode: "instant",
      localTime: "09:19",
      sampleEveryMinutes: 15,
      gridStepMeters: 5,
      maxPoints: 2000,
    };

    const request = new Request("http://localhost/api/sunlight/area", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const response = await POST(request);
    const json = (await response.json()) as {
      error?: string;
      mode: string;
      pointCount: number;
      points: unknown[];
      utcTime: string;
      stats: {
        elapsedMs: number;
        indoorPointsExcluded: number;
      };
      gridPointCount: number;
    };

    expect(response.status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.mode).toBe("instant");
    expect(Array.isArray(json.points)).toBe(true);
    expect(json.pointCount).toBeGreaterThan(0);
    expect(json.pointCount).toBe(json.points.length);
    expect(json.gridPointCount).toBeGreaterThanOrEqual(json.pointCount);
    expect(json.stats.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(json.stats.indoorPointsExcluded).toBeGreaterThanOrEqual(0);
  });

  it("does not reject when raw grid is large but outdoor points stay under maxPoints", async () => {
    let contextCallCount = 0;
    vi.mocked(buildPointEvaluationContext).mockImplementation(async (lat, lon) => {
      const currentCall = contextCallCount;
      contextCallCount += 1;

      if (currentCall >= 8) {
        return createMockContext(lat, lon, {
          insideBuilding: true,
          indoorBuildingId: `building-${currentCall}`,
          pointElevationMeters: null,
        });
      }

      return createMockContext(lat, lon);
    });

    const payload = {
      bbox: [6.599447, 46.522107, 6.601426, 46.523137],
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      mode: "instant",
      localTime: "09:19",
      sampleEveryMinutes: 15,
      gridStepMeters: 5,
      maxPoints: 10,
    };

    const request = new Request("http://localhost/api/sunlight/area", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const response = await POST(request);
    const json = (await response.json()) as {
      error?: string;
      pointCount: number;
      gridPointCount: number;
      stats: {
        indoorPointsExcluded: number;
      };
    };

    expect(response.status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.gridPointCount).toBeGreaterThan(json.pointCount);
    expect(json.pointCount).toBe(8);
    expect(json.stats.indoorPointsExcluded).toBeGreaterThan(0);
  });

  it("rejects only when outdoor points exceed maxPoints", async () => {
    vi.mocked(buildPointEvaluationContext).mockImplementation(async (lat, lon) =>
      createMockContext(lat, lon),
    );

    const payload = {
      bbox: [6.599447, 46.522107, 6.601426, 46.523137],
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      mode: "instant",
      localTime: "09:19",
      sampleEveryMinutes: 15,
      gridStepMeters: 5,
      maxPoints: 5,
    };

    const request = new Request("http://localhost/api/sunlight/area", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const response = await POST(request);
    const json = (await response.json()) as {
      error: string;
      detail: string;
    };

    expect(response.status).toBe(400);
    expect(json.error).toContain("Outdoor grid exceeds maxPoints limit");
    expect(json.detail).toContain("outdoor points");
  });

  it("includes dynamic terrain horizon debug data when DEM horizon is available", async () => {
    const dynamicMask = {
      generatedAt: "2026-03-08T00:00:00.000Z",
      method: "copernicus-dem30-runtime-raycast-v1",
      center: { lat: 46.5225, lon: 6.6005 },
      radiusKm: 120,
      binsDeg: Array.from({ length: 360 }, (_, index) => (index === 90 ? 18 : -2)),
      ridgePoints: [
        {
          azimuthDeg: 90,
          lat: 46.53,
          lon: 6.71,
          distanceMeters: 8450,
          horizonAngleDeg: 18,
          peakElevationMeters: 2280,
        },
      ],
    };

    vi.mocked(buildDynamicHorizonMask).mockResolvedValue(dynamicMask);
    vi.mocked(buildPointEvaluationContext).mockImplementation(
      async (lat, lon, options) =>
        createMockContext(lat, lon, {
          terrainHorizonMethod:
            options?.terrainHorizonOverride?.method ?? "mock-terrain",
          horizonMask: options?.terrainHorizonOverride ?? null,
        }),
    );

    const payload = {
      bbox: [6.599447, 46.522107, 6.6002, 46.5227],
      date: "2026-03-08",
      timezone: "Europe/Zurich",
      mode: "instant",
      localTime: "09:19",
      sampleEveryMinutes: 15,
      gridStepMeters: 20,
      maxPoints: 3000,
    };

    const request = new Request("http://localhost/api/sunlight/area", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const response = await POST(request);
    const json = (await response.json()) as {
      error?: string;
      model: {
        terrainHorizonMethod: string;
        terrainHorizonDebug: {
          center: { lat: number; lon: number };
          radiusKm: number;
          ridgePoints: Array<{ azimuthDeg: number; horizonAngleDeg: number }>;
        } | null;
      };
    };

    expect(response.status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.model.terrainHorizonMethod).toBe(dynamicMask.method);
    expect(json.model.terrainHorizonDebug).not.toBeNull();
    expect(json.model.terrainHorizonDebug?.ridgePoints.length).toBeGreaterThan(0);
    expect(json.model.terrainHorizonDebug?.ridgePoints[0]?.azimuthDeg).toBe(90);
  });

  it("serves instant area requests from precomputed cache when available", async () => {
    vi.mocked(resolveSunlightTilesForBbox).mockResolvedValue({
      region: "lausanne",
      modelVersionHash: "model-hash",
      artifacts: [],
      tileSizeMeters: 250,
      cache: {
        hit: true,
        layer: "L2",
        region: "lausanne",
        modelVersionHash: "model-hash",
        fullyCovered: true,
        tilesRequested: 1,
        tilesFromL1: 0,
        tilesFromL2: 1,
        tilesComputed: 0,
      },
    });
    vi.mocked(aggregateInstantAreaFromArtifacts).mockReturnValue({
      utcTime: "2026-03-08T08:15:00.000Z",
      pointCount: 1,
      gridPointCount: 1,
      points: [
        {
          id: "ix1-iy2",
          lat: 46.5225,
          lon: 6.6005,
          lv95Easting: 2_538_000.5,
          lv95Northing: 1_152_000.5,
          pointElevationMeters: 520,
          isSunny: true,
          terrainBlocked: false,
          buildingsBlocked: false,
          vegetationBlocked: false,
          altitudeDeg: 22.1,
          azimuthDeg: 132.4,
          horizonAngleDeg: null,
          buildingBlockerId: null,
          insideBuilding: false,
          indoorBuildingId: null,
        },
      ],
      warnings: [],
      stats: {
        pointsWithElevation: 1,
        pointsWithoutElevation: 0,
        indoorPointsExcluded: 0,
      },
      model: {
        terrainHorizonMethod: "precomputed-cache",
        buildingsShadowMethod: "precomputed-cache",
        vegetationShadowMethod: "precomputed-cache",
        terrainHorizonDebug: null,
        shadowCalibration: {
          buildingHeightBiasMeters: 0,
        },
      },
    });

    const request = new Request("http://localhost/api/sunlight/area", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bbox: [6.6001, 46.5221, 6.6009, 46.5228],
        date: "2026-03-08",
        timezone: "Europe/Zurich",
        mode: "instant",
        localTime: "09:15",
        sampleEveryMinutes: 15,
        gridStepMeters: 5,
        maxPoints: 3000,
      }),
    });

    const response = await POST(request);
    const json = (await response.json()) as {
      pointCount: number;
      points: Array<{ isSunny: boolean }>;
      cache: { hit?: boolean; layer?: string; region?: string; fullyCovered?: boolean };
    };

    expect(response.status).toBe(200);
    expect(json.pointCount).toBe(1);
    expect(json.points[0]?.isSunny).toBe(true);
    expect(json.cache.hit).toBe(true);
    expect(json.cache.layer).toBe("L2");
    expect(json.cache.region).toBe("lausanne");
    expect(json.cache.fullyCovered).toBe(true);
    expect(buildPointEvaluationContext).not.toHaveBeenCalled();
  });

  it("serves daily area requests from precomputed cache when available", async () => {
    vi.mocked(resolveSunlightTilesForBbox).mockResolvedValue({
      region: "lausanne",
      modelVersionHash: "model-hash",
      artifacts: [],
      tileSizeMeters: 250,
      cache: {
        hit: true,
        layer: "L2",
        region: "lausanne",
        modelVersionHash: "model-hash",
        fullyCovered: true,
        tilesRequested: 2,
        tilesFromL1: 0,
        tilesFromL2: 2,
        tilesComputed: 0,
      },
    });
    vi.mocked(aggregateDailyAreaFromArtifacts).mockReturnValue({
      pointCount: 1,
      gridPointCount: 2,
      points: [
        {
          id: "ix1-iy2",
          lat: 46.5225,
          lon: 6.6005,
          lv95Easting: 2_538_000.5,
          lv95Northing: 1_152_000.5,
          pointElevationMeters: 520,
          sunriseLocalTime: "2026-03-08 06:58:00",
          sunsetLocalTime: "2026-03-08 18:24:00",
          sunnyMinutes: 180,
          sunnyWindows: [
            {
              startLocalTime: "2026-03-08 09:00:00",
              endLocalTime: "2026-03-08 12:00:00",
              durationMinutes: 180,
            },
          ],
          insideBuilding: false,
          indoorBuildingId: null,
        },
      ],
      warnings: [],
      stats: {
        pointsWithElevation: 1,
        pointsWithoutElevation: 0,
        indoorPointsExcluded: 1,
      },
      model: {
        terrainHorizonMethod: "precomputed-cache",
        buildingsShadowMethod: "precomputed-cache",
        vegetationShadowMethod: "precomputed-cache",
        terrainHorizonDebug: null,
        shadowCalibration: {
          buildingHeightBiasMeters: 0,
        },
      },
    });

    const request = new Request("http://localhost/api/sunlight/area", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bbox: [6.6001, 46.5221, 6.6009, 46.5228],
        date: "2026-03-08",
        timezone: "Europe/Zurich",
        mode: "daily",
        sampleEveryMinutes: 15,
        gridStepMeters: 5,
        maxPoints: 3000,
        ignoreVegetation: true,
      }),
    });

    const response = await POST(request);
    const json = (await response.json()) as {
      pointCount: number;
      points: Array<{ sunnyMinutes: number }>;
      cache: { hit?: boolean; layer?: string; region?: string; fullyCovered?: boolean };
    };

    expect(response.status).toBe(200);
    expect(json.pointCount).toBe(1);
    expect(json.points[0]?.sunnyMinutes).toBe(180);
    expect(json.cache.hit).toBe(true);
    expect(json.cache.layer).toBe("L2");
    expect(json.cache.region).toBe("lausanne");
    expect(json.cache.fullyCovered).toBe(true);
    expect(aggregateDailyAreaFromArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        ignoreVegetation: true,
      }),
    );
    expect(buildPointEvaluationContext).not.toHaveBeenCalled();
  });
});
