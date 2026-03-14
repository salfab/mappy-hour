# Web Performance Playbook - Throughput and Cost

Date: 2026-03-08  
Updated: 2026-03-14
Scope: increase sunlight compute throughput (points/minute) while keeping a web architecture.

## 0. 2026-03-14 status update (measured)

Benchmarks now available:

- `docs/progress/benchmarks/precompute-lausanne-2026-03-08-d1-g250.json`
- `docs/progress/benchmarks/smoke-cache-benchmark-2026-03-08-instant-g20.json`
- `docs/progress/benchmarks/lausanne-horizon-macro-tiling-20260308-s5.json`
- `docs/progress/benchmarks/lausanne-horizon-tile-vs-global-20260308-s5.json`

Observed results:

1. Large bbox vs tiled precompute (same covered area):
   - large: `2.85 points/s`
   - tiled: `155.779 points/s`
   - throughput ratio: `54.653x` (cold/warm effects still contribute to this gap)
2. Cache cold vs warm (instant):
   - cold wall time: `~222701 ms`
   - warm wall time: `~105 ms`
   - practical speedup: `~x2100`
3. Horizon sharing quality:
   - one global Lausanne mask is not acceptable as a universal replacement
   - tile/macro-local masks are significantly closer to local reference than global mask

Immediate implication:

- Keep tile-first architecture.
- Focus optimization work on:
  - avoiding unnecessary per-point shadow checks once terrain already blocks
  - reducing horizon-mask computation count with controlled local sharing
  - preserving quality with explicit mismatch budgets.

Implementation status (2026-03-14, runtime):

- `evaluateInstantSunlight()` now skips building + vegetation evaluators when:
  - sun is below the astronomical horizon
  - terrain already blocks sunlight (default fast path)
- optional diagnostic mode is available through `evaluateAllBlockers=true` to keep full blocker details when needed.
- a conservative high-sun gate is active for terrain checks:
  - if `sunAltitude > max(horizonMask) + margin`, terrain blocking check is skipped.

## 1. What to optimize exactly

Use one common unit across backend and product:

- `point-evaluations` = `outdoorPoints * timeFrames`

Examples:

- instant mode: `3000 points * 1 frame = 3000 point-evaluations`
- daily mode (06:00-21:00, every 5 min): `3000 * 180 = 540000 point-evaluations`

The real bottleneck is not "points only", but point-evaluations per request.

## 2. Current bottlenecks in this project

1. Building shadow check is CPU-heavy for each point/frame.
2. Daily mode multiplies cost by number of sampled timestamps.
3. Per-point context setup (terrain/building/vegetation) is expensive when bbox is large.
4. Same requests are recomputed too often (limited result reuse).
5. Long-running requests consume expensive API time directly.

## 3. Performance strategy (web-first)

### A. Keep two execution paths

- Interactive path (sync): point + small instant area.
- Heavy path (async): daily large bbox and/or fine grid.

This keeps UI reactive without forcing all users into queue latency.

### B. Budget by point-evaluations (not only maxPoints)

Add a hard budget like:

- `maxPointEvaluationsSync` (example: 300k)
- `maxPointEvaluationsAsync` (example: 3M)

Reject or reroute to async when budget is exceeded.

### C. Cache aggressively at the right granularity

Cache keys should include:

- normalized bbox tile key
- date, timezone, time range
- grid step, sample step
- calibration parameters (observer height, building bias)
- ignore vegetation flag

Use 3 levels:

1. in-memory short TTL (hot requests)
2. Redis (cross-instance dedupe)
3. object storage for full daily frame sets

### D. Move heavy work to workers

- API node handles auth, validation, streaming metadata.
- Worker pool handles compute jobs.
- API streams progress from job state (SSE).

## 4. High-impact optimizations (priority order)

## P0 (quick wins, low risk)

1. Add metrics per request:
   - pointCount, frameCount, pointEvaluations, elapsedMs, cacheHit, cpuMs
2. Add in-flight deduplication:
   - if same request key is already running, attach to existing job/stream
3. Add point-evaluation guardrails:
   - fail fast with actionable message
4. Prefer coarser defaults:
   - instant default grid wider than daily
5. Add terrain-first short-circuit in runtime evaluation:
   - if `terrainBlocked === true`, skip building + vegetation checks
   - keep optional full-cause mode only for diagnostics/click-debug
6. Add high-sun coarse gate for horizon:
   - per region/tile, precompute conservative `maxHorizonDeg`
   - if `sunAltitude > maxHorizonDeg + margin`, skip terrain block checks for that frame
   - best gain for instant requests and mid-day windows

## P1 (big CPU gains)

