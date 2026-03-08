import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PROCESSED_LAUSANNE_PLACES_PATH } from "@/lib/storage/data-paths";

import { POST } from "./route";

const GREAT_ESCAPE_ID = "osm:node:1758921857";
const GRANDES_ROCHES_ID = "osm:node:1319947886";

const HAS_PLACES_FILE = existsSync(PROCESSED_LAUSANNE_PLACES_PATH);
const PLACES_RAW = HAS_PLACES_FILE
  ? readFileSync(PROCESSED_LAUSANNE_PLACES_PATH, "utf8")
  : "";
const HAS_TARGET_PLACES =
  HAS_PLACES_FILE &&
  PLACES_RAW.includes(GREAT_ESCAPE_ID) &&
  PLACES_RAW.includes(GRANDES_ROCHES_ID);

const describeIfPlaces = HAS_TARGET_PLACES ? describe : describe.skip;

describeIfPlaces("POST /api/places/windows (Lausanne terraces)", () => {
  it(
    "returns sunlight windows for The Great Escape and Les Grandes Roches in daily mode",
    async () => {
      const request = new Request("http://localhost/api/places/windows", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          date: "2026-06-21",
          timezone: "Europe/Zurich",
          mode: "daily",
          startLocalTime: "10:00",
          endLocalTime: "18:00",
          sampleEveryMinutes: 30,
          placeIds: [GREAT_ESCAPE_ID, GRANDES_ROCHES_ID],
          category: "terrace_candidate",
          outdoorOnly: true,
          foodTypes: ["restaurant", "bar", "snack", "foodtruck"],
          includeNonSunny: true,
          limit: 10,
        }),
      });

      const response = await POST(request);
      const json = (await response.json()) as {
        error?: string;
        mode: string;
        count: number;
        places: Array<{
          id: string;
          name: string;
          venueType: string;
          hasOutdoorSeating: boolean;
          selectionStrategy: string;
          sunnyMinutes: number;
          sunlightStartLocalTime: string | null;
          sunlightEndLocalTime: string | null;
        }>;
      };

      expect(response.status).toBe(200);
      expect(json.error).toBeUndefined();
      expect(json.mode).toBe("daily");
      expect(json.count).toBe(2);

      const byId = new Map(json.places.map((place) => [place.id, place]));
      const greatEscape = byId.get(GREAT_ESCAPE_ID);
      const grandesRoches = byId.get(GRANDES_ROCHES_ID);
      expect(greatEscape).toBeDefined();
      expect(grandesRoches).toBeDefined();
      expect(greatEscape?.hasOutdoorSeating).toBe(true);
      expect(grandesRoches?.hasOutdoorSeating).toBe(true);

      for (const place of json.places) {
        expect(place.venueType === "restaurant" || place.venueType === "bar").toBe(
          true,
        );
        expect(
          place.selectionStrategy === "original" ||
            place.selectionStrategy === "terrace_offset" ||
            place.selectionStrategy === "indoor_fallback",
        ).toBe(true);
        expect(place.sunnyMinutes).toBeGreaterThanOrEqual(0);
      }
      expect(json.places.some((place) => place.sunnyMinutes > 0)).toBe(true);
    },
    180_000,
  );
});
