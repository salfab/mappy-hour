import { wgs84ToLv95Precise } from "../../src/lib/geo/projection";
const LAT = 46.5128039, LON = 6.6236758;
const { easting, northing } = wgs84ToLv95Precise(LON, LAT);
console.log(`LV95: E=${easting.toFixed(1)} N=${northing.toFixed(1)}`);
const tileE = Math.floor(easting / 250) * 250;
const tileN = Math.floor(northing / 250) * 250;
console.log(`Tile: e${tileE}_n${tileN}_s250`);
