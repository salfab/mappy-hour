# Audit code smell & erreurs de design — MappyHour

**Date** : 2026-04-24 (rédigé pendant le run de précompute du 2026-05-05)
**Scope** : `src/`, `scripts/`, `tools/wgpu-vulkan-probe/`
**Méthode** : 10 audits ciblés (5 monolithes + 5 transverses) menés en parallèle par agents Explore
**Livrable** : ce rapport. Aucune modification de code.

---

## Executive summary

L'audit a recensé **~150 findings** distribués sur 5 monolithes et 5 axes transverses. La codebase est globalement propre (TypeScript strict, peu d'`any`, bon error-handling Rust) mais accumule de la dette aux **frontières** : GPU IPC, SSE network, format binaire atlas, env vars, et caches in-memory. Trois zones cumulent les risques **Critical** :

1. **Polymorphisme des shadow backends** — dispatch via `typeof fn === "function"` + cast `as { method?: unknown }`. Aucune capture par le typage des invariants inter-méthodes (`evaluateBatchFramesWithShadows` ⟹ `evaluateBatchWithShadows` ⟹ `evaluateBatch`).
2. **JSON.parse non validés aux frontières SSE/IPC** — 18 sites cast aveugle (events stream, GPU worker, Rust server). Toute évolution serveur silencieusement casse le client.
3. **State module-level + lifecycle GPU** — `obstacleIndexCache` jamais invalidé après ingest (data corruption silencieuse), `disposeWebGpuBackend()` sync fait fire-and-forget sur shutdown async (D3D12 segfault au redéploiement).

### Top 10 findings (sévérité × impact)

| # | Sévérité | Finding | Loc | Effort |
|---|---|---|---|---|
| 1 | **Critical** | `obstacleIndexCache` stale après ingest → outdoor/indoor mix-up silencieux | `buildings-shadow.ts:222` | M |
| 2 | **Critical** | Polymorphisme shadow backends via `typeof + as { method?: unknown }` | `sunlight-tile-service.ts:1197/1369/1393` | M |
| 3 | **Critical** | 12 SSE/IPC `JSON.parse` cast aveugle à frontière non-trusted | `sunlight-map-client.tsx:3937-4230`, `webgpu-ipc-client.ts:39+`, `rust-server-client.ts:522` | M |
| 4 | **Critical** | `disposeWebGpuBackend()` sync fire-and-forget shutdown async → D3D12 segfault | `evaluation-context.ts:dispose*` | M |
| 5 | **Critical** | `runAreaCalculation` 540L fusion instant + daily streaming | `sunlight-map-client.tsx:3816-4358` | L |
| 6 | **Critical** | Hot loop matrice 5-D booléenne implicite (~10 chemins effectifs sur 240 théoriques) | `sunlight-tile-service.ts:1115/1194/1366/1495/846` | M |
| 7 | **Critical** | Worker pool messages `as WorkerPoolMessage` sans validation Zod | `cache-admin.ts:636-691` | M |
| 8 | **Critical** | NaN silencieux nodata Rust shader → equality casse silencieusement | `main.rs:760-817` | M |
| 9 | **Critical** | Vec<u32> cloné × 4/frame batch (≈32 MiB / 1000 frames) | `main.rs:1756-1776` | M |
| 10 | **Critical** | `runDateTilesWithWorkerPool` 435L monolithe (orchestration + lifecycle + cleanup) | `cache-admin.ts:314-747` | L |

**Aucun bug actif corrompant les données** détecté à ce jour. Les Critical sont des **dettes prêtes à exploser** quand le code adjacent change (ex: ingest sans invalidation cache, déploiement sans cleanup, shape SSE différente).

---

## Sommaire

