import type { Map as MapLibreMap } from "maplibre-gl";
import type { TimelineTile } from "@/components/sunlight-overlay/maplibre-sunlight-custom-layer";
import { decodeTileMasksBlob } from "@/lib/encoding/mask-codec-client";
import {
  getCachedTile,
  getCachedTileIdsInBbox,
  putCachedTile,
} from "./timeline-tile-cache";
import { encodeCompactTileIds } from "@/lib/encoding/tile-id-compact";

// Compact-encoded tile IDs are ~10 chars each (vs ~23 for the full form), so
// 1000 entries land at ~11 KB — still safely under typical proxy URL limits
// (~16 KB) while letting us skip a city-scale viewport's worth of work.
const MAX_EXCLUDE_TILE_IDS = 1000;

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
  const bbox = {
    minLon: bounds.getWest(),
    minLat: bounds.getSouth(),
    maxLon: bounds.getEast(),
    maxLat: bounds.getNorth(),
  };
  // Tile IDs we already hold in the LRU for this date AND that intersect
  // the requested bbox. The server skips them; we'll inject the cached
  // versions ourselves into the result.
  const cachedIdsInBbox = getCachedTileIdsInBbox(date, bbox, MAX_EXCLUDE_TILE_IDS);
  const params = new URLSearchParams({
    minLon: String(bbox.minLon),
    minLat: String(bbox.minLat),
    maxLon: String(bbox.maxLon),
    maxLat: String(bbox.maxLat),
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
  if (cachedIdsInBbox.length > 0) {
    params.set("excludeTileIds", encodeCompactTileIds(cachedIdsInBbox));
  }

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

    const seedFromCache = () => {
      for (const id of cachedIdsInBbox) {
        const cached = getCachedTile(date, id);
        if (cached) collected.push(cached);
      }
    };

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
            seedFromCache();
          } else if (eventType === "tile") {
            const tile = payload as unknown as TimelineTile & {
              masksEncoding?: string;
              masksBase64?: string;
              grid?: { width: number; height: number };
            };
            // LRU cache hit: skip the gzip decode entirely and reuse the
            // previously-decoded masks. The server still streamed the bytes,
            // but the heavy per-tile work (decompression + mask split) is
            // bypassed.
            const cached = getCachedTile(date, tile.tileId);
            if (cached) {
              collected.push(cached);
            } else {
              if (tile.masksEncoding === "gzip-concat-v1" && tile.masksBase64 && tile.grid) {
                const maskBytes = Math.ceil(tile.grid.width * tile.grid.height / 8);
                const frameCount = tile.frames.length;
                pendingDecodes.push(
                  decodeTileMasksBlob(tile.masksBase64, maskBytes, frameCount).then((decoded) => {
                    tile.decodedMasks = decoded;
                    putCachedTile(date, tile);
                  }),
                );
              }
              collected.push(tile);
            }
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
