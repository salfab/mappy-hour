import { beforeEach, describe, expect, it, vi } from "vitest";

import { purgeCacheRuns, verifyCacheRuns } from "@/lib/admin/cache-admin";

import { POST } from "./route";

vi.mock("@/lib/admin/cache-admin", () => ({
  verifyCacheRuns: vi.fn(),
  purgeCacheRuns: vi.fn(),
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
