# ADR-0002 - Precompute Large Zone Strategy from Benchmark Findings

Date: 2026-03-09  
Status: Accepted

## Context

We need a reliable precompute strategy for Lausanne over multi-day periods.
Two technical risks were explicitly identified:

- performance collapse when computing a large bbox in one request
- geometric drift (parallax) when reusing a horizon mask centered far from the evaluated point

A dedicated benchmark was implemented and run to measure these effects with real data.

Benchmark artifacts:

- script: `scripts/benchmark/precompute-lausanne-benchmark.ts`
- output: `docs/progress/benchmarks/precompute-lausanne-2026-03-08-d1-g250.json`
- script: `scripts/benchmark/nyon-parallax-impact.ts`
- output: `docs/progress/benchmarks/nyon-parallax-impact-20260308-1700.json`

## Benchmark protocol

Run command:

```bash
pnpm --dir mappy-hour run benchmark:precompute:lausanne -- \
  --start-date=2026-03-08 \
  --days=1 \
  --local-time=17:00 \
  --grid-step-meters=250 \
  --tile-cols=4 \
  --tile-rows=4
```

Compared scenarios:

1. Single large Lausanne bbox request
2. Same Lausanne bbox split in 4x4 tiles (16 requests)
3. Nyon point evaluated with:
   - horizon mask centered on Lausanne
   - horizon mask centered on Nyon
4. Nyon 100m local area for local-center reference
5. Nyon parallax impact in daily timeline (1-minute sampling)

## Results

Large bbox (single request):

- wall time: `1,198,811.723 ms` (~19m59s)
- outdoor points: `3417`
- throughput: `2.85 points/s`

Tiled bbox (4x4, 16 requests):

- cumulative wall time: `23,302.201 ms` (~23.3s)
- outdoor points: `3630`
- throughput: `155.779 points/s`

Observed ratio:

- tiled wall time / large wall time: `0.019`
- tiled throughput / large throughput: `54.653x`

Important clarification:

- "More performant" here means runtime/throughput only.
- This comparison is already normalized on the same covered surface (single large bbox vs full 4x4 tile cover of that same bbox).
- Additional cold/warm check on the same large bbox (same payload, same process):
  - run-1: `275,556.919 ms`
  - run-2: `14,424.242 ms`
- Therefore the large-vs-tiled gap is real for operations, but the first measured ratio is also influenced by cache warm-up effects.

Parallax check (Nyon point, 2026-03-08 17:00 Europe/Zurich):

- horizon angle with Lausanne-centered mask: `0.917 deg`
- horizon angle with Nyon-centered mask: `3.18 deg`
- delta: `+2.263 deg`
- center distance Lausanne->Nyon: `33,770.602 m`
- ridge distance delta on same azimuth: `32,000 m`

Point-impact metrics (more interpretable than angles):

- equivalent shadow-length delta at 17:00:
  - 5m obstacle: `222.387 m`
  - 10m obstacle: `444.774 m`
  - 20m obstacle: `889.548 m`
- daily terrain-only disagreement (Nyon point):
  - mismatch: `18 minutes/day` (`1.25%`)
  - evening shadow onset: `18:06` (Nyon mask) vs `18:19` (Lausanne mask), delta `13 min`
  - morning release: `07:19` (Nyon mask) vs `07:24` (Lausanne mask), delta `5 min`
- 100m x 100m grid around Nyon (121 points, 10m step):
  - max simultaneous disagreement: `121 points` (`12,100 m2`)
  - total disagreement: `2,178 point-minutes` (`36.3 point-hours`)

1m daily precompute envelope (Lausanne bbox, raw upper bound):

- approx points at 1m: `221.6M`
- raw bitset footprint per day:
  - 96 frames (15 min): `~2.48 GB/day`
  - 288 frames (5 min): `~7.43 GB/day`
  - 1440 frames (1 min): `~37.14 GB/day`

## Decision

Adopt tile-based precompute as the default strategy for Lausanne and larger regions.

Mandatory rules:

1. Do not precompute large regional bbox as one request.
2. Use fixed geographic tiles for precompute jobs.
3. Build/use local horizon masks per tile (or near-tile macro-cell).
4. Do not reuse a horizon mask beyond a strict distance threshold.
5. 1m daily precompute must be tile-based and compressed by design.

## Recommendations

Immediate:

1. Precompute scheduler unit = `(tile_id, date, params_version)`.
2. Persist results per tile/day with explicit model-version metadata.
3. Add retry/resume semantics at job level.

Reliability:

1. Enforce a mask reuse distance guardrail (start with `<= 5 km`).
2. Log horizon-angle deltas on spot checks to detect geometry drift.
3. Keep a validation suite with fixed Lausanne/Nyon control points and point-disagreement metrics.

Performance:

1. Scale horizontally by tile-job parallelism (controlled worker pool).
2. Keep interactive APIs for small bbox; route large requests to precomputed data.
3. Maintain periodic benchmark runs (1, 7, 30 days) to track regressions.
4. Track cold-vs-warm benchmarks separately; never infer capacity from one mixed run.

## Consequences

Positive:

- predictable throughput
- better geometric fidelity across the region
- clear operational model for long-period precompute

Tradeoffs:

- more job orchestration and storage objects
- versioning and cache invalidation become mandatory

## Alternatives considered

1. Single large bbox precompute:
   - rejected (severe throughput degradation in measured run)
2. One global horizon mask for wide region:
   - rejected (measured non-negligible parallax on Nyon case)
