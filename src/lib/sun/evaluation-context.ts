import { wgs84ToLv95Precise } from "@/lib/geo/projection";
import {
  createDetailedBuildingShadowVerifier,
  evaluateBuildingsShadow,
  evaluateBuildingsShadowTwoLevel,
  loadBuildingsObstacleIndex,
} from "@/lib/sun/buildings-shadow";
import { HorizonMask } from "@/lib/sun/horizon-mask";
import {
  DEFAULT_SHADOW_CALIBRATION,
  ShadowCalibration,
} from "@/lib/sun/shadow-calibration";
import {
  createVegetationShadowEvaluator,
  DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS,
  loadVegetationSurfaceTilesForBounds,
  loadVegetationSurfaceTilesForPoint,
  vegetationShadowMethod,
} from "@/lib/sun/vegetation-shadow";
import { buildLocalTerrainShadowEvaluator } from "@/lib/sun/terrain-shadow";
import {
  loadTerrainTilesForBounds,
  sampleSwissTerrainElevationLv95,
  sampleSwissTerrainElevationLv95FromTiles,
  TerrainTileSource,
} from "@/lib/terrain/swiss-terrain";

export interface Lv95Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BuildSharedPointEvaluationSourcesOptions {
  terrainHorizonOverride?: HorizonMask;
  lv95Bounds?: Lv95Bounds;
  vegetationSearchDistanceMeters?: number;
  /** Region name for WebGPU IPC worker */
  region?: string;
  /**
   * Skip loading the pre-computed zenith indoor mask. The preflight
   * (`precompute-tile-grid-metadata`) uses this: it cannot require the
   * metadata it's about to generate. The shared-sources function then
   * returns `zenithIndoorCheck = undefined`; consumers (like the
   * preflight itself) run the zenith shadow render and derive the mask.
   */
  skipZenithIndoorCheck?: boolean;
}

export interface SharedPointEvaluationSources {
  horizonMask: HorizonMask | null;
  buildingsIndex: Awaited<ReturnType<typeof loadBuildingsObstacleIndex>>;
  terrainTiles: TerrainTileSource[] | null;
  vegetationSurfaceTiles: Awaited<
    ReturnType<typeof loadVegetationSurfaceTilesForBounds>
  >;
  /** GPU shadow backend, created when MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster */
  gpuShadowBackend?: import("@/lib/sun/building-shadow-backend").BuildingShadowBackend | null;
  /** GPU compute backend for batch evaluation (precompute only). */
  webgpuComputeBackend?: import("@/lib/sun/building-shadow-backend").BatchBuildingShadowBackend | null;
  /** Zenith indoor mask: isIndoor(easting, northing) → boolean. Loaded from grid metadata. */
  zenithIndoorCheck?: (easting: number, northing: number) => boolean;
  /**
   * True when the backend's batch API will compute the vegetation-blocked
   * bitmask on GPU (Phase C+). When set, per-point `vegetationShadowEvaluator`
   * closures are NOT constructed by `buildPointEvaluationContext` because the
   * hot loop reads `batchVegetationBlockedMask` directly and never invokes
   * them. Saves ~400ms/tile of closure-allocation work for 62.5K grid points.
   */
  vegetationShadowHandledByBackend?: boolean;
  terrainShadowHandledByBackend?: boolean;
  /**
   * Per-tile focus capsule for the Vulkan backend. Computed alongside
   * `webgpuComputeBackend` when shadow mode = rust-wgpu-vulkan. The caller
   * (sunlight-tile-service) must thread this into `evaluateBatchFramesWithShadows`
   * via `options.focusUpdate` so the Vulkan backend can apply mesh + focus
   * atomically with the dispatch (race fix for concurrent precompute, see
   * RustWgpuVulkanShadowBackend.evaluateBatchFramesWithShadowsOnSlot).
   */
  vulkanFocusUpdate?: {
    focusBounds: { minX: number; minY: number; maxX: number; maxY: number };
    maxBuildingHeight: number;
    zoneKey: string;
    zoneObstacles?: Array<{
      centerX: number; centerY: number; height: number;
      minX: number; maxX: number; minY: number; maxY: number;
      [key: string]: unknown;
    }>;
  } | null;
}

export interface BuildPointEvaluationContextOptions {
  skipTerrainSamplingWhenIndoor?: boolean;
  terrainHorizonOverride?: HorizonMask;
  shadowCalibration?: ShadowCalibration;
  sharedSources?: SharedPointEvaluationSources;
  buildingShadowAllowedIds?: ReadonlySet<string>;
  /** Skip the indoor/outdoor building containment check (assume outdoor). */
  skipIndoorCheck?: boolean;
  /** Override terrain elevation instead of sampling from terrain tiles. */
  overrideElevation?: number | null;
}

export interface PointEvaluationContext {
  pointLv95: {
    easting: number;
    northing: number;
  };
  insideBuilding: boolean;
  indoorBuildingId: string | null;
  pointElevationMeters: number | null;
  terrainHorizonMethod: string;
  buildingsShadowMethod: string;
  vegetationShadowMethod?: string;
  warnings: string[];
  horizonMask: HorizonMask | null;
  buildingShadowEvaluator?: (sample: { azimuthDeg: number; altitudeDeg: number }) => {
    blocked: boolean;
    blockerId: string | null;
    blockerDistanceMeters: number | null;
    blockerAltitudeAngleDeg: number | null;
    checkedObstaclesCount: number;
    profiling?: {
      mode: "base" | "two-level";
      basePasses: number;
      nearThresholdHits: number;
      detailedVerifierCalls: number;
      detailedVerifierBlocked: number;
      detailedVerifierCleared: number;
      fallbackPassUsed: boolean;
    };
  };
  vegetationShadowEvaluator?: (sample: { azimuthDeg: number; altitudeDeg: number }) => {
    blocked: boolean;
    blockerDistanceMeters: number | null;
    blockerAltitudeAngleDeg: number | null;
    blockerSurfaceElevationMeters: number | null;
    blockerClearanceMeters: number | null;
    checkedSamplesCount: number;
  };
  terrainShadowEvaluator?: (sample: { azimuthDeg: number; altitudeDeg: number }) => {
    blocked: boolean;
    blockerDistanceMeters: number | null;
    blockerAltitudeAngleDeg: number | null;
    blockerSurfaceElevationMeters: number | null;
    checkedSamplesCount: number;
  };
}

