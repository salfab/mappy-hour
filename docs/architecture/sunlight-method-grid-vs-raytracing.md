# Sunlight Method - Grid Vs Shadow Contours

Date: 2026-03-08

Related ADR:
- `docs/architecture/adr-0001-daily-timeline-streaming.md`

## Context

For the map, there are two main families of methods:

1. Point grid method:
   - generate a grid of sample points
   - for each point, evaluate `sunny / shadowed` at a time (or across a day)
2. Shadow contour method:
   - compute projected shadow polygons (terrain + buildings)
   - render polygon contours directly on the map

This project currently uses method 1 (point grid), with:
- terrain horizon mask (transborder DEM)
- building shadow test (footprint prism model)

## Why we chose the point grid method

The point grid was selected first because it is the fastest path to a robust MVP:

- Stable API contract:
  - easy to return JSON points for frontend rendering
  - same model can return instant or daily windows
- Incremental complexity:
  - we can improve physical accuracy (terrain/buildings) without changing client format
- Performance control:
  - compute cost scales with `number_of_points`
  - easy to cap by `maxPoints`
- Product alignment:
  - directly supports questions like "is this place sunny now?" and "sunny from hh:mm to hh:mm?"

## Known limitation of the point grid

If a grid sample falls inside a building footprint, that sample is expected to be shadowed/blocked.
This is physically coherent for an outdoor map, but visually noisy:

- random cells can look "red" only because the sample hit indoor space
- users can read this as "the street is in shadow" when the nearby outdoor area is sunny

## How to avoid false visual blocking from indoor samples

### Recommended strategy (next step)

Add an explicit "indoor mask" phase before sunlight classification:

1. test each sample point against building footprints
2. if inside a footprint:
   - mark `surfaceType = indoor`
   - do not classify as regular outdoor `sunny/shadow`
3. in UI:
   - hide indoor points, or render with neutral color (grey hatch)

This separates two concepts:
- "blocked outdoor point"
- "indoor sample (not relevant for outdoor sunshine map)"

### Current implementation status

Implemented on `2026-03-08` for `POST /api/sunlight/area`:

- each grid point is tested against building footprints first
- indoor points are excluded before solar evaluation
- response stats now expose `indoorPointsExcluded`
- map rendering now uses merged contours (union of grid cells), not per-point markers
- sun/shadow contours are clipped by building polygons to avoid visible overlap artifacts

Result:
- no more "false red" points caused by indoor samples
- less compute work because excluded indoor points skip sunlight evaluation
- cleaner UX with continuous polygons for sunlight/shadow layers

### Alternative strategies

1. Cell representative point:
   - evaluate center + 4 subpoints per cell
   - classify by majority outdoor subpoints
2. Snap-to-outdoor:
   - if a point is indoor, move it to nearest outdoor location within search radius
3. Polygon output for display:
   - keep grid for computation
   - convert grid result to smoothed iso-contours for rendering

## Recommended implementation plan

1. Add `insideBuilding` flag in `/api/sunlight/area` point payload.
2. Add optional API mode:
   - `indoorPolicy = "exclude" | "neutral" | "blocked"`
   - default: `exclude` for map use.
3. Update frontend legend and style:
   - sunny (yellow), shadowed (red/blue), indoor (neutral or hidden).

This keeps current architecture, improves UX immediately, and does not require full polygon raytracing output.
