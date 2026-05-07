/**
 * Factory for creating the appropriate BuildingShadowBackend.
 *
 * Selects GPU or CPU based on `options.preferGpu` or the environment variable
 * `MAPPY_SHADOW_BACKEND=gpu`. Falls back to CPU if the GPU backend cannot
 * be loaded (e.g. missing `gl` native module).
 */
import { CpuBuildingShadowBackend } from "@/lib/sun/cpu-building-shadow-backend";
import type { BuildingShadowBackend } from "@/lib/sun/building-shadow-backend";
import { evaluateBuildingsShadow } from "@/lib/sun/buildings-shadow";

type BuildingObstacle = Parameters<typeof evaluateBuildingsShadow>[0][number];
type BuildingSpatialGrid = Parameters<typeof evaluateBuildingsShadow>[2];

export function createBuildingShadowBackend(
  obstacles: BuildingObstacle[],
  spatialGrid: BuildingSpatialGrid | undefined,
  options?: { preferGpu?: boolean; shadowMapResolution?: number },
): BuildingShadowBackend {
  const prefer =
    options?.preferGpu ?? process.env.MAPPY_SHADOW_BACKEND === "gpu";

  if (prefer) {
    try {
      // Dynamic import so the native `gl` module isn't required at load time
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GpuBuildingShadowBackend } = require("./gpu-building-shadow-backend");
      const backend = new GpuBuildingShadowBackend(
        obstacles,
        options?.shadowMapResolution ?? 4096,
      );
      console.log(`[shadow-backend] Using GPU (${backend.name})`);
      return backend;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[shadow-backend] GPU unavailable: ${msg}. Falling back to CPU.`,
      );
    }
  }

  const backend = new CpuBuildingShadowBackend(obstacles, spatialGrid);
  console.log(`[shadow-backend] Using CPU (${backend.name})`);
  return backend;
}