type BuildingsShadowMode = "detailed" | "two-level" | "prism" | "gpu-raster" | "webgpu-compute" | "rust-wgpu-vulkan";

function parseBuildingsShadowMode(): BuildingsShadowMode {
  const raw = (process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "").trim().toLowerCase();
  if (
    raw === "detailed" ||
    raw === "two-level" ||
    raw === "prism" ||
    raw === "gpu-raster" ||
    raw === "webgpu-compute" ||
    raw === "rust-wgpu-vulkan"
  ) {
    return raw;
  }
  if (process.env.MAPPY_BUILDINGS_TWO_LEVEL_REFINEMENT === "0") {
    return "prism";
  }
  return "detailed";
}

const BUILDINGS_SHADOW_MODE = parseBuildingsShadowMode();
const BUILDINGS_TWO_LEVEL_NEAR_THRESHOLD_DEGREES = 2;
const BUILDINGS_TWO_LEVEL_MAX_REFINEMENT_STEPS = 3;
const BUILDINGS_DETAILED_MAX_REFINEMENT_STEPS = 32;

// ── GPU backend cache ────────────────────────────────────────────────
// The GPU backend is created per focus zone (~5km radius). When the
// focus moves to a different zone, the backend is recreated with only
// the buildings in that zone (spatial VBO filtering, ADR-0008).
const GPU_FOCUS_MARGIN_METERS = 5000; // load buildings within 5km of focus
let gpuBackendCache: import("@/lib/sun/building-shadow-backend").BuildingShadowBackend | null | undefined;
let gpuBackendFocusKey = "";
let gpuBackendLoading: Promise<import("@/lib/sun/building-shadow-backend").BuildingShadowBackend | null> | null = null;

function getRustWgpuVulkanFocusMarginMeters(): number {
  const parsed = Number(process.env.MAPPY_RUST_WGPU_FOCUS_MARGIN_METERS ?? 500);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function focusKeyFromBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }): string {
  // Round to 1km grid so nearby tiles share the same key
  const cx = Math.round((bounds.minX + bounds.maxX) / 2 / 1000);
  const cy = Math.round((bounds.minY + bounds.maxY) / 2 / 1000);
  return `${cx},${cy}`;
}

/**
 * Return the 1km-aligned bbox of the focus bucket that owns the given tile
 * bounds. Used for obstacle filtering: we need the mesh to cover the whole
 * 1km focus (all tiles sharing the same cached backend), not just the tile
 * bounds of the FIRST tile that triggered updateMesh — otherwise obstacles
 * located on the east side of the focus are missed when the first tile sat
 * on the west side (the infamous "62 Vulkan tiles still at bBlk=0%" pattern).
 */
function focusBucketBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): { minX: number; minY: number; maxX: number; maxY: number } {
  const cx = Math.round((bounds.minX + bounds.maxX) / 2 / 1000);
  const cy = Math.round((bounds.minY + bounds.maxY) / 2 / 1000);
  return {
    minX: cx * 1000 - 500,
    minY: cy * 1000 - 500,
    maxX: cx * 1000 + 500,
    maxY: cy * 1000 + 500,
  };
}

