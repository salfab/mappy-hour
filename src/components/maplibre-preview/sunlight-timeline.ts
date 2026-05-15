import type { Map as MapLibreMap } from "maplibre-gl";
import type { TimelineTile } from "@/components/sunlight-overlay/maplibre-sunlight-custom-layer";
import { decodeTileMasksBlob } from "@/lib/encoding/mask-codec-client";
import {
  getCachedTile,
  getCachedTileIdsInBbox,
  isBboxCoveredByCache,
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
  /** Progress signal for an external timeline progress bar:
   *  - `number` 0..100 → determinate.
   *  - `null` → indeterminate (start received but no total announced).
   *  - `undefined` → idle (cleared at fetch end). */
  onProgress?: (value: number | null | undefined) => void;
}

/**
 * Fetch one SSE timeline from `/api/sunlight/timeline/stream` for the current
 * map bounds at `date`. Decodes gzip-concat-v1 masks in parallel with the read
 * loop and resolves the final tile set via `onResult`. All callbacks are
 * skipped when the signal is aborted.
 */
export async function fetchTimeline(opts: FetchTimelineOptions): Promise<void> {
  const { map, date, signal, onResult, onError, onLoadingChange, onProgress } = opts;
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
  const fullyCovered = cachedIdsInBbox.length > 0 && isBboxCoveredByCache(date, bbox);
  console.log(
    `[timeline] fetch start date=${date} bbox=${bbox.minLon.toFixed(4)},${bbox.minLat.toFixed(4)},${bbox.maxLon.toFixed(4)},${bbox.maxLat.toFixed(4)} cachedInBbox=${cachedIdsInBbox.length} fullyCovered=${fullyCovered}`,
  );

  // Optimistic render: pop the cached tiles to the layer IMMEDIATELY so the
  // user sees the overlay without waiting for the network. If the bbox is
  // fully covered we can even skip the SSE call entirely.
  if (cachedIdsInBbox.length > 0) {
    const cachedTiles: TimelineTile[] = [];
    for (const id of cachedIdsInBbox) {
      const cached = getCachedTile(date, id);
      if (cached) cachedTiles.push(cached);
    }
    if (cachedTiles.length > 0) {
      const frames =
        cachedTiles[0].frames?.map((f) => ({ localTime: f.localTime })) ?? [];
      onResult({ tiles: cachedTiles, frames });
      onProgress?.(
        fullyCovered ? undefined : 0,
      );
    }
  }

  if (fullyCovered) {
    console.log("[timeline] bbox fully covered by LRU — skipping SSE round-trip.");
    onLoadingChange?.(false);
    onProgress?.(undefined);
    return;
  }

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
    // Diagnostic counters
    let seededFromCache = 0;
    let freshDecoded = 0;
    let cacheHitDuringStream = 0;
    let totalAnnounced = 0;

    const seedFromCache = () => {
      for (const id of cachedIdsInBbox) {
        const cached = getCachedTile(date, id);
        if (cached) {
          collected.push(cached);
          seededFromCache++;
        }
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
            seededFromCache = 0;
            freshDecoded = 0;
            cacheHitDuringStream = 0;
            totalAnnounced = (payload as { totalTiles?: number }).totalTiles ?? 0;
            seedFromCache();
            console.log(
              `[timeline] start event: server announces totalTiles=${totalAnnounced}, pre-seeded ${seededFromCache} from cache`,
            );
            // Cached tiles are already in `collected` — count them as
            // "progress so far" against the announced total.
            if (totalAnnounced > 0) {
              onProgress?.((collected.length / totalAnnounced) * 100);
            } else {
              onProgress?.(null);
            }
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
              // Server didn't skip this tile (probably because the client
              // didn't list it in excludeTileIds, e.g. cachedIdsInBbox cap
              // hit, or bbox filter excluded it). The decoded masks are
              // already in LRU though, so we still skip the decode.
              collected.push(cached);
              cacheHitDuringStream++;
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
                freshDecoded++;
              }
              collected.push(tile);
            }
            if (totalAnnounced > 0) {
              onProgress?.((collected.length / totalAnnounced) * 100);
            }
          } else if (eventType === "done") {
            await Promise.all(pendingDecodes);
            if (signal?.aborted) return;
            const first = collected[0];
            const frames = first?.frames?.map((f) => ({ localTime: f.localTime })) ?? [];
            console.log(
              `[timeline] done: collected=${collected.length} (seededFromCache=${seededFromCache} + freshDecoded=${freshDecoded} + cacheHitDuringStream=${cacheHitDuringStream}) | server announced totalTiles=${totalAnnounced} excludeRequested=${cachedIdsInBbox.length}`,
            );
            onResult({ tiles: collected, frames });
            onProgress?.(undefined);
            onLoadingChange?.(false);
          } else if (eventType === "error") {
            // Defensive fallback: if the server errored before emitting a
            // start event AND we have cached tiles to seed in the bbox, we
            // still render those rather than leaving the layer empty. The
            // server fix above should make this branch rare, but it keeps
            // older server versions usable.
            if (collected.length === 0 && cachedIdsInBbox.length > 0) {
              seedFromCache();
              if (collected.length > 0) {
                const frames = collected[0].frames?.map((f) => ({ localTime: f.localTime })) ?? [];
                console.log(
                  `[timeline] error event fallback: server said no tiles but we have ${collected.length} cached in bbox — rendering those.`,
                );
                onResult({ tiles: collected, frames });
                onProgress?.(undefined);
                onLoadingChange?.(false);
                continue;
              }
            }
            onError?.(payload);
            onProgress?.(undefined);
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
    onProgress?.(undefined);
    onLoadingChange?.(false);
  }
}
