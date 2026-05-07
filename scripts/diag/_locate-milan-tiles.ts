import { wgs84ToLv95Precise } from "../../src/lib/geo/projection";

const points = [
  { name: "Parc de Milan centre", lat: 46.5157, lon: 6.6185 },
  { name: "Parc de Milan N", lat: 46.5170, lon: 6.6185 },
  { name: "Parc de Milan S", lat: 46.5145, lon: 6.6185 },
  { name: "Parc de Milan E", lat: 46.5157, lon: 6.6205 },
  { name: "Parc de Milan W", lat: 46.5157, lon: 6.6165 },
];
for (const p of points) {
  const lv = wgs84ToLv95Precise(p.lon, p.lat);
  const tileE = Math.floor(lv.easting / 250) * 250;
  const tileN = Math.floor(lv.northing / 250) * 250;
  console.log(
    `${p.name.padEnd(25)}: LV95=(${lv.easting.toFixed(0)},${lv.northing.toFixed(0)}) tile=e${tileE}_n${tileN}_s250`,
  );
}
