import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: readFileMock,
  },
  readFile: readFileMock,
}));

describe("loadAllPlaces", () => {
  beforeEach(() => {
    vi.resetModules();
    readFileMock.mockReset();
  });

  it("merges Lausanne and Nyon places into a single dataset", async () => {
    const lausannePayload = {
      generatedAt: "2026-03-08T00:00:00.000Z",
      source: "Overpass",
      bbox: [6.54, 46.49, 6.74, 46.62],
      totalPlaces: 2,
      categories: {
        parks: 1,
        terraceCandidates: 1,
        outdoorSeatingYes: 1,
      },
      places: [
        {
          id: "osm:node:1",
          source: "osm",
          osmType: "node",
          osmId: 1,
          name: "Parc Lausanne",
          category: "park",
          subcategory: "park",
          hasOutdoorSeating: false,
          lat: 46.52,
          lon: 6.63,
          tags: {},
        },
        {
          id: "osm:node:2",
          source: "osm",
          osmType: "node",
          osmId: 2,
          name: "Terrasse Lausanne",
          category: "terrace_candidate",
          subcategory: "restaurant",
          hasOutdoorSeating: true,
          lat: 46.521,
          lon: 6.631,
          tags: {
            amenity: "restaurant",
          },
        },
      ],
    };

    const nyonPayload = {
      generatedAt: "2026-03-08T00:00:00.000Z",
      source: "Overpass",
      bbox: [6.14, 46.33, 6.33, 46.45],
      totalPlaces: 2,
      categories: {
        parks: 0,
        terraceCandidates: 2,
        outdoorSeatingYes: 2,
      },
      places: [
        {
          id: "osm:node:2",
          source: "osm",
          osmType: "node",
          osmId: 2,
          name: "Terrasse Lausanne (duplicate id)",
          category: "terrace_candidate",
          subcategory: "restaurant",
          hasOutdoorSeating: true,
          lat: 46.521,
          lon: 6.631,
          tags: {
            amenity: "restaurant",
          },
        },
        {
          id: "osm:node:3",
          source: "osm",
          osmType: "node",
          osmId: 3,
          name: "Terrasse Nyon",
          category: "terrace_candidate",
          subcategory: "bar",
          hasOutdoorSeating: true,
          lat: 46.383,
          lon: 6.239,
          tags: {
            amenity: "bar",
          },
        },
      ],
    };

    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.includes("lausanne-places.json")) {
        return JSON.stringify(lausannePayload);
      }
      if (filePath.includes("nyon-places.json")) {
        return JSON.stringify(nyonPayload);
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const module = await import("./lausanne-places");
    const merged = await module.loadAllPlaces();

    expect(merged).not.toBeNull();
    expect(merged?.totalPlaces).toBe(3);
    expect(merged?.categories.parks).toBe(1);
    expect(merged?.categories.terraceCandidates).toBe(2);
    expect(merged?.bbox).toEqual([6.14, 46.33, 6.74, 46.62]);
    expect(merged?.places.some((place) => place.id === "osm:node:1")).toBe(true);
    expect(merged?.places.some((place) => place.id === "osm:node:2")).toBe(true);
    expect(merged?.places.some((place) => place.id === "osm:node:3")).toBe(true);
  });
});
