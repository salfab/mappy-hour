/**
 * Centralized limits for grid computation.
 *
 * These govern the maximum number of outdoor points the API will compute
 * in a single streaming or area request. The precompute cache uses tiles
 * (250m × 250m) so it's not subject to these limits.
 */

/**
 * Maximum outdoor points allowed per streaming timeline or area request.
 * At grid=1m on a 2km×1km zone, ~1.1M outdoor points are expected.
 */
export const MAX_OUTDOOR_POINTS = 2_000_000;

/**
 * Default outdoor point limit sent by the frontend when not overridden.
 */
export const DEFAULT_MAX_OUTDOOR_POINTS = 50_000;
