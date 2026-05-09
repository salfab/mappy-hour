# Audit transversal : État module-level, lifecycle, config sprawl

## Partie 1 — Inventaire état module-level

### Backends GPU (evaluation-context.ts)

| Var | Ligne | Type | Risque | Sévérité |
|---|---|---|---|---|
| `gpuBackendCache` | 163 | Backend \| null | Race read/write parallèle | High |
| `gpuBackendFocusKey` | 164 | string | Mutée sur focus change, pas de cleanup | Med |
| `gpuBackendLoading` | 165 | Promise \| null | Peut fuiter si init crash avant finally | High |
| `webgpuBackendCache` | 262 | Backend \| null | 2 fonctions dispose asymétriques | High |
| `webgpuBackendLoading` | 297 | Promise \| null | Same pattern | Med |
| `rustWgpuVulkanBackendCache` | 299 | Backend \| null | dispose/shutdown asymétrique, focus tracking complexe | **Critical** |
| `rustWgpuVulkanBackendFocusKey` | 300 | string | Dépendance implicite à backendCache | Med |
| `rustWgpuVulkanBackendLoading` | 301 | Promise \| null | Promise reuse pattern | Med |

### Caches buildings/végétation (jamais purgés)

| Var | Fichier:ligne | Risque | Sévérité |
|---|---|---|---|
| `obstacleIndexCache` | buildings-shadow.ts:222 | **Stale après ingest → data corruption silencieuse** | **Critical** |
| `zipPolyfaceCache` | buildings-shadow.ts:224 | Fuite mémoire (DXF parsed meshes accumulés) | **Critical** |
| `detailedMeshCacheByObstacleId` | buildings-shadow.ts:225 | Fuite : >10K bâtiments × mesh = >100MB | **Critical** |
| `assignmentCache` | adaptive-horizon-sharing.ts:65 | ~200 keys max, OK | Low |
| `maskCache` | dynamic-horizon-mask.ts:38 | ~5K entries observed sous live API | Med |
| `vegetationTileRasterCache` | vegetation-shadow.ts:57 | Croît avec tiles uniques | Med |
| `terrainRasterCache` | swiss-terrain.ts:39 | ~2K tiles Lausanne, OK borné région | Med |

### Caches précompute (TTL OK mais incohérences)

| Var | Fichier:ligne | TTL/Cap | Note |
|---|---|---|---|
| `manifestMemoryCache` | sunlight-tile-service.ts:88 | 60s/64 | OK |
| `tileMemoryCache` | sunlight-tile-service.ts:89 | 60s/128 | OK |
| `tileBinaryMemoryCache` | sunlight-tile-service.ts:90 | 60s/128 | OK |
| `tileAtlasMemoryCache` | sunlight-tile-service.ts:91 | **300s**/64 | **Incohérence : TTL 5× plus long** que les autres |
| `atlasSkipCache` | atlas-tile-service.ts:42 | sans bound | Med |

### Jobs admin (cache-precompute-jobs.ts)

| Var | Ligne | Lifecycle |
|---|---|---|
| `jobs` | 47 | `evictFinishedJobs()` si size>40 (soft) — jamais purgé totalement |
| `jobAbortControllers` | 48 | Fuite si crash avant cleanup |
| `lastPersistedAtMs` | 52 | Sans cleanup sur éviction → orphans |

## Partie 2 — Dispose / Shutdown lifecycle

### Asymétrie dangerous

```
disposeWebGpuBackend() [SYNC]
  └─ rustWgpuVulkanBackendCache?.dispose()
     └─ void this.shutdown().catch(...)  ← FIRE-AND-FORGET, pas await !

disposeWebGpuBackendAsync() [ASYNC]
  └─ if rust-wgpu-vulkan: await backend.shutdown() (5000ms timeout)
```

**Bug observé** : Server cleanup utilise `disposeWebGpuBackend()` (sync) → process Rust pas tué → D3D12 segfault au redéploiement.

### Recommandations dispose

1. Supprimer `disposeWebGpuBackend()` sync, garder uniquement async
2. Process exit hook avec await + timeout
3. State machine explicite : `UNINITIALIZED | INITIALIZING | READY | BROKEN | SHUTDOWN`

## Partie 3 — Config sprawl

### 17 variables `MAPPY_*` éparpillées

| Variable | Fichiers | Type | Default | Validation |
|---|---|---|---|---|
| `MAPPY_BUILDINGS_SHADOW_MODE` | 9+ | enum string | "detailed" | hardcoded enum list |
| `MAPPY_BUILDINGS_TWO_LEVEL_REFINEMENT` | 1 | bool string | true | loose ("0"==false) |
| `MAPPY_RUST_WGPU_FOCUS_MARGIN_METERS` | 2 | int | 500 | isFinite & ≥0 |
| `MAPPY_RUST_WGPU_PROBE_PROFILE` | 1 | enum | "release" | loose |
| `MAPPY_RUST_WGPU_OUTPUT_DIR` | 1 | path | (default) | none |
| `MAPPY_WEBGPU_BACKEND` | 1 | enum | "auto" | loose (passed to Dawn) |
| `MAPPY_WEBGPU_DLLDIR` | 1 | path | undef | none |
| `MAPPY_WEBGPU_COMPUTE_MAX_POINTS_PER_DISPATCH` | 1 | int | 16384 | none |
| `MAPPY_WEBGPU_IPC_MAX_BATCH_POINTS` | 1 | int | 65536 | none |
| `MAPPY_WEBGPU_FOCUS_MARGIN_METERS` | 1 | int | 5000 | none |
| `MAPPY_PRECOMPUTE_WORKERS` | 3 | int | os.cpus().length | loose (NaN possible) |
| `MAPPY_PRECOMPUTE_WORKERS_STRICT` | 2 | bool | false | loose ("1"==true) |
| `MAPPY_DATA_ROOT` | 3 | path | cwd/data | path.isAbsolute |
| `MAPPY_VHM_SHADER_COMPOSE` | 1 | bool | false | loose |
| `MAPPY_VHM_PYTHON` | 1 | path | "python3" | none |
| `MAPPY_SUN_POSITION_ROUND_DEG` | 1 | float | undef | none |
| `MAPPY_SHADOW_BACKEND` | 1 | enum | undef | only "gpu"/undef |
| `MAPPY_CHECK_MODEL_HASH` | 1 | string | null | none |

