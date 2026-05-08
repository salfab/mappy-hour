# Audit transversal : Polymorphisme Shadow Backends

## Matrice [Méthode × Backend]

| Méthode | CPU | GPU-raster | WebGPU | Rust/wgpu | WebGPU-IPC | Déclarée dans |
|---|---|---|---|---|---|---|
| `name` | ✓ | ✓ | ✓ | ✓ | ✓ | `BuildingShadowBackend` |
| `prepareSunPosition()` | ✓ | ✓ | ✓ | ✓ | ✓ | `BuildingShadowBackend` |
| `evaluate()` | ✓ | ✓ | ✓ | ✓ | ✓ | `BuildingShadowBackend` |
| `dispose()` | ✓ | ✓ | ✓ | ✓ | ✓ | `BuildingShadowBackend` |
| `getOrigin()` | ✗ | ✗ | ✓ | ✓ | ✓ | `BatchBuildingShadowBackend` |
| `evaluateBatch()` | ✗ | ✗ | ✓ | ✓ | ✓ | `BatchBuildingShadowBackend` |
| `setFrustumFocus()` | ✗ | ✗ | ✓ | ✓ | ✓ | `BatchBuildingShadowBackend` |
| `uploadHorizonMasks?()` | ✗ | ✗ | ✗ | ✓ | ✗ | optional in `BatchBuildingShadowBackend` |
| `uploadVegetationRasters?()` | ✗ | ✗ | ✗ | ✓ | ✗ | optional in `BatchBuildingShadowBackend` |
| `evaluateBatchWithShadows?()` | ✗ | ✗ | ✗ | ✓ | ✗ | optional in `BatchBuildingShadowBackend` |
| `evaluateBatchFramesWithShadows?()` | ✗ | ✗ | ✗ | ✓ | ✗ | optional in `BatchBuildingShadowBackend` |
| `updateMesh?()` | ✗ | ✗ | ✗ | ✓ | ✗ | **NON déclarée** |
| `shutdown?()` | ✗ | ✗ | ✗ | ✓ | ✗ | **NON déclarée** |

**2 méthodes Rust-spécifiques (`updateMesh`, `shutdown`) ne sont nulle part dans l'interface** — découvertes uniquement par introspection runtime.

## Call sites (11 sites de dispatch fragile)

| Fichier | Ligne | Pattern | Sévérité |
|---|---|---|---|
| `sunlight-tile-service.ts` | 1197 | `typeof (.. as {method?:unknown}).method === "function"` | **Critical** |
| `sunlight-tile-service.ts` | 1369 | idem | **Critical** |
| `sunlight-tile-service.ts` | 1393-1404 | `as { evaluateBatchFramesWithShadows: ... }` | **Critical** |
| `webgpu-worker-process.ts` | 74, 81, 90 | Pas de garde, assume batch | **Critical** |
| `evaluation-context.ts` | 289 | `"shutdown" in backend &&` | **High** |
| `evaluation-context.ts` | 325 | `"setFrustumFocus" in backend` | **High** |
| `evaluation-context.ts` | 340 | `"updateMesh" in backend` | **High** |
| `evaluation-context.ts` | 345-354 | `as unknown as {...}` double cast | **High** |
| `evaluation-context.ts` | 575 | `"setFrustumFocus" in backend` | **High** |
| `check-vulkan-vs-gpuraster.ts` | 267-278 | `as unknown as {...}` | **Critical** |
| `webgpu-shared-sources-test.ts` | 14 | `"evaluateBatch" in sources.backend` | **High** |

## Anti-patterns recensés

1. **`typeof fn === "function"` après cast `as { method?: unknown }`** (2 sites) — combinaison faible
2. **Introspection `"x" in backend`** (5+ sites) — pattern fragile
3. **Casts `as unknown as { ... }`** (3 sites) — double weakness
4. **Méthodes optionnelles `?:` non-implémentées par tous les batch backends** — 4 méthodes optionnelles déclarées, 1 seul backend (Rust) les implémente
5. **`updateMesh` / `shutdown` non-déclarées dans l'interface** — découvertes par introspection
6. **Appels directs sans garde** (`webgpu-worker-process.ts`) — assume batch sans assertion

## Dépendances implicites non capturées par le typage

| Dép | Implique | Captured ? |
|---|---|---|
| A | `evaluateBatchWithShadows` ⟹ `evaluateBatch` + `setFrustumFocus` + `getOrigin` | ❌ |
| B | `evaluateBatchFramesWithShadows` ⟹ `evaluateBatchWithShadows` | ❌ |
| C | `dispose()` Rust devrait appeler `shutdown()` | ❌ |
| D | Si `evaluateBatchWithShadows` appelé sans `uploadHorizonMasks` au préalable, qui gère l'horizon ? | ❌ documentation |

