"""
Capture golden baseline metadata for the 7 dedup-terrain reference tiles.

Reads the current atlas state on disk and produces a structured JSON file in
golden/atlas/baseline-dedup-terrain-2026-05-04/ with per-tile:
- atlas .bin.gz SHA256 + size
- atlas .idx SHA256 + size
- model version hash
- timestamp

Usage: PYTHONIOENCODING=utf-8 python scripts/diag/_capture-golden-baseline.py
"""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

GOLDEN_DIR = Path("golden/atlas/baseline-dedup-terrain-2026-05-04")
SELECTION_FILE = Path("data/processed/precompute/golden-dedup-terrain-2026-05-04.json")
CACHE_ROOT = Path("data/cache/sunlight")

REGION_MODEL_HASH = {
    "lausanne":   None,  # to discover (most recent in cache)
    "morges":     None,
    "nyon":       None,
    "geneve":     None,
    "vevey":      None,
    "vevey_city": None,
    "neuchatel":  None,
    "la_chaux_de_fonds": None,
    "bern":       None,
    "zurich":     None,
    "thun":       None,
}


def newest_hash_dir(region: str) -> str | None:
    """Pick the most recently modified model hash dir under a region."""
    base = CACHE_ROOT / region
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


def find_vevey_hash() -> str | None:
    base = CACHE_ROOT / "vevey"
    if not base.exists():
        return None
    for entry in base.iterdir():
        if entry.is_dir() and len(entry.name) == 16:
            return entry.name
    return None


def main():
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)

    if not SELECTION_FILE.exists():
        print(f"ERROR: selection file missing: {SELECTION_FILE}", file=sys.stderr)
        sys.exit(2)

    with open(SELECTION_FILE, encoding="utf-8") as f:
        selection = json.load(f)

    for region in REGION_MODEL_HASH:
        if REGION_MODEL_HASH[region] is None:
            REGION_MODEL_HASH[region] = newest_hash_dir(region)

    captures = []
    found = 0
    missing = 0

    for tile in selection["tiles"]:
        region = tile["region"]
        tile_id = tile["tileId"]
        label = selection.get("labels", {}).get(tile_id, tile_id)
        model_hash = REGION_MODEL_HASH.get(region)

        capture = {
            "region": region,
            "tileId": tile_id,
            "label": label,
            "modelVersionHash": model_hash,
            "atlasBin": None,
            "atlasIdx": None,
        }

        if model_hash:
            atlas_dir = CACHE_ROOT / region / model_hash / "g1" / "atlas" / "r0.75"
            bin_path = atlas_dir / f"{tile_id}.atlas.bin.gz"
            idx_path = atlas_dir / f"{tile_id}.atlas.idx"

            if bin_path.exists():
                capture["atlasBin"] = {
                    "path": str(bin_path).replace("\\", "/"),
                    "sha256": sha256_file(bin_path),
                    "size": bin_path.stat().st_size,
                    "mtime": datetime.fromtimestamp(bin_path.stat().st_mtime, tz=timezone.utc).isoformat(),
                }
                found += 1
            else:
                missing += 1

            if idx_path.exists():
                capture["atlasIdx"] = {
                    "path": str(idx_path).replace("\\", "/"),
                    "sha256": sha256_file(idx_path),
                    "size": idx_path.stat().st_size,
                    "mtime": datetime.fromtimestamp(idx_path.stat().st_mtime, tz=timezone.utc).isoformat(),
                }

        captures.append(capture)

    output = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "purpose": "Baseline before dedup-terrain refactor (2026-05-04)",
        "selectionFile": str(SELECTION_FILE).replace("\\", "/"),
        "regionModelHashes": REGION_MODEL_HASH,
        "summary": {
            "totalTiles": len(captures),
            "atlasesFound": found,
            "atlasesMissing": missing,
        },
        "captures": captures,
    }

    out_file = GOLDEN_DIR / "atlas-hashes.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"Wrote {out_file}")
    print(f"Summary: {found} atlases hashed, {missing} missing")
    for c in captures:
        present = "OK" if c["atlasBin"] else "MISSING"
        bin_size = c["atlasBin"]["size"] if c["atlasBin"] else 0
        sha_short = c["atlasBin"]["sha256"][:16] if c["atlasBin"] else "-"
        print(f"  [{present}] {c['region']:9s} {c['tileId']} ({c['label']}) {bin_size:>10} bytes sha={sha_short}...")


if __name__ == "__main__":
    main()
