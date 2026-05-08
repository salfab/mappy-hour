# Differences between building model (swissBUILDINGS3D) and OpenStreetMap

## Context

The sunlight/shadow overlay on the map sometimes shows building outlines that do not perfectly match the OpenStreetMap base map. This document explains why.

## Data sources

| Aspect | Shadow model | Base map |
|--------|-------------|----------|
| Source | **swissBUILDINGS3D 2.0** (swisstopo) | **OpenStreetMap** (community) |
| Method | Aerial LiDAR + cadastral survey | Manual tracing on satellite imagery |
| Format | 3D DXF polylines (roof + walls) | 2D polygons (footprints at ground level) |
| Update frequency | Official release cycle | Continuous community edits |

## Why the outlines differ

### 1. Different data origin

swissBUILDINGS3D is derived from **official aerial LiDAR** scans by swisstopo. The 3D model captures the full building envelope as seen from above, including roof overhangs, balconies, and canopies that extend beyond the ground-level footprint.

OSM footprints are **manually traced** by volunteers from aerial/satellite imagery. They typically represent the ground-level perimeter of the building, not the roof outline.

### 2. Footprint extraction from 3D model

The building shadow model extracts a 2D footprint from the 3D DXF data by:

1. Collecting all vertices at ground level (within 0.6m of the building's minimum Z coordinate)
2. Removing duplicates and collinear points
3. Simplifying edges shorter than 0.8m

This means the footprint represents the **ground projection of the 3D model**, which may include structural elements not visible in OSM's simpler tracing.

### 3. Convex hull simplification

Complex or problematic footprints are replaced by their **convex hull**:

- Self-intersecting polygons (edge crossings)
- "Spiky" polygons: buildings with >=3 acute angles (<16 degrees) AND area/convex-hull ratio <= 72%

This simplification **removes interior courtyards, U-shapes, and L-shaped indentations**, making the shadow footprint **larger** than the actual building outline. Shadows may be cast into areas that are in reality open courtyards.

### 4. Roof vs ground footprint

swissBUILDINGS3D captures the building as seen from above. For buildings with:
- Roof overhangs
- Cantilevers
- Upper-floor extensions beyond the ground floor

...the extracted footprint will be **wider** than the OSM ground-level trace. This is actually correct for shadow computation (a roof overhang does cast a shadow), but creates a visual mismatch with the OSM map.

## Impact on shadow accuracy

| Factor | Effect on shadows |
|--------|------------------|
| Convex hull | Shadows may be **too large** (courtyards filled in) |
| Roof overhangs | Shadows are **correct** (overhangs cast real shadows) |
| OSM inaccuracy | OSM map may show buildings slightly offset from reality |
| LiDAR precision | Shadow model is typically **more geometrically accurate** than OSM |

## Key files

| File | Role |
|------|------|
| `scripts/ingest/download-lausanne-buildings.ts` | Downloads swissBUILDINGS3D DXF tiles from STAC |
| `scripts/preprocess/build-lausanne-buildings-index.ts` | Extracts footprints from DXF, applies simplification |
| `src/lib/sun/building-footprint.ts` | Footprint normalization, spike detection, convex hull |
| `src/lib/sun/gpu-mesh-loader.ts` | Loads 3D DXF meshes for GPU shadow rendering |
| `src/lib/sun/buildings-shadow.ts` | Runtime building obstacle index + spatial grid |

## Possible improvements

- **Disable convex hull** for L/U-shaped buildings and use the original footprint with self-intersection repair instead
- **Overlay the swissBUILDINGS3D footprints** on the map (blue polygons layer) to visualize the actual model used for shadows
- Use **swissTLM3D** footprints as an alternative source with simpler but more consistent outlines
