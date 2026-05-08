/**
 * Visual diff renderer: date-keyed tile cache vs angle-keyed atlas cache.
 *
 * For selected tiles at a given hour, generates a single HTML report embedding
 * side-by-side canvas renderings:
 *   - date-keyed sunMask   (yellow = sunny, black = shadow, gray = indoor)
 *   - atlas sunMask        (same coloring)
 *   - disagreement         (green = agree sunny, dark = agree shadow,
 *                           red = tile sunny / atlas shadow,
 *                           cyan = atlas sunny / tile shadow)
 *
 * Run:
 *   pnpm tsx scripts/ingest/_render-atlas-vs-tile-diff.ts
 *
 * Output:
 *   data/analysis/atlas-vs-tile-diff-<date>-<hour>.html
 */

import fs from "node:fs/promises";
import path from "node:path";
import SunCalc from "suncalc";

import { DATA_ROOT } from "../../src/lib/storage/data-paths";
import { lv95ToWgs84Precise } from "../../src/lib/geo/projection";
import {
  loadPrecomputedSunlightTileBinary,
  getFrameMask,
  MASK_KIND_SUN,
} from "../../src/lib/precompute/sunlight-cache-binary";
import {
  loadPrecomputedTileAtlas,
  lookupAtlasBucket,
} from "../../src/lib/precompute/sunlight-cache-atlas";

const RAD_TO_DEG = 180 / Math.PI;
const RES = 1;

// Top divergent tiles at 17h for Lausanne 2026-04-18 (from _compare-atlas-vs-tilecache.ts).
const SELECTED_TILES = [
  "e2538000_n1152500_s250",
  "e2538250_n1152250_s250",
  "e2538500_n1152250_s250",
  "e2538000_n1152250_s250",
  "e2537250_n1153000_s250",
  "e2537750_n1152000_s250",
];

const REGION = "lausanne" as const;
const MODEL_HASH = "d43fe24cbb9190af";
const GRID_STEP = 1;
const SAMPLE_MINUTES = 15;
const DATE = "2026-04-18";
const HOUR = 17;
const START_LOCAL = "00:00";
const END_LOCAL = "23:59";

function parseTileId(id: string): { minE: number; minN: number; size: number } {
  const m = /^e(\d+)_n(\d+)_s(\d+)$/.exec(id);
  if (!m) throw new Error(`Bad tileId: ${id}`);
  return { minE: Number(m[1]), minN: Number(m[2]), size: Number(m[3]) };
}

interface RenderedFrame {
  localTime: string;
  azimuthDeg: number;
  altitudeDeg: number;
  azBucket: number;
  altBucket: number;
  width: number;
  height: number;
  tilePngDataUrl: string;
  atlasPngDataUrl: string;
  diffPngDataUrl: string;
  agreeSunny: number;
  agreeShadow: number;
  tileOnlySunny: number;
  atlasOnlySunny: number;
  tileSunnyCount: number;
  atlasSunnyCount: number;
  outdoorPoints: number;
  divergencePct: number;
}

interface RenderedTile {
  tileId: string;
  centerLat: number;
  centerLon: number;
  frames: RenderedFrame[];
}

// ------------- Minimal PNG encoder (8-bit RGBA) -------------

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

function concatU8(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
  const typeAndData = concatU8([typeBytes, data]);
  const crc = crc32(typeAndData);
  return concatU8([u32be(data.length), typeAndData, u32be(crc)]);
}

async function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array, // width*height*4 row-major
): Promise<Buffer> {
  const { promisify } = await import("node:util");
  const { deflate } = await import("node:zlib");
  const deflateP = promisify(deflate);

  // Filter 0 (None) prepended to each scanline.
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const deflated = (await deflateP(Buffer.from(raw))) as Buffer;

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = concatU8([
    u32be(width),
    u32be(height),
    new Uint8Array([8, 6, 0, 0, 0]), // 8-bit, RGBA, default compression/filter/interlace
  ]);

  const parts = [
    sig,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.byteLength)),
    makeChunk("IEND", new Uint8Array(0)),
  ];
  return Buffer.from(concatU8(parts));
}

function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

// ------------- Rendering -------------

type PointInfo = {
  ix: number;
  iy: number;
  outdoorIndex: number;
  indoor: boolean;
};

function readBit(mask: Uint8Array, bitIndex: number): number {
  return (mask[bitIndex >> 3] >> (bitIndex & 7)) & 1;
}

