# MappyHour — Pipeline d'ingest des données

Ce document décrit le pipeline complet pour ajouter ou mettre à jour les données
géospatiales d'une région. À lire avant de lancer un ingest partiel.

## Vue d'ensemble

```
SwissTopo STAC API          EnviDat (VHM)         Copernicus (horizon)
      │                          │                       │
      ▼                          ▼                       ▼
download-buildings.ts    download-vegetation-vhm.ts  (global, déjà téléchargé)
download-terrain.ts
download-vegetation.ts
      │
      ▼
 raw/swisstopo/
   swissbuildings3d_2/       ← DXF zips des bâtiments
   swissalti3d_2m/           ← rasters terrain 2 m
   swisssurface3d_raster/    ← rasters végétation + VHM
      │
      ▼
build-buildings-index.ts --region=X   ← ÉTAPE SOUVENT OUBLIÉE
      │
      ▼
processed/buildings/
   {region}-buildings-index.json      ← index footprints bâtiments (GPU raster)
   gpu-mesh-*.bin/json                ← triangles 3D (générés à la volée par Vulkan)
      │
      ▼
precompute-all-regions-sunlight.ts
   preflight grid-metadata  ← zenith shadow indoor/outdoor (gpu-raster)
   Vulkan precompute         ← atlas .bin.zst par tuile × date
      │
      ▼
cache/sunlight/{region}/{modelVersionHash}/...
```

---

## Étapes par région

### 1. Bâtiments SwissBuildings3D (OBLIGATOIRE)

```bash
npx tsx scripts/ingest/download-buildings.ts --region=<région>
```

Télécharge les DXF zip dans `data/raw/swisstopo/swissbuildings3d_2/`.

**Puis, impérativement, rebuild l'index bâtiments :**

```bash
npx tsx scripts/preprocess/build-buildings-index.ts --region=<région>
```

Génère `processed/buildings/{région}-buildings-index.json` (footprints 2D + grille spatiale).
Sans cet index, la grid-metadata preflight ne détecte aucun point indoor et le preflight
échouera avec une erreur rouge `totalIndoor=0`.

> **Historique :** cette étape a été oubliée lors de l'ajout des régions
> neuchatel/bern/zurich/thun/la_chaux_de_fonds en mai 2026, provoquant des atlas
> sans ombres de bâtiment pour ces 5 régions.

Pour la grappe Lausanne (lausanne, morges, nyon, vevey, vevey_city, geneve), l'index
`buildings-index.json` est partagé. Utiliser `--region=lausanne-cluster` pour le rebuilder :

```bash
npx tsx scripts/preprocess/build-buildings-index.ts --region=lausanne-cluster
```

### 2. Terrain SwissALTI3D

```bash
npx tsx scripts/ingest/download-terrain.ts --region=<région>
```

Télécharge les rasters ALTImétrie 2m dans `data/raw/swisstopo/swissalti3d_2m/`.
Idempotent (saute les tuiles déjà présentes).

### 3. Végétation swissSURFACE3D

```bash
npx tsx scripts/ingest/download-vegetation.ts --region=<région>
```

Télécharge les rasters de surface dans `data/raw/swisstopo/swisssurface3d_raster/`.

### 4. VHM (Vegetationshöhenmodell)

```bash
npx tsx scripts/ingest/download-vegetation-vhm.ts --region=<région>
```

Requiert Python 3 + rasterio. Orchestre deux passes :
- `download-vhm.py` → tuiles brutes `vhm_raw_*`
- `compose-vhm-canopy.py` → tuiles composées `vhm_*` (hauteur canopée absolue)

Les deux sont nécessaires pour le précompute.

### 5. Horizon Copernicus (une fois pour tout le projet)

Le DEM Copernicus couvre toute la Suisse (N45–N47, E004–E008). Il a déjà été téléchargé
pour l'ensemble du projet. Pas d'action requise pour les nouvelles régions.

---

## Régions et grappes

| Région | Grappe bâtiments | Remarque |
|---|---|---|
| lausanne | `buildings-index.json` | grappe partagée Lausanne |
| morges | `buildings-index.json` | |
| nyon | `buildings-index.json` | |
| vevey | `buildings-index.json` | |
| vevey_city | `buildings-index.json` | sous-zone de vevey |
| geneve | `buildings-index.json` | |
| neuchatel | `neuchatel-buildings-index.json` | indépendant |
| la_chaux_de_fonds | `la_chaux_de_fonds-buildings-index.json` | indépendant |
| bern | `bern-buildings-index.json` | indépendant |
| zurich | `zurich-buildings-index.json` | indépendant |
| thun | `thun-buildings-index.json` | indépendant |

---

## Checklist pour une nouvelle région

```
[ ] download-buildings.ts --region=<région>
[ ] build-buildings-index.ts --region=<région>    ← souvent oublié !
[ ] download-terrain.ts --region=<région>
[ ] download-vegetation.ts --region=<région>
[ ] download-vegetation-vhm.ts --region=<région>
[ ] Vérifier que la config src/lib/config/<région>.ts existe (localBbox, etc.)
[ ] Ajouter la région dans REGION_PRIORITY de precompute-all-regions-sunlight.ts
[ ] Lancer le precompute : precompute-all-regions-sunlight.ts --region=<région> ...
[ ] Vérifier le preflight : aucune ligne "0 indoor" en rouge
[ ] check-atlas-vs-cpu-multi.ts : mism% ≤ 2%
```

---

## Supprimer et recalculer une région

Si les atlas d'une région sont invalides (ex : calculés sans bâtiments) :

```powershell
# 1. Supprimer la grid-metadata (preflight)
Remove-Item -Recurse -Force "C:\sources\mappy-data\cache\tile-grid-metadata\<région>"

# 2. Supprimer les atlas
Remove-Item -Recurse -Force "C:\sources\mappy-data\cache\sunlight\<région>"

# 3. Relancer le precompute complet
npx tsx scripts/precompute/precompute-all-regions-sunlight.ts `
  --buildings-shadow-mode=rust-wgpu-vulkan `
  --tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json `
  --start-date=2026-05-01 --days=2000 `
  --region=<région>
```

---

## Diagnostics utiles

| Symptôme | Commande |
|---|---|
| 0 indoor au preflight | `npx tsx scripts/precompute/precompute-tile-grid-metadata.ts --region=X --tile-selection-file=...` |
| Atlas sans ombres bâtiment | `npx tsx scripts/diag/check-atlas-vs-cpu-multi.ts` (mism% > 2%) |
| Hash de modèle inconnu | `src/lib/precompute/model-version.ts` → `getSunlightModelVersion(region)` |
| Manifests buildings manquants | `data/raw/swisstopo/swissbuildings3d_2/manifest-{région}.json` |

---

## Note sur les caches et les hashes

Le hash du modèle (`modelVersionHash`) dépend du contenu de l'index bâtiments.
Si l'index change (rebuild après ajout de bâtiments), le hash change pour cette région
uniquement — les autres régions ne sont pas affectées grâce aux index per-région.

L'ancien format (un seul `lausanne-buildings-index.json` global) était problématique :
ajouter Bern invalidait le cache de Lausanne. Le format actuel (per-région) y remédie.
