# ADR-0016 - Source végétation : VHM NFI au lieu de SwissSURFACE3D DSM

**Date** : 2026-04-23
**Statut** : Accepté
**Références** : commit `ad72538` (prefer VHM over DSM), `scripts/ingest/compose-vhm-canopy.py`, `scripts/ingest/download-vegetation-vhm.ts`, `src/lib/sun/vegetation-shadow.ts`, shortcut-registry 2b.14

## Contexte

MappyHour évalue les ombres de végétation par un ray-march sur un raster d'altitude de surface. Jusqu'à ce changement, la source utilisée était **SwissSURFACE3D** (Digital Surface Model — DSM) : un raster qui donne l'altitude absolue du **sommet de tout ce qui dépasse** du sol — **arbres et bâtiments mélangés**.

Conséquences de ce mélange :

- **Double-comptage** : un point dans l'ombre d'un immeuble voit cet immeuble dans le DSM → flag `vegetationBlocked=true`, alors que c'est `buildingsBlocked=true` qui devrait être seul.
- **Sémantique cassée dans la viz** : le bouton "ignorer végétation" masque aussi les ombres de bâtiments présentes dans le DSM, au lieu de révéler les ombres pures d'arbres.
- **Attribution impossible** : impossible de répondre "combien d'heures le point est à l'ombre spécifiquement à cause d'arbres" vs "à cause d'immeubles".

Le produit **Vegetationshöhenmodell NFI (VHM)** de l'Inventaire Forestier National / WSL fournit exactement ce qu'il faut : un raster de **hauteur de canopée relative au sol**, **bâtiments masqués**, ~98% de couverture CH, licence CC-BY, format GeoTIFF (aussi une variante LiDAR COG). Publié en annuel sur EnviDat.

## Décision

**Remplacer la source végétation du DSM SwissSURFACE3D par le VHM NFI**, mais en pré-composant à l'ingestion au lieu de modifier le shader.

### Stratégie : pré-composition `canopy_abs = terrain + max(0, vhm)`

Le ray-march existant (CPU dans `vegetation-shadow.ts`, GPU dans les shaders WGSL Vulkan/gpu-raster) compare des **altitudes absolues**. Le VHM donne une **hauteur relative** — incompatible tel quel.

Deux options :

- **A. Pré-composition** : à l'ingestion, produire un nouveau raster `canopy_abs[pixel] = terrain_elev[pixel] + max(0, vhm[pixel])`, même format GeoTIFF que le DSM. Le shader reste identique. **Retenu.**
- **B. Refacto shader** : passer terrain + VHM comme deux rasters séparés au shader, additionner dans la fonction de sample.

Option A est retenue parce qu'elle :
- **Ne touche pas un seul caractère** du shader WGSL / CPU ray-march / backend Vulkan / GPU raster — le risque de régression est nul
- **Simplifie le stockage GPU** : 1 raster à uploader au lieu de 2
- **Garde les perfs inchangées** : pas de texture sample supplémentaire par step
- **Tradeoff stockage disque** : duplique le terrain dans le canopy raster (~2× disk footprint pour la végétation). Acceptable vu la place (~100 MB par région avec compression).

Alternative "refacto shader" gardée en tête pour une future évolution si on veut économiser le stockage et avoir un VHM mis à jour sans re-composition — mais pas prioritaire aujourd'hui.

**Update 2026-04-23 — Option B implémentée en parallèle (opt-in)** : le shader WGSL compose à la volée `canopy_abs = terrain + max(0, vhm_raw)` quand un nouvel uniforme `vegetation_is_raw: u32` vaut 1. La sélection de la source bascule via `MAPPY_VHM_SHADER_COMPOSE=1` : le loader `swissSurfaceFindTilesForBounds` préfère alors `vhm_raw > vhm_composed > dsm`. Les tuiles raw sont ingérées par le même script `compose-vhm-canopy.py --mode=raw` (210 tuiles Lausanne dans `swisssurface3d-raster_vhm_raw_*`). Validation bit-parité : 333 octets différents sur 7,5 MB (~0,005 %) entre atlas composé-disque et atlas composé-shader sur 2 tuiles Montriond (origine : alignement sous-pixel terrain 2m / VHM 1m). Option A reste la source par défaut (stabilité, compat CPU fallback).

### Implémentation

1. `scripts/ingest/download-vegetation-vhm.ts` : wrapper Node qui orchestre les deux scripts Python (rasterio requis pour le codec LERC que GDAL/Node ne supporte pas). Option `--skip-compose` pour n'ingérer que le raw.
2. `scripts/ingest/download-vhm.py` : lit le VHM via HTTP range sur le COG EnviDat (URL `doi/1000001.1/2022/landesforstinventar-vegetationshoehenmodell_stereo_2022_2056.tif`), clamp ≥0, nodata→0, écrit les tuiles **raw** 1 km × 1 km (heights relatives au sol) en GeoTIFF.
3. `scripts/ingest/compose-vhm-canopy.py` : lit les tuiles raw déjà téléchargées + les tuiles SwissALTI3D locales, écrit les tuiles **composées** `canopy_abs = terrain + max(0, vhm)`.
4. Outputs : `data/raw/swisstopo/swisssurface3d_raster/swisssurface3d-raster_vhm_raw_<e>-<n>/*.tif` (raw, pour option B) et `swisssurface3d-raster_vhm_<e>-<n>/*.tif` (composé, pour option A + CPU) — **même arborescence** que le DSM SwissSURFACE3D existant.
5. `vegetation-shadow.ts` (`swissSurfaceFindTilesForBounds`) **prefère** les tuiles VHM (composées par défaut, raw si `MAPPY_VHM_SHADER_COMPOSE=1`) lorsqu'une cellule km a plusieurs sources — voir priority map dans le code.