/**
 * Build a width×height grid of RGBA pixels from a sunMask, where each pixel's
 * (x, y) = point's (ix, iy). Indoor = gray; sunny = yellow; shadow = dark.
 */
function renderMaskRgba(
  width: number,
  height: number,
  points: PointInfo[],
  mask: Uint8Array,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  // Background: very dark (no-point).
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 20;
    rgba[i + 1] = 20;
    rgba[i + 2] = 20;
    rgba[i + 3] = 255;
  }
  for (const p of points) {
    const base = (p.iy * width + p.ix) * 4;
    if (p.indoor || p.outdoorIndex < 0) {
      rgba[base] = 90;
      rgba[base + 1] = 90;
      rgba[base + 2] = 90;
      continue;
    }
    const bit = readBit(mask, p.outdoorIndex);
    if (bit) {
      // sunny — yellow
      rgba[base] = 255;
      rgba[base + 1] = 220;
      rgba[base + 2] = 40;
    } else {
      // shadow — dark purple
      rgba[base] = 30;
      rgba[base + 1] = 20;
      rgba[base + 2] = 50;
    }
  }
  return rgba;
}

function renderDiffRgba(
  width: number,
  height: number,
  points: PointInfo[],
  tileMask: Uint8Array,
  atlasMask: Uint8Array,
): { rgba: Uint8Array; counts: { agreeSunny: number; agreeShadow: number; tileOnlySunny: number; atlasOnlySunny: number } } {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 15;
    rgba[i + 1] = 15;
    rgba[i + 2] = 15;
    rgba[i + 3] = 255;
  }
  let agreeSunny = 0;
  let agreeShadow = 0;
  let tileOnlySunny = 0;
  let atlasOnlySunny = 0;
  for (const p of points) {
    const base = (p.iy * width + p.ix) * 4;
    if (p.indoor || p.outdoorIndex < 0) {
      rgba[base] = 70;
      rgba[base + 1] = 70;
      rgba[base + 2] = 70;
      continue;
    }
    const t = readBit(tileMask, p.outdoorIndex);
    const a = readBit(atlasMask, p.outdoorIndex);
    if (t === 1 && a === 1) {
      // agree sunny → subdued green
      rgba[base] = 40;
      rgba[base + 1] = 130;
      rgba[base + 2] = 50;
      agreeSunny++;
    } else if (t === 0 && a === 0) {
      // agree shadow → very dark
      rgba[base] = 25;
      rgba[base + 1] = 25;
      rgba[base + 2] = 50;
      agreeShadow++;
    } else if (t === 1 && a === 0) {
      // only tile says sunny → red
      rgba[base] = 230;
      rgba[base + 1] = 50;
      rgba[base + 2] = 50;
      tileOnlySunny++;
    } else {
      // only atlas says sunny → cyan
      rgba[base] = 40;
      rgba[base + 1] = 180;
      rgba[base + 2] = 230;
      atlasOnlySunny++;
    }
  }
  return { rgba, counts: { agreeSunny, agreeShadow, tileOnlySunny, atlasOnlySunny } };
}

function countSetBitsInMask(mask: Uint8Array, outdoorBits: number): number {
  let n = 0;
  const fullBytes = Math.floor(outdoorBits / 8);
  for (let i = 0; i < fullBytes; i++) {
    let x = mask[i];
    while (x) { x &= x - 1; n++; }
  }
  const tail = outdoorBits - fullBytes * 8;
  if (tail > 0) {
    let x = mask[fullBytes] & ((1 << tail) - 1);
    while (x) { x &= x - 1; n++; }
  }
  return n;
}

