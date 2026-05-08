/**
 * Process-local sink that collects atlas drift events during a precompute run.
 *
 * When `mergeBucketsIntoAtlas` detects an outdoor-count drift (caused by the
 * gpu-raster zenith non-determinism documented in
 * `project_zenith_shadow_non_deterministic.md`), it gracefully invalidates the
 * stale atlas and emits a record here. The orchestrator (precompute-region-
 * sunlight.ts) consumes the records at the end of the run to generate a patch
 * script that the operator can run to fill the gaps left by the invalidation.
 *
 * The sink is opt-in: callers must `enableAtlasDriftSink()` at the start of a
 * run and `consumeAtlasDriftRecords()` at the end. Outside of an enabled run,
 * `recordAtlasDrift` is a no-op so unit tests / one-off scripts using
 * `mergeBucketsIntoAtlas` are not affected.
 */

export interface AtlasDriftRecord {
  region: string;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
  resolutionDeg: number;
  previousOutdoorCount: number;
  newOutdoorCount: number;
  previousMaskBytesPerBucket: number;
  newMaskBytesPerBucket: number;
  previousBucketCount: number;
  detectedAt: string;
}

let sinkEnabled = false;
const records = new Map<string, AtlasDriftRecord>();

function recordKey(region: string, modelVersionHash: string, tileId: string): string {
  return `${region}|${modelVersionHash}|${tileId}`;
}

export function enableAtlasDriftSink(): void {
  sinkEnabled = true;
  records.clear();
}

export function disableAtlasDriftSink(): void {
  sinkEnabled = false;
  records.clear();
}

export function recordAtlasDrift(record: AtlasDriftRecord): void {
  if (!sinkEnabled) return;
  // Last-write-wins per (region, hash, tileId): if a tile drifts twice during
  // the same run (rare but possible), the latter record carries the most recent
  // mask sizes which is what the patch script needs to reason about.
  records.set(recordKey(record.region, record.modelVersionHash, record.tileId), record);
}

export function consumeAtlasDriftRecords(): AtlasDriftRecord[] {
  const list = Array.from(records.values());
  records.clear();
  return list;
}

export function peekAtlasDriftRecordCount(): number {
  return records.size;
}
