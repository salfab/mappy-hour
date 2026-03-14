import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelCachePrecomputeJob,
  getCachePrecomputeJob,
  isCachePrecomputeJobExecuting,
  rejectCachePrecomputeJob,
  resumeCachePrecomputeJob,
} from "@/lib/admin/cache-precompute-jobs";

import { GET, POST } from "./route";

vi.mock("@/lib/admin/cache-precompute-jobs", () => ({
  cancelCachePrecomputeJob: vi.fn(),
  getCachePrecomputeJob: vi.fn(),
  isCachePrecomputeJobExecuting: vi.fn(),
  rejectCachePrecomputeJob: vi.fn(),
  resumeCachePrecomputeJob: vi.fn(),
}));

describe("GET /api/admin/cache/jobs/[jobId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isCachePrecomputeJobExecuting).mockReturnValue(false);
  });

  it("returns an existing job", async () => {
    vi.mocked(getCachePrecomputeJob).mockReturnValue({
      jobId: "job-1",
      createdAt: "2026-03-14T10:00:00.000Z",
      updatedAt: "2026-03-14T10:00:05.000Z",
      revision: 2,
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

  it("cancels an existing job", async () => {
    vi.mocked(cancelCachePrecomputeJob).mockReturnValue({
      jobId: "job-cancel",
      createdAt: "2026-03-14T10:00:00.000Z",
      updatedAt: "2026-03-14T10:01:00.000Z",
      revision: 3,
      startedAt: "2026-03-14T10:00:01.000Z",
      endedAt: "2026-03-14T10:01:00.000Z",
      status: "cancelled",
      request: {
        region: "lausanne",
        startDate: "2026-03-08",
        days: 1,
        timezone: "Europe/Zurich",
        sampleEveryMinutes: 15,
        gridStepMeters: 1,
        startLocalTime: "00:00",
        endLocalTime: "23:59",
        skipExisting: true,
      },
      progress: null,
      result: null,
      error: "Annule manuellement par l'utilisateur.",
    });
    vi.mocked(rejectCachePrecomputeJob).mockResolvedValue({
      jobId: "job-cancel",
      modelVersionHash: "model-abc",
      removedModelVersionHashes: ["model-abc"],
      removedRunDirs: ["C:\\cache\\run-a"],
      removedSnapshot: true,
    });

    const response = await POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      }),
      {
        params: Promise.resolve({ jobId: "job-cancel" }),
      },
    );
    const json = (await response.json()) as { status: string; rejected: boolean };

    expect(response.status).toBe(200);
    expect(json.status).toBe("cancelled");
    expect(json.rejected).toBe(true);
    expect(cancelCachePrecomputeJob).toHaveBeenCalledWith("job-cancel");
    expect(rejectCachePrecomputeJob).toHaveBeenCalledWith("job-cancel");
  });

  it("resumes the same job id (no duplicate job)", async () => {
    vi.mocked(resumeCachePrecomputeJob).mockReturnValue({
      jobId: "job-old",
      createdAt: "2026-03-14T10:05:00.000Z",
      updatedAt: "2026-03-14T10:05:00.000Z",
      revision: 0,
      startedAt: null,
      endedAt: null,
      status: "queued",
      request: {
        region: "lausanne",
        startDate: "2026-03-08",
        days: 1,
        timezone: "Europe/Zurich",
        sampleEveryMinutes: 15,
        gridStepMeters: 1,
        startLocalTime: "00:00",
        endLocalTime: "23:59",
        skipExisting: true,
      },
      progress: null,
      result: null,
      error: null,
    });

    const response = await POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      }),
      {
        params: Promise.resolve({ jobId: "job-old" }),
      },
    );
    const json = (await response.json()) as { jobId: string };

    expect(response.status).toBe(202);
    expect(json.jobId).toBe("job-old");
    expect(resumeCachePrecomputeJob).toHaveBeenCalledWith("job-old");
  });

  it("returns 409 when resume is not allowed", async () => {
    vi.mocked(resumeCachePrecomputeJob).mockImplementation(() => {
      throw new Error("Le job est deja actif.");
    });

    const response = await POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      }),
      {
        params: Promise.resolve({ jobId: "job-running" }),
      },
    );

    expect(response.status).toBe(409);
  });

  it("rejects a cancelled job and returns cleanup result", async () => {
    vi.mocked(rejectCachePrecomputeJob).mockResolvedValue({
      jobId: "job-cancelled",
      modelVersionHash: "model-abc",
      removedModelVersionHashes: ["model-abc"],
      removedRunDirs: ["C:\\cache\\sunlight\\lausanne\\model-abc\\g1\\m15\\2026-03-08\\t0000-2359"],
      removedSnapshot: true,
    });

    const response = await POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject" }),
      }),
      {
        params: Promise.resolve({ jobId: "job-cancelled" }),
      },
    );
    const json = (await response.json()) as { removedSnapshot: boolean; removedRunDirs: string[] };

    expect(response.status).toBe(200);
    expect(json.removedSnapshot).toBe(true);
    expect(json.removedRunDirs.length).toBe(1);
    expect(rejectCachePrecomputeJob).toHaveBeenCalledWith("job-cancelled");
  });
});
