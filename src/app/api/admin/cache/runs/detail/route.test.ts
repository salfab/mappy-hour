import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCacheRunDetail } from "@/lib/admin/cache-admin";

import { GET } from "./route";

vi.mock("@/lib/admin/cache-admin", () => ({
  getCacheRunDetail: vi.fn(),
}));

describe("GET /api/admin/cache/runs/detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns run detail payload", async () => {
    vi.mocked(getCacheRunDetail).mockResolvedValue({
      run: {
        region: "lausanne",
        modelVersionHash: "abc123",
        date: "2026-03-08",
        timezone: "Europe/Zurich",
        gridStepMeters: 5,
        sampleEveryMinutes: 15,
        startLocalTime: "08:00",
        endLocalTime: "09:00",
        tileSizeMeters: 250,
        tileCount: 12,
        failedTileCount: 0,
        complete: true,
        generatedAt: "2026-03-15T10:00:00.000Z",
      },
      bbox: {
        minLon: 6.59,
        minLat: 46.51,
        maxLon: 6.64,
        maxLat: 46.54,
      },
      outlineRings: [
        [
          [46.51, 6.59],
          [46.51, 6.64],
          [46.54, 6.64],
          [46.54, 6.59],
          [46.51, 6.59],
        ],
      ],
    });

    const response = await GET(
      new Request(
        "http://localhost/api/admin/cache/runs/detail?region=lausanne&modelVersionHash=abc123&date=2026-03-08&gridStepMeters=5&sampleEveryMinutes=15&startLocalTime=08:00&endLocalTime=09:00",
      ),
    );
    const json = (await response.json()) as {
      run: { modelVersionHash: string };
      outlineRings: Array<Array<[number, number]>>;
    };

    expect(response.status).toBe(200);
    expect(json.run.modelVersionHash).toBe("abc123");
    expect(json.outlineRings).toHaveLength(1);
    expect(getCacheRunDetail).toHaveBeenCalledWith({
      region: "lausanne",
      modelVersionHash: "abc123",
      date: "2026-03-08",
      gridStepMeters: 5,
      sampleEveryMinutes: 15,
      startLocalTime: "08:00",
      endLocalTime: "09:00",
    });
  });

  it("returns 400 for invalid queries", async () => {
    const response = await GET(
      new Request("http://localhost/api/admin/cache/runs/detail?region=lausanne"),
    );
    const json = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(json.error).toContain("Invalid run detail query");
  });

  it("returns 404 when run is missing", async () => {
    vi.mocked(getCacheRunDetail).mockResolvedValue(null);
    const response = await GET(
      new Request(
        "http://localhost/api/admin/cache/runs/detail?region=lausanne&modelVersionHash=abc123&date=2026-03-08&gridStepMeters=5&sampleEveryMinutes=15&startLocalTime=08:00&endLocalTime=09:00",
      ),
    );
    const json = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(json.error).toContain("not found");
  });
});
