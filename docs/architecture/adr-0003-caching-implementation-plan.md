# ADR-0003 - Caching Implementation Plan (Daily + 1m Precompute)

Date: 2026-03-09  
Status: Proposed

## Context

The project now has:

- measured evidence that large one-shot area requests are operationally expensive
- measured parallax impact requiring local horizon handling
- a product requirement to support daily precompute at 1m granularity (at least on selected areas)

At this scale, caching is not optional. It is required for:

1. throughput
2. cost control
3. consistent response times
4. avoiding duplicate heavy work

This ADR defines the implementation plan for caching, not only high-level recommendations.

## Decision

Implement a multi-layer cache with strict key/versioning rules, in-flight deduplication, and explicit invalidation.

Cache layers:

1. L0 In-flight dedupe (per process): avoid running the same heavy compute twice concurrently.
2. L1 Memory cache (short TTL): accelerate repeated hot requests.
3. L2 Persistent cache (disk/object): store tile/day/frame artifacts for daily playback and API reuse.

Primary unit of caching for heavy workloads:

- `(region, tile_id, date, sample_step, grid_step, model_version_hash, calibration)`

## Why this decision

- `daily + 1m` on full Lausanne has very large raw data envelope, so recomputing on-demand is not viable at scale.
- Tiled precompute is now the accepted compute strategy (ADR-0002). Cache must follow the same unit.
- Current runtime already exposes warm/cold behavior and expensive context setup; cache reuse gives immediate gains.

## Cache key strategy

All keys must include a deterministic `model_version_hash`.

### 1. Request-level key (interactive and daily query entrypoint)

```
request:v1:{
  region,
  bbox_norm_or_tile_set,
  date,
  mode,
  local_time_or_range,
  grid_step_m,
  sample_step_min,
  observer_height_m,
  building_height_bias_m,
  ignore_vegetation,
  model_version_hash
}
```

### 2. Tile/day artifact key (heavy path)

```
tileday:v1:{
  region,
  tile_id,
  date,
  grid_step_m,
  sample_step_min,
  observer_height_m,
  building_height_bias_m,
  ignore_vegetation,
  model_version_hash
}
```

### 3. Point context key (optional local acceleration)

```
pointctx:v1:{
  region,
  tile_id,
  point_index,
  model_version_hash,
  calibration_hash
}
```

## model_version_hash rules

Build from immutable inputs used by the solver:

1. buildings index version/hash
2. terrain DEM bundle version/hash
3. horizon DEM/mask version/hash
4. vegetation raster bundle version/hash
5. algorithm version string

If any input changes, hash changes, cache becomes stale by construction.

## Storage design

### L0 in-flight (memory)

- `Map<request_key, Promise<Result>>`
- attach secondary callers to same Promise
- delete entry on resolve/reject

### L1 memory (short TTL)

- small bounded LRU map
- target TTL:
  - instant: 30s to 5min
  - daily metadata: 5min to 30min
- never store massive frame payloads here unless chunked and bounded

### L2 persistent

Suggested local layout:

`data/cache/sunlight/{region}/{model_hash}/{grid_step}/{sample_step}/{date}/{tile_id}.json.zst`

Artifact payload (minimum):

1. tile metadata (bbox, point count, indoor excluded)
2. frame bitsets (sun/no-sun, optional no-vegetation variant)
3. aggregates (`sunnyMinutes`, windows, start/end)
4. diagnostics metadata (timings, warnings, generation timestamp)

For multi-instance deployment:

- keep same object naming in object storage
- optional Redis index for fast existence lookup and in-flight coordination

## Invalidation policy

Primary invalidation = versioned keys.

Additional controls:

1. TTL eviction for L1 memory.
2. Scheduled cleanup by retention policy for L2:
   - keep recent N days hot
   - archive or prune older artifacts
3. Manual purge command by scope:
   - region
   - model hash
   - date range
   - tile set

## API/contract changes

Add `cache` metadata in responses/events:

```json
{
  "cache": {
    "hit": true,
    "layer": "L1|L2|MISS",
    "keyPrefix": "request:v1",
    "modelVersionHash": "..."
  }
}
```

For heavy daily requests:

1. resolve from tile/day cache when fully available
2. compute only missing tiles
3. merge cached + computed tiles before returning/streaming

## Implementation plan

## Phase 1 - Foundations (low risk)

1. Implement key builder module (`src/lib/cache/cache-keys.ts`).
2. Implement `model_version_hash` provider from dataset manifests/indexes.
3. Add L0 in-flight dedupe for area/instant/timeline handlers.
4. Add response `cache` metadata (hit/miss/layer).

Exit criteria:

- duplicate concurrent requests dedupe correctly
- cache metadata visible in API responses

## Phase 2 - L1 memory cache

1. Add bounded in-process LRU for request-level hot responses.
2. Separate TTL policy by endpoint/mode.
3. Add hit/miss counters.

Exit criteria:

- no functional regression
- measurable p95 reduction on repeated instant requests

## Phase 3 - L2 persistent tile/day cache (core)

1. Define artifact schema + serializer (bitset + metadata).
2. Write/read tile/day artifacts under versioned path.
3. Integrate partial-hit execution:
   - load cached tiles
   - compute missing tiles only
   - merge outputs

Exit criteria:

- repeated daily queries over same tiles are served from L2
- missing-tiles only recompute works

## Phase 4 - 1m daily specialization

1. Restrict 1m mode to tile-first path only.
2. Enforce max tile area and chunked writes.
3. Add compression and optional frame-delta encoding.
4. Add priority policy:
   - 1m for hotspots
   - coarser grid fallback for full-city requests unless precomputed

Exit criteria:

- stable memory usage under 1m tile jobs
- acceptable storage growth and retrieval latency

## Observability and SLOs

Track at least:

1. cache hit rate by layer (L1/L2)
2. deduped request count
3. point-evaluations computed vs reused
4. per-job compute time and queue wait
5. artifact size per tile/day

Target initial SLOs:

- repeated daily tile request: `>= 90%` served from L2 for hot horizon
- no duplicate compute for same in-flight key

## Test strategy

1. Unit tests:
   - key determinism
   - model hash change on input change
   - LRU TTL behavior
2. Integration tests:
   - MISS -> write -> HIT path
   - partial tile hit merge correctness
   - in-flight dedupe for concurrent identical requests
3. Regression tests:
   - cache on/off returns equivalent sunlight outputs
   - calibration params create distinct cache keys

## Risks and mitigations

Risk:

- stale data served after model updates

Mitigation:

- strict model_version_hash in keys
- no cross-hash reuse

Risk:

- storage explosion for 1m daily artifacts

Mitigation:

- tile size caps
- compression + retention
- hotspot-first policy

Risk:

- complexity of partial tile merge

Mitigation:

- stable tile index ordering
- deterministic merge contract
- dedicated integration tests

## Non-goals (this ADR)

1. Full distributed queue implementation details
2. Billing/quota policy specifics
3. Frontend UX redesign