1. Build a spatial index for buildings:
   - uniform grid or R-tree in LV95
   - query only nearby candidate obstacles per ray
2. Reuse contexts within a request:
   - batch terrain/vegetation tile loads once per bbox
3. Parallelize compute:
   - worker_threads by point chunk
   - fixed pool size per machine
4. Horizon mask sharing with quality budget:
   - keep local mask as reference model
   - choose macro-cell mask only when estimated angular error stays below threshold
   - fallback to finer/local mask in sensitive areas (steep slopes / ridge transitions)
5. Offline partition pass:
   - one-time preprocessing to assign canonical mask centers to LV95 cells
   - runtime does lookup instead of ad-hoc center choice

## P2 (large-scale web operations)

1. Async job API for heavy daily runs:
   - `POST /jobs/sunlight`
   - `GET /jobs/:id`
   - `GET /jobs/:id/stream` (SSE)
2. Persist frame bitmasks:
   - avoid recompute for slider replay and repeated users
3. Precompute popular zones:
   - Lausanne hotspots, terraces, parks
   - morning/noon/evening seasonal packs
4. Day interpolation (every K days) with safety fallback:
   - compute exact every `K` days (start with `K=3`)
   - interpolate intermediate days
   - force exact recompute for sensitive points/time windows

## 5. Cost control model

Simple model:

- `cost ~= cpu_seconds + memory_pressure + storage_io + egress`

Operational levers:

1. Protect sync API with strict point-evaluation caps.
2. Make heavy mode async + queue-based.
3. Cache daily frames for repeated demand.
4. Autoscale workers on queue depth, not API traffic.
5. Enforce per-user quota (requests/day + compute budget/day).

## 6. Suggested hosting patterns

### Stage 1 (MVP)

- 1 CPU-oriented VM (API + worker)
- local SSD cache + periodic cleanup

### Stage 2 (production)

- stateless API instances
- dedicated worker instances
- Redis for queue/state
- object storage for frame archives

### Stage 3 (high traffic)

- regional worker pools
- precompute + cache warming by demand
- aggressive in-flight dedupe and admission control

## 7. Product guardrails for better UX and lower cost

1. Show estimated compute before launch:
   - "This request = X point-evaluations"
2. Suggest automatic fallback:
   - "Switch to async"
   - "Increase grid step"
   - "Increase sample interval"
3. Keep first feedback fast:
   - stream first frame ASAP
   - continue remaining frames in background

## 8. Concrete next steps for this codebase

1. Add `point-evaluations` estimator in API responses and UI.
2. Add request-level result cache for daily frame bitsets.
3. Add building spatial index in preprocess output and runtime query path.
4. Add async job endpoint for heavy daily requests.
5. Add dashboards:
   - p50/p95 latency
   - point-evaluations/sec per worker
   - cache hit rate
   - queue wait time

## 9. Optimization matrix (new)

### A. Terrain-first short-circuit (buildings/vegetation)

Idea:

- evaluate terrain/horizon first
- if blocked, skip building/vegetation checks for non-debug execution path

Expected gain:

- near-zero when terrain rarely blocks
- very high when terrain blocks most points in a frame (morning/evening, north-facing areas)
- measured in a Lausanne-north micro-benchmark: up to `~96%` compute saved for fully terrain-blocked frame

Quality impact:

- none on final sunny/not-sunny result
- potential loss of secondary blocker diagnostics unless enabled in debug mode

### B. High-sun coarse gate

Idea:

- skip terrain shadow evaluation when sun altitude is safely above local maximum horizon angle

Expected gain:

- modest-to-good for instant/midday calls
- limited for full-day timelines (morning/evening still need full checks)

Quality impact:

- none if safety margin is conservative

### C. Adaptive horizon sharing (macro-cell vs local)

Idea:

- reduce number of masks by sharing on macro-cells
- enforce mismatch budget against local reference

Expected gain:

- less mask-build work and fewer unique mask computations
- runtime lookup simplification

Quality impact:

- controlled by mismatch budget (`point-minutes`, max mismatch per point)
- global single-mask strategy is rejected by current Lausanne benchmark data

### D. Daily interpolation every K days

Idea:

- compute exact for anchor days only, interpolate intermediate days

Expected gain:

- potentially large reduction in daily precompute volume

Quality impact:

- needs sensitive-area fallback to avoid time-shift errors near shadow transitions

## 10. Decision

Web architecture remains viable if we keep a layered strategy:

1. tile-first cache and precompute
2. terrain-first compute short-circuit
3. adaptive (not global) horizon sharing
4. optional interpolation only with error-budget fallback

Without these controls, costs and latency grow non-linearly with usage.
