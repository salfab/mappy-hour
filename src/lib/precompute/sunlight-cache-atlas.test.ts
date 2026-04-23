import { describe, expect, it } from "vitest";

import {
  decodeTileAtlasFromBinary,
  encodeTileAtlasToBinary,
  getAtlasBucketMasks,
  mergeBucketsIntoAtlas,
  packBucketKey,
  type AtlasBucketEntry,
  type BinaryTileAtlas,
  type TileAtlasMetadata,
} from "./sunlight-cache-atlas";

const MASK_BYTES = 4;
const POINT_COUNT = 2;
const OUTDOOR_POINT_COUNT = 2;

function makeMask(fill: number): Uint8Array {
  return new Uint8Array([fill, fill, fill, fill]);
}

function makeBucket(az: number, alt: number, fill: number): AtlasBucketEntry {
  return {
    azBucket: az,
    altBucket: alt,
    sunMask: makeMask(fill),
    sunNoVegMask: makeMask(fill + 1),
    terrainMask: makeMask(fill + 2),
    buildingsMask: makeMask(fill + 3),
    vegetationMask: makeMask(fill + 4),
  };
}

function makeMeta(): TileAtlasMetadata {
  return {
    atlasFormatVersion: 1,
    region: "lausanne",
    modelVersionHash: "test-hash",
    gridStepMeters: 1,
    resolutionDegAz: 0.75,
    resolutionDegAlt: 0.75,
    tile: {
      tileId: "e0_n0_s250",
      tileSizeMeters: 250,
      minEasting: 0,
      minNorthing: 0,
      maxEasting: 250,
      maxNorthing: 250,
      bbox: { minLon: 6.5, minLat: 46.5, maxLon: 6.51, maxLat: 46.51 },
    },
    warnings: [],
    stats: {
      bucketCount: 0,
      pointCount: POINT_COUNT,
      outdoorPointCount: OUTDOOR_POINT_COUNT,
      sourceFramesTotal: 1,
    },
  };
}

function makePointParams() {
  return {
    pointCount: POINT_COUNT,
    outdoorPointCount: OUTDOOR_POINT_COUNT,
    maskBytesPerBucket: MASK_BYTES,
    resolutionDegAz: 0.75,
    resolutionDegAlt: 0.75,
    pointLon: new Float64Array([6.6, 6.6]),
    pointLat: new Float64Array([46.5, 46.5]),
    pointIx: new Int32Array([0, 1]),
    pointIy: new Int32Array([0, 0]),
    pointOutdoorIndex: new Int32Array([0, 1]),
    pointFlags: new Uint32Array([0, 0]),
  };
}

function readBucket(atlas: BinaryTileAtlas, az: number, alt: number) {
  const key = packBucketKey(az, alt);
  for (let i = 0; i < atlas.bucketCount; i++) {
    if (packBucketKey(atlas.bucketAz[i], atlas.bucketAlt[i]) === key) {
      return getAtlasBucketMasks(atlas, atlas.bucketDataIndex[i]);
    }
  }
  return null;
}

