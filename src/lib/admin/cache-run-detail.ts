import type {
  PrecomputedRegionName,
  RegionBbox,
} from "@/lib/precompute/sunlight-cache";

export interface CacheRunCanonicalRef {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  date: string;
  gridStepMeters: number;
  sampleEveryMinutes: number;
  startLocalTime: string;
  endLocalTime: string;
}

export interface CacheRunDetailRun extends CacheRunCanonicalRef {
  timezone: string;
  tileSizeMeters: number;
  tileCount: number;
  failedTileCount: number;
  complete: boolean;
  generatedAt: string;
}

// [lat, lon] pairs, suitable for direct Leaflet rendering.
export type CacheRunOutlineRing = Array<[number, number]>;

export interface CacheRunDetailResponse {
  run: CacheRunDetailRun;
  bbox: RegionBbox;
  outlineRings: CacheRunOutlineRing[];
}