**Total** : 17 variables × 13 src files + 20 scripts. Aucun schema central.

### CLI args dupliqués

| Arg | Scripts | Pattern |
|---|---|---|
| `--region=` | 15+ | Inconsistent validation (vevey ajouté tardivement → certains scripts l'ignoraient) |
| `--days=` / `--start-date=` / `--grid-step=` etc. | 12+ | 40+ occurrences, no shared schema |
| `--buildings-shadow-mode=` | 3 | Custom parseArgs + set env var |
| `--tile-selection-file=` | 2 | Path resolution varies |
| `--group-filter=` | 1 | Custom parse |

**25+ `parseArgs()` independents**. Bug récent : ajout vevey, 1 script l'avait, autres l'ignoraient silencieusement.

### Régions hardcodées

- Type `PrecomputedRegionName` (sunlight-cache.ts:19) : 5 régions
- `PRECOMPUTED_REGIONS` array (sunlight-tile-service.ts:87) : **excludes vevey** !
- Default fallback `?? "lausanne"` (evaluation-context.ts:600, 631) — défaut caché
- 5 fichiers `XXX_CONFIG` avec bbox hardcodés

## Findings

### CRITICAL

| ID | Loc | Symptôme | Effort |
|---|---|---|---|
| 1 | buildings-shadow.ts:222 | `obstacleIndexCache` stale après ingest, no invalidation | M |
| 2 | buildings-shadow.ts:224, 225 | `zipPolyfaceCache` + `detailedMeshCacheByObstacleId` fuite mémoire | M |
| 3 | evaluation-context.ts:299 | `rustWgpuVulkanBackendCache` state ambigu (undefined vs null vs broken) | L |
| 4 | evaluation-context.ts:dispose* | `disposeWebGpuBackend()` sync fire-and-forget shutdown async (D3D12 segfault) | M |

### HIGH

| ID | Loc | Symptôme | Effort |
|---|---|---|---|
| 5 | evaluation-context.ts:165, 297, 301 | Promises `*Loading` peuvent fuiter si init crash | S |
| 6 | cache-precompute-jobs.ts:47, 48, 52 | Maps croissance non bornée, eviction soft seulement | M |
| 7 | 17 vars × 13 files | Pas de schema config central, validations loose | M |
| 8 | 25+ parseArgs scripts | Pas de schema CLI commun, bugs comme vevey récurrents | M |
| 9 | sunlight-tile-service.ts:87 | `PRECOMPUTED_REGIONS` array exclut "vevey" silencieusement | S |

### MEDIUM

| ID | Loc | Symptôme | Effort |
|---|---|---|---|
| 10 | sunlight-tile-service.ts:91 | Atlas TTL 300s vs autres 60s — incohérence | S |
| 11 | atlas-tile-service.ts:42 | `atlasSkipCache` croît sans bound | S |
| 12 | dynamic-horizon-mask.ts:38 | `maskCache` ~5K entries en live API | M |
| 13 | evaluation-context.ts:600, 631 | Default `?? "lausanne"` défaut caché | S |

## Architecture cible recommandée

### 1. Schema config central (`src/lib/config/env-schema.ts`)

Zod schema avec parse au startup (fail-fast). 17 vars consolidées en un objet `Config` typé. Effort : ~M.

### 2. CLI args common (`src/lib/cli/common-args.ts`)

`parseCommonArgs(argv)` partagé par 25+ scripts. Effort : ~M.

### 3. GPU backend lifecycle (`src/lib/sun/gpu-backend-manager.ts`)

Class avec state machine explicite (`UNINITIALIZED | INITIALIZING | READY | BROKEN | SHUTDOWN`). Effort : ~L.

### 4. LRU bornées pour caches sans purge

Wrapper `BoundedCache<K,V>` à appliquer aux 3 caches buildings + 1 vegetation + 1 mask. Effort : ~M.

### 5. Cache invalidation hooks

`cacheInvalidators.buildingsDataChanged()` appelé par scripts d'ingest. Effort : ~S.

## Synthèse

| Sévérité | Count |
|---|---|
| Critical | 4 |
| High | 5 |
| Medium | 4 |

13 findings. Effort total estimé : ~140h (80h refacto lifecycle, 40h LRU+invalidation, 20h tests).

**Priorisation immédiate** :
1. Fix `obstacleIndexCache` stale (silent data corruption)
2. Fix dispose async D3D12 segfault
3. Fix Rust backend state machine (focus bugs)
