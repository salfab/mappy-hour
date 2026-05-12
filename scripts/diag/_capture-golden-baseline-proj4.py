"""
Capture golden baseline metadata for the 7 reference tiles before proj4
migration to swisstopo Precise (2026-05-05).

Reads atlas (.bin.gz + .idx) AND grid-metadata (.json.gz) on disk and produces
a structured JSON file in golden/atlas/baseline-proj4-migration-2026-05-05/
with per-tile SHA256 + size for both surfaces.

Usage: PYTHONIOENCODING=utf-8 python scripts/diag/_capture-golden-baseline-proj4.py
"""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

GOLDEN_DIR = Path("golden/atlas/baseline-proj4-migration-2026-05-05")
SELECTION_FILE = Path("data/processed/precompute/golden-dedup-terrain-2026-05-04.json")
CACHE_ROOT = Path("data/cache/sunlight")
GRID_META_ROOT = Path("data/cache/tile-grid-metadata")

REGION_MODEL_HASH = {region: None for region in ["lausanne", "morges", "nyon", "geneve", "vevey", "vevey_city", "neuchatel", "la_chaux_de_fonds"]}


def newest_hash_dir(base: Path) -> str | None:
    if not base.exists():
        return None
    candidates = [d for d in base.iterdir() if d.is_dir() and len(d.name) == 16]
    if not candidates:
        return None
    return max(candidates, key=lambda d: d.stat().st_mtime).name


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def file_capture(path: Path) -> dict | None:
    if not path.exists():
        return None
    return {
        "path": str(path).replace("\\", "/"),
        "sha256": sha256_file(path),
        "size": path.stat().st_size,
        "mtime": datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat(),
    }


def main():
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)

    if not SELECTION_FILE.exists():
        print(f"ERROR: selection file missing: {SELECTION_FILE}", file=sys.stderr)
        sys.exit(2)

    with open(SELECTION_FILE, encoding="utf-8") as f:
        selection = json.load(f)

    region_grid_hashes = {}
    for region in REGION_MODEL_HASH:
        REGION_MODEL_HASH[region] = newest_hash_dir(CACHE_ROOT / region)
        region_grid_hashes[region] = newest_hash_dir(GRID_META_ROOT / region)

    captures = []
    found_atlas = 0
    found_grid = 0
    missing = 0

    for tile in selection["tiles"]:
        region = tile["region"]
        tile_id = tile["tileId"]
        label = selection.get("labels", {}).get(tile_id, tile_id)
        atlas_hash = REGION_MODEL_HASH.get(region)
        grid_hash = region_grid_hashes.get(region)

        capture = {
            "region": region,
            "tileId": tile_id,
            "label": label,
            "atlasModelHash": atlas_hash,
            "gridMetadataHash": grid_hash,
            "atlasBin": None,
            "atlasIdx": None,
            "gridMetadata": None,
        }

        if atlas_hash:
            atlas_dir = CACHE_ROOT / region / atlas_hash / "g1" / "atlas" / "r0.75"
            capture["atlasBin"] = file_capture(atlas_dir / f"{tile_id}.atlas.bin.gz")
            capture["atlasIdx"] = file_capture(atlas_dir / f"{tile_id}.atlas.idx")
            if capture["atlasBin"]:
                found_atlas += 1
            else:
                missing += 1

        if grid_hash:
            grid_dir = GRID_META_ROOT / region / grid_hash / "g1"
            capture["gridMetadata"] = file_capture(grid_dir / f"{tile_id}.json.gz")
            if capture["gridMetadata"]:
                found_grid += 1

        captures.append(capture)

    output = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "purpose": "Baseline before proj4 -> swisstopo Precise migration (2026-05-05)",
        "gitTag": "baseline/proj4-migration-2026-05-05",
        "selectionFile": str(SELECTION_FILE).replace("\\", "/"),
        "regionAtlasModelHashes": REGION_MODEL_HASH,
        "regionGridMetadataHashes": region_grid_hashes,
        "summary": {
            "totalTiles": len(captures),
            "atlasesFound": found_atlas,
            "atlasesMissing": missing,
            "gridMetadataFound": found_grid,
        },
        "captures": captures,
    }

    out_file = GOLDEN_DIR / "golden-hashes.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"Wrote {out_file}")
    print(f"Summary: atlas {found_atlas}/{len(captures)}, grid-metadata {found_grid}/{len(captures)}")
    for c in captures:
        atlas_status = "OK" if c["atlasBin"] else "MISS"
        grid_status = "OK" if c["gridMetadata"] else "MISS"
        atlas_sha = c["atlasBin"]["sha256"][:12] if c["atlasBin"] else "-"
        grid_sha = c["gridMetadata"]["sha256"][:12] if c["gridMetadata"] else "-"
        print(f"  atlas[{atlas_status}] grid[{grid_status}] {c['region']:9s} {c['tileId']} ({c['label']}) atlas={atlas_sha} grid={grid_sha}")


if __name__ == "__main__":
    main()