## Findings

### CRITICAL

| ID | Loc | Symptôme | Effort |
|---|---|---|---|
| 1 | `sunlight-tile-service.ts:1197/1369/1393` | 3 sites `typeof + as {method?:unknown}` runtime fragile | M |
| 2 | `webgpu-worker-process.ts:74/81/90` | Aucune garde, assume batch | S |
| 3 | `check-vulkan-vs-gpuraster.ts:267-278` | `as unknown as {...}` double cast | S |

### HIGH

| ID | Loc | Symptôme | Effort |
|---|---|---|---|
| 4 | `evaluation-context.ts:289` | `"shutdown" in backend` introspection (méthode non déclarée) | S |
| 5 | `evaluation-context.ts:325/340/575` | `"setFrustumFocus" in` × 3 + `"updateMesh" in` (refactoring DRY raté) | S |
| 6 | `evaluation-context.ts:345-354` | `as unknown as {...}` double cast | S |
| 7 | `webgpu-shared-sources-test.ts:14` | `"evaluateBatch" in` sans null check | S |

### MEDIUM

| ID | Loc | Symptôme | Effort |
|---|---|---|---|
| 8 | `building-shadow-backend.ts:91-113` | Optionnelles `uploadHorizonMasks?` / `uploadVegetationRasters?` sans contrat sur callers | M |
| 9 | `sunlight-tile-service.ts:1366-1370` | Dép D⟹C+ implicite, pas de type | S |
| 10 | matrice incomplète (CPU/GPU jamais batch) | Asymétrie undocumented dans ADR/CLAUDE.md | S |

### LOW

| ID | Loc | Symptôme | Effort |
|---|---|---|---|
| 11 | `webgpu-ipc-client.ts:22` | Asymétrie : déclaration explicite vs introspection ailleurs | S |

## Architecture cible — 3 options

### Option A — Discriminated Union + caps (RECOMMANDÉ)

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

interface BuildingShadowBackend {
  readonly caps: BackendCaps;
  // ... methods
}
```

Callers : `if (backend.caps.hasBatchFrames) backend.evaluateBatchFramesWithShadows(...)`. Compile-time narrowing simple. **Effort : ~100L net, 12-15 fichiers.**

### Option B — Interfaces séparées + assertions

```typescript
interface CoreBackend { ... }
interface BatchBackend extends CoreBackend { ... }
interface RustBackend extends BatchBackend { updateMesh; shutdown }

function assertBatchBackend(b: unknown): asserts b is BatchBackend { ... }
```

Plus type-safe. Plus verbeux.

### Option C — Class hierarchy

`abstract class BuildingShadowBackend / class extends BatchBackend / class RustBackend extends BatchBackend`. `instanceof` checks. Plus lourd, factory plus complexe.

## Effort migration

- **Files touched** : 12-15
- **Lines removed** : ~60 (introspection + weak casts)
- **Lines added** : ~80 (interface + caps + narrowing)
- **Net** : ~+20L, refacto ~500L existantes
- **Runtime impact** : 0 (shapes inchangées)

## Recommandations priorisées

1. **Semaine 1** : Ajouter `caps` object à `BuildingShadowBackend` + remplacer tous `typeof` par `.caps.hasX`
2. **Semaine 2** : Extraire `RustBuildingShadowBackend extends BatchBuildingShadowBackend` avec `updateMesh` + `shutdown` typés
3. **Semaine 3** : Documenter invariants inter-phase D⟹C+⟹batch en JSDoc + type guards
4. **Cleanup** : Switch sur `caps.type` au lieu d'introspection partout

## Synthèse

| Sévérité | Count |
|---|---|
| Critical | 3 |
| High | 4 |
| Medium | 3 |
| Low | 1 |

11 findings. Effort total ~3 jours pour Option A. Bénéfices : 0 runtime risk, +clarté code, narrowing compiler propre.

## Mise à jour 2026-05-06 — Phase G illustre l'exigence

Le fix Phase G (commit `5922b89`, voir ADR-0011) est un cas concret où la fragilité documentée dans cet audit a coûté plusieurs semaines de précompute Lausanne dégradé silencieusement. Trois bugs coordonnés (Rust readback gate, Node `hasTerrain` test, `buildPointEvaluationContext` non-gated) auraient été détectables au compile-time avec le `caps` object recommandé en Option A : `caps.handlesTerrainOnGpu` aurait centralisé la décision en un endroit, au lieu de la dupliquer dans `evaluation-context.ts` (mal) et dans la closure construction (oubliée).

Cela renforce la priorité de l'Option A — le coût de la dette n'est pas seulement « refacto plus difficile » mais « bug silencieux qui passe en prod ».