async function getOrCreateGpuBackend(
  obstacles: Array<{ centerX: number; centerY: number; height: number; minX: number; maxX: number; minY: number; maxY: number; [key: string]: unknown }>,
  focusBounds?: { minX: number; minY: number; maxX: number; maxY: number },
): Promise<import("@/lib/sun/building-shadow-backend").BuildingShadowBackend | null> {
  const newFocusKey = focusBounds ? focusKeyFromBounds(focusBounds) : "all";

  // If focus zone changed, invalidate the cache
  if (gpuBackendCache && newFocusKey !== gpuBackendFocusKey) {
    console.log(`[evaluation-context] GPU focus changed (${gpuBackendFocusKey} → ${newFocusKey}), recreating backend...`);
    gpuBackendCache.dispose();
    gpuBackendCache = undefined;
    gpuBackendLoading = null;
  }

  // Already created for this zone
  if (gpuBackendCache !== undefined) return gpuBackendCache;

  // Another call is already creating it — wait for that
  if (gpuBackendLoading) return gpuBackendLoading;

  gpuBackendLoading = (async () => {
    try {
      // Filter obstacles to focus zone + margin
      let filtered = obstacles;
      if (focusBounds) {
        const margin = GPU_FOCUS_MARGIN_METERS;
        filtered = obstacles.filter(o =>
          o.maxX > focusBounds.minX - margin && o.minX < focusBounds.maxX + margin &&
          o.maxY > focusBounds.minY - margin && o.minY < focusBounds.maxY + margin,
        );
        console.log(`[evaluation-context] Spatial filter: ${filtered.length}/${obstacles.length} obstacles within ${margin}m of focus`);
      }

      const { GpuBuildingShadowBackend } = await import(
        "@/lib/sun/gpu-building-shadow-backend"
      );
      const backend = await GpuBuildingShadowBackend.createWithDxfMeshes(
        filtered as Parameters<typeof GpuBuildingShadowBackend.createWithDxfMeshes>[0],
        4096,
      );
      console.log(
        `[evaluation-context] GPU raster backend ready: ${backend.name}, ${backend.triangleCount} triangles`,
      );
      gpuBackendCache = backend;
      gpuBackendFocusKey = newFocusKey;
      return backend;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[evaluation-context] GPU raster unavailable: ${msg}. Falling back to CPU.`,
      );
      gpuBackendCache = null;
      return null;
    } finally {
      gpuBackendLoading = null;
    }
  })();

  return gpuBackendLoading;
}

// ── WebGPU compute backend singleton cache ─────────────────────────────
let webgpuBackendCache: import("@/lib/sun/building-shadow-backend").BatchBuildingShadowBackend | null | undefined;

/** Dispose the cached WebGPU backend. Must be called before process exit to avoid D3D12 segfault. */
export function disposeWebGpuBackend(): void {
  if (webgpuBackendCache) {
    webgpuBackendCache.dispose();
    // Reset to `undefined` so a subsequent getOrCreate re-initializes.
    // `null` is reserved for "init failed → fallback CPU, do not retry"
    // (cf the catch block in getOrCreateRustWgpuVulkanBackend).
    webgpuBackendCache = undefined;
  }
  if (rustWgpuVulkanBackendCache) {
    rustWgpuVulkanBackendCache.dispose();
    rustWgpuVulkanBackendCache = undefined;
    rustWgpuVulkanBackendLoading = null;
    rustWgpuVulkanLastPreparedZoneKey = null;
    zoneObstaclesCache.clear();
  }
}

export async function disposeWebGpuBackendAsync(): Promise<void> {
  if (webgpuBackendCache) {
    webgpuBackendCache.dispose();
    webgpuBackendCache = null;
  }
  if (BUILDINGS_SHADOW_MODE === "rust-wgpu-vulkan") {
    console.log(
      `[evaluation-context] Rust/wgpu Vulkan dispose: ${rustWgpuVulkanBackendCache ? "backend cached" : "no cached backend"}`,
    );
  }
  if (rustWgpuVulkanBackendCache) {
    const backend = rustWgpuVulkanBackendCache;
    // Reset to `undefined` (not `null`) so a subsequent
    // getOrCreateRustWgpuVulkanBackend re-creates the backend instead of
    // hitting the `cache !== undefined` early-return that would return null.
    // This was the source of the multi-config freeze: bench scripts call
    // precomputeCacheRuns N times, each ending with this dispose; the
    // second config saw cache=null and silently got a null backend.
    rustWgpuVulkanBackendCache = undefined;
    rustWgpuVulkanBackendLoading = null;
    rustWgpuVulkanLastPreparedZoneKey = null;
    zoneObstaclesCache.clear();
    if ("shutdown" in backend && typeof backend.shutdown === "function") {
      await (backend.shutdown as () => Promise<void>)();
    } else {
      backend.dispose();
    }
  }
}

let webgpuBackendLoading: Promise<import("@/lib/sun/building-shadow-backend").BatchBuildingShadowBackend | null> | null = null;

let rustWgpuVulkanBackendCache: import("@/lib/sun/building-shadow-backend").BatchBuildingShadowBackend | null | undefined;
let rustWgpuVulkanBackendLoading: Promise<import("@/lib/sun/building-shadow-backend").BatchBuildingShadowBackend | null> | null = null;
// Tracks the last 1km focus zone for which `updateMesh` has been issued out
// of band by `prepareVulkanZoneIfChanged`. Reset at backend dispose.
let rustWgpuVulkanLastPreparedZoneKey: string | null = null;

// Per-zone filtered-obstacles cache. Filtering ~8k obstacles per tile is
// wasteful when 16 tiles share the same 1km zone — cache the result keyed
// on `${focusKey}|m${margin}`. Cleared at backend dispose.
const zoneObstaclesCache = new Map<
  string,
  Array<{
    centerX: number; centerY: number; height: number;
    minX: number; maxX: number; minY: number; maxY: number;
    [key: string]: unknown;
  }>
>();

type ObstacleType = {
  centerX: number; centerY: number; height: number;
  minX: number; maxX: number; minY: number; maxY: number;
  [key: string]: unknown;
};

function filterObstaclesForZone(
  obstacles: ReadonlyArray<ObstacleType>,
  focusBounds: { minX: number; minY: number; maxX: number; maxY: number },
  margin: number,
): ObstacleType[] {
  const bucket = focusBucketBounds(focusBounds);
  return obstacles.filter(
    (o) =>
      o.maxX > bucket.minX - margin && o.minX < bucket.maxX + margin &&
      o.maxY > bucket.minY - margin && o.minY < bucket.maxY + margin,
  );
}

/**
 * Build the per-tile focus capsule that is threaded into
 * `evaluateBatchFramesWithShadows` via `options.focusUpdate`. The Vulkan
 * backend applies it inside the session lock, atomically with the dispatch,
 * preventing concurrent tile prep from clobbering the focus state mid-eval
 * (race fix 2026-05-08).
 *
 * Returns null when the focus zone has no obstacles (caller falls back to
 * "all outdoor" for this tile, same semantics as the previous mutating path).
 */
export function buildVulkanFocusCapsule(
  obstacles: ReadonlyArray<ObstacleType>,
  focusBounds: { minX: number; minY: number; maxX: number; maxY: number },
): SharedPointEvaluationSources["vulkanFocusUpdate"] {
  const margin = getRustWgpuVulkanFocusMarginMeters();
  const zoneKey = `${focusKeyFromBounds(focusBounds)}|m${margin}`;
  let zoneObstacles = zoneObstaclesCache.get(zoneKey);
  if (!zoneObstacles) {
    zoneObstacles = filterObstaclesForZone(obstacles, focusBounds, margin);
    zoneObstaclesCache.set(zoneKey, zoneObstacles);
  }
  if (zoneObstacles.length === 0) {
    return null;
  }
  const maxBuildingHeight = zoneObstacles.reduce(
    (max, o) => Math.max(max, o.height),
    0,
  );
  return {
    focusBounds: {
      minX: focusBounds.minX,
      minY: focusBounds.minY,
      maxX: focusBounds.maxX,
      maxY: focusBounds.maxY,
    },
    maxBuildingHeight,
    zoneKey,
    zoneObstacles,
  };
}

/**
 * Out-of-lock mesh update for the Vulkan backend, called by the precompute
 * orchestrator at zone boundaries. The caller MUST guarantee that no in-flight
 * eval is running on the backend when this is invoked (drain barrier in
 * cache-admin tile-first branch).
 *
 * Returns true if the mesh was actually updated (zone changed); false if the
 * zone was already current (no-op). Used to drive a `[zone-prepare]` log line
 * for diagnostics.
 *
 * Race fix 2026-05-08 part 2: keeps `updateMesh` out of `withSessionLock` so
 * it doesn't serialise zone changes against the whole pipeline. The earlier
 * fix put `updateMesh` inside the lock to close the focus race; that cost
 * ~30s wall on Lausanne tile-first runs (18 zone changes × ~2s amortisation
 * gap). Moving the call here, behind a drain barrier, recovers the gap.
 */
export async function prepareVulkanZoneIfChanged(params: {
  focusBounds: { minX: number; minY: number; maxX: number; maxY: number };
}): Promise<boolean> {
  // Read env at call time (not module load time): the orchestrator may set
  // MAPPY_BUILDINGS_SHADOW_MODE after this module is first imported, e.g.
  // when precompute-region-sunlight.ts parses --buildings-shadow-mode CLI
  // before importing cache-admin which transitively pulls evaluation-context.
  const mode = (process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "").trim().toLowerCase();
  if (mode !== "rust-wgpu-vulkan") return false;
  const margin = getRustWgpuVulkanFocusMarginMeters();
  const zoneKey = `${focusKeyFromBounds(params.focusBounds)}|m${margin}`;
  if (zoneKey === rustWgpuVulkanLastPreparedZoneKey) return false;
  // Backend not yet created (first zone change before any tile has triggered
  // cold-start) — skip silently. The first tile in this zone will cold-start
  // the backend with its own zone-filtered obstacles.
  if (!rustWgpuVulkanBackendCache) return false;
  const buildingsIndex = await loadBuildingsObstacleIndex();
  if (!buildingsIndex) return false;
  let zoneObstacles = zoneObstaclesCache.get(zoneKey);
  if (!zoneObstacles) {
    zoneObstacles = filterObstaclesForZone(
      buildingsIndex.obstacles,
      params.focusBounds,
      margin,
    );
    zoneObstaclesCache.set(zoneKey, zoneObstacles);
  }
  if (zoneObstacles.length === 0) {
    // No obstacles in this zone — keep the existing mesh (tiles will get
    // empty buildings shadows naturally). Still mark the zone prepared so we
    // don't retry every tile.
    rustWgpuVulkanLastPreparedZoneKey = zoneKey;
    return false;
  }
  const backend = rustWgpuVulkanBackendCache as unknown as {
    updateMesh: (o: typeof zoneObstacles) => Promise<void>;
    triangleCount: number;
  };
  const t0 = performance.now();
  await backend.updateMesh(zoneObstacles);
  const ms = performance.now() - t0;
  console.log(
    `[zone-prepare] ${zoneKey}  ${ms.toFixed(0)}ms  ${zoneObstacles.length} obstacles  ${backend.triangleCount} triangles`,
  );
  rustWgpuVulkanLastPreparedZoneKey = zoneKey;
  return true;
}

async function getOrCreateRustWgpuVulkanBackend(
  obstacles: Array<{ centerX: number; centerY: number; height: number; minX: number; maxX: number; minY: number; maxY: number; [key: string]: unknown }>,
  focusBounds?: { minX: number; minY: number; maxX: number; maxY: number },
): Promise<import("@/lib/sun/building-shadow-backend").BatchBuildingShadowBackend | null> {
  // Lifecycle simplified post-2026-05-08 race fix: this function only ensures
  // the backend INSTANCE exists. Per-tile focus state (focusBounds, maxH,
  // mesh swap on zone change) is no longer applied here — it travels through
  // `sharedSources.vulkanFocusUpdate` and is committed atomically inside the
  // session lock by `evaluateBatchFramesWithShadows`. Removing the per-tile
  // mutations eliminates the race that caused intermittent atlas drift on
  // tiles whose dispatch overlapped a sibling tile's focus prep.
  if (rustWgpuVulkanBackendCache !== undefined) {
    return rustWgpuVulkanBackendCache;
  }
  if (rustWgpuVulkanBackendLoading) return rustWgpuVulkanBackendLoading;

  rustWgpuVulkanBackendLoading = (async () => {
    try {
      const margin = getRustWgpuVulkanFocusMarginMeters();
      let filtered = obstacles;
      if (focusBounds) {
        // Cold-start filter: use first-tile zone obstacles so initial mesh
        // upload is small. Subsequent zone changes ride through focusUpdate.
        filtered = filterObstaclesForZone(obstacles, focusBounds, margin);
        console.log(`[evaluation-context] Rust/wgpu Vulkan spatial filter: ${filtered.length}/${obstacles.length} obstacles within ${margin}m of 1km focus bucket`);
      }
      if (filtered.length === 0) {
        return null;
      }

      const { RustWgpuVulkanShadowBackend } = await import(
        "@/lib/sun/rust-wgpu-vulkan-shadow-backend"
      );
      const backend = await RustWgpuVulkanShadowBackend.createWithDxfMeshes(
        filtered as Parameters<typeof RustWgpuVulkanShadowBackend.createWithDxfMeshes>[0],
        4096,
      );
      console.log(
        `[evaluation-context] Rust/wgpu Vulkan backend ready: ${backend.name}, ${backend.triangleCount} triangles`,
      );
      rustWgpuVulkanBackendCache = backend;
      return backend;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[evaluation-context] Rust/wgpu Vulkan unavailable: ${msg}. Falling back to CPU.`);
      rustWgpuVulkanBackendCache = null;
      return null;
    } finally {
      rustWgpuVulkanBackendLoading = null;
    }
  })();

  return rustWgpuVulkanBackendLoading;
}

