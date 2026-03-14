import { beforeEach, describe, expect, it, vi } from "vitest";

import { listCacheRuns } from "@/lib/admin/cache-admin";

import { GET } from "./route";

vi.mock("@/lib/admin/cache-admin", () => ({
  listCacheRuns: vi.fn(),
}));

describe("GET /api/admin/cache/runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns cache runs overview", async () => {
    vi.mocked(listCacheRuns).mockResolvedValue({
      generatedAt: "2026-03-14T10:00:00.000Z",
      root: "C:\\cache",
      filters: {
        region: "lausanne",
      },
      summary: {
        runCount: 1,
        totalTiles: 16,
        totalFailedTiles: 0,
        completeRuns: 1,
        totalSizeBytes: 2048,
        totalFiles: 17,
      },
      runs: [
        {
          region: "lausanne",
          modelVersionHash: "abc123",
          date: "2026-03-08",
          timezone: "Europe/Zurich",
          gridStepMeters: 5,
          sampleEveryMinutes: 15,
          startLocalTime: "00:00",
          endLocalTime: "23:59",
          tileSizeMeters: 250,
          tileCount: 16,
          failedTileCount: 0,
          complete: true,
          generatedAt: "2026-03-14T10:00:00.000Z",
          runDir: "C:\\cache\\run-a",
          sizeBytes: 2048,
          fileCount: 17,
        },
      ],
    });

    const response = await GET(
      new Request(
        "http://localhost/api/admin/cache/runs?region=lausanne&startDate=2026-03-08",
      ),
    );
    const json = (await response.json()) as {
      summary: { runCount: number };
      runs: Array<{ modelVersionHash: string }>;
    };

    expect(response.status).toBe(200);
    expect(json.summary.runCount).toBe(1);
    expect(json.runs[0]?.modelVersionHash).toBe("abc123");
    expect(listCacheRuns).toHaveBeenCalledWith({
      region: "lausanne",
      modelVersionHash: undefined,
      startDate: "2026-03-08",
      endDate: undefined,
    });
  });

  it("rejects invalid queries", async () => {
    const response = await GET(
      new Request("http://localhost/api/admin/cache/runs?startDate=bad-date"),
    );
    const json = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(json.error).toContain("Invalid admin cache query");
  });
});
