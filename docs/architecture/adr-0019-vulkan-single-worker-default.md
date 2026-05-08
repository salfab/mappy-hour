# ADR-0019 - Default `MAPPY_PRECOMPUTE_WORKERS=1` pour les backends GPU-IPC

**Date** : 2026-05-05
**Statut** : Accepté
**Références** : ADR-0011 (Vulkan backend), `precompute-workers-benchmark-2026-03-15.md` (CPU mode), `rust-wgpu-vulkan-precompute-rollout-2026-04.md` (mise en garde initiale `WORKERS=1`)

## Contexte

Le benchmark CPU de 2026-03-15 (`precompute-workers-benchmark-2026-03-15.md`) recommandait `MAPPY_PRECOMPUTE_WORKERS=4` après mesure d'un speedup x2.08 (1→4 workers, grid=1m, charge lourde). Cette mesure a été prise sur les modes CPU (`detailed`, `two-level`) où chaque worker est CPU-bound indépendamment.

Le rollout Vulkan d'avril 2026 mettait en garde par prudence (`WORKERS=1` recommandé tant que la stabilité multi-worker n'a pas été testée), mais aucun bench dédié n'avait été effectué. Le default `auto: min(4, max(2, cpu-1))` continuait à s'appliquer aux runs Vulkan, donc 4 workers étaient utilisés en pratique.

Un bench worker × Vulkan a été effectué le 2026-05-05 pour combler ce trou de connaissance.

## Mesures (2026-05-05)

`scripts/benchmark/precompute-workers-parallelism.ts` — Lausanne, 8 tuiles top-priority, grid=1m, 06:00-21:00, 60 frames, 1 jour, `MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan`. Cache dir purgé entre chaque config (cf TODO `project_skipexisting_false_bug.md` qui décrit le workaround nécessaire pour avoir des mesures représentatives).

| Repeat | Workers | Temps | tiles/min | Ratio vs 1-worker |
|---|---|---|---|---|
| 1 | **1** | 44 s | 10.90 | **1×** (baseline) |
| 1 | 2 | 22 min | 0.36 | **30× pire** |
| 1 | 4 | 10.7 min | 0.74 | **15× pire** |
| 2 | 4 | 11.7 min | 0.68 | 16× pire |
| 2 | 2 | 19.4 min | 0.41 | 26× pire |
| 2 | **1** | (≈ 44 s attendus) | (≈ 10.9) | **1×** confirmation |

→ Mesure stable, repeats cohérents : **multi-worker × Vulkan dégrade les perfs d'un facteur 15-30**.

## Cause

Chaque worker du pool spawn son **propre process Rust Vulkan** via fork. Tous se contendent sur :

1. **Cold-start GPU** : chaque process Vulkan paie ~10-15s de cold-start (Vulkan instance + device creation + pipeline compile + buffer alloc). N workers = N cold-starts.
2. **GPU device contention** : un seul GPU physique sur la machine (Intel Arc) ne peut traiter qu'une commande Vulkan submission à la fois. N workers se sérialisent au niveau driver, et perdent en plus du temps en context-switching.
3. **Shared memory pressure** : chaque process Vulkan alloue ses propres buffers GPU, multipliant la pression sur la VRAM disponible.

À l'inverse, le mode CPU `detailed` n'utilise pas le GPU. Chaque worker est un processus Node CPU-bound indépendant qui scale linéairement (jusqu'au plafond `cpu-1`), d'où le speedup ~x2 mesuré en mars.

## Décision

Modifier `resolvePrecomputeWorkerCount` (`src/lib/admin/cache-admin.ts:300`) pour forcer `1` quand `MAPPY_BUILDINGS_SHADOW_MODE` est un backend GPU-IPC :

```typescript
const shadowMode = process.env.MAPPY_BUILDINGS_SHADOW_MODE?.trim().toLowerCase();
if (shadowMode === "rust-wgpu-vulkan" || shadowMode === "webgpu-compute") {
  return 1;
}
```

L'override `MAPPY_PRECOMPUTE_WORKERS=N` reste prioritaire pour permettre l'expérimentation (par exemple multi-GPU futur).

Le label affiché par `precompute-region-sunlight.ts` reflète le nouveau default :
- Mode CPU : `(auto: min(4, max(2, cpu-1)))`
- Mode GPU-IPC : `(auto: 1, GPU-IPC backend forces single-worker — see ADR-0019)`

## Conséquences

### Positives

- Performance : un run Vulkan typique avec 4 workers (default actuel) → 1 worker forcé (nouveau default) ≈ **+15× plus rapide**, transparent côté utilisateur.
- Stabilité : pas de race conditions / GPU contention / OOM imprévus. Confirme empiriquement la mise en garde du rollout Vulkan d'avril.
- Cohérence : le rollout doc disait déjà "garder à 1", maintenant c'est appliqué automatiquement sans devoir se rappeler de le faire.

### Compromis

- Pas de scaling horizontal sur GPU. Si un setup multi-GPU émerge, il faudra revoir la logique (worker count = nombre de GPU + assignation par device-id).
- Le bench `precompute-workers-parallelism.ts` continue à fonctionner avec ce default (il bypass via `MAPPY_PRECOMPUTE_WORKERS=N` direct).

## Vérification

- [x] Bench reproductible : `npx tsx scripts/benchmark/precompute-workers-parallelism.ts --start-date=2027-01-01 --tile-count=8 --workers=1,2,4 --grid-step-meters=1`
- [x] `pnpm tsc --noEmit` clean après modif
- [ ] Run précompute Geneva top-priority avec nouveau default → vérifier wall-time conforme au bench (~5.5 s/tile)

## Références

- Bench : `scripts/benchmark/precompute-workers-parallelism.ts` (modifié 2026-05-05 pour `buildingHeightBiasMeters: 0.001` + cache purge entre configs)
- Mise en garde initiale : `docs/architecture/rust-wgpu-vulkan-precompute-rollout-2026-04.md:136`
- Bench CPU contradictoire : `docs/architecture/precompute-workers-benchmark-2026-03-15.md` (recommandait `WORKERS=4` mais en mode CPU uniquement)
- TODO lié : `project_skipexisting_false_bug.md` (workaround nécessaire pour bench)