// Kept for direct in-process WebGPU experiments; the safer precompute path uses WebGpuIpcClient.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function getOrCreateWebGpuBackend(
  obstacles: Array<{ centerX: number; centerY: number; height: number; [key: string]: unknown }>,
): Promise<import("@/lib/sun/building-shadow-backend").BatchBuildingShadowBackend | null> {
  console.log("[webgpu-lazy] getOrCreateWebGpuBackend called");
  if (webgpuBackendCache !== undefined) return webgpuBackendCache;
  if (webgpuBackendLoading) return webgpuBackendLoading;

  webgpuBackendLoading = (async () => {
    try {
      // Use relative path — @/ alias doesn't work in forked child processes
      const mod = await import("./webgpu-compute-shadow-backend") as
        { WebGpuComputeShadowBackend: typeof import("@/lib/sun/webgpu-compute-shadow-backend").WebGpuComputeShadowBackend };
      const { WebGpuComputeShadowBackend } = mod;
      const backend = await WebGpuComputeShadowBackend.createWithDxfMeshes(
        obstacles as Parameters<typeof WebGpuComputeShadowBackend.createWithDxfMeshes>[0],
        4096,
      );
      console.log(
        `[evaluation-context] WebGPU compute backend ready: ${backend.name}, ${backend.triangleCount} triangles`,
      );
      webgpuBackendCache = backend;
      return backend;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[evaluation-context] WebGPU compute unavailable: ${msg}. Falling back to gpu-raster/CPU.`,
      );
      webgpuBackendCache = null;
      return null;
    } finally {
      webgpuBackendLoading = null;
    }
  })();

  return webgpuBackendLoading;
}

export async function buildSharedPointEvaluationSources(
  options: BuildSharedPointEvaluationSourcesOptions = {},
): Promise<SharedPointEvaluationSources> {
  const buildingsIndex = await loadBuildingsObstacleIndex();
  // No static horizon-mask fallback: callers that need one must either
  //  - precompute path → `resolveAdaptiveTerrainHorizonForTile` sets `terrainHorizonOverride`
  //  - live API path   → build it on the fly via `buildDynamicHorizonMask`
  // Dropping the old Lausanne-centered fallback avoids silently using a
  // 40+ km offset mask for Geneva/Vevey/etc. live queries. If a caller
  // reaches this function without an override and no dynamic builder,
  // the warning at the bottom of buildPointEvaluationContext flags it.
  const horizonMask = options.terrainHorizonOverride ?? null;
  const terrainTiles = options.lv95Bounds
    ? await loadTerrainTilesForBounds({
        minX: options.lv95Bounds.minX,
        minY: options.lv95Bounds.minY,
        maxX: options.lv95Bounds.maxX,
        maxY: options.lv95Bounds.maxY,
      })
    : null;
  const vegetationSurfaceTiles = options.lv95Bounds
    ? await loadVegetationSurfaceTilesForBounds({
        minX:
          options.lv95Bounds.minX -
          (options.vegetationSearchDistanceMeters ??
            DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS),
        minY:
          options.lv95Bounds.minY -
          (options.vegetationSearchDistanceMeters ??
            DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS),
        maxX:
          options.lv95Bounds.maxX +
          (options.vegetationSearchDistanceMeters ??
            DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS),
        maxY:
          options.lv95Bounds.maxY +
          (options.vegetationSearchDistanceMeters ??
            DEFAULT_VEGETATION_SHADOW_MAX_DISTANCE_METERS),
      })
    : null;

  // ── GPU raster backend (optional, cached at module level) ──────────
  let gpuShadowBackend: SharedPointEvaluationSources["gpuShadowBackend"] = undefined;
  if (BUILDINGS_SHADOW_MODE === "gpu-raster" && buildingsIndex) {
    const backend = await getOrCreateGpuBackend(buildingsIndex.obstacles, options.lv95Bounds ?? undefined);
    if (backend) {
      // Update frustum focus for this specific tile (narrows the shadow map
      // to the tile area for higher resolution). setFrustumFocus is specific
      // to GpuBuildingShadowBackend — safe to cast since we just created it.
      if (options.lv95Bounds && "setFrustumFocus" in backend) {
        const maxH = buildingsIndex.obstacles.reduce((m, o) => Math.max(m, o.height), 0);
        (backend as { setFrustumFocus: (bounds: { minX: number; minY: number; maxX: number; maxY: number }, maxH: number) => void }).setFrustumFocus(
          {
            minX: options.lv95Bounds.minX,
            minY: options.lv95Bounds.minY,
            maxX: options.lv95Bounds.maxX,
            maxY: options.lv95Bounds.maxY,
          },
          maxH,
        );
      }
      gpuShadowBackend = backend;
    } else {
      gpuShadowBackend = null; // GPU unavailable, fallback to CPU
    }
  }

  // ── WebGPU compute backend (optional, precompute only) ───────────────
  // Uses an isolated subprocess (stdin/stdout) so Dawn/D3D12 never coexists
  // with terrain file I/O in the same process (Intel Arc driver bug).
  let webgpuComputeBackend: SharedPointEvaluationSources["webgpuComputeBackend"] = undefined;
  let vulkanFocusUpdate: SharedPointEvaluationSources["vulkanFocusUpdate"] = null;
  if (BUILDINGS_SHADOW_MODE === "webgpu-compute" && buildingsIndex) {
    try {
      const { WebGpuIpcClient } = await import("./webgpu-ipc-client");
      const client = await WebGpuIpcClient.create(options.region ?? "lausanne", options.lv95Bounds ?? undefined);
      if (options.lv95Bounds) {
        const maxH = buildingsIndex.obstacles.reduce((m, o) => Math.max(m, o.height), 0);
        await client.setFrustumFocus(
          { minX: options.lv95Bounds.minX, minY: options.lv95Bounds.minY,
            maxX: options.lv95Bounds.maxX, maxY: options.lv95Bounds.maxY },
          maxH,
        );
      }
      webgpuComputeBackend = client;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[evaluation-context] WebGPU IPC unavailable: ${msg}. Falling back to CPU.`);
      webgpuComputeBackend = null;
    }
  }
  if (BUILDINGS_SHADOW_MODE === "rust-wgpu-vulkan" && buildingsIndex) {
    webgpuComputeBackend = await getOrCreateRustWgpuVulkanBackend(
      buildingsIndex.obstacles,
      options.lv95Bounds ?? undefined,
    );
    if (webgpuComputeBackend && options.lv95Bounds) {
      vulkanFocusUpdate = buildVulkanFocusCapsule(
        buildingsIndex.obstacles,
        options.lv95Bounds,
      );
    }
  }

  // ── Zenith indoor mask (from pre-computed grid metadata) ─────────────
  // Provides accurate indoor/outdoor detection using real DXF mesh geometry
  // instead of convex hull footprints. Generated once per building model.
  let zenithIndoorCheck: SharedPointEvaluationSources["zenithIndoorCheck"];
  if (options.lv95Bounds && !options.skipZenithIndoorCheck) {
    try {
      const { loadTileGridMetadata } = await import("@/lib/precompute/tile-grid-metadata");
      const { getSunlightModelVersion } = await import("@/lib/precompute/model-version");
      const regionName = options.region ?? "lausanne";
      const modelVersion = await getSunlightModelVersion(regionName as import("@/lib/precompute/sunlight-cache").PrecomputedRegionName, { buildingHeightBiasMeters: 0 });
      // Find tile ID from lv95Bounds (tile bounds are 250m aligned)
      const tileSizeMeters = 250;
      const tileMinE = Math.floor(options.lv95Bounds.minX / tileSizeMeters) * tileSizeMeters;
      const tileMinN = Math.floor(options.lv95Bounds.minY / tileSizeMeters) * tileSizeMeters;
      const tileId = `e${tileMinE}_n${tileMinN}_s${tileSizeMeters}`;
      const metadata = await loadTileGridMetadata(
        regionName, modelVersion.gridMetadataHash, 1, tileId,
      );
      if (metadata) {
        const gridMinIx = Math.floor(tileMinE);
        const gridMinIy = Math.floor(tileMinN);
        const gridW = Math.ceil(tileSizeMeters);
        zenithIndoorCheck = (easting: number, northing: number) => {
          const ix = Math.floor(easting) - gridMinIx;
          const iy = Math.floor(northing) - gridMinIy;
          if (ix < 0 || ix >= gridW || iy < 0 || iy >= metadata.totalPoints / gridW) return false;
          const idx = iy * gridW + ix;
          return metadata.indoor[idx] ?? false;
        };
        console.error(`[indoor-check] Loaded zenith indoor mask for ${tileId} (${metadata.indoorCount} indoor)`);
      } else if (buildingsIndex) {
        // Grid-metadata is missing. Fast-path optim: if the focus zone of
        // this tile contains zero building obstacles, no roof can ever
        // block the zenith → entire tile is outdoor and we can skip the
        // preflight requirement. Used by rural tiles (e.g. open fields
        // north of Lausanne) where running the full zenith shadow render
        // is wasted work.
        //
        // Otherwise: fail-fast. The previous runtime fallback hardcoded
        // `approxElevation = 500` and silently mis-classified every
        // building whose roof was below 500m absolute (≈80% of Lausanne's
        // urban fabric). We now require the preflight to have run:
        //   npm run precompute:grid-metadata -- --region=<region>
        const margin =
          BUILDINGS_SHADOW_MODE === "rust-wgpu-vulkan"
            ? getRustWgpuVulkanFocusMarginMeters()
            : GPU_FOCUS_MARGIN_METERS;
        const inFocus = buildingsIndex.obstacles.some((o) =>
          o.maxX > tileMinE - margin && o.minX < tileMinE + tileSizeMeters + margin &&
          o.maxY > tileMinN - margin && o.minY < tileMinN + tileSizeMeters + margin,
        );
        if (!inFocus) {
          console.error(`[indoor-check] No obstacles in focus zone for ${tileId}, all points treated as outdoor.`);
          zenithIndoorCheck = () => false;
        } else {
          throw new Error(
            `Indoor detection unavailable for tile ${tileId}: grid metadata is missing and obstacles are present. ` +
            `Run the preflight to generate the zenith indoor mask: ` +
            `\`npm run precompute:grid-metadata -- --region=${regionName}\` ` +
            `(or run the full \`precompute:all-regions\` which includes the preflight).`,
          );
        }
      } else {
        throw new Error(
          `Indoor detection unavailable for tile ${tileId}: no grid metadata and no buildings index. ` +
          `Run the preflight: \`npm run precompute:grid-metadata -- --region=${regionName}\`.`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Indoor detection unavailable")) throw e;
    }
  }

  // The vegetation bitmask is produced by the GPU when the batch backend
  // exposes both `uploadVegetationRasters` and `evaluateBatchFramesWithShadows`
  // (Phase C + D). In that case the hot loop reads the GPU bitmask and never
  // invokes the per-point CPU closure — skip its construction upstream.
  const vegetationShadowHandledByBackend =
    webgpuComputeBackend != null &&
    typeof (webgpuComputeBackend as { uploadVegetationRasters?: unknown })
      .uploadVegetationRasters === "function" &&
    typeof (webgpuComputeBackend as { evaluateBatchFramesWithShadows?: unknown })
      .evaluateBatchFramesWithShadows === "function";
  // Local terrain (DEM) ray-march is also handled by the GPU when the
  // backend exposes `uploadTerrainRasters`. When true, skip the per-point
  // CPU closure construction — the GPU OR's it into terrainBlockedWords.
  const terrainShadowHandledByBackend =
    webgpuComputeBackend != null &&
    typeof (webgpuComputeBackend as { uploadTerrainRasters?: unknown })
      .uploadTerrainRasters === "function" &&
    typeof (webgpuComputeBackend as { evaluateBatchFramesWithShadows?: unknown })
      .evaluateBatchFramesWithShadows === "function";

  return {
    horizonMask,
    buildingsIndex,
    terrainTiles,
    vegetationSurfaceTiles,
    gpuShadowBackend,
    webgpuComputeBackend,
    zenithIndoorCheck,
    vegetationShadowHandledByBackend,
    terrainShadowHandledByBackend,
    vulkanFocusUpdate,
  };
}

export async function buildPointEvaluationContext(
  lat: number,
  lon: number,
  options: BuildPointEvaluationContextOptions = {},
): Promise<PointEvaluationContext> {
  const shadowCalibration =
    options.shadowCalibration ?? DEFAULT_SHADOW_CALIBRATION;
  const pointLv95 = wgs84ToLv95Precise(lon, lat);
  const sharedSources =
    options.sharedSources ??
    (await buildSharedPointEvaluationSources({
      terrainHorizonOverride: options.terrainHorizonOverride,
    }));
  const horizonMask = sharedSources.horizonMask;
  const buildingsIndex = sharedSources.buildingsIndex;

  // Sample terrain elevation first (needed for zenith shadow map indoor check)
  const pointElevationMeters = options.overrideElevation !== undefined
    ? options.overrideElevation
    : sharedSources.terrainTiles && sharedSources.terrainTiles.length > 0
      ? sampleSwissTerrainElevationLv95FromTiles(
          sharedSources.terrainTiles,
          pointLv95.easting,
            pointLv95.northing,
          )
        : await sampleSwissTerrainElevationLv95(pointLv95.easting, pointLv95.northing);

  // Indoor detection priority:
  // 1. Pre-computed zenith mask from grid metadata (fastest, most accurate)
  // 2. GPU zenith shadow map render (accurate but slower, needs GPU backend)
  // 3. Convex hull containment (fast but inaccurate for L/U shapes)
  let containment: { insideBuilding: boolean; buildingId: string | null };
  if (options.skipIndoorCheck) {
    containment = { insideBuilding: false, buildingId: null };
  } else if (sharedSources.zenithIndoorCheck) {
    containment = {
      insideBuilding: sharedSources.zenithIndoorCheck(pointLv95.easting, pointLv95.northing),
      buildingId: null,
    };
  } else {
    // No zenith indoor check available — treat as outdoor.
    // Convex hull containment is no longer used (inaccurate for L/U shapes).
    containment = { insideBuilding: false, buildingId: null };
  }

  const shouldEvaluateVegetation =
    pointElevationMeters !== null && !containment.insideBuilding;
  const vegetationSurfaceTiles = shouldEvaluateVegetation
    ? sharedSources.vegetationSurfaceTiles ??
      (await loadVegetationSurfaceTilesForPoint(
        pointLv95.easting,
        pointLv95.northing,
      ))
    : null;

  // ── GPU raster path ───────────────────────────────────────────────
  const gpuBackend = sharedSources.gpuShadowBackend;
  const useGpuRaster =
    BUILDINGS_SHADOW_MODE === "gpu-raster" &&
    gpuBackend != null &&
    gpuBackend !== null;
  const useBatchBuildingBackend =
    (BUILDINGS_SHADOW_MODE === "webgpu-compute" || BUILDINGS_SHADOW_MODE === "rust-wgpu-vulkan") &&
    sharedSources.webgpuComputeBackend != null;

  const buildingShadowEvaluator =
    buildingsIndex && pointElevationMeters !== null && !containment.insideBuilding
      ? (() => {
          // ── GPU raster evaluator ─────────────────────────────────
          if (useGpuRaster) {
            return (sample: { azimuthDeg: number; altitudeDeg: number }) => {
              // prepareSunPosition is idempotent for the same angles
              // (tracked inside the backend via lastPreparedAz/Alt)
              gpuBackend.prepareSunPosition(sample.azimuthDeg, sample.altitudeDeg);
              const result = gpuBackend.evaluate({
                pointX: pointLv95.easting,
                pointY: pointLv95.northing,
                pointElevation: pointElevationMeters,
                solarAzimuthDeg: sample.azimuthDeg,
                solarAltitudeDeg: sample.altitudeDeg,
              });
              return {
                blocked: result.blocked,
                blockerId: result.blockerId,
                blockerDistanceMeters: result.blockerDistanceMeters,
                blockerAltitudeAngleDeg: result.blockerAltitudeAngleDeg,
                checkedObstaclesCount: 0,
              };
            };
          }
          // Batch backends (Vulkan / WebGPU compute) are preferred by the
          // precompute hot loop via `evaluateBatch*`; the per-point evaluator
          // below is ignored there (see sunlight-tile-service.ts useBatchMask
          // branch). But live endpoints like /api/sunlight/instant/stream call
          // evaluateInstantSunlight point-by-point and need this evaluator to
          // be defined — returning undefined here made Vulkan-mode UI show 0%
          // building shadows. Fall back to the CPU "detailed" evaluator.

          // ── CPU evaluator (existing logic) ───────────────────────
          const detailedVerifier =
            BUILDINGS_SHADOW_MODE === "prism"
              ? null
              : createDetailedBuildingShadowVerifier(buildingsIndex.obstacles);

          return (sample: { azimuthDeg: number; altitudeDeg: number }) => {
            if (!detailedVerifier || BUILDINGS_SHADOW_MODE === "prism") {
              return evaluateBuildingsShadow(
                buildingsIndex.obstacles,
                {
                  pointX: pointLv95.easting,
                  pointY: pointLv95.northing,
                  pointElevation: pointElevationMeters,
                  allowedBlockerIds: options.buildingShadowAllowedIds,
                  buildingHeightBiasMeters:
                    shadowCalibration.buildingHeightBiasMeters,
                  solarAzimuthDeg: sample.azimuthDeg,
                  solarAltitudeDeg: sample.altitudeDeg,
                },
                buildingsIndex.spatialGrid,
              );
            }

            if (BUILDINGS_SHADOW_MODE === "two-level") {
              return evaluateBuildingsShadowTwoLevel(
                buildingsIndex.obstacles,
                {
                  pointX: pointLv95.easting,
                  pointY: pointLv95.northing,
                  pointElevation: pointElevationMeters,
                  allowedBlockerIds: options.buildingShadowAllowedIds,
                  buildingHeightBiasMeters:
                    shadowCalibration.buildingHeightBiasMeters,
                  solarAzimuthDeg: sample.azimuthDeg,
                  solarAltitudeDeg: sample.altitudeDeg,
                },
                buildingsIndex.spatialGrid,
                {
                  detailedVerifier,
                  nearThresholdDegrees:
                    BUILDINGS_TWO_LEVEL_NEAR_THRESHOLD_DEGREES,
                  maxRefinementSteps:
                    BUILDINGS_TWO_LEVEL_MAX_REFINEMENT_STEPS,
                },
              );
            }

            return evaluateBuildingsShadowTwoLevel(
              buildingsIndex.obstacles,
              {
                pointX: pointLv95.easting,
                pointY: pointLv95.northing,
                pointElevation: pointElevationMeters,
                allowedBlockerIds: options.buildingShadowAllowedIds,
                buildingHeightBiasMeters:
                  shadowCalibration.buildingHeightBiasMeters,
                solarAzimuthDeg: sample.azimuthDeg,
                solarAltitudeDeg: sample.altitudeDeg,
              },
              buildingsIndex.spatialGrid,
              {
                detailedVerifier,
                nearThresholdDegrees: Number.POSITIVE_INFINITY,
                maxRefinementSteps:
                  BUILDINGS_DETAILED_MAX_REFINEMENT_STEPS,
              },
            );
          };
        })()
      : undefined;
  // Phase F: skip the per-point CPU evaluator when the batch backend computes
  // the vegetation bitmask on GPU. Mirrors the existing `useBatchBuildingBackend`
  // short-circuit for buildings above.
  const vegetationShadowEvaluator =
    sharedSources.vegetationShadowHandledByBackend
      ? undefined
      : vegetationSurfaceTiles &&
        vegetationSurfaceTiles.length > 0 &&
        pointElevationMeters !== null &&
        !containment.insideBuilding
        ? createVegetationShadowEvaluator({
            tiles: vegetationSurfaceTiles,
            pointX: pointLv95.easting,
            pointY: pointLv95.northing,
            pointElevation: pointElevationMeters,
          })
        : undefined;

  // Local terrain self-shadowing: complements the horizon mask (which only
  // captures distant relief > ~500m) by ray-marching the local DEM out to
  // 500m. Gated to altitudeDeg < 30° inside the evaluator. See ADR-0011 and
  // shortcuts-registry 2b.X (terrain local ray-march).
  //
  // Skipped when the GPU backend exposes uploadTerrainRasters: the same
  // ray-march runs on GPU (shortcut 2b.11) and is already OR'd into
  // batchTerrainBlockedMask. Building the CPU evaluator here would force the
  // tile-service hot loop fallback (`hasLocalTerrainEvaluator` disables Phase
  // E bulk-copy) and re-do work the GPU already did.
  const terrainShadowEvaluator =
    !sharedSources.terrainShadowHandledByBackend &&
    sharedSources.terrainTiles &&
    sharedSources.terrainTiles.length > 0 &&
    pointElevationMeters !== null &&
    !containment.insideBuilding
      ? buildLocalTerrainShadowEvaluator({
          pointLv95Easting: pointLv95.easting,
          pointLv95Northing: pointLv95.northing,
          pointElevationMeters,
          terrainTiles: sharedSources.terrainTiles,
        })
      : undefined;

  const warnings: string[] = [];
  if (!horizonMask) {
    warnings.push(
      "No horizon mask. Callers should supply `terrainHorizonOverride` (live API: buildDynamicHorizonMask; precompute: resolveAdaptiveTerrainHorizonForTile). Far-horizon blocking will be ignored.",
    );
  }
  if (!buildingsIndex) {
    warnings.push(
      "No buildings obstacle index found. Run preprocess:buildings:index after ingesting buildings data for your target area.",
    );
  }
  if (shouldEvaluateVegetation && vegetationSurfaceTiles === null) {
    warnings.push(
      "No vegetation surface raster found. Run ingest:lausanne:vegetation:surface and/or ingest:nyon:vegetation:surface to enable vegetation shadow blocking.",
    );
  }
  if (pointElevationMeters === null && !containment.insideBuilding) {
    warnings.push(
      "Point elevation unavailable from swissALTI3D. Building-shadow blocking was skipped.",
    );
  }

  return {
    pointLv95,
    insideBuilding: containment.insideBuilding,
    indoorBuildingId: containment.buildingId,
    pointElevationMeters,
    terrainHorizonMethod: horizonMask?.method ?? "none",
    buildingsShadowMethod: buildingsIndex
      ? `${buildingsIndex.method}${
          useGpuRaster
            ? "|gpu-raster-v1"
            : useBatchBuildingBackend && BUILDINGS_SHADOW_MODE === "webgpu-compute"
              ? "|webgpu-compute-batch-v1"
            : useBatchBuildingBackend && BUILDINGS_SHADOW_MODE === "rust-wgpu-vulkan"
              ? "|rust-wgpu-vulkan-v1"
            : BUILDINGS_SHADOW_MODE === "gpu-raster" && !useGpuRaster
              ? "|gpu-raster-fallback-cpu|detailed-direct-v1"
              : BUILDINGS_SHADOW_MODE === "two-level"
                ? "|two-level-near-threshold-v1"
                : BUILDINGS_SHADOW_MODE === "detailed"
                  ? "|detailed-direct-v1"
                  : ""
        }`
      : "none",
    vegetationShadowMethod:
      vegetationSurfaceTiles && vegetationSurfaceTiles.length > 0
        ? vegetationShadowMethod
        : "none",
    warnings,
    horizonMask,
    buildingShadowEvaluator,
    vegetationShadowEvaluator,
    terrainShadowEvaluator,
  };
}
