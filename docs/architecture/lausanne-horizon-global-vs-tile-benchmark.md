# Benchmark - Horizon mask global vs per-tile (Lausanne)

Date: 2026-03-14  
Status: exploratory benchmark

## Goal

Check if we can avoid computing a horizon mask per tile and use one global mask for Lausanne.

## Commands used

```bash
pnpm run benchmark:horizon:macro:lausanne -- \
  --date=2026-03-08 \
  --sample-step-minutes=5 \
  --point-grid-step-meters=500 \
  --max-points=220 \
  --macro-cell-sizes=250,500,1000,2000

pnpm run benchmark:horizon:tile-vs-global:lausanne -- \
  --date=2026-03-08 \
  --sample-step-minutes=5 \
  --tile-size-meters=250 \
  --point-step-meters=25
```

Artifacts:

- `docs/progress/benchmarks/lausanne-horizon-macro-tiling-20260308-s5.json`
- `docs/progress/benchmarks/lausanne-horizon-tile-vs-global-20260308-s5.json`

## Key findings

### 1) Lausanne-wide sampled points (220 points)

From `lausanne-horizon-macro-tiling-20260308-s5.json`:

- `global-single-mask` vs local reference:
  - points with mismatch: `77.727%`
  - mismatch point-minutes: `1805`
  - horizon delta abs mean at 17:00: `0.453 deg`
- `macro-2000m`:
  - points with mismatch: `68.636%`
  - mismatch point-minutes: `1800`
- `macro-1000m`:
  - points with mismatch: `59.545%`
  - mismatch point-minutes: `1310`

Conclusion on wide, distant Lausanne points: a single global mask is not equivalent to local masks.

### 2) Four distant Lausanne tiles (dense 25m sampling inside each 250m tile)

From `lausanne-horizon-tile-vs-global-20260308-s5.json`:

- Scenario:
  - 4 clusters (west, east, north, south Lausanne)
  - 121 points per cluster (`484` total)
  - max distance from Lausanne center: `9067.907 m`
- `tile-mask` (1 mask per cluster) vs local reference:
  - points with mismatch: `45.455%`
  - mismatch point-minutes: `1215`
  - horizon delta abs mean at 17:00: `0.016 deg`
  - horizon delta abs max at 17:00: `0.081 deg`
- `global-mask` (single Lausanne center mask) vs local reference:
  - points with mismatch: `61.364%`
  - mismatch point-minutes: `1985`
  - horizon delta abs mean at 17:00: `0.267 deg`
  - horizon delta abs max at 17:00: `0.424 deg`

Conclusion on distant Lausanne tiles: per-tile mask is clearly closer to local reference than one global mask.

## Practical decision

- Keep horizon mask computation local (at least tile-level / macro-tile-level).
- Do not replace tile masks with one global Lausanne mask if shadow timing quality matters.
- If we want more performance, test controlled macro-cells (e.g. 500m-1000m) and accept a measured quality budget.

