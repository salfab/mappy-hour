export interface ShadowCalibration {
  buildingHeightBiasMeters: number;
}

export const DEFAULT_SHADOW_CALIBRATION: ShadowCalibration = {
  buildingHeightBiasMeters: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Experimental calibration knobs to compare model output with field observations.
 * Keep centralized so the feature can be removed cleanly later.
 */
export function normalizeShadowCalibration(
  input: Partial<ShadowCalibration> | undefined,
): ShadowCalibration {
  const buildingHeightBiasMeters = Number.isFinite(input?.buildingHeightBiasMeters)
    ? clamp(input!.buildingHeightBiasMeters as number, -20, 20)
    : DEFAULT_SHADOW_CALIBRATION.buildingHeightBiasMeters;

  return {
    buildingHeightBiasMeters,
  };
}
