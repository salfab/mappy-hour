"""
Compose pre-computed canopy GeoTIFFs from raw VHM + SwissALTI3D terrain.

Reads raw VHM tiles produced by `download-vhm.py` (in
`swisssurface3d-raster_vhm_raw_<e>-<n>/...tif`) and the local SwissALTI3D
terrain tiles, then writes `canopy_abs = terrain + max(0, vhm)` tiles to
`swisssurface3d-raster_vhm_<e>-<n>/...tif`.

These composed tiles are consumed by:
  - the CPU vegetation ray-march (`vegetation-shadow.ts`) which compares
    absolute altitudes — raw VHM would break it (see ADR-0016);
  - the Vulkan GPU backend in its default mode (Option A, ADR-0016).

When MAPPY_VHM_SHADER_COMPOSE=1 is set, the GPU backend switches to
Option B: it reads the raw tiles directly and composes at sample time,
making this pre-composition only useful for the CPU path.

Requires the raw tiles to exist on disk — run `download-vhm.py --region=...`
first. Missing raw or terrain tiles are skipped and reported.

Usage: python compose-vhm-canopy.py --region=nyon
       python compose-vhm-canopy.py --region=nyon --tile=2502-1141
       python compose-vhm-canopy.py --region=nyon --overwrite
"""
import argparse, json, sys
import numpy as np
import rasterio
from rasterio.transform import from_bounds as transform_from_bounds
from pathlib import Path

TILE_SIZE = 1000  # meters
TERRAIN_ROOT = Path("data/raw/swisstopo/swissalti3d_2m")
OUTPUT_ROOT = Path("data/raw/swisstopo/swisssurface3d_raster")

# Region bboxes in LV95 (used to enumerate the km grid)
REGIONS = {
    "nyon":     {"minE": 2500000, "minN": 1131000, "maxE": 2515000, "maxN": 1145000},
    "lausanne": {"minE": 2531000, "minN": 1148000, "maxE": 2545000, "maxN": 1163000},
    "morges":   {"minE": 2524000, "minN": 1149000, "maxE": 2531000, "maxN": 1155000},
    "geneve":   {"minE": 2495000, "minN": 1113000, "maxE": 2508000, "maxN": 1125000},
    # Lavaux + Vevey extended (Pully → Saint-Saphorin + Vevey).
    # Widened 2026-05-11 to match VEVEY_LOCAL_BBOX [6.715, 46.468, 6.795, 46.541]
    # after the "180 TILE(S) SILENTLY DROPPED" warning revealed 180/268 selection
    # tiles were north or west of the previous bbox. New northern strip
    # (1150000→1154500) covers the upper Lavaux foothills.
    # NB : bboxes alignées sur TILE_SIZE=1000m (cf. download-vhm.py).
    "vevey":    {"minE": 2544000, "minN": 1141000, "maxE": 2558000, "maxN": 1155000},
    # Vraie ville de Vevey (commune Vevey + La Tour-de-Peilz + Corseaux),
    # sans Lavaux. Matches VEVEY_CITY_LOCAL_BBOX [6.82, 46.44, 6.89, 46.49].
    "vevey_city": {"minE": 2551000, "minN": 1143000, "maxE": 2557000, "maxN": 1149000},
    # Ville de Neuchâtel (commune OSM minus Lac de Neuchâtel) + Auvernier
    # (rattaché à Milvignes, ~3 km SW). Matches NEUCHATEL_LOCAL_BBOX
    # [6.84, 46.95, 7.00, 47.07]. Auvernier LV95 ≈ E[2555750..2557250]
    # N[1200500..1201750] : on étend vers le SW (minE 2560k→2554k, minN
    # 1202k→1198k) en alignement 1000m.
    "neuchatel": {"minE": 2554000, "minN": 1198000, "maxE": 2566000, "maxN": 1207000},
    # Ville de La Chaux-de-Fonds (centre urbain uniquement, hors forêts du Jura).
    # Matches LA_CHAUX_DE_FONDS_LOCAL_BBOX [6.79, 47.085, 6.86, 47.12].
    "la_chaux_de_fonds": {"minE": 2550000, "minN": 1215000, "maxE": 2557000, "maxN": 1219000},
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

    composed = 0
    skipped = 0
    no_raw = 0
    no_terrain = 0

    for e in range(bbox["minE"], bbox["maxE"], TILE_SIZE):
        for n in range(bbox["minN"], bbox["maxN"], TILE_SIZE):
            e_km = e // TILE_SIZE
            n_km = n // TILE_SIZE
            tile_key = f"{e_km}-{n_km}"

            raw_tif = (
                OUTPUT_ROOT
                / f"swisssurface3d-raster_vhm_raw_{tile_key}"
                / f"swisssurface3d-raster_vhm_raw_{tile_key}.tif"
            )
            composed_dir = OUTPUT_ROOT / f"swisssurface3d-raster_vhm_{tile_key}"
            composed_tif = composed_dir / f"swisssurface3d-raster_vhm_{tile_key}.tif"

            if not args.overwrite and composed_tif.exists():
                skipped += 1
                sys.stdout.write("s")
                sys.stdout.flush()
                continue

            if not raw_tif.exists():
                no_raw += 1
                sys.stdout.write("r")
                sys.stdout.flush()
                continue

            terrain_path = find_terrain_tile(e_km, n_km)
            if not terrain_path:
                no_terrain += 1
                sys.stdout.write("x")
                sys.stdout.flush()
                continue

            # Read raw VHM (already clamped ≥0, nodata→0 on disk)
            with rasterio.open(raw_tif) as vhm_src:
                vhm_tile = vhm_src.read(1)

            # Read terrain, resample via nearest to VHM resolution, compose
            with rasterio.open(terrain_path) as t_src:
                terrain = t_src.read(1)
            t_h, t_w = terrain.shape
            vh, vw = vhm_tile.shape
            canopy = np.zeros((vh, vw), dtype=np.float32)
            for y in range(vh):
                ty = min(int(y * t_h / vh), t_h - 1)
                for x in range(vw):
                    tx = min(int(x * t_w / vw), t_w - 1)
                    canopy[y, x] = terrain[ty, tx] + vhm_tile[y, x]

            transform = transform_from_bounds(e, n, e + TILE_SIZE, n + TILE_SIZE, vw, vh)
            composed_dir.mkdir(parents=True, exist_ok=True)
            with rasterio.open(
                composed_tif, "w", driver="GTiff",
                width=vw, height=vh, count=1, dtype="float32",
                crs="EPSG:2056", transform=transform, compress="deflate",
            ) as dst:
                dst.write(canopy, 1)

            composed += 1
            sys.stdout.write(".")
            sys.stdout.flush()

    print(
        f"\n[vhm:{args.region}] Done: {composed} composed, {skipped} existing, "
        f"{no_raw} no-raw, {no_terrain} no-terrain"
    )

    # Write manifest
    manifest = {
        "generatedAt": __import__("datetime").datetime.now().isoformat(),
        "source": "VHM raw + SwissALTI3D terrain (composed canopy_abs)",
        "region": args.region,
        "composed": composed, "skipped": skipped,
        "noRaw": no_raw, "noTerrain": no_terrain,
    }
    manifest_path = OUTPUT_ROOT / f"manifest-{args.region}-vhm.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
