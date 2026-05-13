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

// ── Mode filter (mocked dataset) ────────────────────────────────────────
// Verifies the server-side prefilter that runs BEFORE the snap loop:
//   - `mode=confirmed` (default) drops parks + food_court + unconfirmed.
//   - `mode=all` returns everything.
// Also asserts the snap loop only runs for the kept places (the snap mock
// counts invocations and we compare the two modes 1:4).

describe("POST /api/places/viewport (mode filter)", () => {
  const SAMPLE_PLACES = [
    // Kept under `confirmed`.
    {
      id: "p:confirmed-1",
      source: "osm",
      osmType: "node" as const,
      osmId: 1,
      name: "Café Confirmé",
      category: "terrace_candidate" as const,
      subcategory: "cafe",
      hasOutdoorSeating: true,
      lat: 46.52,
      lon: 6.63,
      tags: {},
    },
    // Dropped: unconfirmed terrace candidate.
    {
      id: "p:unknown-1",
      source: "osm",
      osmType: "node" as const,
      osmId: 2,
      name: "Resto Inconnu",
      category: "terrace_candidate" as const,
      subcategory: "restaurant",
      hasOutdoorSeating: false,
      hasOutdoorSeatingUnknown: true,
      lat: 46.521,
      lon: 6.631,
      tags: {},
    },
    // Dropped: food_court (mall gallery).
    {
      id: "p:foodcourt-1",
      source: "osm",
      osmType: "node" as const,
      osmId: 3,
      name: "Food Court Inside Mall",
      category: "terrace_candidate" as const,
      subcategory: "food_court",
      hasOutdoorSeating: true,
      lat: 46.522,
      lon: 6.632,
      tags: {},
    },
    // Dropped: park.
    {
      id: "p:park-1",
      source: "osm",
      osmType: "way" as const,
      osmId: 4,
      name: "Parc",
      category: "park" as const,
      subcategory: "park",
      hasOutdoorSeating: false,
      lat: 46.523,
      lon: 6.633,
      tags: {},
    },
  ];

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/places/snap-to-outdoor");
    vi.doUnmock("@/lib/places/lausanne-places");
  });

  function mockDataset() {
    vi.doMock("@/lib/places/lausanne-places", () => ({
      loadAllPlaces: vi.fn(async () => ({
        generatedAt: "2026-05-13T00:00:00.000Z",
        source: "test",
        bbox: [6.6, 46.5, 6.7, 46.6],
        totalPlaces: SAMPLE_PLACES.length,
        categories: {
          parks: 1,
          terraceCandidates: 3,
          outdoorSeatingYes: 2,
          outdoorSeatingUnknown: 1,
        },
        places: SAMPLE_PLACES,
      })),
    }));
  }

  function mockSnapWithCounter() {
    const snapCalls = { count: 0 };
    vi.doMock("@/lib/places/snap-to-outdoor", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("@/lib/places/snap-to-outdoor")>();
      return {
        ...actual,
        snapPlaceToOutdoor: vi.fn(async (coords: { lat: number; lon: number }) => {
          snapCalls.count += 1;
          return {
            lat: coords.lat,
            lon: coords.lon,
            offsetMeters: 0,
            selectionStrategy: "original" as const,
          };
        }),
      };
    });
    return snapCalls;
  }

  it("mode=confirmed (default) excludes parks, food_court, and unconfirmed", async () => {
    mockDataset();
    const snapCalls = mockSnapWithCounter();
    const { POST } = await import("./route");
    const request = new Request("http://localhost/api/places/viewport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ south: 46.5, west: 6.6, north: 46.6, east: 6.7 }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Server-Timing")).toMatch(/^snap;dur=/);
    const json = (await response.json()) as {
      mode: string;
      places: Array<{ id: string }>;
    };
    expect(json.mode).toBe("confirmed");
    expect(json.places).toHaveLength(1);
    expect(json.places[0].id).toBe("p:confirmed-1");
    // Snap only ran on the single kept place.
    expect(snapCalls.count).toBe(1);
  });

  it("mode=all returns everything and snaps ~4× as many places", async () => {
    mockDataset();
    const snapCalls = mockSnapWithCounter();
    const { POST } = await import("./route");
    const request = new Request("http://localhost/api/places/viewport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        south: 46.5,
        west: 6.6,
        north: 46.6,
        east: 6.7,
        mode: "all",
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Server-Timing")).toMatch(/^snap;dur=/);
    const json = (await response.json()) as {
      mode: string;
      places: Array<{ id: string }>;
    };
    expect(json.mode).toBe("all");
    expect(json.places).toHaveLength(SAMPLE_PLACES.length);
    expect(snapCalls.count).toBe(SAMPLE_PLACES.length);
    // 4 in the fixture, 1 kept under confirmed → ratio holds.
    expect(snapCalls.count).toBe(4 * 1);
  });

  it("mode=all also accepted via ?mode=all query string", async () => {
    mockDataset();
    mockSnapWithCounter();
    const { POST } = await import("./route");
    const request = new Request(
      "http://localhost/api/places/viewport?mode=all",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ south: 46.5, west: 6.6, north: 46.6, east: 6.7 }),
      },
    );
    const response = await POST(request);
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      mode: string;
      places: Array<{ id: string }>;
    };
    expect(json.mode).toBe("all");
    expect(json.places).toHaveLength(SAMPLE_PLACES.length);
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
