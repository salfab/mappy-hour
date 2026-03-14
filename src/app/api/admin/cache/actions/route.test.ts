import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  purgeCacheRuns,
  verifyCacheRuns,
} from "@/lib/admin/cache-admin";
import { startCachePrecomputeJob } from "@/lib/admin/cache-precompute-jobs";

import { POST } from "./route";

vi.mock("@/lib/admin/cache-admin", () => ({
  verifyCacheRuns: vi.fn(),
  purgeCacheRuns: vi.fn(),
}));

vi.mock("@/lib/admin/cache-precompute-jobs", () => ({
  startCachePrecomputeJob: vi.fn(),
}));

describe("POST /api/admin/cache/actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs verification", async () => {
    vi.mocked(verifyCacheRuns).mockResolvedValue({
      generatedAt: "2026-03-14T10:00:00.000Z",
      root: "C:\\cache",
      filters: {
        region: "lausanne",
      },
      manifestsMatched: 2,
      tilesVerified: 24,
      strictChecks: {
        expectedFrameCountChecks: 2,
        expectedMaskSizeChecks: 10,
        pointIndexChecks: 100,
      },
      problems: [],
    });

    const response = await POST(
      new Request("http://localhost/api/admin/cache/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "verify",
          filters: {
            region: "lausanne",
          },
        }),
      }),
    );
    const json = (await response.json()) as { tilesVerified: number };

    expect(response.status).toBe(200);
    expect(json.tilesVerified).toBe(24);
    expect(verifyCacheRuns).toHaveBeenCalledWith({
      region: "lausanne",
    });
  });

  it("runs purge", async () => {
    vi.mocked(purgeCacheRuns).mockResolvedValue({
      generatedAt: "2026-03-14T10:00:00.000Z",
      root: "C:\\cache",
      filters: {
        region: "nyon",
      },
      dryRun: true,
      runsMatched: 1,
      removedRunDirs: [],
      runs: [],
    });

    const response = await POST(
      new Request("http://localhost/api/admin/cache/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "purge",
          dryRun: true,
          filters: {
            region: "nyon",
          },
        }),
      }),
    );
    const json = (await response.json()) as { runsMatched: number; dryRun: boolean };

    expect(response.status).toBe(200);
    expect(json.runsMatched).toBe(1);
    expect(json.dryRun).toBe(true);
    expect(purgeCacheRuns).toHaveBeenCalledWith(
      {
        region: "nyon",
      },
      {
        dryRun: true,
      },
    );
  });

  it("runs precompute", async () => {
    vi.mocked(startCachePrecomputeJob).mockReturnValue({
      jobId: "job-123",
      createdAt: "2026-03-14T10:00:00.000Z",
      startedAt: null,
      endedAt: null,
      status: "queued",
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
      progress: null,
      result: null,
      error: null,
    });

    const response = await POST(
      new Request("http://localhost/api/admin/cache/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "precompute",
          precompute: {
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
        }),
      }),
    );
    const json = (await response.json()) as { jobId: string; status: string };

    expect(response.status).toBe(202);
    expect(json.jobId).toBe("job-123");
    expect(json.status).toBe("queued");
    expect(startCachePrecomputeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "lausanne",
        startDate: "2026-03-08",
        days: 1,
      }),
    );
  });

  it("rejects invalid payloads", async () => {
    const response = await POST(
      new Request("http://localhost/api/admin/cache/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "nope",
        }),
      }),
    );
    const json = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(json.error).toContain("Invalid admin cache action payload");
  });
});