async function renderTile(tileId: string): Promise<RenderedTile | null> {
  const parsed = parseTileId(tileId);
  const centerE = parsed.minE + parsed.size / 2;
  const centerN = parsed.minN + parsed.size / 2;
  const { lat, lon } = lv95ToWgs84Precise(centerE, centerN);

  const [tile, atlas] = await Promise.all([
    loadPrecomputedSunlightTileBinary({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      date: DATE,
      gridStepMeters: GRID_STEP,
      sampleEveryMinutes: SAMPLE_MINUTES,
      startLocalTime: START_LOCAL,
      endLocalTime: END_LOCAL,
      tileId,
    }),
    loadPrecomputedTileAtlas({
      region: REGION,
      modelVersionHash: MODEL_HASH,
      gridStepMeters: GRID_STEP,
      tileId,
      resolutionDeg: RES,
    }),
  ]);

  if (!tile || !atlas) return null;
  if (tile.outdoorPointCount !== atlas.outdoorPointCount) return null;

  // Build PointInfo[] shared across frames. ix/iy are LV95 grid indices
  // (absolute, not tile-local), so normalize by subtracting the tile origin.
  const pointCount = tile.pointCount;
  const originIx = Math.floor(parsed.minE / GRID_STEP);
  const originIy = Math.floor(parsed.minN / GRID_STEP);
  const points: PointInfo[] = new Array(pointCount);
  let maxLocalX = 0;
  let maxLocalY = 0;
  for (let i = 0; i < pointCount; i++) {
    const lx = tile.pointIx[i] - originIx;
    const ly = tile.pointIy[i] - originIy;
    if (lx > maxLocalX) maxLocalX = lx;
    if (ly > maxLocalY) maxLocalY = ly;
    const indoor = (tile.pointFlags[i] & 1) !== 0;
    points[i] = { ix: lx, iy: ly, outdoorIndex: tile.pointOutdoorIndex[i], indoor };
  }
  const width = maxLocalX + 1;
  const height = maxLocalY + 1;

  const frames: RenderedFrame[] = [];
  const framesMeta = tile.meta.framesMeta;
  const outdoorBits = tile.outdoorPointCount;

  for (let f = 0; f < framesMeta.length; f++) {
    const fm = framesMeta[f];
    const h = Number(fm.localTime.slice(0, 2));
    if (h !== HOUR) continue;

    const utc = new Date(fm.utcTime);
    const pos = SunCalc.getPosition(utc, lat, lon);
    const altDeg = pos.altitude * RAD_TO_DEG;
    if (altDeg <= 0) continue;
    let azDeg = (pos.azimuth * RAD_TO_DEG + 180) % 360;
    if (azDeg < 0) azDeg += 360;
    const azB = Math.floor(azDeg / RES);
    const altB = Math.floor(altDeg / RES);

    const bucket = lookupAtlasBucket(atlas, azB, altB);
    if (!bucket) continue;

    const tileMask = getFrameMask(tile, f, MASK_KIND_SUN);
    const atlasMask = bucket.sunMask;

    const tileRgba = renderMaskRgba(width, height, points, tileMask);
    const atlasRgba = renderMaskRgba(width, height, points, atlasMask);
    const { rgba: diffRgba, counts } = renderDiffRgba(width, height, points, tileMask, atlasMask);

    // Flip Y axis for display (north at top) — in our data iy=0 is south, so flip.
    const flipRgba = (src: Uint8Array): Uint8Array => {
      const dst = new Uint8Array(src.length);
      const stride = width * 4;
      for (let y = 0; y < height; y++) {
        const srcRow = (height - 1 - y) * stride;
        dst.set(src.subarray(srcRow, srcRow + stride), y * stride);
      }
      return dst;
    };

    const tilePng = await encodePng(width, height, flipRgba(tileRgba));
    const atlasPng = await encodePng(width, height, flipRgba(atlasRgba));
    const diffPng = await encodePng(width, height, flipRgba(diffRgba));

    const tileSunnyCount = countSetBitsInMask(tileMask, outdoorBits);
    const atlasSunnyCount = countSetBitsInMask(atlasMask, outdoorBits);

    const totalDiff = counts.tileOnlySunny + counts.atlasOnlySunny;
    const totalOutdoor = counts.agreeSunny + counts.agreeShadow + totalDiff;
    const divergencePct = totalOutdoor > 0 ? (100 * totalDiff) / totalOutdoor : 0;

    frames.push({
      localTime: fm.localTime,
      azimuthDeg: azDeg,
      altitudeDeg: altDeg,
      azBucket: azB,
      altBucket: altB,
      width,
      height,
      tilePngDataUrl: toDataUrl(tilePng),
      atlasPngDataUrl: toDataUrl(atlasPng),
      diffPngDataUrl: toDataUrl(diffPng),
      agreeSunny: counts.agreeSunny,
      agreeShadow: counts.agreeShadow,
      tileOnlySunny: counts.tileOnlySunny,
      atlasOnlySunny: counts.atlasOnlySunny,
      tileSunnyCount,
      atlasSunnyCount,
      outdoorPoints: totalOutdoor,
      divergencePct,
    });
  }

  return { tileId, centerLat: lat, centerLon: lon, frames };
}

