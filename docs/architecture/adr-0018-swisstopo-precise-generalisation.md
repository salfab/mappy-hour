# ADR-0018 - Généralisation Swisstopo Precise à toute la prod (LV95↔WGS84)

**Date** : 2026-05-05
**Statut** : Accepté
**Références** : ADR-0014 (Swisstopo rigoureux pour `buildTilePoints`), bench `scripts/diag/bench-wgs84-to-lv95.ts`, validation `scripts/diag/_compare-atlas-idx-subset.ts`

## Contexte

ADR-0014 (avril 2026) a remplacé `proj4` par une implémentation rigoureuse Swisstopo (`lv95ToWgs84Precise`) **uniquement** dans `buildTilePoints`. Les autres usages de `lv95ToWgs84` et tous les usages de `wgs84ToLv95` étaient restés sur `proj4` au prétexte qu'ils étaient hors du chemin chaud.

Audit de la dette `project_proj4_drift.md` (mémoire 2026-05-04) :
- ~30 call sites prod en `src/` utilisant encore `proj4` directement (10 fichiers)
- Pas de variante `Precise` pour le sens inverse `wgs84ToLv95`
- Couplage à proj4 dans tous les API routes (`timeline/stream`, `instant/stream`, `places/windows`), `evaluation-context.ts`, `cache-run-outline.ts`, `adaptive-horizon-sharing.ts`, `atlas-tile-service.ts`, `sunlight-tile-service.ts`, `sunlight-cache.ts`

## Décision

1. **Implémenter `wgs84ToLv95Precise`** dans `src/lib/geo/projection.ts` — algo Swisstopo rigoureux dans le sens inverse (WGS84 géodésique → géocentrique → translation 3-paramètres ETRS89→CH1903+ → Bessel → sphère → plan oblique Mercator). Mêmes constantes que `lv95ToWgs84Precise`. `h = 0` assumé.
2. **Migrer mécaniquement les 30 call sites prod** : `lv95ToWgs84` → `lv95ToWgs84Precise`, `wgs84ToLv95` → `wgs84ToLv95Precise` dans tout `src/`.
3. **Conserver les versions `proj4`** (`lv95ToWgs84`, `wgs84ToLv95`) dans `projection.ts` pour les tests/scripts/docs qui les utilisent encore. Pas de suppression dans cet ADR.

## Validation perf + précision

### Précision (`wgs84ToLv95Precise` vs proj4)

`scripts/diag/bench-wgs84-to-lv95.ts` sur Geneva, **195 687 500 points (grid 1m)** :

| Metric | Precise vs proj4 |
|---|---|
| Mean delta | **4 µm** |
| p50 | 0 m |
| p99 | 0 m |
| Max | **4 µm** |

Round-trip (proj4 forward + Precise inverse vs identité) : max 1.088 mm — l'erreur résiduelle vient de proj4 forward, pas de Precise.

### Runtime

Geneva, 1.96M points (grid 10m) :

| Algo | Durée | Débit | Speedup |
|---|---|---|---|
| proj4 (`wgs84ToLv95`) | 5786 ms | 338k pts/s | 1× |
| **Precise (`wgs84ToLv95Precise`)** | **857 ms** | **2.28M pts/s** | **6.7×** |

Cohérent avec le speedup 6.2× obtenu sur le sens LV95→WGS84 (ADR-0014).

### Bit-parity atlas (validation downstream)

Tuile Lausanne-Montriond, régen 7 jours sous nouveau code, comparé au baseline (run nocturne pré-migration) via `scripts/diag/_compare-atlas-idx-subset.ts` :

| Métrique | Baseline | Post-migration | Verdict |
|---|---|---|---|
| Buckets totaux (résolution 0.75°) | 6869 | 6869 | **Identique** |
| Bucket keys diff | — | 0 | **Strict subset** |
| outdoorPointCount | 47980 | 47981 | ±1 point (cf `project_zenith_shadow_non_deterministic.md`, drift gpu-raster pré-existant, indépendant de proj4) |

