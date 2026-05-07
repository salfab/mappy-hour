/**
 * Microbench to break down the per-frame eval loop into phases.
 *
 * Loads real Lausanne horizon masks + synthetic outdoor points and runs
 * each phase of the fast-path in isolation N times (matching a 60-frame day).
 *
 * Goal: identify whether horizon lookup, terrain check, vegetation eval,
 * mask bit setting, or diagnostic push dominates the JS eval phase.
 *
 * Usage: pnpm exec tsx scripts/benchmark/eval-loop-phase-microbench.ts
 */
import { performance } from "node:perf_hooks";

import {
  getHorizonAngleForAzimuth,
  isTerrainBlockedByHorizon,
  type HorizonMask,
} from "@/lib/sun/horizon-mask";
import {
  getMaxHorizonAngle,
  TERRAIN_HORIZON_SKIP_MARGIN_DEG,
} from "@/lib/sun/solar";

const POINT_COUNT = 32_186;
const FRAME_COUNT = 60;
const ITERATIONS = 3; // run each phase 3 times, take median

function buildSyntheticHorizonMask(): HorizonMask {
  // 360 bins, max 8° (typical urban Lausanne)
  const binsDeg = new Array(360);
  for (let i = 0; i < 360; i++) {
    binsDeg[i] = Math.max(0, 8 * Math.sin((i / 360) * Math.PI * 2 + Math.random() * 0.5));
  }
  return {
    binsDeg,
    method: "synthetic",
  } as unknown as HorizonMask;
}

type PointLike = {
  horizonMask: HorizonMask | null;
  vegetationShadowEvaluator?: (s: { azimuthDeg: number; altitudeDeg: number }) => { blocked: boolean };
};

function buildPoints(count: number, vegRatio: number): PointLike[] {
  const points: PointLike[] = new Array(count);
  // Most points share the SAME mask in production (tile-wide horizon).
  // We simulate this with ~10 distinct masks across the tile.
  const masks: HorizonMask[] = [];
  for (let i = 0; i < 10; i++) masks.push(buildSyntheticHorizonMask());

  // Vegetation evaluator: ~80% of LV95 grid samples have surface tiles in
  // central Lausanne. For the bench, we synthesize a fast evaluator (~3µs)
  // that returns blocked=true ~10% of the time.
  const vegEval = (s: { azimuthDeg: number; altitudeDeg: number }) => {
    // Mimic ray-march: a few sin/cos + atan
    let acc = 0;
    for (let i = 0; i < 30; i++) {
      acc += Math.sin(s.azimuthDeg * 0.01 + i) * Math.cos(s.altitudeDeg * 0.02 + i);
    }
    return { blocked: (acc | 0) % 11 === 0 };
  };

  for (let i = 0; i < count; i++) {
    points[i] = {
      horizonMask: masks[i % masks.length],
      vegetationShadowEvaluator: i / count < vegRatio ? vegEval : undefined,
    };
  }
  return points;
}

function timePhase(label: string, fn: () => void): number {
  // Warm up
  fn();
  // Measure
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`  ${label.padEnd(30)} median=${median.toFixed(1)}ms  (samples ${samples.map((s) => s.toFixed(1)).join(", ")})`);
  return median;
}

