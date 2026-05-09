# Audit : Scripts orphelins + couverture tests

## Synthèse

- **54 scripts préfixés `_`** (28 diag, 25 ingest, 1 tools)
- **21 fichiers de tests** (4314 LOC totales)
- **Aucun CI** (`.github/workflows/` absent)
- **10 modules >500 LOC sans test**

## Partie 1 — Scripts orphelins (54)

### Classification

| Type | Count | Action |
|---|---|---|
| Archive utile (>100L, patterns cohérents bench/compare/verify/scan) | ~35 | Garder + README |
| Vestige (géo-spécifique fragmenté ou date-spécifique) | ~12 | Archiver dans dossier daté |
| Mort (<40L, noms cryptiques) | ~7 | Supprimer |

### Top 16 — Archive utile

| Path | LOC | Last | Status |
|---|---|---|---|
| ingest/_render-atlas-vs-tile-diff.ts | 528 | 2026-04-23 | Keep + doc |
| ingest/_measure-atlas-error-spatial.ts | 355 | 2026-04-23 | Keep + doc |
| ingest/_compare-atlas-vs-tilecache.ts | 334 | 2026-04-23 | Keep + doc |
| ingest/_test-atlas-0.25deg.ts | 314 | 2026-04-23 | Keep (test-like) |
| ingest/_bench-grazing-instants.ts | 300 | 2026-04-23 | Keep + doc |
| ingest/_diag-mask-sanity.ts | 273 | 2026-04-23 | Keep + doc |
| ingest/_cross-validate-detailed-vs-vulkan.ts | 242 | 2026-04-23 | Keep + doc |
| ingest/_bench-atlas-lookup-error.ts | 208 | 2026-04-23 | Keep + doc |
| diag/_compare-vulkan-vs-golden-full.ts | 176 | 2026-04-24 | Keep + doc |
| diag/_check-milan-atlas.ts | 168 | 2026-04-23 | Vestige (géo-spécifique) |
| diag/_scan-building-corrupt-tiles.ts | 150 | 2026-04-23 | Keep + doc |
| diag/_capture-golden-baseline.py | 147 | 2026-05-04 | Keep + doc (récent) |
| diag/_scan-lausanne-suspect-tiles.ts | 135 | 2026-04-23 | Keep + doc |
| tools/_merge-high-value-commune-based.py | 114 | 2026-05-04 | Keep + doc (récent) |
| diag/_scan-building-shadow-coverage.ts | 82 | 2026-04-23 | Keep + doc |
| diag/_scan-partial-atlas-tiles.ts | 83 | 2026-04-23 | Keep + doc |

### TS compile

`pnpm tsc --noEmit` ✓ — pas d'erreurs bloquantes des orphelins.

## Partie 2 — Tests existants (21 fichiers, 4314 LOC)

### Distribution

| Catégorie | Files | LOC |
|---|---|---|
| API tests (route.test.ts) | 10 | 2320 |
| Lib unit tests | 11 | 1994 |

### État

- **Passing** : 18 fichiers (86%)
- **Skip markers** : 3 fichiers
- **`evaluation-context.test.ts`** : 5 it() pour 252L (mocks massifs, 1 test cassé pre-existing)

### Couverture par test existant

| Test | Couvre |
|---|---|
| sunlight-cache-atlas.test.ts | Atlas merge ✓ |
| route.lausanne-shadow-sources.test.ts | Sources buildings/horizon |
| Autres route.test.ts | Endpoints divers |
| place tests | Places search |
| evaluation-context.test.ts | Backend dispatch (partiel) |

## Partie 3 — Surfaces critiques SANS test

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
| `swiss-terrain.ts` | 383 | SwissALTI3D parser + dedup récent, 0 test |
| `model-version.ts` | 226 | Hash + gridMetadataHash split (5be2ce2), 0 test |

### Tests manquants prioritaires

1. **mask-codec-{client,server}.ts** — encode/decode binaire (frontier critique)
2. **swiss-terrain.ts** — SwissALTI3D loader + dedup (`parseTerrainTifName`, `dedupTerrainTifs`) — **récemment ajouté, non couvert**
3. **model-version.ts** — `modelVersionHash` vs `gridMetadataHash` split (5be2ce2) — **modif récente sensible, non couverte**
4. **sunlight-cache-binary.ts** — round-trip encode/decode
5. **Vulkan validation intégration** — promouvoir `scripts/diag/check-*` en `*.test.ts` Vitest

## Partie 4 — CI

### Statut

`.github/workflows/` **n'existe pas**. Ni `.gitlab-ci.yml`, ni `.drone.yml`.

### Blocages identifiés

1. **Dépendances natives** : Rust wgpu/Vulkan (compilation requise), WebGPU Dawn (DLLs Windows)
2. **Données volumineuses** : SwissALTI3D ~4GB, manifests bâtiments
3. **GPU en CI** : WebGPU/Vulkan demandent GPU/drivers (Linux headless complexe)
4. **Tests longs** : certains orphelins benchent atlas (minutes)

### Stratégie pragmatique

| Phase | Tests | Effort |
|---|---|---|
| Phase 1 — pre-submit léger | TypeScript check + ESLint + tests Vitest pure (sans GPU) | M (4-6h) |
| Phase 2 — tests d'unité | mask-codec, model-version, swiss-terrain, sunlight-cache-binary | L (12h) |
| Phase 3 — GPU intégration optionnelle | Self-hosted runner Windows avec GPU | XL |

## Findings

### HIGH

| ID | Symptôme | Effort |
|---|---|---|
| 1 | 10 modules >500L sans aucun test | L (12-16h prio) |
| 2 | Encoding/decoding binaire (mask, atlas) sans round-trip test | M |
| 3 | SwissALTI3D parser + dedup récent sans test | M |
| 4 | `modelVersionHash` / `gridMetadataHash` split (5be2ce2) sans test | S |
| 5 | Aucun CI configuré | M |

### MEDIUM

| ID | Symptôme | Effort |
|---|---|---|
| 6 | `evaluation-context.test.ts` 1 test cassé pre-existing | S |
| 7 | Scripts `_test-*` nommés tests mais hors Vitest | S |
| 8 | Orphelins archive non documentés (35 fichiers) | M (README batch) |

### LOW

| ID | Symptôme | Effort |
|---|---|---|
| 9 | 12 vestiges géo-spécifiques | S |
| 10 | 7 scripts morts (<40L, cryptiques) | XS (delete batch) |

## Effort cumulé

| Catégorie | Effort |
|---|---|
| Cleanup orphelins (archive doc + delete morts) | M (4-6h) |
| Tests gaps prioritaires (mask-codec, terrain, binary, model-version) | L (12-16h) |
| CI minimal pre-submit (TS + lint + tests sans GPU) | M (6-8h) |
| **Total** | **~24-30h** |

## Synthèse

| Sévérité | Count |
|---|---|
| High | 5 |
| Medium | 3 |
| Low | 2 |

10 findings. Priorité : couvrir surfaces récentes (terrain dedup, gridMetadataHash split) avant qu'un refacto futur n'introduise un drift silencieux.