### Couverture produite

| Région | Tiles VHM composées (1 km × 1 km) |
|---|---|
| Lausanne | 198 |
| Nyon | 190 |
| Genève | 132 |
| Morges | 42 |
| **Total** | **562** |

Taille totale sur disque : ~XX GB (à remesurer). Ingestion effectuée le 2026-04-16.

## Validation

### Fonctionnelle

- **Atlas régénéré Vulkan 2026-04-29** sur Lausanne — les masques `vegetationBlocked` utilisent désormais le VHM via la préférence `vhm_` dans `swissSurfaceFindTilesForBounds`.
- **Test visuel front** (2026-04-23) : la zone Montriond/Floréal, typique mix arbres + immeubles, montre maintenant :
  - `buildingsBlocked` : contours nets des immeubles
  - `vegetationBlocked` : contours d'arbres du parc seulement, **plus l'empreinte des toits**
  - Case "ignorer végétation" révèle correctement les ombres d'arbres pures
- **Régen bit-parité** : gpu-raster et Vulkan produisent des atlas identiques sur 291/301 tuiles (les 10 autres ont `bBlk<0.5%` identique dans les deux) → validation croisée du pipeline.

### Couverture VHM

- VHM NFI stereo 2022 couvre ~98% du territoire suisse. Les 12 tuiles Lausanne reportées `noTerrain` dans le manifest correspondent à des cellules de bord où SwissALTI3D n'a pas de donnée → exclues de la composition, la végétation fallback sur le DSM pour ces cellules-là via la logique existante.
- Pour Lausanne (198 tuiles composées / 210 attendues), **94% des tuiles** ont la nouvelle source VHM en place.

## Conséquences

### Positives

- **Sémantique correcte** : ombres d'arbres et d'immeubles sont désormais attribuées au bon canal.
- **UX viz** : le toggle "ignorer végétation" fait enfin ce que son nom dit.
- **Zéro impact perf** : shader inchangé, même format raster.
- **Évolution indépendante** : le VHM est mis à jour annuellement par WSL/NFI ; recomposer est automatique (relancer `download-vegetation-vhm.ts`).

### Compromis

- **Nouveau raster à maintenir** : 562 tuiles supplémentaires à garder synchronisées avec le VHM en amont.
- **Désynchro VHM ↔ SwissALTI3D** : VHM annuel, SwissALTI3D ~triennal. Écart ponctuel (chantiers, coupes) — accepté.
- **Perte d'antennes / cheminées** : ces éléments étaient dans le DSM (car physiquement au-dessus du sol) ; le VHM NFI les exclut car ils ne sont pas de la végétation. Perte marginale d'ombres pour des éléments de < 5m largeur, typiquement invisibles dans nos masques 1m.
- **Dépendance Python + rasterio** : la composition utilise `rasterio` (codec LERC requis pour lire le COG EnviDat, pas supporté par la lib `geotiff` JS ni par GDAL Node). Env var `MAPPY_VHM_PYTHON` pour surcharger.

### Rollback

Si un problème survient, renommer les répertoires `swisssurface3d-raster_vhm_*` (ex. → `_disabled_vhm_*`) fait que `swissSurfaceFindTilesForBounds` retombe automatiquement sur les tuiles DSM originales. Aucune modification de code nécessaire.

## Vérification

- [x] 562 tuiles VHM composées sur 4 régions (manifests `manifest-{region}-vhm.json`)
- [x] Atlas régen Vulkan 2026-04-29 utilise les tuiles VHM (log `[vegetation-shadow] using VHM tile ...`)
- [x] Bit-parité Vulkan ↔ gpu-raster après régen (291/301 tuiles identiques, 10 restantes identiques aussi)
- [x] Validation visuelle Montriond/Floréal/Royal Savoy (front 2026-04-23)
- [ ] Bench quantitatif : comparer `vBlk%` avant/après sur un échantillon de tuiles urbaines vs forestières — décalage attendu uniquement en zones urbaines
- [ ] Si extension à une nouvelle région : vérifier la couverture VHM via `manifest-<region>-vhm.json` et accepter/refuser selon `noTerrain` ratio

## Références

- Commit `ad72538` — ajout de la préférence VHM-over-DSM dans `vegetation-shadow.ts`
- Scripts : `scripts/ingest/download-vegetation-vhm.ts`, `scripts/ingest/compose-vhm-canopy.py`
- Source data : WSL/NFI "Vegetation Height Model NFI" (DOI 10.16904/1000001.1)
- Manifests : `data/raw/swisstopo/swisssurface3d_raster/manifest-{region}-vhm.json`
- Shortcut registry : entry 2b.14
- Layout / sémantique du répertoire mixte : [docs/data/vegetation-surface-rasters.md](../data/vegetation-surface-rasters.md)
