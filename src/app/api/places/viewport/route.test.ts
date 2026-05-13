import { existsSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESSED_LAUSANNE_PLACES_PATH } from "@/lib/storage/data-paths";

const HAS_PLACES_FILE = existsSync(PROCESSED_LAUSANNE_PLACES_PATH);
const describeIfPlaces = HAS_PLACES_FILE ? describe : describe.skip;

describeIfPlaces("POST /api/places/viewport (real dataset)", () => {
  it("returns places strictly within the requested bbox", async () => {
    const { POST } = await import("./route");
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
    // Snap timing is exposed for clients (and to give us a quick perf
    // signal in the logs); make sure the header is present even when the
    // snap was instantaneous.
    expect(response.headers.get("Server-Timing")).toMatch(/^snap;dur=/);
    const json = (await response.json()) as {
      generatedAt: string;
      sourceGeneratedAt: string;
      places: Array<{
        id: string;
        lat: number;
        lon: number;
        osmType: string;
        osmId: number;
        selectionStrategy?: string;
        osmLat?: number;
        osmLon?: number;
        // Make sure `tags` is stripped.
        tags?: unknown;
      }>;
    };
    expect(json.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(json.places.length).toBeGreaterThan(0);
    for (const place of json.places) {
      // `lat`/`lon` may be the snapped coords; they should still be inside
      // the requested bbox to a few-meter tolerance. We don't relax the
      // bbox check itself — a sub-degree fudge is enough.
      expect(place.lat).toBeGreaterThanOrEqual(body.south - 0.001);
      expect(place.lat).toBeLessThanOrEqual(body.north + 0.001);
      expect(place.lon).toBeGreaterThanOrEqual(body.west - 0.001);
      expect(place.lon).toBeLessThanOrEqual(body.east + 0.001);
      expect(place.tags).toBeUndefined();
      expect(typeof place.osmId).toBe("number");
      if (place.selectionStrategy === "terrace_offset") {
        // When we nudged the point, raw OSM coords are surfaced too.
        expect(typeof place.osmLat).toBe("number");
        expect(typeof place.osmLon).toBe("number");
      }
    }
  });

  it("rejects an invalid bbox", async () => {
    const { POST } = await import("./route");
    const request = new Request("http://localhost/api/places/viewport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ south: 47, west: 6, north: 46, east: 7 }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const { POST } = await import("./route");
    const request = new Request("http://localhost/api/places/viewport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ south: "nope" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

// ── Mocked-snap path ────────────────────────────────────────────────────
// Drives the snap helper with a hand-rolled fake so we can prove that an
// indoor OSM point comes back with `selectionStrategy=terrace_offset` and
// the response `lat`/`lon` reflect the moved point. Doesn't depend on the
// real tile-grid-metadata being on disk — runs everywhere.

describe("POST /api/places/viewport (mocked snap)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/places/snap-to-outdoor");
    vi.doUnmock("@/lib/places/lausanne-places");
  });

  it("rewrites lat/lon and preserves OSM coords when the OSM point is indoor", async () => {
    const ORIGINAL = { lat: 46.5200, lon: 6.6330 };
    const NUDGED = { lat: 46.5201, lon: 6.6331 };

    vi.doMock("@/lib/places/snap-to-outdoor", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/places/snap-to-outdoor")>();
      return {
        ...actual,
        snapPlaceToOutdoor: vi.fn(async () => ({
          lat: NUDGED.lat,
          lon: NUDGED.lon,
          offsetMeters: 4,
          selectionStrategy: "terrace_offset" as const,
        })),
      };
    });
    vi.doMock("@/lib/places/lausanne-places", () => ({
      loadAllPlaces: vi.fn(async () => ({
        generatedAt: "2026-05-13T00:00:00.000Z",
        source: "test",
        bbox: [6.6, 46.5, 6.7, 46.6],
        totalPlaces: 1,
        categories: {
          parks: 0,
          terraceCandidates: 1,
          outdoorSeatingYes: 1,
          outdoorSeatingUnknown: 0,
        },
        places: [
          {
            id: "test:1",
            source: "osm",
            osmType: "node",
            osmId: 42,
            name: "Test Café",
            category: "terrace_candidate",
            subcategory: "cafe",
            hasOutdoorSeating: true,
            lat: ORIGINAL.lat,
            lon: ORIGINAL.lon,
            tags: {},
          },
        ],
      })),
    }));

    const { POST } = await import("./route");
    const request = new Request("http://localhost/api/places/viewport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ south: 46.5, west: 6.6, north: 46.6, east: 6.7 }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      places: Array<{
        lat: number;
        lon: number;
        osmLat?: number;
        osmLon?: number;
        selectionStrategy?: string;
      }>;
    };
    expect(json.places).toHaveLength(1);
    const [p] = json.places;
    expect(p.selectionStrategy).toBe("terrace_offset");
    expect(p.lat).toBeCloseTo(NUDGED.lat, 5);
    expect(p.lon).toBeCloseTo(NUDGED.lon, 5);
    expect(p.osmLat).toBeCloseTo(ORIGINAL.lat, 5);
    expect(p.osmLon).toBeCloseTo(ORIGINAL.lon, 5);
  });

  it("does not surface osmLat/osmLon when the place was already outdoor", async () => {
    const ORIGINAL = { lat: 46.5200, lon: 6.6330 };
    vi.doMock("@/lib/places/snap-to-outdoor", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/places/snap-to-outdoor")>();
      return {
        ...actual,
        snapPlaceToOutdoor: vi.fn(async () => ({
          lat: ORIGINAL.lat,
          lon: ORIGINAL.lon,
          offsetMeters: 0,
          selectionStrategy: "original" as const,
        })),
      };
    });
    vi.doMock("@/lib/places/lausanne-places", () => ({
      loadAllPlaces: vi.fn(async () => ({
        generatedAt: "2026-05-13T00:00:00.000Z",
        source: "test",
        bbox: [6.6, 46.5, 6.7, 46.6],
        totalPlaces: 1,
        categories: {
          parks: 0,
          terraceCandidates: 1,
          outdoorSeatingYes: 1,
          outdoorSeatingUnknown: 0,
        },
        places: [
          {
            id: "test:1",
            source: "osm",
            osmType: "node",
            osmId: 42,
            name: "Test Café",
            category: "terrace_candidate",
            subcategory: "cafe",
            hasOutdoorSeating: true,
            lat: ORIGINAL.lat,
            lon: ORIGINAL.lon,
            tags: {},
          },
        ],
      })),
    }));

    const { POST } = await import("./route");
    const request = new Request("http://localhost/api/places/viewport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ south: 46.5, west: 6.6, north: 46.6, east: 6.7 }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      places: Array<{
        lat: number;
        lon: number;
        osmLat?: number;
        osmLon?: number;
        selectionStrategy?: string;
      }>;
    };
    const [p] = json.places;
    expect(p.selectionStrategy).toBe("original");
    expect(p.osmLat).toBeUndefined();
    expect(p.osmLon).toBeUndefined();
  });
});
