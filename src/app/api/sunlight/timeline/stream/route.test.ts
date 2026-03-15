import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTimelineFromArtifacts,
  resolveSunlightTilesForBbox,
} from "@/lib/precompute/sunlight-tile-service";
import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";

import { GET } from "./route";

function createMockContext(lat: number, lon: number) {
  return {
    pointLv95: {
      easting: lon * 100_000,
      northing: lat * 100_000,
    },
    insideBuilding: false,
    indoorBuildingId: null,
    pointElevationMeters: 520,
    terrainHorizonMethod: "mock-terrain",
    buildingsShadowMethod: "mock-buildings",
    vegetationShadowMethod: "mock-vegetation",
    warnings: [],
    horizonMask: null,
    buildingShadowEvaluator: undefined,
    vegetationShadowEvaluator: undefined,
  };
}

function parseSseEventData(streamText: string, eventName: string): unknown | null {
  const marker = `event: ${eventName}\ndata: `;
  const startIndex = streamText.indexOf(marker);
  if (startIndex < 0) {
    return null;
  }

  const dataStart = startIndex + marker.length;
  const dataEnd = streamText.indexOf("\n\n", dataStart);
  if (dataEnd < 0) {
    return null;
  }

  try {
    return JSON.parse(streamText.slice(dataStart, dataEnd));
  } catch {
    return null;
  }
}

