"""
Compose VHM + terrain into canopy-elevation GeoTIFFs.

Reads the VHM (vegetation height) from a remote COG for the full regional bbox,
reads local SwissALTI3D terrain tiles, and writes pre-composed canopy GeoTIFFs
in the same directory as the old SwissSURFACE3D tiles.

Usage: python compose-vhm-canopy.py --region=nyon
       python compose-vhm-canopy.py --region=nyon --tile=2502-1141  (single tile)
"""
import argparse, json, os, sys
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
TERRAIN_ROOT = Path("data/raw/swisstopo/swissalti3d_2m")
OUTPUT_ROOT = Path("data/raw/swisstopo/swisssurface3d_raster")

# Region bboxes in LV95 (pre-computed from WGS84 config)
REGIONS = {
    "nyon":     {"minE": 2500000, "minN": 1131000, "maxE": 2515000, "maxN": 1145000},
    "lausanne": {"minE": 2531000, "minN": 1148000, "maxE": 2545000, "maxN": 1163000},
    "morges":   {"minE": 2524000, "minN": 1149000, "maxE": 2531000, "maxN": 1155000},
    "geneve":   {"minE": 2495000, "minN": 1113000, "maxE": 2508000, "maxN": 1125000},
}


def find_terrain_tile(e_km: int, n_km: int) -> Path | None:
    """Find the SwissALTI3D terrain tile for a 1km grid cell."""
    key = f"{e_km}-{n_km}"
    candidates = sorted(TERRAIN_ROOT.glob(f"swissalti3d_*_{key}"))
    if not candidates:
        return None
    tif_dir = candidates[-1]  # latest year
    tifs = list(tif_dir.glob("*.tif"))
    return tifs[0] if tifs else None


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
    # Replace nodata with 0
    mask = np.isnan(vhm_data) | (vhm_data == nodata) if nodata else np.isnan(vhm_data)
    vhm_data[mask] = 0.0
    vhm_data = np.maximum(vhm_data, 0.0)
    print(f"[vhm:{args.region}] VHM loaded: {vhm_data.shape}, max height: {vhm_data.max():.1f}m")

    vhm_h, vhm_w = vhm_data.shape
    region_w = bbox["maxE"] - bbox["minE"]
    region_h = bbox["maxN"] - bbox["minN"]

    composed = 0
    skipped = 0
    no_terrain = 0

    for e in range(bbox["minE"], bbox["maxE"], TILE_SIZE):
        for n in range(bbox["minN"], bbox["maxN"], TILE_SIZE):
            e_km = e // TILE_SIZE
            n_km = n // TILE_SIZE
            tile_key = f"{e_km}-{n_km}"

            out_dir = OUTPUT_ROOT / f"swisssurface3d-raster_vhm_{tile_key}"
            out_tif = out_dir / f"swisssurface3d-raster_vhm_{tile_key}.tif"

            if out_tif.exists() and not args.overwrite:
                skipped += 1
                sys.stdout.write("s")
                sys.stdout.flush()
                continue

            # Find terrain tile
            terrain_path = find_terrain_tile(e_km, n_km)
            if not terrain_path:
                no_terrain += 1
                sys.stdout.write("x")
                sys.stdout.flush()
                continue

            # Read terrain
            with rasterio.open(terrain_path) as t_src:
                terrain = t_src.read(1)
                t_h, t_w = terrain.shape

            # Slice VHM for this 1km tile
            col0 = round((e - bbox["minE"]) / region_w * vhm_w)
            row0 = round((bbox["maxN"] - n - TILE_SIZE) / region_h * vhm_h)
            col1 = round((e + TILE_SIZE - bbox["minE"]) / region_w * vhm_w)
            row1 = round((bbox["maxN"] - n) / region_h * vhm_h)
            vhm_tile = vhm_data[row0:row1, col0:col1]
            vh, vw = vhm_tile.shape

            # Compose: canopy = terrain + vhm (upsample terrain to VHM resolution)
            canopy = np.zeros((vh, vw), dtype=np.float32)
            for y in range(vh):
                ty = min(int(y * t_h / vh), t_h - 1)
                for x in range(vw):
                    tx = min(int(x * t_w / vw), t_w - 1)
                    canopy[y, x] = terrain[ty, tx] + vhm_tile[y, x]

            # Write GeoTIFF
            out_dir.mkdir(parents=True, exist_ok=True)
            transform = transform_from_bounds(e, n, e + TILE_SIZE, n + TILE_SIZE, vw, vh)
            with rasterio.open(
                out_tif, "w", driver="GTiff",
                width=vw, height=vh, count=1, dtype="float32",
                crs="EPSG:2056", transform=transform, compress="deflate",
            ) as dst:
                dst.write(canopy, 1)

            composed += 1
            sys.stdout.write(".")
            sys.stdout.flush()

    src.close()
    print(f"\n[vhm:{args.region}] Done: {composed} composed, {skipped} existing, {no_terrain} no-terrain")

    # Write manifest
    manifest = {
        "generatedAt": __import__("datetime").datetime.now().isoformat(),
        "source": "VHM NFI 2022 (EnviDat COG) + SwissALTI3D terrain",
        "cogUrl": VHM_COG_URL,
        "region": args.region,
        "composed": composed, "skipped": skipped, "noTerrain": no_terrain,
    }
    manifest_path = OUTPUT_ROOT / f"manifest-{args.region}-vhm.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
