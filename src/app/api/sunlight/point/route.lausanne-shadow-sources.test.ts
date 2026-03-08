import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  RAW_HORIZON_DEM_DIR,
  RAW_TERRAIN_CH_DIR,
  RAW_VEGETATION_SURFACE_DIR,
} from "@/lib/storage/data-paths";
import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import { evaluateInstantSunlight } from "@/lib/sun/solar";
import { zonedDateTimeToUtc } from "@/lib/time/zoned-date";

function directoryHasTif(rootDirectory: string): boolean {
  if (!existsSync(rootDirectory)) {
    return false;
  }

  const stack = [rootDirectory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".tif")) {
        return true;
      }
    }
  }

  return false;
}

const HAS_LAUSANNE_SHADOW_DATA =
  directoryHasTif(RAW_TERRAIN_CH_DIR) &&
  directoryHasTif(RAW_HORIZON_DEM_DIR) &&
  directoryHasTif(RAW_VEGETATION_SURFACE_DIR);

const describeIfData = HAS_LAUSANNE_SHADOW_DATA ? describe : describe.skip;

function normalizeAzimuth(azimuthDeg: number): number {
  const rounded = Math.round(azimuthDeg) % 360;
  return rounded >= 0 ? rounded : rounded + 360;
}

describeIfData("Lausanne shadow sources integration", () => {
  const sauvabelin = { lat: 46.5369, lon: 6.6377 };
  const riponne = { lat: 46.5231, lon: 6.6323 };

  let sauvabelinMaskPromise: Promise<
    Awaited<ReturnType<typeof buildDynamicHorizonMask>>
  > | null = null;

  const getSauvabelinMask = async () => {
    if (!sauvabelinMaskPromise) {
      // Coarser sampling keeps this integration test tractable while still
      // validating mountain/local DEM contributions.
      sauvabelinMaskPromise = buildDynamicHorizonMask({
        lat: sauvabelin.lat,
        lon: sauvabelin.lon,
        radiusKm: 80,
        stepMeters: 1000,
      });
    }
    return sauvabelinMaskPromise;
  };

  it(
    "detects local-terrain shadow (city relief) near Sauvabelin",
    async () => {
      const mask = await getSauvabelinMask();
      expect(mask).not.toBeNull();
      if (!mask) {
        return;
      }

      const utcDate = zonedDateTimeToUtc("2026-06-21", "06:00", "Europe/Zurich");
      const sample = evaluateInstantSunlight({
        lat: sauvabelin.lat,
        lon: sauvabelin.lon,
        utcDate,
        timeZone: "Europe/Zurich",
        horizonMask: mask,
      });
      const ridgePoint = mask.ridgePoints?.find(
        (point) => point.azimuthDeg === normalizeAzimuth(sample.azimuthDeg),
      );

      expect(sample.terrainBlocked).toBe(true);
      expect(ridgePoint).toBeDefined();
      expect((ridgePoint?.distanceMeters ?? Number.POSITIVE_INFINITY) < 20_000).toBe(
        true,
      );
    },
    300_000,
  );

  it(
    "detects mountain shadow (distant ridge) from French Alps",
    async () => {
      const mask = await getSauvabelinMask();
      expect(mask).not.toBeNull();
      if (!mask) {
        return;
      }

      const utcDate = zonedDateTimeToUtc("2026-12-21", "08:30", "Europe/Zurich");
      const sample = evaluateInstantSunlight({
        lat: sauvabelin.lat,
        lon: sauvabelin.lon,
        utcDate,
        timeZone: "Europe/Zurich",
        horizonMask: mask,
      });
      const ridgePoint = mask.ridgePoints?.find(
        (point) => point.azimuthDeg === normalizeAzimuth(sample.azimuthDeg),
      );

      expect(sample.terrainBlocked).toBe(true);
      expect(ridgePoint).toBeDefined();
      expect((ridgePoint?.distanceMeters ?? 0) >= 20_000).toBe(true);
    },
    300_000,
  );

  it(
    "detects building shadow in central Lausanne (Riponne)",
    async () => {
      const context = await buildPointEvaluationContext(riponne.lat, riponne.lon, {
        skipTerrainSamplingWhenIndoor: true,
      });
      const utcDate = zonedDateTimeToUtc("2026-03-08", "09:00", "Europe/Zurich");
      const sample = evaluateInstantSunlight({
        lat: riponne.lat,
        lon: riponne.lon,
        utcDate,
        timeZone: "Europe/Zurich",
        horizonMask: context.horizonMask,
        buildingShadowEvaluator: context.buildingShadowEvaluator,
        vegetationShadowEvaluator: context.vegetationShadowEvaluator,
      });

      expect(context.insideBuilding).toBe(false);
      expect(sample.buildingsBlocked).toBe(true);
      expect(sample.buildingBlockerId).not.toBeNull();
    },
    90_000,
  );

  it(
    "detects vegetation shadow near Sauvabelin and uses vegetation model",
    async () => {
      const context = await buildPointEvaluationContext(
        sauvabelin.lat,
        sauvabelin.lon,
        {
          skipTerrainSamplingWhenIndoor: true,
        },
      );
      const utcDate = zonedDateTimeToUtc("2026-03-08", "08:00", "Europe/Zurich");
      const sample = evaluateInstantSunlight({
        lat: sauvabelin.lat,
        lon: sauvabelin.lon,
        utcDate,
        timeZone: "Europe/Zurich",
        horizonMask: context.horizonMask,
        buildingShadowEvaluator: context.buildingShadowEvaluator,
        vegetationShadowEvaluator: context.vegetationShadowEvaluator,
      });

      expect(sample.vegetationBlocked).toBe(true);
      expect((sample.vegetationBlockerDistanceMeters ?? 0) > 0).toBe(true);
      expect(context.vegetationShadowMethod).not.toBe("none");
      expect(
        context.warnings.some((warning) =>
          warning.includes("No vegetation surface raster found"),
        ),
      ).toBe(false);
    },
    90_000,
  );
});
