import { describe, expect, it, vi } from "vitest";

import { getCachePrecomputeJob } from "@/lib/admin/cache-precompute-jobs";

import { GET } from "./route";

vi.mock("@/lib/admin/cache-precompute-jobs", () => ({
  getCachePrecomputeJob: vi.fn(),
}));

describe("GET /api/admin/cache/jobs/[jobId]", () => {
  it("returns an existing job", async () => {
    vi.mocked(getCachePrecomputeJob).mockReturnValue({
      jobId: "job-1",
      createdAt: "2026-03-14T10:00:00.000Z",
      startedAt: "2026-03-14T10:00:01.000Z",
      endedAt: null,
      status: "running",
      request: {
        region: "lausanne",
        startDate: "2026-03-08",
        days: 1,
        timezone: "Europe/Zurich",
        sampleEveryMinutes: 15,
        gridStepMeters: 5,
        tileSizeMeters: 250,
        startLocalTime: "00:00",
        endLocalTime: "23:59",
        skipExisting: true,
      },
      progress: {
        stage: "running",
        date: "2026-03-08",
        dayIndex: 1,
        daysTotal: 1,
        tileIndex: 3,
        tilesTotal: 16,
        completedTiles: 3,
        totalTiles: 16,
        percent: 18.8,
        currentTileState: "computed",
        elapsedMs: 5500,
        etaSeconds: 24,
      },
      result: null,
      error: null,
    });

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ jobId: "job-1" }),
    });
    const json = (await response.json()) as { jobId: string; status: string };

    expect(response.status).toBe(200);
    expect(json.jobId).toBe("job-1");
    expect(json.status).toBe("running");
  });

  it("returns 404 for unknown jobs", async () => {
    vi.mocked(getCachePrecomputeJob).mockReturnValue(null);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ jobId: "unknown" }),
    });
    expect(response.status).toBe(404);
  });
});
