import { wgs84ToLv95Precise } from "../../src/lib/geo/projection";
import SunCalc from "suncalc";

const places = [
  { id: "jetee-compagnie", lat: 46.5051, lon: 6.6303 },
  { id: "great-escape", lat: 46.5228, lon: 6.63277 },
];
for (const p of places) {
  const { easting, northing } = wgs84ToLv95Precise(p.lon, p.lat);
  const minE = Math.floor(easting / 250) * 250;
  const minN = Math.floor(northing / 250) * 250;
  const tileId = `e${minE}_n${minN}_s250`;
  const noonUtc = new Date("2026-04-18T10:00:00Z");
  const t = SunCalc.getTimes(noonUtc, p.lat, p.lon);
  const sunrise = t.sunrise!;
  const sunset = t.sunset!;
  const toLocal = (d: Date) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Zurich",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(d);
  const fmtPos = (d: Date) => {
    const pos = SunCalc.getPosition(d, p.lat, p.lon);
    const altDeg = (pos.altitude * 180) / Math.PI;
    let azDeg = ((pos.azimuth * 180) / Math.PI + 180) % 360;
    if (azDeg < 0) azDeg += 360;
    return `az=${azDeg.toFixed(2)}° alt=${altDeg.toFixed(2)}°`;
  };
  console.log(
    `${p.id}: LV95 (${easting.toFixed(1)}, ${northing.toFixed(1)})  tile=${tileId}`,
  );
  console.log(
    `  sunrise ${toLocal(sunrise)} local  (${fmtPos(sunrise)})`,
  );
  console.log(
    `  sunset  ${toLocal(sunset)} local  (${fmtPos(sunset)})`,
  );
}
