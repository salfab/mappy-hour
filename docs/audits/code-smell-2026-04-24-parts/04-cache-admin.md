# Audit `src/lib/admin/cache-admin.ts` (1740 lignes)

## Sections

| Plage | Rôle |
|---|---|
| 1-288 | Imports + interfaces (WorkerPoolMessage, etc.) |
| 194-747 | **Worker pool orchestration (435L)** |
| 314-484 | `runDateTilesWithWorkerPool()` |
| 487-545 | `shutdownWorkers()` (graceful + 5s timeout + SIGKILL) |
| 544-589 | `cancelWorkers()` (cancel + 1s SIGTERM + 5s SIGKILL) |
| 591-720 | dispatch closure + worker.on handlers |
| 790-908 | Listing & manifest (`findManifestFiles`, `listMatchingManifests`, `toRunSummary`) |
| 992-1041 | Listing public API (`listCacheRuns` + pagination) |
| 1047-1211 | Verify & purge actions |
| 1213-1740 | Precompute principal (orchestration séquentielle + worker pool) |

## Mélange de responsabilités

| Axe | Fonctions | Verdict |
|---|---|---|
| Listing | 6 funcs (`findManifestFiles`, `listMatchingManifests`, `toRunSummary`, `withStorageStats`, `compareRuns`, `listCacheRuns`) | Fragmenté géographiquement, OK conceptuellement |
| Actions | `verifyCacheRuns`, `purgeCacheRuns` | Clair |
| Worker pool | `runDateTilesWithWorkerPool` + `shutdownWorkers` + `cancelWorkers` (3 funcs / 435L) | **Symptomatique** : tout fait, lifecycle imbriqué |
| Jobs | (en `cache-precompute-jobs.ts`) | Bien isolé ailleurs |

`precomputeCacheRuns()` (1213) appelle directement worker pool sans abstraction.

## State module-level

**Dans cache-admin.ts** : zéro `let` module-level. ✓

**Dans `cache-precompute-jobs.ts` (lié)** :
- `jobs = new Map<string, CachePrecomputeJob>()` — jamais purgé
- `jobAbortControllers = new Map<...>` — jamais purgé
- `lastPersistedAtMs = new Map<...>` — jamais purgé
- **Fuite mémoire potentielle** : jobs terminal restent enregistrés jusqu'au reboot serveur.

## Errors swallowed (catch vides)

| Loc | Pattern |
|---|---|
| 273 | `JSON.stringify(error)` catch vide |
| 482 | `worker.send()` swallow disconnected |
| 511-513 | shutdown signal failures |
| 521-523 | forced SIGTERM failures |
| 529-531 | SIGKILL failures |
| 568-570, 577-579, 583-585 | cancel paths × 3 |

7 silenced exceptions. Hung workers / bugs invisibles.

## Findings

### CRITICAL

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 1 | **Critical** | 636-691 | Messages workers `as WorkerPoolMessage` sans validation Zod runtime | M |

### HIGH

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 2 | High | 314-747 | Worker pool 435L monolithe, lifecycle/orchestration/cleanup mélangés | L |
| 3 | High | api/admin/cache/actions/route.ts:71/131 | Endpoints appellent `verifyCacheRuns`/`purgeCacheRuns`/`precomputeCacheRuns` directement (couplage UI ← logic) | M |
| 4 | High | 514-535, 568-580 | 6+ `catch {}` swallows worker shutdown errors | S |
| 5 | High | 314-747 | Pas de timeout global pour worker pool ; dépend du `signal` appelant | M |
| 6 | High | jobs.ts | `jobs` Map croissance infinie (pas de TTL/cleanup post-terminal) | M |

### MEDIUM

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 7 | Medium | 662-668, 1576-1582 | Logs `console.warn` string-concat + JSON.stringify inline (illisible obs) | S |
| 8 | Medium | 875-908 | 6 funcs listing fragmentées | M |
| 9 | Medium | 346, 374 | `runningFractions` Map mutée dans `emitRunningProgress()` sans lock — race possible si progression rapide | S |

### NITPICK

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 10 | Nitpick | 482 | `sendWorkerCommand()` catch sans JSDoc explicatif | S |

## Candidats d'extraction

| Module | Source | Effort |
|---|---|---|
| `cache-admin-worker-pool.ts` | 314-747 | L |
| `cache-admin-listing.ts` | 790-1041 | M |
| `cache-admin-actions.ts` | 1047-1211 | S |
| `CacheAdminService` interface | wraps endpoints | M |

## Synthèse

| Sévérité | Count |
|---|---|
| Critical | 1 |
| High | 5 |
| Medium | 3 |
| Nitpick | 1 |

10 findings. Priorité : extraire worker pool + valider messages Zod + purger jobs Map.
