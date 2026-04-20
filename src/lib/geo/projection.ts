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
 * Rigorous LV95 → WGS84 transformation (Swisstopo official algorithm).
 *
 * Pipeline: LV95 plane → sphere (inverse oblique Mercator) → Bessel ellipsoid
 * (iterative) → geocentric → 3-parameter translation (CH1903+ → ETRS89) →
 * WGS84 geodetic (iterative).
 *
 * Precision sub-cm on the national extent — matches proj4 within round-off.
 * Much faster than proj4 in practice (no dynamic pipeline, no allocations).
 */
// Bessel ellipsoid (CH1903 datum)
const BESSEL_A = 6377397.155;
const BESSEL_E2 = 0.006674372230614;
const BESSEL_E = Math.sqrt(BESSEL_E2);

// Bern origin (fundamental point)
const LAMBDA_0_BERN = (7 + 26 / 60 + 22.5 / 3600) * (Math.PI / 180); // 7°26'22.50"
const PHI_0_BERN = (46 + 57 / 60 + 8.66 / 3600) * (Math.PI / 180); // 46°57'08.66"

// Derived projection constants (computed once)
const PROJ_R =
  (BESSEL_A * Math.sqrt(1 - BESSEL_E2)) /
  (1 - BESSEL_E2 * Math.sin(PHI_0_BERN) * Math.sin(PHI_0_BERN));
const PROJ_ALPHA = Math.sqrt(
  1 + (BESSEL_E2 / (1 - BESSEL_E2)) * Math.pow(Math.cos(PHI_0_BERN), 4),
);
const PROJ_B0 = Math.asin(Math.sin(PHI_0_BERN) / PROJ_ALPHA);
const PROJ_K =
  Math.log(Math.tan(Math.PI / 4 + PROJ_B0 / 2)) -
  PROJ_ALPHA * Math.log(Math.tan(Math.PI / 4 + PHI_0_BERN / 2)) +
  ((PROJ_ALPHA * BESSEL_E) / 2) *
    Math.log(
      (1 + BESSEL_E * Math.sin(PHI_0_BERN)) /
        (1 - BESSEL_E * Math.sin(PHI_0_BERN)),
    );

// CH1903+ → ETRS89/WGS84 translation (Swisstopo simplified 3-parameter).
const DX = 674.374;
const DY = 15.056;
const DZ = 405.346;

// WGS84 ellipsoid
const WGS_A = 6378137;
const WGS_E2 = 0.00669437999014;

export function lv95ToWgs84Precise(easting: number, northing: number): Wgs84Point {
  // Step 1: LV95 → offsets from Bern
  const y = easting - 2600000;
  const x = northing - 1200000;

  // Step 2: Sphere (inverse oblique Mercator)
  const lambdaSphereBern = y / PROJ_R;
  const bSphere = 2 * (Math.atan(Math.exp(x / PROJ_R)) - Math.PI / 4);

  // Step 3: Sphere oblique → equatorial
  const sinB0 = Math.sin(PROJ_B0);
  const cosB0 = Math.cos(PROJ_B0);
  const sinBs = Math.sin(bSphere);
  const cosBs = Math.cos(bSphere);
  const sinLs = Math.sin(lambdaSphereBern);
  const cosLs = Math.cos(lambdaSphereBern);
  const sinB = cosB0 * sinBs + sinB0 * cosBs * cosLs;
  const b = Math.asin(sinB);
  const lambdaBessel =
    Math.atan2(sinLs * cosBs, cosB0 * cosBs * cosLs - sinB0 * sinBs) / PROJ_ALPHA +
    LAMBDA_0_BERN;

  // Step 4: Sphere → Bessel ellipsoid latitude (iterate 3×)
  const rhs = (Math.log(Math.tan(Math.PI / 4 + b / 2)) - PROJ_K) / PROJ_ALPHA;
  let phiBessel = b;
  for (let i = 0; i < 3; i++) {
    const S =
      rhs +
      (BESSEL_E / 2) *
        Math.log(
          (1 + BESSEL_E * Math.sin(phiBessel)) /
            (1 - BESSEL_E * Math.sin(phiBessel)),
        );
    phiBessel = 2 * Math.atan(Math.exp(S)) - Math.PI / 2;
  }

  // Step 5: Bessel geodetic → geocentric (CH1903+)
  const sinPhiB = Math.sin(phiBessel);
  const cosPhiB = Math.cos(phiBessel);
  const sinLamB = Math.sin(lambdaBessel);
  const cosLamB = Math.cos(lambdaBessel);
  const N_B = BESSEL_A / Math.sqrt(1 - BESSEL_E2 * sinPhiB * sinPhiB);
  // Assume h=0 (WGS84 coords we output are 2D only)
  const X = N_B * cosPhiB * cosLamB + DX;
  const Y = N_B * cosPhiB * sinLamB + DY;
  const Z = N_B * (1 - BESSEL_E2) * sinPhiB + DZ;

  // Step 6: Geocentric → WGS84 geodetic (iterate 3×)
  const p = Math.sqrt(X * X + Y * Y);
  let phiWgs = Math.atan2(Z, p * (1 - WGS_E2));
  for (let i = 0; i < 3; i++) {
    const sinPhiW = Math.sin(phiWgs);
    const Rn = WGS_A / Math.sqrt(1 - WGS_E2 * sinPhiW * sinPhiW);
    phiWgs = Math.atan2(Z + WGS_E2 * Rn * sinPhiW, p);
  }
  const lambdaWgs = Math.atan2(Y, X);

  return {
    lat: phiWgs * (180 / Math.PI),
    lon: lambdaWgs * (180 / Math.PI),
  };
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