- [Section 1 — Monolithes](#section-1--monolithes)
  - [1.1 `sunlight-tile-service.ts` (2865L)](#11-sunlight-tile-servicets-2865l)
  - [1.2 `sunlight-map-client.tsx` (4871L)](#12-sunlight-map-clienttsx-4871l)
  - [1.3 `cache-admin.ts` (1740L)](#13-cache-admints-1740l)
  - [1.4 `buildings-shadow.ts` (1819L)](#14-buildings-shadowts-1819l)
  - [1.5 `tools/wgpu-vulkan-probe/src/main.rs` (3570L)](#15-toolswgpu-vulkan-probesrcmainrs-3570l)
- [Section 2 — Audits transverses](#section-2--audits-transverses)
  - [2.1 Polymorphisme shadow backends](#21-polymorphisme-shadow-backends)
  - [2.2 State / lifecycle / config sprawl](#22-state--lifecycle--config-sprawl)
  - [2.3 Duplication / parseurs dispersés](#23-duplication--parseurs-dispersés)
  - [2.4 Typing TypeScript](#24-typing-typescript)
  - [2.5 Scripts orphelins + tests](#25-scripts-orphelins--tests)
- [Section 3 — Priorisation finale](#section-3--priorisation-finale)
- [Section 4 — Recommandations & ADRs proposées](#section-4--recommandations--adrs-proposées)
- [Annexe — Localisation des parts détaillés](#annexe--localisation-des-parts-détaillés)

---

## Section 1 — Monolithes

### 1.1 `sunlight-tile-service.ts` (2865L)

**Cœur du pipeline** : `computeSunlightTileArtifact()` orchestre le calcul d'une tuile (250m × 250m) en 5 phases : adaptiveHorizon → sharedSources → pointPrep → evalSetup → frameLoop.

#### Hot loop : matrice 5-D implicite

5 booléens contrôlent ~10 chemins effectifs (sur ~240 théoriques) :

| Flag | Ligne | Sémantique |
|---|---|---|
| `useBatchPath` | 1115 | webgpu batch backend present |
| `useBatchShadows` | 1194 | has `evaluateBatchWithShadows` |
| `useBatchFrames` | 1366 | has `evaluateBatchFramesWithShadows` |
| `phaseE` | 1495 | 5-point null-check (toutes masks + pas de local terrain) |
| `batchSkipsAllEvaluators` | 846 | gridMetadata + vegetation handled by backend |

Aucune capture explicite. La validité de chaque combo n'est observable qu'en lisant 700 lignes.

#### Polymorphisme dispersé sur 4 sites

| Méthode | Garde | Site |
|---|---|---|
| `getOrigin()` | `isBatchBackend()` helper | 1119 |
| `evaluateBatch()` | **aucune** | 1604 |
| `evaluateBatchWithShadows()` | `typeof + as { method?: unknown }` | 1197 |
| `evaluateBatchFramesWithShadows()` | idem | 1369 |

Le cast `as { method?: unknown }` est un hint compilateur. Zéro garantie runtime. Voir aussi §2.1.

#### Findings

- **Critical 1** — 5-D matrix implicit
- **Critical 2** — Polymorphisme typeof
- **Critical 3** — Dispatch dispersé sur 4 sites
- **High 4** — `terrainMethod`/`buildingsMethod`/`vegetationMethod` réassignés × 3 chemins (lignes 741-1020) — extraire `resolveShadowMethods()`
- **High 5** — 10 allocations `new Uint8Array()` par frame (~18M allocs/run) → pooling
- **High 6** — `setMaskBit` inliné × 5 lignes au lieu d'utiliser le helper importé
- **High 7** — Phase E (1521) et hot loop (1647-1659) recalculent `uniqueHorizonAnglesRounded` sur les mêmes données
- **Medium 8** — `process.env.MAPPY_SUN_POSITION_ROUND_DEG` non typé/validé (1328) — voir §2.2
- **Medium 9** — `console.log` 25-ligne debug sans gating prod (1822-1846)

**Candidats d'extraction** : `shadow-dispatch.ts` (~150L), `point-evaluator.ts` (~120L), `tile-prep.ts` (~250L), `horizon-angle-cache.ts` (~80L).

---

### 1.2 `sunlight-map-client.tsx` (4871L)

**Frontend monolithe** : 28 useState + 12 useRef + tout le streaming SSE + Leaflet rendering + UI.

#### Hotspots

| Hotspot | Range | LOC | Symptôme |
|---|---|---|---|
| `runAreaCalculation` | 3816-4358 | 540 | **CRITICAL** — fusion instant (EventSource) + daily (ReadableStream + manual SSE parsing) |
| `handleSseEvent` | 4125-4242 | 120 | High — switch 5 branches × `JSON.parse` cast aveugle |
| `renderLayers` | 3075-3321 | 250 | High — 4 boucles for layers + click handlers imbriqués |
| `buildTileContourPolygons` | 1394-1505 | 110 | Medium — flood-fill non documenté |
| `prepareSunShadowGrid` + `paintSunShadowFrame` | 1233-1382 | 150 | Medium — couplage prep/paint, formats grid-indexed vs legacy non isolés |

#### Findings clés

**JSON.parse cast aveugle (8 sites)** — frontière SSE non-trusted :
- Instant stream events × 4 (lignes 3937, 3945, 3953, 3982)
- Timeline stream events × 4 (lignes 4129, 4171, 4216, 4221)

**Type safety dégradée** :
- `contourLayerRef.current!` × 5 sur même ref après `if (!ref) return` (3444-3495) — narrowing local
- `tile.tileBounds!.minLat/Lon/...` × 4 (3579) — extraction variable

**State management** :
- `instantCancelledRef` / `timelineCancelledRef` devraient être `useState`
- `decodedTimelineMaskCacheRef` croît jusqu'au prochain run (~48 MB)

**API contract brittleness** :
- Endpoints `/api/sunlight/*` hardcodés × 2 (3929, 4249)
- Timezone `"Europe/Zurich"` × 4 hardcoded (2556, 3760, 3920, 4080)
- SSE event types strings non typées (typo silencieuse)
- `masksEncoding === "gzip-concat-v1"` non versionné (4198)
- SSE order assumption "start first" sans state machine (4128-4168)

**Candidats d'extraction priorisés** : `useDailyStream` (-280L), `validateSSEPayload` (Zod), `SunlitPlacesList`, `useTilePixelMapper`, `maskDecoder` worker.

---

### 1.3 `cache-admin.ts` (1740L)

**Mélange 4 axes** : listing, actions (verify/purge), worker pool orchestration (435L), precompute principal (528L).

#### Worker pool — 435L monolithe

```
runDateTilesWithWorkerPool() 314-484  → fork + dispatch + on(message/error/exit)
shutdownWorkers()           487-545  → graceful + 5s timeout + SIGKILL
cancelWorkers()             544-589  → cancel + 1s SIGTERM + 5s SIGKILL
```

7 `catch {}` swallowed (lignes 273, 482, 511-513, 521-523, 529-531, 568-570, 577-579, 583-585). Hung workers et bugs invisibles.

#### Findings

- **Critical 1** — Messages workers `as WorkerPoolMessage` sans validation Zod runtime (636-691). Si worker corrompu, TS protège qu'à compile.
- **High 2** — Worker pool 435L monolithe (extraire `cache-admin-worker-pool.ts`)
- **High 3** — Endpoints `route.ts` appellent `verifyCacheRuns/purgeCacheRuns/precomputeCacheRuns` directement — couplage UI ← logic
- **High 4** — 6+ `catch {}` swallows worker shutdown errors
- **High 5** — Pas de timeout global pour worker pool (dépend du `signal` appelant)
- **High 6** — `jobs` Map (cache-precompute-jobs.ts) croissance non bornée — eviction soft >40 seulement, jobs terminal restent enregistrés
- **Medium 7** — Logs `console.warn` string-concat + JSON.stringify inline (illisible obs)
- **Medium 8** — `runningFractions` Map mutée sans lock (race possible si progression rapide)

---

### 1.4 `buildings-shadow.ts` (1819L)

**Plusieurs implémentations CPU** golden reference pour valider GPU.

#### Variantes

| Variante | Range | Status |
|---|---|---|
| `evaluateBuildingsShadow()` | 1477-1713 | **Active** — golden reference principale, utilisée par CPU backend |
| `evaluateBuildingsShadowTwoLevel()` | 1715-1819 | **Deprecated** — 0 callsites en `src/lib/`, scripts analysis only |
| `createDetailedBuildingShadowVerifier()` | 1421-1472 | Indirect via TwoLevel uniquement |

#### Findings

- **High 1** — Allocations debug en hot loop (`checkedObstacleIds.push()` ~500x/query, ligne 1620)
- **High 2** — BVH stack DFS alloué à chaque traversal (1350)
- **High 3** — Epsilon incohérents : 1e-6, 1e-9, 1e-12 dans 4 sites sans pattern (603/630/975/1056). `building-footprint.ts` définit déjà `EPSILON = 1e-9` non importé.
- **Medium 4** — Magic threshold `score > 6` non documenté (1242)
- **Medium 5** — Variante TwoLevel deprecated, à archiver dans `_legacy/`
- **Medium 6** — Hot loop avec 7 `continue` imbriqués (1557-1617)

**Candidats d'extraction** : `geometry-constants.ts` (S), `mesh-bvh-builder.ts` (M), `polyface-parser.ts` (M), `ray-polygon-2d.ts` (S), `spatial-grid-utils.ts` (S).

---

### 1.5 `tools/wgpu-vulkan-probe/src/main.rs` (3570L)

**Single-file Rust** : argv + IPC server + Vulkan setup + 2 shaders WGSL inline (1 trivial 17L + 1 compute 274L) + handlers + lifecycle. Aucun panic, aucun unsafe ✓.

#### Modes (4)

`Adapter | Render | Shadow | Server`. Render et Shadow fusionnés via flag bool, pas vraiment séparés.

#### Shader compute (2372-2646, 274L)

14 bindings (group 0/0-13). Functions `sample_terrain_elevation` (18L) et `sample_veg_elevation` (34L) **identiques sauf nom** — WGSL ne supporte pas macros, copy-paste inhérente.

#### Findings

- **Critical 1** — `unwrap_or(f32::NAN)` pour nodata (760-817) → equality `abs(val - nodata) < eps` toujours faux silencieusement
- **Critical 2** — Vec<u32> cloné × 4/frame en batch (1756-1776) — ≈32 MiB pour 1000 frames
- **Critical 3** — Buffer leak partiel possible si bind_group creation échoue après buffers (1887-1925)
- **High 4** — Sample functions duplicate (terrain vs veg, 2447-2501) — accepter et documenter
- **High 5** — `request.id.clone()` per-request server loop (552)
- **High 6** — Cast bytes→u32 sans bounds-check assertion (3085-3089)
- **High 7** — `device.poll(timeout: 30/60s)` hardcodé non adaptatif (1345, 1694)
- **Medium 8-12** — `let _ = i;`, magic π × 3, `textureLoad × 4` manuel sans comment, etc.

**Candidats d'extraction** : sortir shaders en `.wgsl` (debugging IDE), IPC handlers en modules, `vulkan/setup.rs`, `gpu/math.rs`, `gpu/readback.rs`.

---

## Section 2 — Audits transverses

### 2.1 Polymorphisme shadow backends

#### Matrice [méthode × backend]

| Méthode | CPU | GPU-raster | WebGPU | Rust/wgpu | WebGPU-IPC | Déclarée |
|---|---|---|---|---|---|---|
| `evaluate()`, `dispose()`, `prepareSunPosition()` | ✓ | ✓ | ✓ | ✓ | ✓ | `BuildingShadowBackend` |
| `getOrigin()`, `evaluateBatch()`, `setFrustumFocus()` | ✗ | ✗ | ✓ | ✓ | ✓ | `BatchBuildingShadowBackend` |
| `uploadHorizonMasks?()`, `uploadVegetationRasters?()` | ✗ | ✗ | ✗ | ✓ | ✗ | optional |
| `evaluateBatchWithShadows?()`, `evaluateBatchFramesWithShadows?()` | ✗ | ✗ | ✗ | ✓ | ✗ | optional |
| `updateMesh?()`, `shutdown?()` | ✗ | ✗ | ✗ | ✓ | ✗ | **NON déclarée** |

**Anomalies** :
- `updateMesh()`, `shutdown()` Rust-spécifiques découvertes par introspection runtime uniquement
- 4 méthodes optionnelles `?:` implémentées par 1 seul backend (Rust)

#### 11 call sites de dispatch fragile

| Fichier | Ligne | Pattern | Sévérité |
|---|---|---|---|
| `sunlight-tile-service.ts` | 1197/1369/1393 | `typeof + as {method?:unknown}` | **Critical** |
| `webgpu-worker-process.ts` | 74/81/90 | Aucune garde | **Critical** |
| `check-vulkan-vs-gpuraster.ts` | 267-278 | `as unknown as {...}` | **Critical** |
| `evaluation-context.ts` | 289 | `"shutdown" in backend` (méthode non déclarée) | High |
| `evaluation-context.ts` | 325/340/575 | `"setFrustumFocus" in` × 3 + `"updateMesh" in` | High |
| `evaluation-context.ts` | 345-354 | `as unknown as {...}` double cast | High |

#### Architecture cible : Discriminated Union + caps (recommandée)

```typescript
type BackendType = "cpu" | "gpu-raster" | "webgpu-compute" | "rust-wgpu-vulkan" | "webgpu-ipc";
interface BackendCaps {
  type: BackendType;
  hasBatch: boolean;
  hasBatchWithShadows: boolean;
  hasBatchFrames: boolean;
  hasUpdateMesh: boolean;
  hasShutdown: boolean;
}
interface BuildingShadowBackend { readonly caps: BackendCaps; ... }
```

Callers : `if (backend.caps.hasBatchFrames) ...`. **Effort : ~3j, +20L net, refacto ~500L existantes, 0 runtime risk.**

---

### 2.2 State / lifecycle / config sprawl

#### Caches in-memory non bornés

| Cache | Loc | Risque | Sévérité |
|---|---|---|---|
| `obstacleIndexCache` | buildings-shadow.ts:222 | Stale après ingest → outdoor/indoor mix-up silencieux | **Critical** |
| `zipPolyfaceCache` | buildings-shadow.ts:224 | Fuite mémoire DXF parsed | **Critical** |
| `detailedMeshCacheByObstacleId` | buildings-shadow.ts:225 | >10K bâtiments × mesh = >100 MB | **Critical** |
| `jobs` Map | cache-precompute-jobs.ts:47 | Eviction soft >40, jobs terminal restent | High |
| `maskCache` | dynamic-horizon-mask.ts:38 | ~5K entries en live API | Medium |
| `tileAtlasMemoryCache` | sunlight-tile-service.ts:91 | TTL 300s vs autres 60s — incohérence | Medium |

#### Dispose asymétrique (D3D12 segfault au redéploiement)

```
disposeWebGpuBackend()  [SYNC]   → rust.dispose() → void this.shutdown().catch(...)  ← FIRE-AND-FORGET !
disposeWebGpuBackendAsync() [ASYNC] → await backend.shutdown() (5000ms timeout)
```

Server cleanup utilise sync → process Rust pas tué → segfault. **Critical**.

#### 17 variables `MAPPY_*` dispersées

| Variable | Files | Validation |
|---|---|---|
| `MAPPY_BUILDINGS_SHADOW_MODE` | 9+ | enum hardcoded |
| `MAPPY_PRECOMPUTE_WORKERS` | 3 | `Number()` (NaN possible) |
| `MAPPY_PRECOMPUTE_WORKERS_STRICT` | 2 | `=== "1"` (loose) |
| `MAPPY_RUST_WGPU_FOCUS_MARGIN_METERS` | 2 | `isFinite() && >= 0` ✓ |
| `MAPPY_DATA_ROOT` | 3 | `path.isAbsolute()` ✓ |
| ... 12 autres | | la plupart loose ou inexistante |

**Aucun schema central**. 13 src files + 20 scripts.

#### CLI args sprawl

8 réimplémentations indépendantes de `parseArgs()`. Variations subtiles (validation région inline ou helper, `manage-sunlight-cache.ts:30` valide encore lausanne/nyon only — bug latent).

#### Architecture cible

| Module | Effort |
|---|---|
| `src/lib/config/env-schema.ts` (Zod) | M |
| `src/lib/cli/common-args.ts` | M |
| `src/lib/sun/gpu-backend-manager.ts` (state machine) | L |
| `BoundedCache<K,V>` LRU wrapper appliqué aux 5 caches non bornés | M |
| `cacheInvalidators.buildingsDataChanged()` hooks | S |

**Effort total** : ~140h (80h refacto lifecycle, 40h LRU+invalidation, 20h tests).

---

### 2.3 Duplication / parseurs dispersés

#### 7 clusters identifiés

| # | Cluster | Sévérité | Effort | Priorité |
|---|---|---|---|---|
| 1 | Tile ID `e_n_s` parsing | Low | 0.5j | P3 |
| 2 | Manifest paths (`region === "lausanne" ? ...`) | Medium | 1j | P2 |
| 3 | **Régions/bbox hardcodés (5+ fichiers, sync TS↔Python cassé)** | **High** | 1.5j | P1 |
| 4 | **CLI args (8 parseArgs indépendants)** | **High** | 2j | P1 |
| 5 | Constantes magiques (grid step 1m, sample 15min, GPU workgroup 256) | Medium | 0.5j | P2 |
| 6 | Format atlas (constants partagés client/serveur) | Low | 0.5j | P3 |
| 7 | Parseurs bbox/boolean (inclus dans 4) | Low | - | - |

#### Bug latent confirmé

- `manage-sunlight-cache.ts:30` valide encore `["lausanne", "nyon"]` — typo silencieuse pour morges/geneve/vevey
- `precompute-webgpu.ts:43-78` : aucune validation région
- `compose-vhm-canopy.py` : REGIONS dict bbox LV95 dupliqué (PAS sync avec TS)

#### Architecture cible

| Module | Contenu |
|---|---|
| `src/lib/config/regions.ts` | `SUPPORTED_REGIONS`, `REGION_CONFIGS` typés |
| `src/lib/precompute/cli-args.ts` | builder réutilisable + validateurs |
| `src/lib/precompute/tile-id.ts` | `tileIdFromCoords` + `parseTileId` |
| `src/lib/encoding/atlas-format.ts` | constants partagés client/serveur |
| `src/lib/precompute/region-manifests.ts` | `getManifestPaths(region)` |

**Effort total** : ~5j optimiste / 7j conservateur.

---

### 2.4 Typing TypeScript

#### Métriques

- **95 non-null assertions `!`** (15 fichiers) — top 3 : `sunlight-tile-service.ts` (13), `building-footprint.ts` (13, OK boucles), `timeline/stream/route.ts` (10, **dont 3 faux**)
- **2 `any` explicites** (cache-admin.ts:1483, sunlight-cache.ts:299 generic)
- **3 `eslint-disable`** tous justifiés
- **32 `JSON.parse`** dont **18 cast aveugle CRITICAL** aux frontières SSE/IPC
- **92 `throw new Error`** sans hiérarchie

#### Triage JSON.parse par frontière

| Frontière | Sites | Risk |
|---|---|---|
| **WebSocket/SSE (server→client)** | 12 | **CRITICAL** |
| **GPU IPC (worker JSON)** | 6 | **CRITICAL** |
| Browser localStorage | 2 | High |
| Cache files (disk) | 8 | Medium |
| Manifests trusted | 4 | Low |

#### tsconfig manquants

```json
"noUncheckedIndexedAccess": true,
"exactOptionalPropertyTypes": true,
"noImplicitOverride": true,
"useUnknownInCatchVariables": true
```

**Impact estimé** : 20-30 nouveaux warnings, 2-3h fix, zero behavior changes.

#### Roadmap typing

| Phase | Effort | Impact |
|---|---|---|
| 1 — tsconfig + localStorage Zod | 2h | Prévention futurs `any/unknown` |
| 2 — SSE/IPC Zod (CRITICAL) | 4h | Élimine 18/32 risk sites |
| 3 — Hiérarchie d'erreurs | 8h | Maintenabilité + debug |
| 4 — `!` reduction (extractions) | 6h | ~30/95 → 0 unjustified |
| 5 — Generics validation helpers | 3h | DRY frontières |
| **Total production-ready** | **23h** | |

---

### 2.5 Scripts orphelins + tests

#### Scripts `_*` (54 total)

- ~35 archive utile (>100L, patterns cohérents bench/compare/verify/scan) — Keep + README
- ~12 vestiges (géo-spécifiques fragmentés) — Archiver dossier daté
- ~7 morts (<40L, cryptiques) — Supprimer

`pnpm tsc --noEmit` passe ✓ — pas de blocage.

#### Tests existants (21 fichiers, 4314 LOC)

- 18/21 passing (86%)
- 3 skip markers
- `evaluation-context.test.ts` : 1 test cassé pre-existing

#### Surfaces critiques SANS test (10 modules >500L)

| Module | LOC | Gap |
|---|---|---|
| `sunlight-tile-service.ts` | 2865 | **Cœur pipeline, 0 test** |
| `cache-admin.ts` | 1740 | Régen atlas, 0 test |
| `rust-wgpu-vulkan-shadow-backend.ts` | 958 | Vulkan TS abstraction, 0 test |
| `cache-precompute-jobs.ts` | 743 | État métier jobs, 0 test |
| `webgpu-compute-shadow-backend.ts` | 700 | Fallback GPU, 0 test |
| `gpu-building-shadow-backend.ts` | 696 | Ombres bâtis GPU, 0 test |
| `vegetation-shadow.ts` | 530 | Shadow végétation, 0 test |
| `sunlight-cache-binary.ts` | 451 | Encoding/decoding binaire, 0 test |
| `swiss-terrain.ts` | 383 | SwissALTI3D + dedup récent (2026-05-04), 0 test |
| `model-version.ts` | 226 | Hash + gridMetadataHash split (5be2ce2), 0 test |

#### CI

`.github/workflows/` **n'existe pas**. Blocages : Rust wgpu compilation, GPU drivers Linux headless, tests longs.

**Stratégie pragmatique** : Phase 1 pre-submit (tsc + eslint + Vitest sans GPU, 4-6h), Phase 2 unit tests prioritaires (mask-codec, terrain dedup, model-version, binary, 12h), Phase 3 GPU intégration sur self-hosted runner (XL).

#### Effort cumulé

~24-30h (cleanup orphelins + tests gaps prioritaires + CI minimal).

---

## Section 3 — Priorisation finale

### Matrice sévérité × effort

| Sévérité \ Effort | S (<1j) | M (1-3j) | L (1 sem) | XL (multi-sem) |
|---|---|---|---|---|
| **Critical** | #3 timeline `artifact!` guard | #1 obstacleIndexCache invalidation, #2 polymorphisme typeof, #3 SSE/IPC Zod, #4 dispose async, #6 hot loop matrix, #7 worker pool Zod, #8 NaN nodata | #5 runAreaCalculation split, #10 worker pool extract | — |
| **High** | tsconfig flags, `manage-sunlight-cache.ts` whitelist, hot loop helpers | regions.ts, cli-args.ts, env-schema.ts, jobs Map purge, BoundedCache LRU, GPU caches, terrain dedup test, model-version test | mesh-bvh-builder extract, point-evaluator extract, hierarchie d'erreurs | — |
| **Medium** | Atlas TTL alignment, console.log gating, magic constants centralization, scripts morts delete | tile-prep extract, polyface-parser extract, atlas-format.ts, manifest paths centralization | TwoLevel CPU → `_legacy/` | — |
| **Low** | Tile ID parser centralize, comments cleanup, archive `_` README | — | — | — |

### Plan d'attaque suggéré (sprints 2 semaines)

**Sprint 1 — Safety net** (avant tout autre refacto)

- Phase 1 typing : tsconfig flags + Zod localStorage (2h)
- Phase 2 typing : Zod SSE/IPC payloads (4h) — **CRITICAL**
- `obstacleIndexCache` invalidation hook + cache invalidators (M)
- `disposeWebGpuBackend` unification async (M)
- `manage-sunlight-cache.ts` whitelist fix (S)
- Tests gaps prioritaires : `swiss-terrain` (terrain dedup), `model-version` (gridMetadataHash split), `mask-codec`, `sunlight-cache-binary` (L)

**Sprint 2 — Architecture polymorphisme**

- Discriminated Union + `BackendCaps` sur tous les backends (M)
- Refacto sites `typeof + as {method?:unknown}` (S après cap)
- Extraire `RustBuildingShadowBackend extends BatchBuildingShadowBackend` avec `updateMesh` + `shutdown` typés (S)
- Documenter invariants D ⟹ C+ ⟹ batch (S)

**Sprint 3 — Configuration & duplication**

- `regions.ts` (P1, H)
- `cli-args.ts` + refacto 8 scripts (P1, M)
- `env-schema.ts` Zod (M)
- `region-manifests.ts` (P2)
- `constants.ts` étendu (P2)

**Sprint 4 — Monolithes**

- `sunlight-tile-service.ts` : extraire `shadow-dispatch.ts` + `point-evaluator.ts` (~M)
- `cache-admin.ts` : extraire `cache-admin-worker-pool.ts` (L)
- `sunlight-map-client.tsx` : extraire `useDailyStream` + `validateSSEPayload` (L)
- `main.rs` : sortir shaders en `.wgsl` + IPC handlers en modules (M)
- `buildings-shadow.ts` : centraliser geometry constants + déprécier TwoLevel (M)

**Sprint 5 — CI + finalisation**

- `BoundedCache` LRU wrapper sur 5 caches non bornés
- Hierarchie d'erreurs (rust-server-client + cache-admin-client)
- `!` reduction extractions
- CI GitHub Actions phase 1 (tsc + lint + tests sans GPU)
- Documenter scripts archivés (README batch)

---

## Section 4 — Recommandations & ADRs proposées

### ADRs à écrire

| Numéro proposé | Titre | Décision |
|---|---|---|
| **ADR-0018** | Polymorphisme shadow backends via Discriminated Union + caps | Choisir option A vs B vs C (cf §2.1) |
| **ADR-0019** | Schema central de configuration (Zod) | Adoption de `env-schema.ts` |
| **ADR-0020** | Validation Zod aux frontières SSE/IPC/GPU | Standard projet |
| **ADR-0021** | Centralisation régions + bbox (TS source of truth, génération Python) | Cf §2.3 cluster 3 |
| **ADR-0022** | Lifecycle GPU backend : state machine + dispose async unique | Cf §2.2 |
| **ADR-0023** | Hiérarchie d'erreurs typées (`MappyError` + sub-classes) | Optionnel, polish |
| **ADR-0024** | Stratégie CI (3 phases : pre-submit / unit / GPU intégration) | Si CI activée |

### Entrées `shortcuts-registry.md` à ajouter

| Raccourci | Hypothèse | Condition d'invalidité |
|---|---|---|
| `obstacleIndexCache` lazy single-load | Données bâtiments stables au runtime | Ingest pendant runtime serveur |
| `evaluateBuildingsShadowTwoLevel` deprecated | GPU Vulkan couvre tous les besoins | Régression Vulkan, fallback CPU requis |
| WGSL shader sample functions duplicate | WGSL ne supporte pas macros | Migration vers Slang ou autre langage |
| 17 variables `MAPPY_*` éparpillées | Codebase de prototype, pas de prod externe | Externalisation, multi-tenant |
| Tests GPU non en CI | Self-hosted runner trop coûteux pour POC | Adoption SaaS cloud GPU |

### Tickets / TODOs à créer

Cf liste des findings Critical/High dans la matrice §3. À transformer en issues dès retour de vacances.

### Fixes immédiats (sans attendre sprint planning)

1. `manage-sunlight-cache.ts:30` — étendre whitelist régions (typo silencieuse latente)
2. `tsconfig.json` — activer `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` (2-3h, warnings only)
3. `obstacleIndexCache` — ajouter invalidation hook au minimum (3h)

### TODOs perf identifiés post-audit (2026-05-06)

| TODO | Statut | Estim. gain | Effort | Mémoire |
|---|---|---|---|---|
| **Multi-session côté Rust server** (vrai overlap GPU N/N+1) | Pas démarré | ~30% wall-time | XL (refacto Rust) | (à créer) |
| **Optim shader WGSL** (réduire dispatches/samples) | Pas démarré | ~10-20% | M | (à créer) |
| **True binary IPC framing** (option B, vs option A faite via fichier .bin) | Pas prioritaire | ~2% | M | `project_ipc_binary_framing_todo.md` |
| **Sanity checks env vars par mode** (cleanup) | Partiellement fait (workers + pipeline-depth) | hygiène | S-M | `project_env_vars_cleanup.md` |

Optims **déjà appliquées** post-audit :
- ADR-0019 : default WORKERS=1 pour GPU-IPC backends (~15× vs default 4)
- Async atlas-write fire-and-forget (-37% wall-time)
- Tile pipeline depth=2 + IPC mutex + backend transaction lock (2.20× supplémentaire)
- IPC binaire pour `evaluate_batch` bitmasks via fichier .bin (gain à valider en prod)
- Cumul mesuré : **~4-8× plus rapide qu'avant la session**

---

## Annexe — Localisation des parts détaillés

Chaque audit a un part dédié dans `docs/audits/code-smell-2026-04-24-parts/` :

| Part | Fichier |
|---|---|
| Buildings-shadow CPU | `01-buildings-shadow.md` |
| Sunlight-map-client | `02-sunlight-map-client.md` |
| Sunlight-tile-service | `03-sunlight-tile-service.md` |
| Cache-admin | `04-cache-admin.md` |
| Rust probe main.rs | `05-rust-probe-main.md` |
| Shadow backends polymorphism | `06-shadow-backends-polymorphism.md` |
| State / lifecycle / config | `07-state-lifecycle-config.md` |
| Duplication | `08-duplication.md` |
| Typing | `09-typing.md` |
| Scripts orphelins + tests | `10-scripts-tests.md` |

Les parts contiennent les findings exhaustifs, tableaux d'inventaire, et recommandations détaillées non incluses dans ce résumé.

---

## Méthodologie de non-régression (rappel pour les chantiers)

Cf section dédiée du plan. Pour tout chantier touchant les 4 surfaces critiques (atlas cache, grid metadata, raw ingestion, API contracts) :

1. `git tag baseline/<chantier>-<date>` avant
2. Capture goldens (atlas + grid + API snapshots)
3. Refacto par micro-étapes (1 changement logique / commit)
4. Validation post-refacto vs goldens
5. Rollback plan documenté

**Red flags STOP-REFACTOR** : changement `modelVersionHash` pour mêmes inputs, changement `SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION` sans bump, breaking change API sans coordination front, comparaison golden hors seuils sans ADR.

À activer dès le premier chantier Sprint 1.

---

**Fin du rapport.** ~150 findings, ~10 ADRs proposées, ~100j de chantiers identifiés (~5 sprints de 2 semaines).
