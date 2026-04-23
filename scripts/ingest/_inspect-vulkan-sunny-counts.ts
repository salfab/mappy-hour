import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
} from "../../src/lib/precompute/sunlight-cache-binary";

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const DATE = "2026-04-18";

const WINDOWS = [
  { label: "Jetée-sunrise", tileId: "e2537750_n1150500_s250", start: "07:00", end: "07:30", step: 5 },
  { label: "Jetée-sunset",  tileId: "e2537750_n1150500_s250", start: "20:00", end: "20:15", step: 5 },
  { label: "GE-morning",    tileId: "e2538000_n1152500_s250", start: "08:00", end: "10:30", step: 15 },
  { label: "GE-evening",    tileId: "e2538000_n1152500_s250", start: "17:00", end: "19:00", step: 15 },
];

function popcount8(x: number): number {
  x = x - ((x >> 1) & 0x55);
  x = (x & 0x33) + ((x >> 2) & 0x33);
  return (x + (x >> 4)) & 0x0f;
}
function popcountBits(buf: Uint8Array, bits: number): number {
  const fullBytes = Math.floor(bits / 8);
  const tailBits = bits - fullBytes * 8;
  let n = 0;
  for (let i = 0; i < fullBytes; i++) n += popcount8(buf[i]);
  if (tailBits > 0) {
    const mask = (1 << tailBits) - 1;
    n += popcount8(buf[fullBytes] & mask);
  }
  return n;
}

async function main() {
  for (const w of WINDOWS) {
    const t = await loadPrecomputedSunlightTileBinary({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      date: DATE,
      gridStepMeters: GRID_STEP,
      sampleEveryMinutes: w.step,
      startLocalTime: w.start,
      endLocalTime: w.end,
      tileId: w.tileId,
    });
    if (!t) {
      console.log(`[${w.label}] MISSING ${w.tileId} ${w.start}..${w.end}`);
      continue;
    }
    const bits = t.outdoorPointCount;
    console.log(`\n[${w.label}] ${w.tileId} ${w.start}..${w.end}  outdoor=${bits}  frames=${t.meta.framesMeta.length}`);
    for (const fm of t.meta.framesMeta) {
      const sun = getFrameMask(t, fm.index, MASK_KIND_SUN);
      const noVeg = getFrameMask(t, fm.index, MASK_KIND_SUN_NO_VEG);
      const sunCount = popcountBits(sun, bits);
      const noVegCount = popcountBits(noVeg, bits);
      const sunPct = ((100 * sunCount) / bits).toFixed(2);
      const noVegPct = ((100 * noVegCount) / bits).toFixed(2);
      console.log(
        `  ${fm.localTime.padEnd(6)}  sun=${String(sunCount).padStart(6)} (${sunPct.padStart(5)}%)  noVeg=${String(noVegCount).padStart(6)} (${noVegPct.padStart(5)}%)`,
      );
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
