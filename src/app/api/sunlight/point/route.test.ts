import { describe, expect, it, vi } from "vitest";

import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import type { HorizonMask } from "@/lib/sun/horizon-mask";

import { POST } from "./route";

interface MockContextOverrides {
  terrainHorizonMethod?: string;
  horizonMask?: HorizonMask | null;
  insideBuilding?: boolean;
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
    indoorBuildingId: null,
    pointElevationMeters: 520,
    terrainHorizonMethod: overrides.terrainHorizonMethod ?? "mock-terrain",
    buildingsShadowMethod: "mock-buildings",
    warnings: [],
    horizonMask: overrides.horizonMask ?? null,
    buildingShadowEvaluator: undefined,
  };
}

vi.mock("@/lib/sun/evaluation-context", () => ({
  buildPointEvaluationContext: vi.fn(async (lat: number, lon: number) =>
    createMockContext(lat, lon),
  ),
}));

vi.mock("@/lib/sun/dynamic-horizon-mask", () => ({
  buildDynamicHorizonMask: vi.fn(async () => null),
}));

describe("POST /api/sunlight/point", () => {
  it("returns valid instant diagnostics without running a web server", async () => {
    vi.mocked(buildPointEvaluationContext).mockImplementation(async (lat, lon) =>
      createMockContext(lat, lon),
    );

    const request = new Request("http://localhost/api/sunlight/point", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        lat: 46.5227,
        lon: 6.6012,
        date: "2026-03-08",
        timezone: "Europe/Zurich",
        mode: "instant",
        localTime: "09:19",
      }),
    });

    const response = await POST(request);
    const json = (await response.json()) as {
      error?: string;
      mode: string;
      sample: {
        isSunny: boolean;
      };
      pointContext: {
        pointElevationMeters: number | null;
      };
      model: {
        terrainHorizonMethod: string;
      };
    };

    expect(response.status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.mode).toBe("instant");
    expect(typeof json.sample.isSunny).toBe("boolean");
    expect(json.pointContext.pointElevationMeters).toBeGreaterThan(0);
    expect(json.model.terrainHorizonMethod).toBe("mock-terrain");
  });

  it("includes dynamic horizon debug and selected ridge point when available", async () => {
    const dynamicMask = {
      generatedAt: "2026-03-08T00:00:00.000Z",
      method: "copernicus-dem30-runtime-raycast-v1",
      center: { lat: 46.5227, lon: 6.6012 },
      radiusKm: 120,
      binsDeg: Array.from({ length: 360 }, () => -2),
      ridgePoints: Array.from({ length: 360 }, (_, azimuthDeg) => ({
        azimuthDeg,
        lat: 46.5227,
        lon: 6.6012 + azimuthDeg * 0.00001,
        distanceMeters: azimuthDeg >= 180 ? 30_000 : 6_000,
        horizonAngleDeg: 5,
        peakElevationMeters: 1800,
      })),
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

    const request = new Request("http://localhost/api/sunlight/point", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        lat: 46.5227,
        lon: 6.6012,
        date: "2026-03-08",
        timezone: "Europe/Zurich",
        mode: "instant",
        localTime: "09:19",
      }),
    });

    const response = await POST(request);
    const json = (await response.json()) as {
      model: {
        terrainHorizonMethod: string;
        terrainHorizonDebug: {
          ridgePoints: Array<{ azimuthDeg: number }>;
        } | null;
      };
      diagnostics: {
        terrainRidgePoint: { azimuthDeg: number } | null;
      };
    };

    expect(response.status).toBe(200);
    expect(json.model.terrainHorizonMethod).toBe(dynamicMask.method);
    expect(json.model.terrainHorizonDebug?.ridgePoints.length).toBe(360);
    expect(json.diagnostics.terrainRidgePoint).not.toBeNull();
  });
});
