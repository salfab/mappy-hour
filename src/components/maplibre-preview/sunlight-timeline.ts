import type { Map as MapLibreMap } from "maplibre-gl";
import type { TimelineTile } from "@/components/sunlight-overlay/maplibre-sunlight-custom-layer";
import { decodeTileMasksBlob } from "@/lib/encoding/mask-codec-client";

export interface TimelineResult {
  tiles: TimelineTile[];
  frames: Array<{ localTime: string }>;
}

export interface FetchTimelineOptions {
  map: MapLibreMap;
  date: string;
  signal?: AbortSignal;
  onResult: (result: TimelineResult) => void;
  onError?: (err: unknown) => void;
  onLoadingChange?: (loading: boolean) => void;
}

/**
 * Fetch one SSE timeline from `/api/sunlight/timeline/stream` for the current
 * map bounds at `date`. Decodes gzip-concat-v1 masks in parallel with the read
 * loop and resolves the final tile set via `onResult`. All callbacks are
 * skipped when the signal is aborted.
 */
export async function fetchTimeline(opts: FetchTimelineOptions): Promise<void> {
  const { map, date, signal, onResult, onError, onLoadingChange } = opts;
  onLoadingChange?.(true);
  const bounds = map.getBounds();
  const params = new URLSearchParams({
    minLon: String(bounds.getWest()),
    minLat: String(bounds.getSouth()),
    maxLon: String(bounds.getEast()),
    maxLat: String(bounds.getNorth()),
    date,
    timezone: "Europe/Zurich",
    startLocalTime: "06:00",
    endLocalTime: "21:00",
    sampleEveryMinutes: "30",
    gridStepMeters: "1",
    maxPoints: "2000000",
    buildingHeightBiasMeters: "0",
    cacheOnly: "true",
  });

  try {
    const response = await fetch(`/api/sunlight/timeline/stream?${params}`, { signal });
    if (!response.ok || !response.body) {
      onError?.(new Error(`SSE HTTP ${response.status}`));
      onLoadingChange?.(false);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const collected: TimelineTile[] = [];
    const pendingDecodes: Promise<void>[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split(/\n\n/);
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        if (!block.trim()) continue;
        let eventType = "";
        let dataStr = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) dataStr = line.slice(5).trim();
        }
        if (!eventType || !dataStr) continue;

        try {
          const payload = JSON.parse(dataStr) as Record<string, unknown>;

          if (eventType === "start") {
            collected.length = 0;
            pendingDecodes.length = 0;
          } else if (eventType === "tile") {
            const tile = payload as unknown as TimelineTile & {
              masksEncoding?: string;
              masksBase64?: string;
              grid?: { width: number; height: number };
            };
            if (tile.masksEncoding === "gzip-concat-v1" && tile.masksBase64 && tile.grid) {
              const maskBytes = Math.ceil(tile.grid.width * tile.grid.height / 8);
              const frameCount = tile.frames.length;
              pendingDecodes.push(
                decodeTileMasksBlob(tile.masksBase64, maskBytes, frameCount).then((decoded) => {
                  tile.decodedMasks = decoded;
                }),
              );
            }
            collected.push(tile);
          } else if (eventType === "done") {
            await Promise.all(pendingDecodes);
            if (signal?.aborted) return;
            const first = collected[0];
            const frames = first?.frames?.map((f) => ({ localTime: f.localTime })) ?? [];
            onResult({ tiles: collected, frames });
            onLoadingChange?.(false);
          } else if (eventType === "error") {
            onError?.(payload);
            onLoadingChange?.(false);
          }
        } catch (parseErr) {
          console.warn("[maplibre-preview] SSE parse error:", parseErr);
        }
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    onError?.(err);
    onLoadingChange?.(false);
  }
}