function parseAllSseEventData(streamText: string, eventName: string): unknown[] {
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

function decodeBase64Bytes(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

vi.mock("@/lib/sun/evaluation-context", () => ({
  buildPointEvaluationContext: vi.fn(async (lat: number, lon: number) =>
    createMockContext(lat, lon),
  ),
}));

vi.mock("@/lib/precompute/sunlight-tile-service", () => ({
  resolveSunlightTilesForBbox: vi.fn(async () => null),
  buildTimelineFromArtifacts: vi.fn(),
}));

vi.mock("@/lib/sun/dynamic-horizon-mask", () => ({
  buildDynamicHorizonMask: vi.fn(async () => null),
}));

describe("GET /api/sunlight/timeline/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveSunlightTilesForBbox).mockResolvedValue(null);
  });

  it("streams timeline events successfully without running a web server", async () => {
    const request = new Request(
      "http://localhost/api/sunlight/timeline/stream?minLon=6.599447&minLat=46.522107&maxLon=6.600200&maxLat=46.522700&date=2026-03-08&timezone=Europe/Zurich&sampleEveryMinutes=60&gridStepMeters=20&maxPoints=3000",
      {
        method: "GET",
      },
    );

    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let streamText = "";

    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    streamText += decoder.decode(firstChunk.value, { stream: true });
    expect(
      streamText.includes("event: start") || streamText.includes("event: progress"),
    ).toBe(true);
    expect(streamText).not.toContain("event: done");

    while (true) {
      const chunk = await reader!.read();
      if (chunk.done) {
        break;
      }
      streamText += decoder.decode(chunk.value, { stream: true });
    }

    streamText += decoder.decode();
    expect(streamText).toContain('"phase":"preparing"');
    expect(streamText).toContain("event: frame");
    expect(streamText).toContain("event: progress");
    expect(streamText).toContain("event: start");
    expect(streamText).toContain("event: done");
  });

  it("includes dynamic terrain horizon debug data in start payload", async () => {
    const dynamicMask = {
      generatedAt: "2026-03-08T00:00:00.000Z",
      method: "copernicus-dem30-runtime-raycast-v1",
      center: { lat: 46.5225, lon: 6.6005 },
      radiusKm: 120,
      binsDeg: Array.from({ length: 360 }, (_, index) => (index === 90 ? 18 : -2)),
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
      async (lat, lon, options) => ({
        ...createMockContext(lat, lon),
        terrainHorizonMethod:
          options?.terrainHorizonOverride?.method ?? "mock-terrain",
        horizonMask: options?.terrainHorizonOverride ?? null,
      }),
    );

    const request = new Request(
      "http://localhost/api/sunlight/timeline/stream?minLon=6.599447&minLat=46.522107&maxLon=6.600200&maxLat=46.522700&date=2026-03-08&timezone=Europe/Zurich&sampleEveryMinutes=60&gridStepMeters=20&maxPoints=3000",
      {
        method: "GET",
      },
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

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

    const startPayload = parseSseEventData(streamText, "start") as
      | {
          model?: {
            terrainHorizonMethod?: string;
            terrainHorizonDebug?: {
              ridgePoints?: Array<{ azimuthDeg: number }>;
            } | null;
          };
        }
      | null;

    expect(startPayload).not.toBeNull();
    expect(startPayload?.model?.terrainHorizonMethod).toBe(dynamicMask.method);
    expect(
      startPayload?.model?.terrainHorizonDebug?.ridgePoints?.length ?? 0,
    ).toBeGreaterThan(0);
    expect(startPayload?.model?.terrainHorizonDebug?.ridgePoints?.[0]?.azimuthDeg).toBe(
      90,
    );
  });

  it("includes start/end local times in stream start payload", async () => {
    const request = new Request(
      "http://localhost/api/sunlight/timeline/stream?minLon=6.599447&minLat=46.522107&maxLon=6.600200&maxLat=46.522700&date=2026-03-08&timezone=Europe/Zurich&startLocalTime=07:00&endLocalTime=09:00&sampleEveryMinutes=60&gridStepMeters=20&maxPoints=3000",
      {
        method: "GET",
      },
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

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

    const startPayload = parseSseEventData(streamText, "start") as
      | {
          startLocalTime?: string;
          endLocalTime?: string;
          frameCount?: number;
        }
      | null;

    expect(startPayload).not.toBeNull();
    expect(startPayload?.startLocalTime).toBe("07:00");
    expect(startPayload?.endLocalTime).toBe("09:00");
    expect(startPayload?.frameCount).toBe(2);
  });

  it("emits both full and no-vegetation masks in frame payloads", async () => {
    const request = new Request(
      "http://localhost/api/sunlight/timeline/stream?minLon=6.599447&minLat=46.522107&maxLon=6.600200&maxLat=46.522700&date=2026-03-08&timezone=Europe/Zurich&sampleEveryMinutes=60&gridStepMeters=20&maxPoints=3000",
      {
        method: "GET",
      },
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

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

    const framePayloads = parseAllSseEventData(streamText, "frame") as Array<{
      index: number;
      sunMaskBase64?: string;
      sunMaskNoVegetationBase64?: string;
    }>;
    expect(framePayloads.length).toBeGreaterThan(0);
    const firstFrame = framePayloads[0];
    expect(firstFrame.sunMaskBase64).toBeTypeOf("string");
    expect(firstFrame.sunMaskNoVegetationBase64).toBeTypeOf("string");

    const fullMask = decodeBase64Bytes(firstFrame.sunMaskBase64 ?? "");
    const noVegetationMask = decodeBase64Bytes(
      firstFrame.sunMaskNoVegetationBase64 ?? "",
    );
    expect(noVegetationMask.length).toBe(fullMask.length);
  });

  it("emits an error event when daily range has no samples", async () => {
    const request = new Request(
      "http://localhost/api/sunlight/timeline/stream?minLon=6.599447&minLat=46.522107&maxLon=6.600200&maxLat=46.522700&date=2026-03-08&timezone=Europe/Zurich&startLocalTime=10:00&endLocalTime=10:00&sampleEveryMinutes=60&gridStepMeters=20&maxPoints=3000",
      {
        method: "GET",
      },
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

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

    const errorPayloads = parseAllSseEventData(streamText, "error") as Array<{
      error?: string;
      details?: string;
    }>;
    expect(errorPayloads.length).toBeGreaterThan(0);
    expect(errorPayloads[0]?.error).toContain("Invalid daily time range");
  });

  it("streams cached timeline frames when precomputed tiles cover the bbox", async () => {
    vi.mocked(resolveSunlightTilesForBbox).mockResolvedValue({
      region: "lausanne",
      modelVersionHash: "model-hash",
      artifacts: [],
      tileSizeMeters: 250,
      cache: {
        hit: true,
        layer: "L2",
        region: "lausanne",
        modelVersionHash: "model-hash",
        fullyCovered: true,
        tilesRequested: 1,
        tilesFromL1: 0,
        tilesFromL2: 1,
        tilesComputed: 0,
      },
    });
    vi.mocked(buildTimelineFromArtifacts).mockReturnValue({
      gridPointCount: 2,
      pointCount: 1,
      indoorPointsExcluded: 1,
      pointsWithElevation: 1,
      pointsWithoutElevation: 0,
      points: [{ id: "ix1-iy2", lat: 46.5225, lon: 6.6005 }],
      frames: [
        {
          index: 0,
          localTime: "09:15",
          sunnyCount: 1,
          sunnyCountNoVegetation: 1,
          sunMaskBase64: "AQ==",
          sunMaskNoVegetationBase64: "AQ==",
        },
      ],
      warnings: [],
      model: {
        terrainHorizonMethod: "precomputed-cache",
        buildingsShadowMethod: "precomputed-cache",
        vegetationShadowMethod: "precomputed-cache",
        terrainHorizonDebug: null,
        shadowCalibration: {
          buildingHeightBiasMeters: 0,
        },
      },
    });

    const request = new Request(
      "http://localhost/api/sunlight/timeline/stream?minLon=6.599447&minLat=46.522107&maxLon=6.600200&maxLat=46.522700&date=2026-03-08&timezone=Europe/Zurich&sampleEveryMinutes=60&gridStepMeters=20&maxPoints=3000",
      { method: "GET" },
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

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

    const startPayload = parseSseEventData(streamText, "start") as
      | { cache?: { hit?: boolean; layer?: string; region?: string } }
      | null;
    const donePayload = parseSseEventData(streamText, "done") as
      | { cache?: { hit?: boolean; fullyCovered?: boolean } }
      | null;

    expect(startPayload?.cache?.hit).toBe(true);
    expect(startPayload?.cache?.layer).toBe("L2");
    expect(startPayload?.cache?.region).toBe("lausanne");
    expect(donePayload?.cache?.fullyCovered).toBe(true);
    expect(streamText).toContain('"phase":"cache-read"');
    expect(streamText).toContain('"phase":"cache-playback"');
  });
});
