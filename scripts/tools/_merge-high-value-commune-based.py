"""
Rebuild data/processed/precompute/high-value-tile-selection.top-priority.json
from:
  - the places-density top-priority tiles (already in the current file, filter
    on presence of `score` field)
  - commune-lausanne-west-tiles.json  (Lausanne + west communes)
  - commune-lausanne-east-tiles.json  (Pully → Saint-Saphorin Lavaux)
  - commune-geneve-all-tiles.json     (Geneve + Carouge + Pregny + Le Grand-Saconnex)

Replaces the previous bbox-based greater-lausanne + geneve-carouge additions
(which included lake tiles and square boundaries).

Each tile gets a `group` field so the HTML can color-group them:
  - "top-priority"    : original places-density-scored tiles
  - "lausanne-west"   : EPFL, Renens, central Lausanne
  - "lausanne-east"   : Pully, Lutry, Lavaux
  - "geneva"          : Genève + Carouge + Pregny-Chambésy + Le Grand-Saconnex

Run: python scripts/tools/_merge-high-value-commune-based.py
"""
import json, datetime
from pathlib import Path

ROOT = Path("data/processed/precompute")
OUT = ROOT / "high-value-tile-selection.top-priority.json"
TILE_SIZE = 250

def tile_east(tile_id):
    return int(tile_id.split("_")[0][1:])

def load_tile_ids(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def main():
    with open(OUT, encoding="utf-8") as f:
        current = json.load(f)

    # 1) Keep only places-density scored tiles (have `score` field)
    kept_scored = [t for t in current["tiles"] if "score" in t]
    for t in kept_scored:
        t.setdefault("group", "top-priority")
    print(f"Kept {len(kept_scored)} places-density-scored tiles (top-priority)")

    existing = {(t["region"], t["tileId"]) for t in kept_scored}
    additions = []

    # 2) West Lausanne — region=lausanne
    west_ids = load_tile_ids(ROOT / "commune-lausanne-west-tiles.json")
    west_added = 0
    for tid in west_ids:
        k = ("lausanne", tid)
        if k in existing: continue
        existing.add(k)
        additions.append({"region": "lausanne", "tileId": tid, "group": "lausanne-west"})
        west_added += 1
    print(f"West Lausanne: {len(west_ids)} commune tiles → {west_added} new")

    # 3) East Lausanne (Lavaux) — region based on easting
    east_ids = load_tile_ids(ROOT / "commune-lausanne-east-tiles.json")
    east_added_lau = east_added_vev = 0
    for tid in east_ids:
        e = tile_east(tid)
        region = "lausanne" if e < 2545000 else "vevey"
        k = (region, tid)
        if k in existing: continue
        existing.add(k)
        additions.append({"region": region, "tileId": tid, "group": "lausanne-east"})
        if region == "lausanne": east_added_lau += 1
        else: east_added_vev += 1
    print(f"East Lausanne (Lavaux): {len(east_ids)} commune tiles → {east_added_lau} lausanne + {east_added_vev} vevey new")

    # 4) Geneva — region=geneve
    geneve_ids = load_tile_ids(ROOT / "commune-geneve-all-tiles.json")
    geneve_added = 0
    for tid in geneve_ids:
        k = ("geneve", tid)
        if k in existing: continue
        existing.add(k)
        additions.append({"region": "geneve", "tileId": tid, "group": "geneva"})
        geneve_added += 1
    print(f"Geneva (4 communes): {len(geneve_ids)} commune tiles → {geneve_added} new")

    # 5) Assemble final
    all_tiles = kept_scored + additions
    all_tiles.sort(key=lambda t: (t["region"], t["tileId"]))

    current["tiles"] = all_tiles
    current["generatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    current["source"] = (
        "high-value places-density scoring (top-priority) + "
        "commune outlines for Lausanne-west (EPFL, Renens, central), "
        "Lausanne-east (Pully → Saint-Saphorin Lavaux), and "
        "Geneva-all (Genève, Carouge, Pregny-Chambésy, Le Grand-Saconnex). "
        "Lake tiles excluded by commune boundary clipping."
    )

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2, ensure_ascii=False)

    counts_by_region = {}
    counts_by_group = {}
    for t in all_tiles:
        counts_by_region[t["region"]] = counts_by_region.get(t["region"], 0) + 1
        g = t.get("group", "?")
        counts_by_group[g] = counts_by_group.get(g, 0) + 1

    print(f"\nTotal: {len(all_tiles)} tiles")
    print("By region:", counts_by_region)
    print("By group :", counts_by_group)
    print(f"Wrote {OUT}")

if __name__ == "__main__":
    main()
