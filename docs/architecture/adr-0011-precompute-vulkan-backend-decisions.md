# ADR-0011 - Décisions backend Rust/wgpu Vulkan et optimisation hot loop précompute

**Date** : 2026-04-15
**Statut** : Accepté
**Références** : ADR-0009 (WebGPU compute retry encadré), ADR-0010 (Maillage SwissTopo source), `rust-wgpu-vulkan-precompute-rollout-2026-04.md`

## Contexte

Suite à la phase d'expérimentation Rust/wgpu Vulkan documentée par le rollout plan d'avril 2026, plusieurs décisions doivent être figées dans le code : choix du profil de compilation Rust, structure du hot loop côté JS, et clarification du gain réel attendu pour ne pas relancer prématurément des chantiers à faible ROI.

Le contrat fonctionnel est inchangé par rapport à ADR-0010 : `gpu-raster` reste le chemin de production supporté, Rust/wgpu Vulkan est un backend alternatif aligné sur le même contrat de cache (`modelVersionHash` partagé, suffixe d'artefact distinct).

## Mesures de référence (2026-04-15)

Bench `precompute-hot-tiles-gpu-mode-matrix.ts` sur 4 tuiles Lausanne top-priority, fenêtre 06:00-21:00, grille 1m, sample 15min :

| Configuration | Vulkan eval (4 tuiles) | Vulkan vs raster (eval) |
|---|---|---|
| Debug binary, hot loop original | 42.8 s | 0.74x (raster plus rapide) |
| Release binary, hot loop original | 26.9 s | 1.16x |
| Release binary, hot loop optimisé | 19.8 s | 1.41x |

L'IPC stdin/stdout JSON entre Node et le serveur Rust mesuré par `vulkan-ipc-overhead-probe.ts` représente ~10% du temps de chaque appel `evaluate` (median 0.58 ms IPC vs 5 ms compute GPU+readback). Ce n'est pas un bottleneck.

## Décision

### 1. Build Rust en release par défaut

Le client TS pointe sur `tools/wgpu-vulkan-probe/target/release/` au lieu de `target/debug/`. Override possible via `MAPPY_RUST_WGPU_PROBE_PROFILE=debug` pour le développement local.

`ensureRustWgpuVulkanProbeBuilt()` invoque `cargo build --release` quand le profil est release.

**Pourquoi** : le binaire debug est ~10x plus lent sur le compute. Le surcoût de compilation release (~3 min sur la première build) est largement compensé dès le premier run de précompute non-trivial.

### 2. Hot loop précompute unifié pour tous les backends

**Version initiale (commit 4f885db)** : le hot loop était split en deux chemins — fast-path optimisé pour les backends batch (rust-wgpu-vulkan, webgpu-compute) et slow-path inchangé pour les autres (gpu-raster, two-level, detailed, prism) qui continuait à passer par `evaluateInstantSunlight()`.

**Version finale (commit 5157a5c)** : le hot loop est unifié en un seul loop qui détermine la source du building shadow par point :

1. bitmask batch (rust-wgpu-vulkan / webgpu-compute via `evaluateBatch`)
2. évaluateur per-point (`point.buildingShadowEvaluator` pour gpu-raster / two-level / detailed / prism)
3. aucun (fallback `detailed-direct-v1`)

La boucle par-point unifiée est inlinée : pas d'appel à `evaluateInstantSunlight()`, pas d'allocation de `SunSample`, masques bitwise directs, diagnostic arrays pré-allouées, abort signal tous les 1024 itérations.

`getMaxHorizonAngle` et `TERRAIN_HORIZON_SKIP_MARGIN_DEG` sont exposés depuis `solar.ts` pour permettre l'inline, avec `evaluateInstantSunlight` qui reste la source canonique pour les callers externes (routes API, tests).

**Sémantique préservée exactement par rapport à `evaluateInstantSunlight` :**

- `aboveAstronomicalHorizon` = true (le skip de frame en haut du loop filtre les cas altitude ≤ 0)
- vegetation eval + building per-point eval skippés quand `terrainBlocked` (matche `evaluateSecondaryBlockers` avec `evaluateAllBlockers=false`)
- bitmask batch est toujours lu indépendamment de `terrainBlocked` (le bit est déjà calculé pour tous les points dans le dispatch batch — sémantique Vulkan historique conservée)

**Pourquoi** : le compute GPU Vulkan ne représente que ~5% du temps eval par tuile. Le reste est CPU dans la boucle JS (~32K points × 60 frames). Inliner cette boucle pour TOUS les backends, pas seulement les batch, amène les mêmes gains au mode `gpu-raster` qui est le mode de production par défaut.

**Mesures (pnpm precompute:all-regions en mode gpu-raster, top-priority 181 tuiles, 06:00-21:00) :**

- Baseline (ancien split fast/slow) : 15.16s/tuile moyenne
- Unifié (commit 5157a5c) : 12.06s/tuile moyenne
- Speedup : **~20% wall-time**

Sur un scope de 200 jours, ça représente environ 30 heures de wall économisées (~152h → ~121h total compute).

### 3. Pas de batched compute dispatch ni reload-points serveur Vulkan

Deux pistes ont été évaluées et écartées :

- **`reload_points` au serveur Rust** pour éviter le restart par tuile : ~5 min économisés sur Lausanne 161 tuiles, refactor 3-5 h. ROI insuffisant.
- **Batched compute dispatch** (60 frames en un seul dispatch GPU) : ne peut gagner que sur les ~5% que représente Vulkan dans l'eval. Refactor Rust + WGSL 6-10 h. ROI insuffisant.

**Pourquoi** : le bottleneck dominant est la boucle JS per-point, pas le compute GPU. Toute optim supplémentaire côté Vulkan reste sous le plafond imposé par cette boucle. Si on veut pousser plus loin, la prochaine cible naturelle est la vegetation evaluator qui fait du ray-marching CPU par point ; ce travail est orthogonal au choix du backend GPU.

### 4. Pas de multi-view rendering (Batching C) — investigué et abandonné

Une seconde tentative, après avoir constaté que les tuiles denses (suburbs Lausanne, 56K triangles vs 12K pour le centre) rendent le shadow-map render dominant :

- **Approche** : utiliser `VK_KHR_multiview` pour rendre N shadow-maps en un seul render pass, le vertex shader sélectionnant la matrice MVP via `@builtin(view_index)`.
- **Probe technique** (binaire jetable, supprimé) : valide que la stack `wgpu 29.0.1 + Naga WGSL + Intel Arc Vulkan` supporte multiview, avec `max_multiview_view_count = 16` annoncé par l'adapter.
- **Bénéfice empirique mesuré** sur 30K triangles, résolution 4096², 100 itérations :
  - N=4 layers : speedup multiview/sequential = **1.07x** (gain 7%)
  - N=8 layers : speedup = **1.20x** (gain 17%)
  - N=16 layers : ne fonctionne pas — seulement 8 layers reçoivent les triangles malgré `max_multiview_view_count=16` annoncé, soit bug driver Intel soit limite wgpu non remontée
- **Extrapolation production** : le render pass représente ~30-50% du temps de frame Vulkan ; un gain de 17% sur le render donne ~5-9% sur l'eval phase et ~3-7% sur le wall total Lausanne.
- **Coût refactor estimé** : 8-12h (texture array, shader vertex/compute, protocole serveur, client TS, boucle hot loop pour grouper les frames par chunks).
- **Décision** : abandonné. Le ratio gain/effort est défavorable face à `MAPPY_PRECOMPUTE_WORKERS=2` (gain attendu ~45% wall sur Lausanne pour 2-3h de travail, dont une partie est juste la validation de stabilité multi-process).

À reconsidérer si : (a) la stabilité multi-worker s'avère bloquée et workers > 1 n'est pas utilisable, (b) une nouvelle génération de driver Intel exposerait un gain multiview significativement plus élevé, (c) le bottleneck change (par exemple si la boucle JS est elle-même portée sur GPU et que le render redevient dominant).

### 5. Pas de promotion Vulkan en production

Vulkan reste un mode opt-in (`--buildings-shadow-mode=rust-wgpu-vulkan` ou `MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan`). `gpu-raster` reste le chemin par défaut.

**Pourquoi** : le speedup wall-clock Vulkan vs raster reste modeste (~1.13-1.41x selon la mesure) et la stabilité multi-worker n'est pas testée. Le gain ne justifie pas d'imposer une dépendance Rust/Vulkan en chemin critique.

### 6. `MAPPY_PRECOMPUTE_WORKERS=1` reste la valeur verrouillée — worker pool Node cassé sous parallélisme

Une tentative d'accélérer le precompute via `MAPPY_PRECOMPUTE_WORKERS=2` a été investiguée et **ne fonctionne pas en l'état** :

- **Probe Rust brut** (binaire jetable, supprimé) : spawn N serveurs `mappyhour-wgpu-vulkan-probe.exe` concurrents, chacun avec mesh identique et points distincts. **Résultat : N=2 donne 3.5x throughput, N=3 donne 4.4x, zéro crash, zéro process résiduel sur Intel Arc**. La stabilité Vulkan multi-instance est validée au niveau driver.
- **Précompute pipeline complet** avec `MAPPY_PRECOMPUTE_WORKERS=2`, 10 tuiles Lausanne, 06:00-09:00 :
  - `workers=1` : 1m14s ✓
  - `workers=2 rust-wgpu-vulkan` : **8m42s** (7× plus lent)
  - `workers=2 gpu-raster` : **10m04s** (8× plus lent)
- Le ralentissement n'est donc **pas Vulkan-spécifique** — raster aussi dégrade sévèrement. Les tuiles restent bloquées longtemps en phase `prepare-context` / `prepare-points` alors que la phase `evaluate-frames` est courte.
- Hypothèses plausibles sur la cause racine du ralentissement (non confirmées) : contention I/O lors du chargement duplique de l'index bâtiments / rasters terrain / tiles végétation dans chaque worker Node, memory pressure forçant du swap, ou bug d'orchestration dans `src/lib/admin/cache-admin.ts`.

**Décision** : `MAPPY_PRECOMPUTE_WORKERS` reste à 1 dans `package.json` pour `pnpm precompute:region:vulkan` et `pnpm precompute:all-regions:vulkan`. Le parallélisme multi-worker Node ne peut pas être activé sans investigation plus approfondie du worker pool, hors scope de la phase Vulkan actuelle.

À reprendre si : l'orchestration worker pool est refactorée (par exemple partage des caches d'index via SharedArrayBuffer ou mémoire mmap, ou basculement worker threads au lieu de child processes pour partager la module-level cache).

