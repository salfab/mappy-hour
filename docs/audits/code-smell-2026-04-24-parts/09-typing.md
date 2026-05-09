# Audit transversal : Typing TypeScript

## Synthèse

- **95 non-null assertions `!`** (15 fichiers)
- **2 `any` explicites**
- **3 `eslint-disable`** (tous justifiés)
- **32 `JSON.parse` non validés** (3 fichiers CRITICAL)
- **92 `throw new Error`** sans hiérarchie (18 fichiers)
- **`Record<string, unknown>` aux frontières GPU/IPC**

tsconfig manque `noUncheckedIndexedAccess` et `exactOptionalPropertyTypes`.

## 1. Non-null assertions `!`

### Top 10 fichiers

| Fichier | Count | Justifié | Redondant | Faux | Status |
|---|---|---|---|---|---|
| sunlight-tile-service.ts | 13 | 8 | 4 | 1 | 🟡 Review |
| building-footprint.ts | 13 | 13 | 0 | 0 | ✅ OK (boucles) |
| timeline/stream/route.ts | 10 | 5 | 2 | **3** | 🔴 High |
| gpu-building-shadow-backend.ts | 9 | 9 | 0 | 0 | ✅ OK (WebGL contrats) |
| sunlight-cache-atlas.test.ts | 13 | 13 | 0 | 0 | ✅ OK (test) |
| cache-run-outline.ts | 7 | 7 | 0 | 0 | ✅ OK |
| adaptive-horizon-sharing.ts | 6 | 2 | 4 | 0 | 🟡 Review |
| sunlight-map-client.tsx | 8 | 4 | 3 | 1 | 🟡 Review |
| webgpu-ipc-client.ts | 3 | 1 | 2 | 0 | 🟡 Review |
| gpu-mesh-loader.ts | 2 | 1 | 1 | 0 | 🟡 Review |

### Catégories

**Justifié (~40)** : boucles `for (i < arr.length)` (TypeScript ne peut pas inférer), WebGL API contrats (`createShader()!`), narrowing après guard mais variable réutilisée.

**Redondant (~30)** : extraction de variable + narrowing local résoudrait. Ex `adaptive-horizon-sharing.ts:544` après `if (!localMask && sharedMask) return ...`.

**Faux (~5)** : bug latent. Ex `timeline/stream/route.ts:293, 361, 383, 422, 473` — `artifact!` sans guard si atlas/binary aussi null → crash.

## 2. `any` explicites

| Fichier:Ligne | Sévérité |
|---|---|
| `cache-admin.ts:1483` `gridMetadata: any` (dynamic import + try-catch) | Medium |
| `sunlight-cache.ts:299` `JSON.parse(...) as T` generic (pas `any`, mais sans validation) | Medium |

## 3. `eslint-disable`

| Fichier:Ligne | Directive | Justifié |
|---|---|---|
| cache-admin.ts:1482 | no-explicit-any | ✓ |
| building-shadow-backend-factory.ts:26 | no-require-imports | ✓ |
| evaluation-context.ts:488 | no-unused-vars | ✓ |

Tous documentés. Aucune suppression silencieuse.

## 4. `JSON.parse` non validé — CRITICAL

### Triage par frontière

| Frontière | Sites | Risk |
|---|---|---|
| **WebSocket/SSE (server→client)** | 12 | **CRITICAL** |
| **GPU IPC (worker JSON)** | 6 | **CRITICAL** |
| **Browser localStorage** | 2 | High |
| **Cache files (disk)** | 8 | Medium |
| **Manifests trusted** | 4 | Low |

### Sites Critical (cast aveugle, frontière non-trusted)

| Fichier:Ligne | Frontière | Recommendation |
|---|---|---|
| `sunlight-map-client.tsx:3937, 3945, 3953, 3982` | SSE instant events × 4 | Zod discriminated union urgent |
| `sunlight-map-client.tsx:4129, 4171, 4216, 4221` | SSE timeline events × 4 | Zod discriminated union urgent |
| `cache-admin-client.tsx:1195` | EventSource job payload | Zod schema |
| `webgpu-ipc-client.ts:39, 138, 173` | GPU worker IPC × 3 | Zod schema |
| `webgpu-worker-process.ts:110` | Worker-side parse | Zod schema |
| `rust-wgpu-vulkan-server-client.ts:522` | Generic Rust IPC | Zod schema |
| `gpu-mesh-loader.ts:342` | Cache file binaire | Try-catch + fallback |
| `dynamic-horizon-mask.ts:239` | Cache disque | Zod schema |
| `model-version.ts:105` | Manifest disque (validation manuelle typeof partielle) | Zod (replace typeof) |