function buildHtml(tiles: RenderedTile[]): string {
  const sections = tiles
    .map((t) => {
      const frameBlocks = t.frames
        .map(
          (f) => `
        <div class="frame">
          <h3>${f.localTime} &middot; az ${f.azimuthDeg.toFixed(2)}° / alt ${f.altitudeDeg.toFixed(2)}° &middot; bucket (az=${f.azBucket}, alt=${f.altBucket})</h3>
          <div class="stats">
            sunny (tile) = <b>${f.tileSunnyCount}</b> · sunny (atlas) = <b>${f.atlasSunnyCount}</b> · outdoor = ${f.outdoorPoints}<br/>
            agree sunny = <span class="dot agree-sunny"></span>${f.agreeSunny} ·
            agree shadow = <span class="dot agree-shadow"></span>${f.agreeShadow} ·
            tile-only sunny = <span class="dot tile-only"></span>${f.tileOnlySunny} ·
            atlas-only sunny = <span class="dot atlas-only"></span>${f.atlasOnlySunny}
            <br/>
            <b>divergence: ${f.divergencePct.toFixed(2)}%</b>
          </div>
          <div class="row">
            <figure><figcaption>date-keyed (true sun)</figcaption><img src="${f.tilePngDataUrl}"/></figure>
            <figure><figcaption>atlas (bucket-center sun)</figcaption><img src="${f.atlasPngDataUrl}"/></figure>
            <figure><figcaption>diff</figcaption><img src="${f.diffPngDataUrl}"/></figure>
          </div>
        </div>`,
        )
        .join("\n");

      return `
      <section class="tile">
        <h2>${t.tileId}  <span class="loc">(${t.centerLat.toFixed(5)}, ${t.centerLon.toFixed(5)})</span></h2>
        ${frameBlocks}
      </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Atlas vs tile cache — ${DATE} ${HOUR}h</title>
  <style>
    body { background:#151515; color:#ddd; font-family: "SF Mono", monospace; margin: 24px; }
    h1 { color:#fff; }
    h2 { color:#ffd; border-bottom: 1px solid #444; padding-bottom: 4px; }
    h3 { color:#ffe; margin: 8px 0 4px 0; font-size: 13px; font-weight: normal; }
    .loc { color:#888; font-size: 14px; font-weight: normal; margin-left: 8px; }
    .tile { margin-bottom: 32px; }
    .frame { margin-bottom: 20px; padding: 8px; background:#1c1c1c; border-radius: 4px; }
    .row { display: flex; gap: 12px; margin-top: 6px; flex-wrap: wrap; }
    figure { margin: 0; background: #222; padding: 6px; border-radius: 4px; }
    figcaption { color:#aaa; font-size: 11px; margin-bottom: 4px; }
    img { image-rendering: pixelated; width: 250px; height: 250px; display:block; background:#000; }
    .stats { color:#bbb; font-size: 12px; line-height: 1.5; margin-bottom: 6px; }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 3px 0 8px; vertical-align: middle; }
    .agree-sunny  { background:#2d8c33; }
    .agree-shadow { background:#191932; }
    .tile-only    { background:#e63232; }
    .atlas-only   { background:#28b4e6; }
    .legend { margin: 8px 0 20px 0; color:#ccc; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Atlas vs date-keyed tile cache — ${DATE}, hour ${String(HOUR).padStart(2,"0")}:00</h1>
  <div class="legend">
    Single sunMask, shown three ways per frame:
    tile = mask computed with the true sun angle at utcTime;
    atlas = mask computed at the (az, alt) bucket center (1° resolution);
    diff = per-pixel agreement (
      <span class="dot agree-sunny"></span>agree sunny,
      <span class="dot agree-shadow"></span>agree shadow,
      <span class="dot tile-only"></span>tile-only sunny,
      <span class="dot atlas-only"></span>atlas-only sunny).
  </div>
  ${sections}
</body>
</html>`;
}

async function main(): Promise<void> {
  const tiles: RenderedTile[] = [];
  for (const tileId of SELECTED_TILES) {
    process.stdout.write(`Rendering ${tileId} ... `);
    const rendered = await renderTile(tileId);
    if (!rendered) {
      console.log("SKIPPED (missing or mismatched)");
      continue;
    }
    console.log(`${rendered.frames.length} frame(s)`);
    tiles.push(rendered);
  }

  if (tiles.length === 0) {
    console.error("No tiles rendered.");
    return;
  }

  const html = buildHtml(tiles);
  const outDir = path.join(DATA_ROOT, "analysis");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `atlas-vs-tile-diff-${DATE}-${String(HOUR).padStart(2, "0")}h.html`);
  await fs.writeFile(outPath, html, "utf8");
  console.log(`\nWrote ${outPath}`);
  console.log(`Open in a browser to inspect.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
