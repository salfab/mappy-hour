# Defis D'Extension - Lausanne -> Lavaux, Nyon, Gingins

Date: 2026-03-08
Related roadmap:
- `docs/roadmap/2026-03-08-vegetation-lavaux-nyon-plan.md`

## Objectif

Lister les defis techniques quand on sort d'un prototype centré Lausanne,
et proposer des moyens concrets pour les traiter.

## Defis, impacts et reponses

| Defi | Impact | Reponse proposee |
|---|---|---|
| 1. Explosion du volume de donnees (DSM/DTM/batiments) | temps ingest et preprocess trop longs, stockage lourd | ingestion par tuiles + manifests + reprise incrémentale + compression index |
| 2. Temps de calcul daily sur grandes bbox | UX lente, timeouts | limites `maxPoints`, streaming SSE, precompute partiel, cache par cellule/heure |
| 3. Filewatcher/FD sur Windows | dev server instable | stocker les donnees hors repo via `MAPPY_DATA_ROOT` (evite que Turbopack observe des milliers de fichiers de donnees) |
| 4. Donnees multi-dates (2017, 2019, etc.) | incoherences ombres vs realite actuelle | ajouter metadata temporelle dans manifests + avertissements UI |
| 5. Differencier vegetation vs batiments dans un DSM | faux blocages vegetation | derive nDSM (`DSM-DTM`) + soustraction footprints batiments + seuils de hauteur |
| 6. Couverture/holes selon zones | points sans elevation ou sans vegetation | fallback clair, warnings explicites, couche QA coverage |
| 7. Projection et resolution (2056, WGS84, 0.5m/2m/30m) | decallages geometriques | normaliser pipeline LV95 interne, conversions centralisees, tests de regression projection |
| 8. Precision physique vs cout calcul | calcul trop couteux si trop fin | mode rapide (grille) + mode qualite (plus fin) + precompute par zones frequentes |
| 9. Saisonnalite vegetation (feuillus) | surestimation ombre en hiver | parametre saisonnier (coeff feuillage), scenarios `winter/summer` |
| 10. Qualite de validation terrain | difficultes a prouver la justesse | corpus de points de reference (Lavaux/Nyon/Gingins), captures terrain, tests reproductibles |
| 11. Support multi-perimetres (plus seulement Lausanne) | scripts et configs non generiques | introduire `region config` (bbox, datasets, paths, cache keys) |
| 12. Observabilite pipeline | debug difficile a grande echelle | logs normalises, stats ingest/preprocess/eval, endpoint sante datasets |

## Etapes recommandees

### Etape A - Industrialiser la config region
- Introduire un schema `region` (nom, bbox locale, bbox horizon, chemins data)
- Parameteriser scripts ingest/preprocess avec `--region=<id>`

### Etape B - Ajouter la vegetation (MVP)
- Ingestion `ch.swisstopo.swisssurface3d-raster`
- Derivation nDSM et index vegetation obstacles
- Integration dans evaluateur d'ombre point/area/timeline

### Etape C - Passer a l'echelle geographique
- Tuilage Lavaux->Nyon->Gingins
- Preprocess chunké et cache spatial
- Validation progressive par sous-zones

### Etape D - Fiabiliser qualite et perfs
- Benchmarks fixes (`instant`, `daily`, 3 tailles bbox)
- tests de non-regression sur diagnostics (terrain/batiment/vegetation)
- tuning des seuils vegetation par zone

## Moyens concrets pour relever les defis

### Donnees
- Manifests versionnes (metadata + dates + source)
- Strategie de refresh incrementale (seulement nouvelles tuiles)

### Calcul
- Cache memoire + disque pour masques reutilises
- Limites API strictes + messages de guidance utilisateur

### Produit
- Diagnostics explicites au clic (cause principale + secondaires)
- Overlay dedie vegetation (toggle) + legendaire

### Qualite
- Jeux de tests de reference par saison et par zone
- Tests unitaires (algorithmes) + integration API (payloads + streaming)

## Definition de "done" pour l'extension

Le passage a l'echelle est considere valide quand:
- vegetation impacte effectivement les ombres sur des cas de reference
- Lavaux, Nyon et Gingins sont couverts par le pipeline ingest/preprocess
- les temps de reponse restent exploitables en `instant` et `daily`
- les diagnostics UI permettent d'expliquer la source de l'ombre
