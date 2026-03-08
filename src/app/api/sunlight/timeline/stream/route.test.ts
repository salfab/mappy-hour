import { describe, expect, it, vi } from "vitest";

import { GET } from "./route";

function createMockContext(lat: number, lon: number) {
  return {
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
  };
}

vi.mock("@/lib/sun/evaluation-context", () => ({
  buildPointEvaluationContext: vi.fn(async (lat: number, lon: number) =>
    createMockContext(lat, lon),
  ),
}));

describe("GET /api/sunlight/timeline/stream", () => {
  it("streams timeline events successfully without running a web server", async () => {
    const request = new Request(
      "http://localhost/api/sunlight/timeline/stream?minLon=6.599447&minLat=46.522107&maxLon=6.600200&maxLat=46.522700&date=2026-03-08&timezone=Europe/Zurich&sampleEveryMinutes=60&gridStepMeters=20&maxPoints=3000",
      {
        method: "GET",
      },
    );

    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");

    const streamText = await response.text();
    expect(streamText).toContain("event: start");
    expect(streamText).toContain("event: frame");
    expect(streamText).toContain("event: progress");
    expect(streamText).toContain("event: done");
  });
});