Sub-µm vs résolution bucket 0.75° (= 13 mrad) : ~6 ordres de grandeur sous le seuil. Bit-parity bucket-key garantie mathématiquement, confirmée empiriquement.

### Tests unitaires

`pnpm tsc --noEmit` clean. `pnpm vitest run` : pas de régression vs baseline (les 7 tests cassés sur master — `evaluation-context.test.ts` × 1 + `timeline/stream/route.test.ts` × 6 — restent cassés à l'identique, dette pre-existing).

Le mock `vi.mock("@/lib/geo/projection")` dans `evaluation-context.test.ts` a été mis à jour pour exposer `wgs84ToLv95Precise` au lieu de `wgs84ToLv95`.

## Conséquences

Positives :

- ~6.7× sur les conversions WGS→LV95 du chemin chaud des API routes (typiquement 1-7 calls par requête bbox), gain proportionnel sur `streamTilesForBbox` et `places/windows`.
- ~6.2× sur les conversions LV95→WGS84 hors `buildTilePoints` (calls par tuile dans `atlas-tile-service`, `sunlight-tile-service`, `adaptive-horizon-sharing`, etc.).
- Cohérence stricte : un seul algo de projection pour tout le prod, plus de mix proj4/Precise.
- Précision uniforme partout (sub-µm vs proj4), pas de clause par région.

Compromis :

- ~50 lignes supplémentaires dans `projection.ts` (nouvelle fonction `wgs84ToLv95Precise`) ;
- 30 call sites migrés mécaniquement (renommage import + appels) ;
- Fonctions `proj4` conservées pour compatibilité scripts (peuvent être supprimées dans un futur ADR si plus aucun caller).

## Vérification attendue

- [x] Bench tri-algo `wgs84ToLv95` vs `wgs84ToLv95Precise` (sub-µm, 6.7×)
- [x] Subset check atlas idx baseline vs post-migration (Montriond, 6869/6869 buckets identiques)
- [x] `pnpm tsc --noEmit` clean
- [x] Pas de régression Vitest (mêmes tests cassés que pré-migration)
- [ ] Run précompute complet futur : observer la perf gain agrégée sur l'ensemble du pipeline (~quelques s/tuile selon le mix de calls)

## Références

- Bench LV95→WGS84 : `scripts/diag/bench-lv95-3algos.ts`
- Bench WGS84→LV95 : `scripts/diag/bench-wgs84-to-lv95.ts`
- Subset check atlas : `scripts/diag/_compare-atlas-idx-subset.ts`
- Capture golden baseline : `scripts/diag/_capture-golden-baseline-proj4.py`
- Sélection golden : `data/processed/precompute/golden-proj4-validation-2026-05-05.json`
- Implémentation : `src/lib/geo/projection.ts` (`wgs84ToLv95Precise`)
- Tag baseline : `baseline/proj4-migration-2026-05-05`
- Source : Swisstopo "Formeln und Konstanten für die Berechnung der Schweizerischen schiefachsigen Zylinderprojektion und der Transformation zwischen Koordinatensystemen"

## Lien avec l'ADR-0014

ADR-0014 reste valide (Precise dans `buildTilePoints`). Le présent ADR-0018 **étend** sa portée à tous les call sites prod sans contredire la décision initiale. Quand l'ADR-0014 disait *« Les autres usages de `lv95ToWgs84` (...) restent sur proj4 : appels rares hors du chemin chaud, pas d'enjeu perf »*, l'ADR-0018 révise ce trade-off à la lumière de :
- la dette de cohérence accumulée (mix proj4/Precise difficile à maintenir),
- le coût marginal d'écrire `wgs84ToLv95Precise` (50 lignes, ~3h de dev + validation),
- le gain perf agrégé non négligeable sur les API routes du frontend.
