import proj4 from "proj4";

const WGS84 = "EPSG:4326";
const LV95 = "EPSG:2056";

proj4.defs(
  LV95,
  "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs",
);

export interface Lv95Point {
  easting: number;
  northing: number;
}

export interface Wgs84Point {
  lon: number;
  lat: number;
}

export function wgs84ToLv95(lon: number, lat: number): Lv95Point {
  const [easting, northing] = proj4(WGS84, LV95, [lon, lat]);
  return { easting, northing };
}

export function lv95ToWgs84(easting: number, northing: number): Wgs84Point {
  const [lon, lat] = proj4(LV95, WGS84, [easting, northing]);
  return { lon, lat };
}

/**
 * Polynomial approximation LV95 → WGS84 (Swisstopo official formulas).
 *
 * Source: Swisstopo "Approximate formulas for the transformation between Swiss
 * projection coordinates and WGS84" (Dec 2016 revision). Precision ~1m on the
 * national extent. No allocation, no trigonometry — ~15 multiplications.
 *
 * Use ONLY when downstream precision tolerates ≥10cm divergence from proj4.
 * Validated against proj4 for the precompute grid — see
 * scripts/diag/validate-lv95-fast-vs-proj4.ts and ADR-0014.
 */
export function lv95ToWgs84Fast(easting: number, northing: number): Wgs84Point {
  // Normalize to Bern origin (units: 10^6 meters)
  const y = (easting - 2600000) / 1e6;
  const x = (northing - 1200000) / 1e6;

  // Result in units of [10000 arc-seconds].
  const lambdaBern =
    2.6779094 +
    4.728982 * y +
    0.791484 * y * x +
    0.1306 * y * (x * x) -
    0.0436 * (y * y * y);

  const phiBern =
    16.9023892 +
    3.238272 * x -
    0.270978 * (y * y) -
    0.002528 * (x * x) -
    0.0447 * (y * y) * x -
    0.0140 * (x * x * x);

  // Convert [10000"] → degrees: 10000" = 10000/3600° = 100/36°
  return {
    lon: (lambdaBern * 100) / 36,
    lat: (phiBern * 100) / 36,
  };
}
