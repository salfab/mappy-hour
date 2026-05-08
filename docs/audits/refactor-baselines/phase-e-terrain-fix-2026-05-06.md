# Phase E terrain readback fix — non-régression record

**Date :** 2026-05-06
**Tag baseline :** `baseline/phase-e-terrain-fix-2026-05-06` (git tag, commit `b93edea`)
**Cible :** activer Phase E (bulk-copy GPU bitmasks dans l'atlas) au lieu du fallback hot-loop JS quand seul le terrain raster GPU est uploadé (pas les horizon masks).

## Contexte du bug

Avant le fix :

- Côté Rust (`main.rs`) : la readback du buffer `terrain_results` était gatée sur `shadow.has_horizon`. Quand seuls les terrain rasters étaient uploadés (cas Lausanne actuel : DEM ALTI3D mais pas de horizon masks), le shader calculait bien le ray-march local en `terrain_blocked` mais le résultat était jamais lu côté Node.
- Côté Node (`rust-wgpu-vulkan-shadow-backend.ts`) : `hasTerrain = serverHorizonHash !== null` → `terrainMask = null` dans `FrameMasks`.
- Côté `sunlight-tile-service.ts` Phase E : le check `preComputed.terrainMask !== null` échouait, fallback hot-loop CPU iterating ~32k pts × 50 frames ≈ 7 sec/tuile.
- Côté `evaluation-context.ts` `buildPointEvaluationContext` : le `terrainShadowEvaluator` CPU était attaché aux points même quand le backend GPU expose `uploadTerrainRasters`. Conséquence : `hasLocalTerrainEvaluator=true` → Phase E refusée même si tous les masques étaient là.

## Surfaces critiques touchées

Per CLAUDE.md, ce fix touche :
- ✓ Atlas binaire (`data/cache/sunlight/{region}/{modelHash}/g{step}/atlas/r{res}/{tileId}.atlas.bin.gz`)
- ✓ API contracts (potentiellement, si terrain rendering live change)
- ✗ Grid metadata (inchangé)
- ✗ Raw ingestion (inchangé)

## Goldens capturés (pre-fix)

Tag `baseline/phase-e-terrain-fix-2026-05-06`. 4 tuiles Lausanne urbaines, hash `bff55b407db8426b`, date 2027-04-01 :

```
e2538000_n1152000_s250  sha=41f1df8d896f0b97  size=15353569
e2537750_n1152250_s250  sha=a0f2278a1cdda0f2  size=20067520
e2538000_n1152250_s250  sha=746c8bf81c876814  size=12486273
e2538250_n1152250_s250  sha=5b85d38e075266a5  size=10622555
```

## Mism% golden (CPU vs atlas)

Tool : `scripts/diag/check-atlas-vs-cpu-multi.ts` (pre-fix : ne passait pas `terrainShadowEvaluator` au CPU golden — bug du tool corrigé dans le même commit). 5 points urbains canon Lausanne :

| Point             | Pre-fix | Post-fix |
|-------------------|---------|----------|
| Rumine ouest      | 1.8 %   | 1.8 %    |
| St-François N     | 1.8 %   | 1.8 %    |
| Cathédrale N      | 0.0 %   | 0.0 %    |
| Pont Bessières    | 1.8 %   | 1.8 %    |
| Chauderon         | 0.0 %   | 0.0 %    |

Seuil documenté ≤ 2 %. **Aucun changement.** Les points testés sont en plateau urbain, où le DEM local ne joue pas (pas de relief proche cassant).

## Atlas SHA256 post-fix

Régen avec `skipExisting=false`, mêmes 4 tuiles. **Bit-parity exacte** :

```
e2538000_n1152000_s250  sha=41f1df8d896f0b97  size=15353569  ← identique
e2537750_n1152250_s250  sha=a0f2278a1cdda0f2  size=20067520  ← identique
e2538000_n1152250_s250  sha=746c8bf81c876814  size=12486273  ← identique
e2538250_n1152250_s250  sha=5b85d38e075266a5  size=10622555  ← identique
```

Les sorties Phase E (bulk-copy GPU) et hot loop (CPU per-point) produisent les mêmes bits sur ces tuiles. Cohérent : la GPU produit les mêmes bits que la CPU réplique sur des points où le DEM local ne casse pas la lumière.

## Effet wall-time

Bench `scripts/benchmark/precompute-tile-pipeline-depth.ts`, 4 tuiles, depth=2, repeats=2 :

| Métrique             | Pre-fix    | Post-fix repeat 1 | Post-fix repeat 2 | Speedup |
|----------------------|------------|-------------------|-------------------|---------|
| Total elapsed        | 17 614 ms  | 4 637 ms          | 3 287 ms          | 5.4×    |
| tiles/min            | 7.32       | 51.76             | 73.01             | 10×     |
| frameLoop / tile     | 5-9 sec    | 0.2-0.4 sec       | 0.2-0.4 sec       | ~25×    |

Le frameLoop chute de ~7 s à ~0.3 s (Phase E bulk-copy = quelques memcpy + sums au lieu de 1.7 M ops JS).

## Tests unitaires

- `sunlight-cache-atlas.test.ts` : 8/8 passants.
- `evaluation-context.test.ts` : 4/5 passants. Le test cassé est **pré-existant** (commit `b93edea` montre le même fail), non lié à ce fix. Documenté dans la mémoire.

## Risques identifiés et mitigations

1. **Tuiles en pente avec relief proche.** Sur les 4 tuiles bench (Lausanne centre), pas de cas pathologique. Sur des tuiles type Ouchy/Pully (slopes), le DEM local doit faire des bits différents. À surveiller au prochain run complet.
2. **API live (web)** : `buildPointEvaluationContext` est utilisé hors précompute aussi. En mode live, `webgpuComputeBackend === null` → `terrainShadowHandledByBackend = false` → CPU evaluator construit comme avant. Pas d'impact.
3. **Tile-service path 1 (line 906-925)** : ce path testait déjà `!terrainShadowHandledByBackend` correctement. Inchangé. Les paths 2 et 3 (lignes 1000, 1048) pollued via `context.terrainShadowEvaluator` qui ne respectait pas le flag.

## Rollback

```
git revert <commit>
git checkout baseline/phase-e-terrain-fix-2026-05-06 -- data/cache/sunlight/lausanne/bff55b407db8426b/g1/atlas/r0.75/e253*.atlas.bin.gz
```

## Validation post-déploiement

À un prochain run complet Lausanne : comparer `outdoorCount` et mism% sur des tuiles type Ouchy/Pully où le terrain raster doit produire un effet visible. Si mism% baisse → fix correct (atlas plus fidèle au CPU golden complet). Si mism% augmente sans explication → STOP, investiguer.
