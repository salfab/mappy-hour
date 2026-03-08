import { describe, expect, it, vi } from "vitest";

import { POST } from "./route";

vi.mock("@/lib/sun/evaluation-context", () => ({
  buildPointEvaluationContext: vi.fn(async (lat: number, lon: number) => ({
    pointLv95: {
      easting: lon * 100_000,
      northing: lat * 100_000,
    },
    insideBuilding: false,
    indoorBuildingId: null,
    pointElevationMeters: 520,
    terrainHorizonMethod: "mock-terrain",
    buildingsShadowMethod: "mock-buildings",
    warnings: [],
    horizonMask: null,
    buildingShadowEvaluator: undefined,
  })),
}));

vi.mock("@/lib/sun/solar", () => ({
  evaluateInstantSunlight: vi.fn(() => ({
    utcTime: "2026-03-08T08:19:00.000Z",
    localTime: "2026-03-08 09:19:00",
    azimuthDeg: 145,
    altitudeDeg: 22,
    horizonAngleDeg: null,
    aboveAstronomicalHorizon: true,
    terrainBlocked: false,
    buildingsBlocked: false,
    buildingBlockerId: null,
    buildingBlockerDistanceMeters: null,
    buildingBlockerAltitudeAngleDeg: null,
    isSunny: true,
  })),
  evaluatePointSunlight: vi.fn(() => ({
    date: "2026-03-08",
    timeZone: "Europe/Zurich",
    sampleEveryMinutes: 15,
    sunriseLocalTime: "2026-03-08 06:56:00",
    sunsetLocalTime: "2026-03-08 18:19:00",
    sunnyWindows: [
      {
        startLocalTime: "2026-03-08 09:00:00",
        endLocalTime: "2026-03-08 10:00:00",
        durationMinutes: 60,
      },
    ],
    samples: [],
  })),
}));

describe("POST /api/sunlight/area", () => {
  it("returns a valid instant area payload without running a web server", async () => {
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
      stats: {
        elapsedMs: number;
      };
    };

    expect(response.status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.mode).toBe("instant");
    expect(Array.isArray(json.points)).toBe(true);
    expect(json.pointCount).toBeGreaterThan(0);
    expect(json.pointCount).toBe(json.points.length);
    expect(json.stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
