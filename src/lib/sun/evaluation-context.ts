import { wgs84ToLv95 } from "@/lib/geo/projection";
import {
  createDetailedBuildingShadowVerifier,
  evaluateBuildingsShadow,
  evaluateBuildingsShadowTwoLevel,
  loadBuildingsObstacleIndex,
} from "@/lib/sun/buildings-shadow";
import { HorizonMask, loadLausanneHorizonMask } from "@/lib/sun/horizon-mask";
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
}

export interface SharedPointEvaluationSources {
  horizonMask: Awaited<ReturnType<typeof loadLausanneHorizonMask>>;
  buildingsIndex: Awaited<ReturnType<typeof loadBuildingsObstacleIndex>>;
  terrainTiles: TerrainTileSource[] | null;
  vegetationSurfaceTiles: Awaited<
    ReturnType<typeof loadVegetationSurfaceTilesForBounds>
  >;
  /** GPU shadow backend, created when MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster */
  gpuShadowBackend?: import("@/lib/sun/building-shadow-backend").BuildingShadowBackend | null;
  /** WebGPU compute backend for batch evaluation (precompute only) */
  webgpuComputeBackend?: import("@/lib/sun/building-shadow-backend").BatchBuildingShadowBackend | null;
  /** Zenith indoor mask: isIndoor(easting, northing) → boolean. Loaded from grid metadata. */
  zenithIndoorCheck?: (easting: number, northing: number) => boolean;
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
  horizonMask: Awaited<ReturnType<typeof loadLausanneHorizonMask>>;
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
}

type BuildingsShadowMode = "detailed" | "two-level" | "prism" | "gpu-raster" | "webgpu-compute";

