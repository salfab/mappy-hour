# Web Performance Playbook - Throughput and Cost

Date: 2026-03-08
Scope: increase sunlight compute throughput (points/minute) while keeping a web architecture.

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

## P1 (big CPU gains)

1. Build a spatial index for buildings:
   - uniform grid or R-tree in LV95
   - query only nearby candidate obstacles per ray
2. Reuse contexts within a request:
   - batch terrain/vegetation tile loads once per bbox
3. Parallelize compute:
   - worker_threads by point chunk
   - fixed pool size per machine

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

## 9. Decision

Web architecture is viable if compute is split into:

- fast sync for interactive
- async + cached for heavy

Without this split, costs and latency will grow non-linearly with usage.
