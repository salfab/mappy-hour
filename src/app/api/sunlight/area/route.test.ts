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
      utcTime: string;
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
