import { wgs84ToLv95 } from "../../src/lib/geo/projection";

// École de Montriond, Lausanne (nord du Parc de Milan)
// approx 46.5173, 6.6170
const points = [
  { name: "École Montriond SW", lat: 46.5170, lon: 6.6165 },
  { name: "École Montriond centre", lat: 46.5173, lon: 6.6175 },
  { name: "École Montriond NE", lat: 46.5178, lon: 6.6185 },
  { name: "Avenue Montriond 25", lat: 46.5173, lon: 6.6170 },
];
for (const p of points) {
  const lv = wgs84ToLv95(p.lon, p.lat);
  const tileE = Math.floor(lv.easting / 250) * 250;
  const tileN = Math.floor(lv.northing / 250) * 250;
  console.log(
    `${p.name.padEnd(28)}: LV95=(${lv.easting.toFixed(0)},${lv.northing.toFixed(0)}) tile=e${tileE}_n${tileN}_s250`,
  );
}