### Sites validés Zod ✓ (8)

`places/lausanne-places.ts:53`, `tile-selection-file.ts:56`, `buildings-shadow.ts:243`, `horizon-mask.ts:42`, `sunlight-cache-atlas.ts:246`, `sunlight-cache-binary.ts:244`, `tile-grid-metadata.ts:31`, `cache-precompute-jobs.ts:234`.

## 5. `Record<string, unknown>` aux frontières

| Type | Fichier:Ligne | Contexte |
|---|---|---|
| `Msg = Record<string, unknown>` | webgpu-ipc-client.ts:13 | IPC GPU worker — UNSAFE |

Devrait être `discriminatedUnion` Zod : `MsgWaiting | MsgInitResult | ...`.

## 6. `throw new Error` (92 occurrences)

### Top 5

| Fichier | Count | Catégorie |
|---|---|---|
| rust-wgpu-vulkan-server-client.ts | 17 | Devrait être typé (protocol errors différenciables) |
| cache-admin-client.tsx | 9 | Devrait être typé (mix payload/network) |
| cache-admin.ts | 5 | OK (validation) |
| gpu-building-shadow-backend.ts | 4 | OK (déterministes WebGL) |
| sunlight-map-client.tsx | 4 | Devrait être typé (HTTP errors) |

### Hiérarchie proposée

```typescript
class MappyError extends Error { code: string; }
class MappyValidationError extends MappyError {}
class MappyNetworkError extends MappyError {}
class MappyGPUError extends MappyError {}
class MappyIOError extends MappyError {}
```

Refacto 30-40 sites de throw. Effort : 8h.

## 7. Génériques manquants

- `readCompressedJson<T>()` (sunlight-cache.ts:295) — generic sans validation, devrait avoir `ZodType<T>`
- `Msg` (webgpu-ipc-client.ts:13) — devrait avoir discriminated union

## 8. tsconfig recommandations

### Manquants

```json
{
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "useUnknownInCatchVariables": true
}
```

**Impact** : 20-30 nouveaux warnings (boucles + assignations `undefined`). Effort : 2-3h, zero behavior changes.

## Findings priorisés

### CRITICAL

| ID | Loc | Symptôme | Effort |
|---|---|---|---|
| 1 | sunlight-map-client.tsx:3937-4230 (8 sites) | SSE payloads cast aveugle | M |
| 2 | webgpu-ipc-client.ts:39/138/173 + worker-process:110 + rust:522 | IPC GPU non validé | M |
| 3 | timeline/stream/route.ts:293/361/383/422/473 | `artifact!` sans guard si atlas/binary null | S |
| 4 | cache-admin-client.tsx:1195 | EventSource job payload non validé | S |

### HIGH

| ID | Loc | Symptôme | Effort |
|---|---|---|---|
| 5 | gpu-mesh-loader.ts:342, dynamic-horizon-mask.ts:239 | Cache files sans validation | S |
| 6 | sunlight-map-client.tsx:453, 499 | localStorage parsing sans Zod | S |
| 7 | webgpu-ipc-client.ts:13 | `Msg = Record<string, unknown>` | M |
| 8 | tsconfig.json | Manque `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | S (2-3h) |

### MEDIUM

| ID | Loc | Symptôme | Effort |
|---|---|---|---|
| 9 | top 4 fichiers `!` | ~30 redondants extractables | M |
| 10 | rust-server-client (17), cache-admin-client (9) | Hiérarchie d'erreurs absente | L |
| 11 | cache-admin.ts:1483 | `gridMetadata: any` au lieu de `TileGridMetadata \| null` | S |

## Roadmap effort

| Phase | Effort | Impact |
|---|---|---|
| 1 — tsconfig + localStorage Zod | 2h | Prévention futurs `any/unknown` |
| 2 — SSE/IPC Zod (CRITICAL) | 4h | Élimine 18/32 JSON.parse risqués |
| 3 — Hiérarchie d'erreurs | 8h | Maintenabilité + debug |
| 4 — `!` reduction (extractions) | 6h | ~30/95 → 0 unjustified |
| 5 — Generics validation helpers | 3h | DRY frontières |
| **Total production-ready** | **23h** | |

## Synthèse

| Sévérité | Count |
|---|---|
| Critical | 4 |
| High | 4 |
| Medium | 3 |

11 findings. Phase 1+2 (6h) couvre l'essentiel du risque CRITICAL. Phase 3+4 améliore maintenabilité.