## Conséquences

### Positives

- Le binaire Vulkan est utilisable sans recompiler en release explicite : `pnpm precompute:region:vulkan` fonctionne directement.
- Toute amélioration future de la boucle JS bénéficie aux deux chemins (raster prod et Vulkan opt-in) puisque seule la portion batch est spécialisée.
- L'ADR cadre clairement ce qui est terminé et ce qui ne sera pas repris sans changement de contexte (par exemple : meilleure compute GPU, ou réécriture de la boucle JS pour batcher la vegetation eval).

### Négatives

- Code dupliqué entre fast-path et slow-path : tout changement de la sémantique d'une frame doit être appliqué aux deux. Mitigation : commentaire en tête du fast-path référençant `evaluateInstantSunlight` comme source canonique.
- Trois exports supplémentaires depuis `solar.ts` (`getMaxHorizonAngle`, `TERRAIN_HORIZON_SKIP_MARGIN_DEG`) augmentent légèrement la surface d'API publique du module.

## Critères de réouverture

Reprendre ce travail uniquement si l'un de ces points apparaît :

- la boucle JS per-point est rendue significativement plus rapide (par exemple par batch GPU de la vegetation eval), faisant remonter Vulkan compute dans la part dominante du temps eval ;
- une régression de stabilité Vulkan apparaît (process résiduels, crashes) ;
- un changement de matériel GPU (NVIDIA / AMD) rend le path WebGPU à nouveau viable, auquel cas comparer Vulkan vs WebGPU sur cette nouvelle base.
