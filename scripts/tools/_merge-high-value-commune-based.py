"""
Rebuild data/processed/precompute/high-value-tile-selection.top-priority.json
from:
  - the places-density top-priority tiles (already in the current file, filter
    on presence of `score` field)
  - commune-lausanne-west-tiles.json  (Lausanne + west communes)
  - commune-lausanne-east-tiles.json  (Pully → Saint-Saphorin Lavaux)
  - commune-vevey-land-tiles.json     (Vevey commune, lake tiles filtered out)
  - commune-neuchatel-land-tiles.json (Neuchâtel commune, Lac de Neuchâtel filtered out)
  - commune-la-chaux-de-fonds-land-tiles.json (La Chaux-de-Fonds commune, urban centre only)
  - commune-geneve-all-tiles.json     (Geneve + Carouge + Pregny + Le Grand-Saconnex)

Replaces the previous bbox-based greater-lausanne + geneve-carouge additions
(which included lake tiles and square boundaries).

Each tile gets a `group` field so the HTML can color-group them:
  - "top-priority"    : original places-density-scored tiles
  - "lausanne-west"   : EPFL, Renens, central Lausanne
  - "lausanne-east"   : Pully, Lutry, Lavaux (region=lausanne|vevey selon easting)
  - "vevey-city"      : Vevey commune (region=vevey_city, lake tiles filtered out)
  - "neuchatel-city"  : Neuchâtel commune (region=neuchatel, lake tiles filtered out)
  - "la-chaux-de-fonds-city" : La Chaux-de-Fonds commune (region=la_chaux_de_fonds, urban centre only)
  - "bern-city"       : Bern commune (region=bern, urban centre only)
  - "zurich-city"     : Zurich commune (region=zurich, urban centre, Zürichsee filtered out)
  - "thun-city"       : Thun commune (region=thun, urban centre, Thunersee filtered out)
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

    # 3b) Vevey commune (lake filtered out) — region=vevey_city, group=vevey-city
    # Distinct region from "vevey" (which historically covers Lavaux + Vevey).
    # Cf. memory project_region_regrouping_todo : un re-groupement scientifique
    # est prévu pour rationaliser ces régions.
    vevey_ids = load_tile_ids(ROOT / "commune-vevey-land-tiles.json")
    vevey_added = 0
    for tid in vevey_ids:
        k = ("vevey_city", tid)
        if k in existing: continue
        existing.add(k)
        additions.append({"region": "vevey_city", "tileId": tid, "group": "vevey-city"})
        vevey_added += 1
    print(f"Vevey-city commune (land only): {len(vevey_ids)} commune tiles → {vevey_added} new")

    # 3c) Neuchâtel commune (Lac de Neuchâtel filtered out) — region=neuchatel, group=neuchatel-city
    neuch_ids = load_tile_ids(ROOT / "commune-neuchatel-land-tiles.json")
    neuch_added = 0
    for tid in neuch_ids:
        k = ("neuchatel", tid)
        if k in existing: continue
        existing.add(k)
        additions.append({"region": "neuchatel", "tileId": tid, "group": "neuchatel-city"})
        neuch_added += 1
    print(f"Neuchâtel commune (land only): {len(neuch_ids)} commune tiles → {neuch_added} new")

    # 3d) La Chaux-de-Fonds commune (urban centre only, Jura forest excluded by bbox clip)
    # — region=la_chaux_de_fonds, group=la-chaux-de-fonds-city
    cdf_ids = load_tile_ids(ROOT / "commune-la-chaux-de-fonds-land-tiles.json")
    cdf_added = 0
    for tid in cdf_ids:
        k = ("la_chaux_de_fonds", tid)
        if k in existing: continue
        existing.add(k)
        additions.append({"region": "la_chaux_de_fonds", "tileId": tid, "group": "la-chaux-de-fonds-city"})
        cdf_added += 1
    print(f"La Chaux-de-Fonds commune (urban centre): {len(cdf_ids)} commune tiles → {cdf_added} new")

    # 3e) Bern commune (urban centre only) — region=bern, group=bern-city
    bern_ids = load_tile_ids(ROOT / "commune-bern-land-tiles.json")
    bern_added = 0
    for tid in bern_ids:
        k = ("bern", tid)
        if k in existing: continue
        existing.add(k)
        additions.append({"region": "bern", "tileId": tid, "group": "bern-city"})
        bern_added += 1
    print(f"Bern commune (urban centre): {len(bern_ids)} commune tiles → {bern_added} new")

    # 3f) Zurich commune (urban centre, Zürichsee filtered out) — region=zurich, group=zurich-city
    zurich_ids = load_tile_ids(ROOT / "commune-zurich-land-tiles.json")
    zurich_added = 0
    for tid in zurich_ids:
        k = ("zurich", tid)
        if k in existing: continue
        existing.add(k)
        additions.append({"region": "zurich", "tileId": tid, "group": "zurich-city"})
        zurich_added += 1
    print(f"Zurich commune (urban centre, lake filtered): {len(zurich_ids)} commune tiles → {zurich_added} new")

    # 3g) Thun commune (urban centre, Thunersee filtered out) — region=thun, group=thun-city
    thun_ids = load_tile_ids(ROOT / "commune-thun-land-tiles.json")
    thun_added = 0
    for tid in thun_ids:
        k = ("thun", tid)
        if k in existing: continue
        existing.add(k)
        additions.append({"region": "thun", "tileId": tid, "group": "thun-city"})
        thun_added += 1
    print(f"Thun commune (urban centre, lake filtered): {len(thun_ids)} commune tiles → {thun_added} new")

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
        "Lausanne-east (Pully → Saint-Saphorin Lavaux), "
        "Vevey-city (commune de Vevey, lake tiles filtered out by Léman polygon), "
        "Neuchâtel-city (commune de Neuchâtel, Lac de Neuchâtel filtered out), "
        "La-Chaux-de-Fonds-city (commune restreinte au centre urbain via bbox, hors forêts du Jura), and "
        "Geneva-all (Genève, Carouge, Pregny-Chambésy, Le Grand-Saconnex). "
        "Lake tiles excluded by commune boundary clipping (and explicit Léman / Lac de Neuchâtel filters). "
        "La Chaux-de-Fonds restricted to LA_CHAUX_DE_FONDS_LOCAL_BBOX [6.79, 47.085, 6.86, 47.12]."
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
