import { describe, expect, it, vi } from "vitest";

import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import type { HorizonMask } from "@/lib/sun/horizon-mask";

import { GET } from "./route";

interface MockContextOverrides {
  insideBuilding?: boolean;
  pointElevationMeters?: number | null;
  terrainHorizonMethod?: string;
  horizonMask?: HorizonMask | null;
}

function createMockContext(
  lat: number,
  lon: number,
  overrides: MockContextOverrides = {},
) {
  return {
    pointLv95: {
      easting: lon * 100_000,
      northing: lat * 100_000,
    },
    insideBuilding: overrides.insideBuilding ?? false,
    indoorBuildingId: null,
    pointElevationMeters: overrides.pointElevationMeters ?? 520,
    terrainHorizonMethod: overrides.terrainHorizonMethod ?? "mock-terrain",
    buildingsShadowMethod: "mock-buildings",
    vegetationShadowMethod: "mock-vegetation",
    warnings: [],
    horizonMask: overrides.horizonMask ?? null,
    buildingShadowEvaluator: undefined,
    vegetationShadowEvaluator: undefined,
  };
}

function parseSseEventData(streamText: string, eventName: string): unknown[] {
  const marker = `event: ${eventName}\ndata: `;
  const payloads: unknown[] = [];
  let cursor = 0;

  while (cursor < streamText.length) {
    const startIndex = streamText.indexOf(marker, cursor);
    if (startIndex < 0) {
      break;
    }

    const dataStart = startIndex + marker.length;
    const dataEnd = streamText.indexOf("\n\n", dataStart);
    if (dataEnd < 0) {
      break;
    }

    try {
      payloads.push(JSON.parse(streamText.slice(dataStart, dataEnd)));
    } catch {
      // Ignore malformed payloads in parser helper.
    }

    cursor = dataEnd + 2;
  }

  return payloads;
}

vi.mock("@/lib/sun/evaluation-context", () => ({
  buildPointEvaluationContext: vi.fn(async (lat: number, lon: number) =>
    createMockContext(lat, lon),
  ),
}));

vi.mock("@/lib/sun/dynamic-horizon-mask", () => ({
  buildDynamicHorizonMask: vi.fn(async () => null),
}));

describe("GET /api/sunlight/instant/stream", () => {
  it("streams progressive instant events successfully", async () => {
    const dynamicMask = {
      generatedAt: "2026-03-08T00:00:00.000Z",
      method: "copernicus-dem30-runtime-raycast-v1",
      center: { lat: 46.5225, lon: 6.6005 },
      radiusKm: 120,
      binsDeg: Array.from({ length: 360 }, () => -2),
      ridgePoints: [
        {
          azimuthDeg: 90,
          lat: 46.53,
          lon: 6.71,
          distanceMeters: 8450,
          horizonAngleDeg: 18,
          peakElevationMeters: 2280,
        },
      ],
    };
    vi.mocked(buildDynamicHorizonMask).mockResolvedValue(dynamicMask);
    vi.mocked(buildPointEvaluationContext).mockImplementation(
      async (lat, lon, options) =>
        createMockContext(lat, lon, {
          terrainHorizonMethod:
            options?.terrainHorizonOverride?.method ?? "mock-terrain",
          horizonMask: options?.terrainHorizonOverride ?? null,
        }),
    );

    const request = new Request(
      "http://localhost/api/sunlight/instant/stream?minLon=6.599447&minLat=46.522107&maxLon=6.600200&maxLat=46.522700&date=2026-03-08&timezone=Europe/Zurich&localTime=09:19&gridStepMeters=20&maxPoints=3000",
      {
        method: "GET",
      },
    );

    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let streamText = "";

    while (true) {
      const chunk = await reader!.read();
      if (chunk.done) {
        break;
      }
      streamText += decoder.decode(chunk.value, { stream: true });
    }
    streamText += decoder.decode();

    expect(streamText).toContain("event: start");
    expect(streamText).toContain("event: progress");
    expect(streamText).toContain("event: partial");
    expect(streamText).toContain("event: done");

    const startPayloads = parseSseEventData(streamText, "start") as Array<{
      model?: {
        terrainHorizonMethod?: string;
      };
      gridPointCount?: number;
    }>;
    expect(startPayloads.length).toBe(1);
    expect(startPayloads[0]?.model?.terrainHorizonMethod).toBe(dynamicMask.method);
    expect((startPayloads[0]?.gridPointCount ?? 0) > 0).toBe(true);

    const partialPayloads = parseSseEventData(streamText, "partial") as Array<{
      points?: unknown[];
      pointCount?: number;
    }>;
    expect(partialPayloads.length).toBeGreaterThan(0);
    expect((partialPayloads[0]?.points?.length ?? 0) > 0).toBe(true);
    expect((partialPayloads[0]?.pointCount ?? 0) > 0).toBe(true);

    const progressPayloads = parseSseEventData(streamText, "progress") as Array<{
      percent?: number;
      phase?: string;
    }>;
    expect(progressPayloads.length).toBeGreaterThan(0);
    expect(
      progressPayloads.some(
        (payload) => payload.phase === "evaluation" && (payload.percent ?? 0) > 0,
      ),
    ).toBe(true);

    const donePayloads = parseSseEventData(streamText, "done") as Array<{
      stats?: { elapsedMs?: number };
      pointCount?: number;
    }>;
    expect(donePayloads.length).toBe(1);
    expect((donePayloads[0]?.stats?.elapsedMs ?? -1) >= 0).toBe(true);
    expect((donePayloads[0]?.pointCount ?? 0) > 0).toBe(true);
  });
});
