# ADR-0004 - Multithread Worker Pool for Precompute

Date: 2026-03-14  
Status: Proposed

## Context

Current precompute behavior is intentionally safe but mostly sequential:

- one active precompute job at a time
- tiles are processed one-by-one
- each tile runs point/frame loops in a single Node.js thread

This keeps correctness simple, but limits throughput for large regional/day workloads.

## Decision

Keep **one logical precompute job** at the API/product level, but execute tile computation with an internal bounded worker pool (`worker_threads`).

Key principles:

1. preserve current cache key/model-version semantics
2. keep deterministic tile artifacts
3. cap concurrency to protect DEM/raster I/O and avoid `EMFILE`
4. preserve current progress/cancel/resume UX

## Planned Architecture

### Execution model

- Parent process:
  - builds tile work queue
  - dispatches tasks to workers
  - aggregates progress and ETA
  - writes manifests when day batch is coherent
- Worker process:
  - computes one tile artifact
  - reports incremental progress
  - supports cancellation checkpoints

### Concurrency controls

- `workerPoolSize` default: `min(4, max(2, cpuCount - 1))`
- DEM/raster read semaphore to cap simultaneous heavy file access
- optional per-worker memory cap and periodic recycle (future hardening)

### Progress model

- total progress: unchanged (`tile-day` unit)
- current tile progress: aggregated from active workers
- ETA: based on completed-equivalent tiles across all workers

## Why this approach

Compared to spawning multiple jobs:

- keeps one source of truth for progress/cancellation
- avoids duplicate overlapping work
- avoids API-level concurrency complexity

Compared to fully async single-thread compute:

- true CPU parallelism for heavy geometry/shadow loops
- better wall-clock reduction on multi-core hosts

## Expected impact

Expected improvement on commodity 6-10 core machines:

- throughput: typically `x1.8` to `x3.0` (workload dependent)
- biggest gains on large tile sets and daily windows
- diminishing returns beyond 4-6 workers due to I/O contention

## Risks and mitigations

1. File handle pressure (`EMFILE`)
   - Mitigation: bounded workers + DEM I/O semaphore.
2. Progress jitter from concurrent updates
   - Mitigation: central aggregator with monotonic counters.
3. Cancellation complexity
   - Mitigation: cooperative abort checks + worker termination fallback.
4. Resume consistency
   - Mitigation: keep skip-existing semantics and manifest completeness checks.

## Rollout plan

1. Add instrumentation baseline (CPU, elapsed, tiles/min, I/O latency).
2. Introduce worker pool behind feature flag (`PRECOMPUTE_WORKERS=1` default off).
3. Enable for admin precompute only.
4. Tune concurrency defaults and I/O semaphore from benchmarks.
5. Enable by default after regression/stability pass.

## Out of scope (this ADR)

- distributed multi-node execution
- external queue systems
- object storage migration

These can be handled later if single-node multithread becomes insufficient.

