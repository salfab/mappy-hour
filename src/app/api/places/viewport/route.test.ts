import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PROCESSED_LAUSANNE_PLACES_PATH } from "@/lib/storage/data-paths";

import { POST } from "./route";

const HAS_PLACES_FILE = existsSync(PROCESSED_LAUSANNE_PLACES_PATH);
const describeIfPlaces = HAS_PLACES_FILE ? describe : describe.skip;

describeIfPlaces("POST /api/places/viewport", () => {
  it("returns places strictly within the requested bbox", async () => {
    // Tight bbox centered on Place Saint-François, Lausanne.
    const body = {
      south: 46.518,
      west: 6.628,
      north: 46.524,
      east: 6.638,
    };
    const request = new Request("http://localhost/api/places/viewport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      generatedAt: string;
      sourceGeneratedAt: string;
      places: Array<{
        id: string;
        lat: number;
        lon: number;
        osmType: string;
        osmId: number;
        // Make sure `tags` is stripped.
        tags?: unknown;
      }>;
    };
    expect(json.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(json.places.length).toBeGreaterThan(0);
    for (const place of json.places) {
      expect(place.lat).toBeGreaterThanOrEqual(body.south);
      expect(place.lat).toBeLessThanOrEqual(body.north);
      expect(place.lon).toBeGreaterThanOrEqual(body.west);
      expect(place.lon).toBeLessThanOrEqual(body.east);
      expect(place.tags).toBeUndefined();
      expect(typeof place.osmId).toBe("number");
    }
  });

  it("rejects an invalid bbox", async () => {
    const request = new Request("http://localhost/api/places/viewport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ south: 47, west: 6, north: 46, east: 7 }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const request = new Request("http://localhost/api/places/viewport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ south: "nope" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});