function parseBuildingsShadowMode(): BuildingsShadowMode {
  const raw = (process.env.MAPPY_BUILDINGS_SHADOW_MODE ?? "").trim().toLowerCase();
  if (raw === "detailed" || raw === "two-level" || raw === "prism" || raw === "gpu-raster" || raw === "webgpu-compute") {
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

// ── GPU backend singleton cache ──────────────────────────────────────
// The GPU backend loads all DXF meshes (~15s). We cache it at module
// level so it's created once and reused across all tiles/requests.
let gpuBackendCache: import("@/lib/sun/building-shadow-backend").BuildingShadowBackend | null | undefined;
let gpuBackendLoading: Promise<import("@/lib/sun/building-shadow-backend").BuildingShadowBackend | null> | null = null;
let indoorCheckLogged = false;

async function getOrCreateGpuBackend(
  obstacles: Array<{ centerX: number; centerY: number; height: number; [key: string]: unknown }>,
): Promise<import("@/lib/sun/building-shadow-backend").BuildingShadowBackend | null> {
  // Already created or failed
  if (gpuBackendCache !== undefined) return gpuBackendCache;

  // Another call is already creating it — wait for that
  if (gpuBackendLoading) return gpuBackendLoading;

  gpuBackendLoading = (async () => {
    try {
      const { GpuBuildingShadowBackend } = await import(
        "@/lib/sun/gpu-building-shadow-backend"
      );
      const backend = await GpuBuildingShadowBackend.createWithDxfMeshes(
        obstacles as Parameters<typeof GpuBuildingShadowBackend.createWithDxfMeshes>[0],
        4096,
      );
      console.log(
        `[evaluation-context] GPU raster backend ready: ${backend.name}, ${backend.triangleCount} triangles (cached for reuse)`,
      );
      gpuBackendCache = backend;
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
    webgpuBackendCache = null;
  }
}

let webgpuBackendLoading: Promise<import("@/lib/sun/building-shadow-backend").BatchBuildingShadowBackend | null> | null = null;

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
  const [fallbackHorizonMask, buildingsIndex] = await Promise.all([
    loadLausanneHorizonMask(),
    loadBuildingsObstacleIndex(),
  ]);
  const horizonMask = options.terrainHorizonOverride ?? fallbackHorizonMask;
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
    const backend = await getOrCreateGpuBackend(buildingsIndex.obstacles);
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
  if (BUILDINGS_SHADOW_MODE === "webgpu-compute" && buildingsIndex) {
    try {
      const { WebGpuIpcClient } = await import("./webgpu-ipc-client");
      const client = await WebGpuIpcClient.create(options.region ?? "lausanne");
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

  // ── Zenith indoor mask (from pre-computed grid metadata) ─────────────
  // Provides accurate indoor/outdoor detection using real DXF mesh geometry
  // instead of convex hull footprints. Generated once per building model.
  let zenithIndoorCheck: SharedPointEvaluationSources["zenithIndoorCheck"];
  if (options.lv95Bounds) {
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
        regionName, modelVersion.modelVersionHash, 1, tileId,
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
      } else if (gpuShadowBackend) {
        // Grid metadata not pre-computed — generate zenith mask on the fly.
        // Render sun straight down, blocked = under a roof = indoor.
        console.error(`[indoor-check] No grid metadata for ${tileId}, computing zenith on the fly...`);
        const tileMinE_ = tileMinE;
        const tileMinN_ = tileMinN;
        const gridW = Math.ceil(tileSizeMeters);
        const gridH = gridW;
        const gridCount = gridW * gridH;
        const indoorMask = new Uint8Array(Math.ceil(gridCount / 8));

        // Set frustum focus and render zenith shadow map
        if ("setFrustumFocus" in gpuShadowBackend) {
          (gpuShadowBackend as { setFrustumFocus: (b: { minX: number; minY: number; maxX: number; maxY: number }, h: number) => void }).setFrustumFocus(
            { minX: tileMinE_, minY: tileMinN_, maxX: tileMinE_ + tileSizeMeters, maxY: tileMinN_ + tileSizeMeters },
            buildingsIndex ? buildingsIndex.obstacles.reduce((m, o) => Math.max(m, o.height), 0) : 100,
          );
        }
        // Use unique azimuth to bust the render cache
        gpuShadowBackend.prepareSunPosition(Math.floor(Math.random() * 360), 90);

        // Evaluate each grid cell
        let indoorCount = 0;
        for (let iy = 0; iy < gridH; iy++) {
          for (let ix = 0; ix < gridW; ix++) {
            const easting = tileMinE_ + ix + 0.5;
            const northing = tileMinN_ + iy + 0.5;
            // Approximate ground elevation — the zenith ray is straight down so
            // the exact elevation barely matters (just needs to be below the roof).
            const approxElevation = 500;
            const result = gpuShadowBackend.evaluate({
              pointX: easting,
              pointY: northing,
              pointElevation: approxElevation,
              solarAzimuthDeg: 0,
              solarAltitudeDeg: 90,
            });
            if (result.blocked) {
              const idx = iy * gridW + ix;
              indoorMask[idx >> 3] |= 1 << (idx & 7);
              indoorCount++;
            }
          }
        }

        // Save for next time
        try {
          const { getTileGridMetadataPath } = await import("@/lib/precompute/tile-grid-metadata");
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const zlib = await import("node:zlib");
          const { promisify } = await import("node:util");
          const gzip = promisify(zlib.gzip);
          const indoor: boolean[] = new Array(gridCount);
          const elevations: (number | null)[] = new Array(gridCount);
          for (let i = 0; i < gridCount; i++) {
            indoor[i] = ((indoorMask[i >> 3] >> (i & 7)) & 1) === 1;
            elevations[i] = indoor[i] ? null : 0; // elevation filled later per-point
          }
          const gmData = {
            tileId, modelVersionHash: modelVersion.modelVersionHash,
            gridStepMeters: 1, totalPoints: gridCount,
            outdoorCount: gridCount - indoorCount, indoorCount,
            elevations, indoor,
          };
          const filePath = getTileGridMetadataPath(regionName, modelVersion.modelVersionHash, 1, tileId);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          const compressed = await gzip(JSON.stringify(gmData));
          await fs.writeFile(filePath, compressed);
          console.error(`[indoor-check] Computed and saved zenith mask for ${tileId} (${indoorCount} indoor)`);
        } catch (saveErr) {
          console.error(`[indoor-check] Failed to save zenith mask: ${saveErr}`);
        }

        const gridMinIx = tileMinE_;
        const gridMinIy = tileMinN_;
        zenithIndoorCheck = (easting: number, northing: number) => {
          const ix = Math.floor(easting) - gridMinIx;
          const iy = Math.floor(northing) - gridMinIy;
          if (ix < 0 || ix >= gridW || iy < 0 || iy >= gridH) return false;
          const idx = iy * gridW + ix;
          return ((indoorMask[idx >> 3] >> (idx & 7)) & 1) === 1;
        };
      } else {
        throw new Error(
          `Indoor detection unavailable for tile ${tileId}: no grid metadata and no GPU backend. ` +
          `Run 'npm run precompute:grid-metadata' to generate zenith indoor masks, ` +
          `or set MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster in .env to enable GPU-based detection.`
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Indoor detection unavailable")) throw e;
    }
  }

  return {
    horizonMask,
    buildingsIndex,
    terrainTiles,
    vegetationSurfaceTiles,
    gpuShadowBackend,
    webgpuComputeBackend,
    zenithIndoorCheck,
  };
}

export async function buildPointEvaluationContext(
  lat: number,
  lon: number,
  options: BuildPointEvaluationContextOptions = {},
): Promise<PointEvaluationContext> {
  const shadowCalibration =
    options.shadowCalibration ?? DEFAULT_SHADOW_CALIBRATION;
  const pointLv95 = wgs84ToLv95(lon, lat);
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
  const vegetationShadowEvaluator =
    vegetationSurfaceTiles &&
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

  const warnings: string[] = [];
  if (!horizonMask) {
    warnings.push(
      "No horizon mask found. Run preprocess:horizon:mask (fallback) and ingest terrain horizon DEM tiles for your target area.",
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
  };
}