describe("mergeBucketsIntoAtlas", () => {
  it("writes new buckets when no existing atlas (fresh write)", () => {
    const merged = mergeBucketsIntoAtlas({
      existing: null,
      meta: makeMeta(),
      ...makePointParams(),
      newBuckets: [makeBucket(10, 20, 42), makeBucket(11, 20, 100)],
    });

    expect(merged.bucketCount).toBe(2);
    const b1 = readBucket(merged, 10, 20);
    expect(b1).not.toBeNull();
    expect(Array.from(b1!.sunMask)).toEqual([42, 42, 42, 42]);
    expect(Array.from(b1!.vegetationMask)).toEqual([46, 46, 46, 46]);

    const b2 = readBucket(merged, 11, 20);
    expect(Array.from(b2!.sunMask)).toEqual([100, 100, 100, 100]);
  });

  it("NEW buckets OVERWRITE existing stale buckets with same (az, alt) key", () => {
    // Step 1: build an existing atlas with a "stale" bucket (fill=7)
    const stale = mergeBucketsIntoAtlas({
      existing: null,
      meta: makeMeta(),
      ...makePointParams(),
      newBuckets: [makeBucket(10, 20, 7)],
    });
    expect(Array.from(readBucket(stale, 10, 20)!.sunMask)).toEqual([7, 7, 7, 7]);

    // Step 2: merge with a NEW bucket at the same key but different content (fill=99)
    const merged = mergeBucketsIntoAtlas({
      existing: stale,
      meta: makeMeta(),
      ...makePointParams(),
      newBuckets: [makeBucket(10, 20, 99)],
    });

    expect(merged.bucketCount).toBe(1);
    const b = readBucket(merged, 10, 20);
    expect(b).not.toBeNull();
    // The NEW content must win — this is the regression guard for the stale-bucket bug.
    expect(Array.from(b!.sunMask)).toEqual([99, 99, 99, 99]);
    expect(Array.from(b!.sunNoVegMask)).toEqual([100, 100, 100, 100]);
    expect(Array.from(b!.terrainMask)).toEqual([101, 101, 101, 101]);
    expect(Array.from(b!.buildingsMask)).toEqual([102, 102, 102, 102]);
    expect(Array.from(b!.vegetationMask)).toEqual([103, 103, 103, 103]);
  });

  it("preserves existing buckets that have no NEW counterpart", () => {
    const existing = mergeBucketsIntoAtlas({
      existing: null,
      meta: makeMeta(),
      ...makePointParams(),
      newBuckets: [makeBucket(10, 20, 7), makeBucket(11, 20, 8)],
    });

    const merged = mergeBucketsIntoAtlas({
      existing,
      meta: makeMeta(),
      ...makePointParams(),
      // Overwrites only (10,20); (11,20) must survive untouched.
      newBuckets: [makeBucket(10, 20, 99)],
    });

    expect(merged.bucketCount).toBe(2);
    expect(Array.from(readBucket(merged, 10, 20)!.sunMask)).toEqual([99, 99, 99, 99]);
    expect(Array.from(readBucket(merged, 11, 20)!.sunMask)).toEqual([8, 8, 8, 8]);
  });

  it("dedupes duplicates within newBuckets (first occurrence wins)", () => {
    const merged = mergeBucketsIntoAtlas({
      existing: null,
      meta: makeMeta(),
      ...makePointParams(),
      newBuckets: [makeBucket(10, 20, 50), makeBucket(10, 20, 200)],
    });

    expect(merged.bucketCount).toBe(1);
    expect(Array.from(readBucket(merged, 10, 20)!.sunMask)).toEqual([50, 50, 50, 50]);
  });

  it("round-trip encode/decode: rewritten bucket reads back with NEW value after merge", () => {
    // Simulate the real-world corruption path:
    // 1. Write an atlas with stale bucket to disk format.
    // 2. Decode it (as if reloaded).
    // 3. Merge a NEW bucket at same (az, alt).
    // 4. Encode/decode the merged atlas.
    // 5. Assert the reloaded atlas contains the NEW value, not the stale one.
    const stale = mergeBucketsIntoAtlas({
      existing: null,
      meta: makeMeta(),
      ...makePointParams(),
      newBuckets: [makeBucket(10, 20, 7), makeBucket(11, 20, 8)],
    });

    const encoded1 = encodeTileAtlasToBinary(stale);
    const reloaded1 = decodeTileAtlasFromBinary(encoded1);
    expect(Array.from(readBucket(reloaded1, 10, 20)!.sunMask)).toEqual([7, 7, 7, 7]);

    const merged = mergeBucketsIntoAtlas({
      existing: reloaded1,
      meta: makeMeta(),
      ...makePointParams(),
      newBuckets: [makeBucket(10, 20, 99)],
    });

    const encoded2 = encodeTileAtlasToBinary(merged);
    const reloaded2 = decodeTileAtlasFromBinary(encoded2);
    expect(reloaded2.bucketCount).toBe(2);
    expect(Array.from(readBucket(reloaded2, 10, 20)!.sunMask)).toEqual([99, 99, 99, 99]);
    expect(Array.from(readBucket(reloaded2, 11, 20)!.sunMask)).toEqual([8, 8, 8, 8]);
  });

  it("sorts buckets by (altBucket asc, azBucket asc)", () => {
    const merged = mergeBucketsIntoAtlas({
      existing: null,
      meta: makeMeta(),
      ...makePointParams(),
      newBuckets: [
        makeBucket(5, 30, 1),
        makeBucket(3, 10, 2),
        makeBucket(10, 30, 3),
        makeBucket(1, 10, 4),
      ],
    });

    const keys = Array.from({ length: merged.bucketCount }, (_, i) => ({
      az: merged.bucketAz[i],
      alt: merged.bucketAlt[i],
    }));
    expect(keys).toEqual([
      { az: 1, alt: 10 },
      { az: 3, alt: 10 },
      { az: 5, alt: 30 },
      { az: 10, alt: 30 },
    ]);
  });
});
