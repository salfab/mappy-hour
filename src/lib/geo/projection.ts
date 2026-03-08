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
