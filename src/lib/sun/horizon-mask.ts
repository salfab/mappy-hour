import fs from "node:fs/promises";

import { z } from "zod";

import { PROCESSED_HORIZON_MASK_PATH } from "@/lib/storage/data-paths";

const horizonMaskSchema = z.object({
  generatedAt: z.string(),
  method: z.string(),
  center: z.object({
    lat: z.number(),
    lon: z.number(),
  }),
  radiusKm: z.number(),
  binsDeg: z.array(z.number()).length(360),
  ridgePoints: z
    .array(
      z.object({
        azimuthDeg: z.number(),
        lat: z.number(),
        lon: z.number(),
        distanceMeters: z.number(),
        horizonAngleDeg: z.number(),
        peakElevationMeters: z.number(),
      }),
    )
    .optional(),
  notes: z.string().optional(),
});

export type HorizonMask = z.infer<typeof horizonMaskSchema>;

let cachedMask: HorizonMask | null | undefined;

export async function loadLausanneHorizonMask(): Promise<HorizonMask | null> {
  if (cachedMask !== undefined) {
    return cachedMask;
  }

  try {
    const raw = await fs.readFile(PROCESSED_HORIZON_MASK_PATH, "utf8");
    cachedMask = horizonMaskSchema.parse(JSON.parse(raw));
    return cachedMask;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      cachedMask = null;
      return null;
    }

    throw error;
  }
}

function normalizeAzimuth(azimuthDeg: number): number {
  const normalized = azimuthDeg % 360;
  return normalized >= 0 ? normalized : normalized + 360;
}

export function getHorizonAngleForAzimuth(
  horizonMask: HorizonMask,
  azimuthDeg: number,
): number {
  const normalized = normalizeAzimuth(azimuthDeg);
  const index = Math.round(normalized) % 360;
  return horizonMask.binsDeg[index];
}

export function isTerrainBlockedByHorizon(
  horizonMask: HorizonMask,
  azimuthDeg: number,
  solarAltitudeDeg: number,
): boolean {
  const horizonAngle = getHorizonAngleForAzimuth(horizonMask, azimuthDeg);
  return solarAltitudeDeg <= horizonAngle;
}
