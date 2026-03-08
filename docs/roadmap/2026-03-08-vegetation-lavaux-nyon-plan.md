# Plan - Vegetation + Extension Lavaux -> Nyon (incl. Gingins)

Date: 2026-03-08

## Scope

Objectif produit:
- Ajouter la vegetation au calcul d'ombre (premiere etape)
- Etendre le perimetre de calcul de Lausanne vers Lavaux, Nyon et Gingins

Perimetre geographique cible (V1 propose):
- `bbox = [6.15, 46.30, 6.90, 46.65]`
- Couvre Lavaux (est), Nyon + Gingins (ouest), et les zones intermediaires

## Datasets cibles (STAC)

Sources confirmees via `https://data.geo.admin.ch/api/stac/v0.9`:

1. Relief local:
- `ch.swisstopo.swissalti3d` (DTM, deja utilise)

2. Relief/horizon lointain:
- Copernicus DEM 30m (pipeline existant)

3. Batiments:
- `ch.swisstopo.swissbuildings3d_2` (pipeline existant)

4. Vegetation (nouveau):
- Option A (recommandee V1): `ch.swisstopo.swisssurface3d-raster`
  - DSM raster (inclut batiments + vegetation)
  - Deriver vegetation via `DSM - DTM`, puis exclusion des footprints batiments
- Option B (secondaire): `ch.bafu.landesforstinventar-vegetationshoehenmodell_lidar`
  - produit vegetation dedie, utile en comparaison/validation

## Decision technique pour la premiere etape vegetation

Decision V1:
- Utiliser `swisssurface3d-raster` comme source principale vegetation
- Construire un index d'obstacles vegetation simplifie (prismes/cells) pour ray test

Pourquoi:
- meme ecosysteme swisstopo/stac que les pipelines existants
- resolution fine (raster 0.5m) et couverture compatible avec notre architecture
- integration simple avec `swissalti3d` deja charge

## Plan d'execution

### Phase 0 - Cadrage (court)
Sorties:
- config region `lavaux-nyon` (bbox local + bbox horizon)
- conventions de stockage:
  - `data/raw/swisstopo/swisssurface3d_raster/...`
  - `data/processed/vegetation/...`

### Phase 1 - Ingestion vegetation (premiere etape demandee)
Actions:
- script ingest STAC pour `ch.swisstopo.swisssurface3d-raster`
- telecharger les `.tif` utiles sur bbox
- manifest JSON (items, pages, volume, date)

Criteres d'acceptation:
- un manifest present
- dataset visible dans `GET /api/datasets`
- dry-run + max-items supportes

### Phase 2 - Preprocess vegetation obstacles
Actions:
- calcul nDSM: `vegetationHeight = DSM - DTM`
- exclusion footprints batiments
- filtrage hauteur mini (ex: > 2m)
- index spatial serialize (grille/tuiles)

Criteres d'acceptation:
- index vegetation chargeable en < 2s a chaud
- warnings clairs si index manquant

### Phase 3 - Moteur d'ombre (integration)
Actions:
- ajouter `vegetationShadowEvaluator` dans `buildPointEvaluationContext`
- fusion blocages: terrain + vegetation + batiments
- exposer diagnostics (`vegetationBlocked`, distance, obstacle id/tile)

Criteres d'acceptation:
- endpoint point/area/timeline repond sans regression
- console diagnostic distingue vegetation vs batiments vs terrain

### Phase 4 - Extension perimetre Lavaux -> Nyon
Actions:
- generaliser les scripts (ne plus hardcoder Lausanne)
- ingestion par tuiles (batch east->west)
- preprocess index par chunks regionaux

Criteres d'acceptation:
- pipelines reproduisibles sur tout le perimetre cible
- pas de saturation memoire ni filewatcher

### Phase 5 - QA/Validation terrain
Actions:
- jeux de points de test (Lavaux pentes, Nyon/ Gingins, bord lac)
- tests hiver/matin et ete/soir
- comparaison visuelle avec observations terrain

Criteres d'acceptation:
- cas confirmes d'ombres vegetation locales
- cas confirmes d'ombres montagne/horizon
- taux de faux positifs acceptable

## Strategie de livraison (incrementale)

1. Livraison A: vegetation sur Lausanne uniquement
2. Livraison B: Morges -> Nyon + Gingins
3. Livraison C: Lavaux complet
4. Livraison D: harmonisation complete du corridor

## Risques majeurs

- volume de donnees (DSM raster) tres important
- coherence temporelle (annees d'acquisition differentes)
- performances daily timeline sur grande zone
- ambiguite batiment vs arbre en zone dense

Mitigations detaillees:
- voir `docs/architecture/lavaux-nyon-scaling-challenges.md`

## Prochaines etapes (court terme)

- Ajouter un toggle UI: "Ignorer ombre vegetation"
  - Objectif: comparer rapidement la carte avec/sans vegetation.
  - Cible technique:
    - `instant`: pas de recalcul complet (recomposition client a partir des flags deja fournis).
    - `daily`: envoyer deux masques par frame (normal + sans vegetation) dans le meme stream SSE.
  - Etat: reporte volontairement (post-MVP actuel).
