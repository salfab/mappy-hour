# Végétation — rasters de surface

Cible : le répertoire `data/raw/swisstopo/swisssurface3d_raster/`.

⚠️ **Le nom de ce répertoire est trompeur.** Pour des raisons historiques, il
contient **deux sources distinctes** de rasters de végétation, avec des
producteurs et des sémantiques différentes. Lire ce document avant d'écrire
du code qui touche ces tuiles.

## Contenu mélangé

| Préfixe du sous-dossier | Producteur | Produit | Contenu sémantique |
|-------------------------|------------|---------|---------------------|
| `swisssurface3d-raster_YYYY_E-N/` | **swisstopo** | SwissSURFACE3D | DSM brut — altitude absolue du sommet de **tout** ce qui dépasse du sol (arbres **+ bâtiments + antennes + ponts**, mélangés) |
| `swisssurface3d-raster_vhm_E-N/` | **WSL / IFN** (pas swisstopo) | VHM-NFI composé avec SwissALTI3D | Altitude absolue de la **canopée uniquement**. Bâtiments exclus. |

Malgré le préfixe `swisssurface3d-raster_vhm_…`, les tuiles `vhm_*` **ne sont
pas du SwissSURFACE3D**. Elles sont produites par un pipeline local
(`scripts/ingest/compose-vhm-canopy.py`) à partir de deux sources distinctes
et pré-composées pour être lues par le shader au même format que le DSM
historique.

## Provenance des tuiles `vhm_*`

1. **VHM-NFI** (Vegetationshöhenmodell de l'Inventaire Forestier National)
   - Producteur : [IFN / NFI](https://www.lfi.ch/), institut scientifique de
     suivi des forêts suisses.
   - Hébergement : [WSL](https://www.wsl.ch/) (Institut fédéral de
     recherches sur la forêt, la neige et le paysage).
   - Portail : [EnviDat](https://www.envidat.ch/) — **pas swisstopo**.
   - DOI : `10.16904/1000001.1` (version stereo aerial 2022, utilisée ici).
   - Licence : CC-BY 4.0.
   - Sémantique : raster de **hauteur relative au sol** de la végétation
     (m au-dessus du terrain, 0 sur les bâtiments, nodata hors couverture).
     ≠ altitude absolue.

2. **SwissALTI3D** (DEM, terrain nu)
   - Producteur : swisstopo.
   - Sémantique : altitude absolue du **sol seul**, résolution 2 m.

3. **Pré-composition locale**
   - Script : `scripts/ingest/compose-vhm-canopy.py`
   - Formule : `canopy_abs[pixel] = terrain[pixel] + max(0, VHM[pixel])`
     - VHM nodata ou nul → canopée = sol nu (pas de végétation qui bloque)
     - Sinon → canopée = altitude absolue du sommet des arbres
   - Output : GeoTIFF au même format / résolution que le DSM swisstopo.
     Le shader de ray-march ne fait **aucune distinction** entre lire un
     ancien DSM et un nouveau canopy composé.

## Pourquoi cette mixité dans un seul répertoire

Choix pragmatique documenté dans **[ADR-0016](../architecture/adr-0016-vhm-vegetation-source.md)** :

- Le ray-march (CPU + WGSL shader) compare des **altitudes absolues** en
  mètres ASL. Le VHM brut étant en hauteur relative, il doit être re-exprimé
  en altitude absolue pour être exploitable sans toucher au shader.
- En pré-composant à l'ingestion, le raster obtenu a exactement le même
  format que l'ancien DSM SwissSURFACE3D → zéro changement shader / code
  pipeline / backend Vulkan.
- Le loader `vegetation-shadow.ts` (`swissSurfaceFindTilesForBounds`)
  **préfère** la tuile `vhm_*` quand les deux existent pour la même km-cell
  (commit `ad72538`). Le DSM legacy sert de fallback pour les zones non
  couvertes par le VHM (~2% de la Suisse, bordures, très haute altitude).

Cette pré-composition évite un refacto shader qui aurait imposé 2 texture
samples par step (perf impact ~5-15 % sur le ray-march végétation d'après
l'analyse ADR-0016). L'option "recomposer à l'ingestion" a été retenue.

## Sémantique produite côté viz

Depuis ce changement :

- Un point à l'ombre d'un immeuble a `buildingsBlocked=true`, pas
  `vegetationBlocked=true` — le VHM exclut les bâtiments.
- Un point à l'ombre d'un arbre a `vegetationBlocked=true`.
- Le bouton "ignorer végétation" dans la viz retire correctement uniquement
  les ombres d'arbres.

Avant (DSM seul), les deux catégories étaient mélangées et le toggle
retirait aussi les ombres des bâtiments présents dans le DSM.

## Si vous devez intervenir ici

- **Ne jamais** supposer que ce répertoire = uniquement swisstopo.
- Le loader utilise l'ordre alphabétique et filtre sur le préfixe `vhm_`
  pour faire gagner le VHM — ne pas renommer les sous-dossiers sans passer
  par `vegetation-shadow.ts`.
- Pour régénérer les tuiles `vhm_*` (par ex. nouvelle version annuelle
  VHM) : `npx tsx scripts/ingest/download-vegetation-vhm.ts --region=<region>`
  (wrapper qui appelle le script Python avec rasterio).
- Les manifests `manifest-<region>-vhm.json` tracent le count de tuiles
  composées + les cellules sans terrain (`noTerrain`).

## Dette technique connue

Le répertoire devrait idéalement être séparé :
- `data/raw/swisstopo/swisssurface3d_raster/` — legacy DSM uniquement
- `data/raw/wsl/vhm_nfi/` — VHM brut téléchargé (producteur WSL)
- `data/raw/derived/vegetation_canopy/` — raster composé (produit dérivé local)

Refacto estimé : ~1h + 1 régénération complète par région. Non fait à date :
le choix pragmatique a été de laisser en place pour minimiser le risque au
moment du chantier VHM (avril 2026).