function main() {
  console.log(`[microbench] points=${POINT_COUNT} frames=${FRAME_COUNT} iters=${ITERATIONS}`);
  console.log("");

  // Test two scenarios: fully populated vegetation vs no vegetation
  for (const vegRatio of [0.0, 0.5, 1.0]) {
    console.log(`=== vegetation ratio = ${vegRatio} ===`);
    const points = buildPoints(POINT_COUNT, vegRatio);

    // Pre-allocate output buffers (matches the optimized fast-path)
    const maskByteLen = Math.ceil(POINT_COUNT / 8);
    const sunnyMask = new Uint8Array(maskByteLen);
    const sunnyMaskNoVeg = new Uint8Array(maskByteLen);
    const terrainMask = new Uint8Array(maskByteLen);
    const buildingsMask = new Uint8Array(maskByteLen);
    const vegetationMask = new Uint8Array(maskByteLen);
    const horizonAngleByPoint: Array<number | null> = new Array(POINT_COUNT);
    const buildingBlockerIds: Array<string | null> = new Array(POINT_COUNT).fill(null);
    // Synthetic GPU result: bitmask with ~5% bits set
    const buildingsBlockedFromGpu = new Uint32Array(Math.ceil(POINT_COUNT / 32));
    for (let i = 0; i < buildingsBlockedFromGpu.length; i++) {
      buildingsBlockedFromGpu[i] = (Math.random() * 0xffffffff) | 0;
      // Sparse-ify: keep ~5% bits
      buildingsBlockedFromGpu[i] &= buildingsBlockedFromGpu[i] >> 4;
    }

    // ---------- Phase 1: horizon angle lookup only ----------
    timePhase("horizon angle lookup", () => {
      let acc = 0;
      for (let f = 0; f < FRAME_COUNT; f++) {
        const az = (f / FRAME_COUNT) * 360;
        for (let i = 0; i < POINT_COUNT; i++) {
          const m = points[i].horizonMask;
          if (m !== null) {
            acc += getHorizonAngleForAzimuth(m, az);
          }
        }
      }
      // prevent dead-code elimination
      if (acc === 12345.6789) console.log(acc);
    });

    // ---------- Phase 2: horizon + terrain check ----------
    timePhase("horizon + terrain check", () => {
      let acc = 0;
      for (let f = 0; f < FRAME_COUNT; f++) {
        const az = (f / FRAME_COUNT) * 360;
        const alt = 30 + (f % 10) * 3;
        for (let i = 0; i < POINT_COUNT; i++) {
          const m = points[i].horizonMask;
          if (m !== null) {
            const ha = getHorizonAngleForAzimuth(m, az);
            acc += ha;
            if (alt <= getMaxHorizonAngle(m) + TERRAIN_HORIZON_SKIP_MARGIN_DEG) {
              if (isTerrainBlockedByHorizon(m, az, alt)) acc += 1;
            }
          }
        }
      }
      if (acc === 12345.6789) console.log(acc);
    });

    // ---------- Phase 3: vegetation eval ----------
    timePhase("vegetation eval (when terrain not blocked)", () => {
      let blocked = 0;
      for (let f = 0; f < FRAME_COUNT; f++) {
        const az = (f / FRAME_COUNT) * 360;
        const alt = 30 + (f % 10) * 3;
        for (let i = 0; i < POINT_COUNT; i++) {
          const veg = points[i].vegetationShadowEvaluator;
          if (veg !== undefined) {
            if (veg({ azimuthDeg: az, altitudeDeg: alt }).blocked) blocked++;
          }
        }
      }
      if (blocked === 12345) console.log(blocked);
    });

    // ---------- Phase 4: mask bits + counters ----------
    timePhase("mask bits + counters", () => {
      for (let f = 0; f < FRAME_COUNT; f++) {
        let sunnyCount = 0;
        let sunnyCountNoVeg = 0;
        for (let i = 0; i < POINT_COUNT; i++) {
          const byteIndex = i >> 3;
          const bit = 1 << (i & 7);
          const buildingsBlocked = ((buildingsBlockedFromGpu[i >>> 5] >>> (i & 31)) & 1) === 1;
          // Simulate: 5% terrain, 10% veg, building from gpu
          const terrainBlocked = (i & 19) === 0;
          const vegBlocked = (i & 9) === 0;
          if (terrainBlocked) terrainMask[byteIndex] |= bit;
          if (buildingsBlocked) buildingsMask[byteIndex] |= bit;
          if (vegBlocked) vegetationMask[byteIndex] |= bit;
          const isSunnyNoVeg = !terrainBlocked && !buildingsBlocked;
          if (isSunnyNoVeg) {
            sunnyMaskNoVeg[byteIndex] |= bit;
            sunnyCountNoVeg++;
            if (!vegBlocked) {
              sunnyMask[byteIndex] |= bit;
              sunnyCount++;
            }
          }
        }
        if (sunnyCount === 99999999) console.log(sunnyCount, sunnyCountNoVeg);
      }
    });

    // ---------- Phase 5: diagnostic array push (current production behavior) ----------
    timePhase("diagnostic array (index assign)", () => {
      for (let f = 0; f < FRAME_COUNT; f++) {
        for (let i = 0; i < POINT_COUNT; i++) {
          const m = points[i].horizonMask;
          horizonAngleByPoint[i] = m === null ? null : Math.round(getHorizonAngleForAzimuth(m, (f / FRAME_COUNT) * 360) * 1000) / 1000;
        }
      }
      // touch consumer
      if (horizonAngleByPoint[0] === 999) console.log(buildingBlockerIds.length);
    });

    // ---------- Phase 6: full inline fast-path (everything combined) ----------
    timePhase("full fast-path inline", () => {
      let sunnyCount = 0;
      let sunnyCountNoVeg = 0;
      for (let f = 0; f < FRAME_COUNT; f++) {
        const az = (f / FRAME_COUNT) * 360;
        const alt = 30 + (f % 10) * 3;
        for (let i = 0; i < POINT_COUNT; i++) {
          const point = points[i];
          const m = point.horizonMask;
          let horizonAngle: number | null = null;
          let terrainBlocked = false;
          if (m !== null) {
            horizonAngle = getHorizonAngleForAzimuth(m, az);
            if (alt <= getMaxHorizonAngle(m) + TERRAIN_HORIZON_SKIP_MARGIN_DEG) {
              terrainBlocked = isTerrainBlockedByHorizon(m, az, alt);
            }
          }
          let vegBlocked = false;
          const veg = point.vegetationShadowEvaluator;
          if (!terrainBlocked && veg !== undefined) {
            vegBlocked = veg({ azimuthDeg: az, altitudeDeg: alt }).blocked;
          }
          const buildingsBlocked = ((buildingsBlockedFromGpu[i >>> 5] >>> (i & 31)) & 1) === 1;
          const byteIndex = i >> 3;
          const bit = 1 << (i & 7);
          if (terrainBlocked) terrainMask[byteIndex] |= bit;
          if (buildingsBlocked) buildingsMask[byteIndex] |= bit;
          if (vegBlocked) vegetationMask[byteIndex] |= bit;
          const isSunnyNoVeg = !terrainBlocked && !buildingsBlocked;
          if (isSunnyNoVeg) {
            sunnyMaskNoVeg[byteIndex] |= bit;
            sunnyCountNoVeg++;
            if (!vegBlocked) {
              sunnyMask[byteIndex] |= bit;
              sunnyCount++;
            }
          }
          horizonAngleByPoint[i] = horizonAngle === null ? null : Math.round(horizonAngle * 1000) / 1000;
        }
      }
      if (sunnyCount === 999999) console.log(sunnyCount, sunnyCountNoVeg);
    });

    console.log("");
  }
}

main();
