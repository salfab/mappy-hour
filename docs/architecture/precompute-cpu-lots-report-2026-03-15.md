# Rapport d'implémentation CPU précompute (Lots A/B/C) - 2026-03-15

Source benchmark: `docs/progress/benchmarks/precompute-cpu-lots-20260315.json`

## Résumé
- **Lot A (P1-1)** implémenté: index spatial bâtiments + filtrage corridor `point -> soleil`.
- **Lot B (P1-2)** implémenté: mutualisation du contexte de calcul par tuile.
- **Lot C (P1-4)** implémenté: partage adaptatif du masque d'horizon avec budget d'erreur + fallback local.
- API publique inchangée, cache invalidé proprement via `modelVersionHash` (algo v3 + config adaptive).

## Pourquoi c'était sous-optimal, et ce qui a été fait

1. Bâtiments (Lot A)
- Avant: scan large des obstacles candidats, puis rejet tardif.
- Impact: coût CPU élevé par point/frame.
- Après: index grille LV95 (64m) + sélection par corridor orienté + filtres direction/distance avant test géométrique exact.

2. Préparation contexte (Lot B)
- Avant: préparation point-par-point répétée (terrain/végétation/structures).
- Impact: gros surcoût CPU/I/O sur les tuiles denses.
- Après: préparation partagée par tuile (`sharedSources`) et réutilisation pour tous les points.

3. Masques d'horizon (Lot C)
- Avant: calcul local de masque trop fréquent.
- Impact: coût important évitable sur zones stables.
- Après: résolution adaptive (shared/local) avec budget:
  - `maxPointMinutesMismatchPerDay = 2`
  - `maxMismatchPointsRatio = 0.5%`
- Si budget dépassé: fallback local obligatoire.

## Résultats benchmark

### Lot A (P1-1)
- `iterations`: 500
- `baselineElapsedMs`: 70.29
- `indexedElapsedMs`: 16.53
- `speedup`: **4.252x**
- `checkedObstaclesCount`:
  - baseline avg/p50/p95: `962 / 962 / 962`
  - indexed avg/p50/p95: `1 / 1 / 1`

### Lot B (P1-2)
- `sampledPoints`: 180
- `noSharedElapsedMs`: 33798.375
- `sharedElapsedMs`: 738.054
- `speedup`: **45.794x**
- `parityMismatchCount`: **0**

### Lot C (P1-4)
- `tilesMeasured`: 24
- `decisions`: `shared=20`, `local=4`, `none=0`
- `localOnlyElapsedMs`: 30321.11
- `adaptiveFirstElapsedMs`: 163.938
- `adaptiveWarmElapsedMs`: 1.61

Note méthodologique:
- Les chiffres du lot C sont mesurés dans un run où les caches de masque sont réutilisés au sein du processus; ils illustrent surtout l'effet du partage + réutilisation.
- Le signal de qualité principal reste la décision adaptive (`shared/local`) sous budget d'erreur, avec fallback local.

## Validation qualité
- Tests différentiels et non-régression passés:
  - `pnpm test` -> 54 tests passés
  - parité stricte maintenue pour Lot A + Lot B (`parityMismatchCount = 0` sur benchmark B)
- Tests adaptifs ajoutés:
  - cas `shared` sous budget
  - cas `local` quand budget dépassé

## Conclusion opérationnelle
- Le gain CPU prioritaire vient bien de `P1-1` et `P1-2`.
- `P1-4` est en place avec garde-fou qualité explicite.
- Prochaine optimisation naturelle: parallélisme contrôlé (worker pool) en complément, sans relâcher les garde-fous de qualité.
