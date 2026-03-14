import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/admin/cache/tiles", () => {
  it("returns tiles for a valid region", async () => {
    const response = await GET(
      new Request("http://localhost/api/admin/cache/tiles?region=lausanne"),
    );
    const json = (await response.json()) as {
      region: string;
      tileSizeMeters: number;
      tileCount: number;
      tiles: Array<{ tileId: string }>;
    };

    expect(response.status).toBe(200);
    expect(json.region).toBe("lausanne");
    expect(json.tileSizeMeters).toBe(250);
    expect(json.tileCount).toBeGreaterThan(0);
    expect(json.tiles.length).toBe(json.tileCount);
    expect(json.tiles[0]?.tileId).toContain("_s250");
  });

  it("returns 400 when region is missing", async () => {
    const response = await GET(
      new Request("http://localhost/api/admin/cache/tiles"),
    );
    expect(response.status).toBe(400);
  });
});

