// Benchmark: JSON.gz vs binary .tile.bin.gz for tile artifact load.
//
// Run:
//   pnpm tsx scripts/bench-tile-binary.ts <tile.json.gz> [count]
//
// For each iteration, measures:
//   - JSON path: readFile + gunzip + JSON.parse
//   - Binary path: encode once from JSON (offline), then readFile + gunzip + decode
//
// Also verifies that key fields match between JSON and binary round-trip.

import fs from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  encodeTileArtifactToBinary,
  decodeTileArtifactFromBinary,
  getFrameMask,
  MASK_KIND_SUN,
} from "../src/lib/precompute/sunlight-cache-binary";
import type { PrecomputedSunlightTileArtifact } from "../src/lib/precompute/sunlight-cache";

const gunzip = promisify(gunzipCb);
const gzip = promisify(gzipCb);

async function main() {
  const inputJsonGz = process.argv[2];
  const count = Number.parseInt(process.argv[3] ?? "5", 10);
  if (!inputJsonGz) {
    console.error("Usage: bench-tile-binary.ts <tile.json.gz> [count]");
    process.exit(1);
  }

  console.log(`Loading ${inputJsonGz} …`);
  const jsonGzBuf = await fs.readFile(inputJsonGz);
  const jsonBuf = await gunzip(jsonGzBuf);
  const artifact = JSON.parse(jsonBuf.toString("utf8")) as PrecomputedSunlightTileArtifact;
  console.log(
    `  pointCount=${artifact.points.length} frameCount=${artifact.frames.length}`,
  );
  console.log(`  json.gz size = ${jsonGzBuf.length} B`);
  console.log(`  json raw size = ${jsonBuf.length} B`);

  // Encode once
  const bin = encodeTileArtifactToBinary(artifact);
  const binGz = await gzip(bin);
  console.log(`  bin raw size = ${bin.length} B`);
  console.log(`  bin.gz size = ${binGz.length} B`);

  // Round-trip correctness check
  const decoded = decodeTileArtifactFromBinary(bin);
  console.log(`\nRound-trip check:`);
  console.log(`  pointCount match: ${decoded.pointCount === artifact.points.length}`);
  console.log(`  frameCount match: ${decoded.frameCount === artifact.frames.length}`);

  // Spot check 3 random points
  const sampleIdx = [0, Math.floor(artifact.points.length / 2), artifact.points.length - 1];
  for (const i of sampleIdx) {
    const p = artifact.points[i];
    const okLon = Math.abs(decoded.pointLon[i] - p.lon) < 1e-12;
    const okLat = Math.abs(decoded.pointLat[i] - p.lat) < 1e-12;
    const okIx = decoded.pointIx[i] === p.ix;
    const okOI = decoded.pointOutdoorIndex[i] === (p.outdoorIndex ?? -1);
    const okFlags = (decoded.pointFlags[i] & 1) === (p.insideBuilding ? 1 : 0);
    console.log(`  point[${i}]: lon=${okLon} lat=${okLat} ix=${okIx} outdoorIndex=${okOI} flags=${okFlags}`);
  }

  // Spot check first sun mask
  if (artifact.frames.length > 0) {
    const f0 = artifact.frames[0];
    const expected = Buffer.from(f0.sunMaskBase64, "base64");
    const got = getFrameMask(decoded, 0, MASK_KIND_SUN);
    let match = expected.length === got.length;
    if (match) {
      for (let i = 0; i < expected.length; i++) {
        if (expected[i] !== got[i]) { match = false; break; }
      }
    }
    console.log(`  frame[0].sunMask bytes match: ${match} (${got.length} B)`);
  }

  // Write the binary file next to the JSON for reads
  const binGzPath = inputJsonGz.replace(/\.json\.gz$/, ".tile.bin.gz");
  await fs.writeFile(binGzPath, binGz);
  console.log(`\nWrote ${binGzPath}`);

  // Bench JSON path
  console.log(`\nBench (${count} iterations):`);
  const jsonTimes: number[] = [];
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    const gz = await fs.readFile(inputJsonGz);
    const raw = await gunzip(gz);
    const _art = JSON.parse(raw.toString("utf8")) as PrecomputedSunlightTileArtifact;
    jsonTimes.push(performance.now() - t0);
  }
  const jsonAvg = jsonTimes.reduce((a, b) => a + b, 0) / jsonTimes.length;
  console.log(`  JSON.gz load: avg=${jsonAvg.toFixed(1)}ms  ${jsonTimes.map((t) => t.toFixed(0)).join("|")}`);

  // Bench binary path
  const binTimes: number[] = [];
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    const gz = await fs.readFile(binGzPath);
    const raw = (await gunzip(gz)) as Buffer;
    const _dec = decodeTileArtifactFromBinary(raw);
    binTimes.push(performance.now() - t0);
  }
  const binAvg = binTimes.reduce((a, b) => a + b, 0) / binTimes.length;
  console.log(`  BIN.gz  load: avg=${binAvg.toFixed(1)}ms  ${binTimes.map((t) => t.toFixed(0)).join("|")}`);

  console.log(`\nSpeedup: ${(jsonAvg / binAvg).toFixed(2)}x`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
