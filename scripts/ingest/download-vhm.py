"""
Download raw VHM (Vegetationshöhenmodell NFI) tiles for a region.

Reads the VHM (vegetation height model) from the remote EnviDat COG and
writes 1 km × 1 km GeoTIFF tiles containing **raw vegetation heights**
(relative to the ground, clamped ≥0, nodata replaced by 0).

Output layout (same parent dir as the legacy DSM so vegetation-shadow.ts
picks them up via the unified vhm_raw/vhm_composed/dsm priority):
  data/raw/swisstopo/swisssurface3d_raster/
    swisssurface3d-raster_vhm_raw_<e>-<n>/
      swisssurface3d-raster_vhm_raw_<e>-<n>.tif

These raw tiles feed Option B (ADR-0016 update 2026-04-23): the Vulkan
shader composes `canopy_abs = terrain + max(0, vhm)` at sample time when
MAPPY_VHM_SHADER_COMPOSE=1.

For the legacy CPU path (and the default Option A), pair this with
`compose-vhm-canopy.py` which reads these raw tiles + SwissALTI3D terrain
and writes pre-composed canopy GeoTIFFs.

Usage: python download-vhm.py --region=nyon
       python download-vhm.py --region=nyon --tile=2502-1141  (single tile)
       python download-vhm.py --region=nyon --overwrite
"""
import argparse, json, sys
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from rasterio.transform import from_bounds as transform_from_bounds
from pathlib import Path

VHM_COG_URL = (
    "https://os.zhdk.cloud.switch.ch/envicloud/doi/1000001.1/2022/"
    "landesforstinventar-vegetationshoehenmodell_stereo_2022_2056.tif"
)

TILE_SIZE = 1000  # meters
OUTPUT_ROOT = Path("data/raw/swisstopo/swisssurface3d_raster")

# Region bboxes in LV95 (pre-computed from WGS84 config)
REGIONS = {
    "nyon":     {"minE": 2500000, "minN": 1131000, "maxE": 2515000, "maxN": 1145000},
    "lausanne": {"minE": 2531000, "minN": 1148000, "maxE": 2545000, "maxN": 1163000},
    "morges":   {"minE": 2524000, "minN": 1149000, "maxE": 2531000, "maxN": 1155000},
    "geneve":   {"minE": 2495000, "minN": 1113000, "maxE": 2508000, "maxN": 1125000},
    # Extended westward (2548→2545) for Lavaux gap: Villette, Cully,
    # Grandvaux, Rivaz, Saint-Saphorin. Extended north (1149→1150) for
    # upper Grandvaux slopes. Matches VEVEY_LOCAL_BBOX.
    "vevey":    {"minE": 2545000, "minN": 1141000, "maxE": 2558000, "maxN": 1150000},
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", required=True)
    parser.add_argument("--tile", help="Single tile key e.g. 2502-1141")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    bbox = REGIONS.get(args.region)
    if not bbox:
        print(f"Unknown region: {args.region}. Available: {list(REGIONS.keys())}")
        sys.exit(1)

    # If single tile requested, narrow the bbox
    if args.tile:
        parts = args.tile.split("-")
        te, tn = int(parts[0]) * TILE_SIZE, int(parts[1]) * TILE_SIZE
        bbox = {"minE": te, "minN": tn, "maxE": te + TILE_SIZE, "maxN": tn + TILE_SIZE}

    print(f"[vhm:{args.region}] Opening remote COG...")
    src = rasterio.open(VHM_COG_URL)
    print(f"[vhm:{args.region}] COG opened: {src.width}x{src.height}")

    # Read the full regional window in one HTTP range request
    print(f"[vhm:{args.region}] Reading VHM for bbox E{bbox['minE']}-{bbox['maxE']} N{bbox['minN']}-{bbox['maxN']}...")
    window = from_bounds(bbox["minE"], bbox["minN"], bbox["maxE"], bbox["maxN"], src.transform)
    vhm_data = src.read(1, window=window)
    nodata = src.nodata
    # Replace nodata with 0 and clamp ≥0 (LiDAR can produce small negatives)
    mask = np.isnan(vhm_data) | (vhm_data == nodata) if nodata else np.isnan(vhm_data)
    vhm_data[mask] = 0.0
    vhm_data = np.maximum(vhm_data, 0.0)
    print(f"[vhm:{args.region}] VHM loaded: {vhm_data.shape}, max height: {vhm_data.max():.1f}m")

    vhm_h, vhm_w = vhm_data.shape
    region_w = bbox["maxE"] - bbox["minE"]
    region_h = bbox["maxN"] - bbox["minN"]

    written = 0
    skipped = 0

    for e in range(bbox["minE"], bbox["maxE"], TILE_SIZE):
        for n in range(bbox["minN"], bbox["maxN"], TILE_SIZE):
            e_km = e // TILE_SIZE
            n_km = n // TILE_SIZE
            tile_key = f"{e_km}-{n_km}"

            raw_dir = OUTPUT_ROOT / f"swisssurface3d-raster_vhm_raw_{tile_key}"
            raw_tif = raw_dir / f"swisssurface3d-raster_vhm_raw_{tile_key}.tif"

            if not args.overwrite and raw_tif.exists():
                skipped += 1
                sys.stdout.write("s")
                sys.stdout.flush()
                continue

            # Slice VHM for this 1km tile
            col0 = round((e - bbox["minE"]) / region_w * vhm_w)
            row0 = round((bbox["maxN"] - n - TILE_SIZE) / region_h * vhm_h)
            col1 = round((e + TILE_SIZE - bbox["minE"]) / region_w * vhm_w)
            row1 = round((bbox["maxN"] - n) / region_h * vhm_h)
            vhm_tile = vhm_data[row0:row1, col0:col1]
            vh, vw = vhm_tile.shape
            transform = transform_from_bounds(e, n, e + TILE_SIZE, n + TILE_SIZE, vw, vh)

            raw_dir.mkdir(parents=True, exist_ok=True)
            with rasterio.open(
                raw_tif, "w", driver="GTiff",
                width=vw, height=vh, count=1, dtype="float32",
                crs="EPSG:2056", transform=transform, compress="deflate",
            ) as dst:
                dst.write(vhm_tile.astype(np.float32), 1)

            written += 1
            sys.stdout.write(".")
            sys.stdout.flush()

    src.close()
    print(f"\n[vhm:{args.region}] Done: {written} downloaded, {skipped} existing")

    # Write manifest
    manifest = {
        "generatedAt": __import__("datetime").datetime.now().isoformat(),
        "source": "VHM NFI 2022 (EnviDat COG) — raw heights (relative to ground)",
        "cogUrl": VHM_COG_URL,
        "region": args.region,
        "written": written, "skipped": skipped,
    }
    manifest_path = OUTPUT_ROOT / f"manifest-{args.region}-vhm-raw.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
