# Audit `src/lib/precompute/sunlight-tile-service.ts` (2865 lignes)

## Sections (sommaire navigable)

| Plage | Rôle |
|---|---|
| 0-175 | Imports, types (TileGridMetadata, PreparedOutdoorPoint) |
| 156-235 | Helpers temps |
| 236-411 | Helpers géo-spatial (collect candidates, allowlist, region resolve) |
| 444-630 | Cache loaders (manifests, tiles, samples) |
| 694-1879 | **`computeSunlightTileArtifact()` cœur** |
| 738-776 | Phase adaptiveHorizon |
| 777-834 | Phase sharedSources (bâtiments, végétation, terrain) |
| 836-1081 | Phase pointPrep (fast/slow paths) |
| 1103-1419 | Phase evalSetup (payloads GPU, dédup, batch dispatch) |
| **1421-1808** | **Phase frameLoop HOT — 5+ chemins** |
| 1881-1994 | `getOrCreateTileArtifact()` wrapper |
| 2033-2389 | Batch resolve & stream (`resolveSunlightTilesForBbox`, `streamTilesForBbox`) |
| 2524-2862 | Aggregate (`aggregateInstantAreaFromArtifacts`, `buildTimelineFromArtifacts`) |

## Hot loop — décortiquage

### 5 dimensions booléennes (matrice ~240 chemins théoriques, ~10 effectifs)

| Flag | Ligne | Signification |
|---|---|---|
| `useBatchPath` | 1115 | webgpu batch backend present + isBatchBackend |
| `useBatchShadows` | 1194 | has `evaluateBatchWithShadows` |
| `useBatchFrames` | 1366 | has `evaluateBatchFramesWithShadows` |
| `phaseE` | 1495 | 5-point null-check (all masks present + no local terrain) |
| `batchSkipsAllEvaluators` | 846 | gridMetadata + vegetation handled by backend |

### Imbrication réelle (1421-1808)

```
for sampleIndex
 ├─ if altitudeDeg <= 0 → skip
 ├─ if preComputed → Phase E (1502-1570) bulk copy
 ├─ if useBatchPath → evaluateBatch[WithShadows]
 └─ for pointIndex (1661)
     ├─ horizon (4 paths : batch / cached / per-point / none)
     ├─ vegetation (2 paths : batch / per-point)
     ├─ building (3 paths : batch / per-point / none)
     ├─ mask bit set inline (1727-1731)
     └─ sunny count + diagnostics + yield check
```

### Polymorphisme backend — fragile

| Méthode | Guard | Lignes |
|---|---|---|
| `getOrigin()` | useBatchPath | 1119, 1216, 1271 |
| `evaluateBatch()` | aucune (!) | 1604 |
| `evaluateBatchWithShadows()` | `typeof === "function"` cast | 1197-1198, 1589 |
| `evaluateBatchFramesWithShadows()` | `typeof === "function"` cast | 1369-1370, 1404 |

**Le cast `as { method?: unknown }` est une hint compilateur. Zéro garantie runtime.** Pas d'interface `BatchBackendCapabilities` qui regrouperait les capacités.

## Findings

### CRITICAL

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 1 | **Critical** | 1197-1370 | Polymorphisme via cast + typeof | M |
| 2 | **Critical** | 1119/1197/1370/1604 | Dispatch dispersé sur 4 sites avec gardes incohérentes | M |
| 3 | **Critical** | 5 booléens (1115/1194/1366/1495/846) | Matrice 5-D non explicite, validité non observable | M |

### HIGH

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 4 | High | 741-1020 | `terrainMethod`/`buildingsMethod`/`vegetationMethod` réassignés × 3 chemins | S |
| 5 | High | 1432, 1443-1463 | 10× `new Uint8Array()` par frame → ~18M allocs sur run typique | M |
| 6 | High | 1727-1731 | `setMaskBit` inliné × 5 lignes au lieu d'utiliser le helper importé | S |
| 7 | High | 1521 + 1647-1659 | `uniqueHorizonAnglesRounded` recalculé 2× (Phase E vs hot loop) | S |
| 8 | High | 1627, 1661 | `preparedOutdoorPoints.length` lu 2× sans invariant explicite | S |

### MEDIUM

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 9 | Medium | 1672-1714 | `terrainBlocked`/`vegetationBlocked`/`buildingsBlocked` mutables per point | M |
| 10 | Medium | 1470/1600/1604 | `batchBuildingBlockedMask` réassignée × 3 branches | S |
| 11 | Medium | 1328 | `process.env.MAPPY_SUN_POSITION_ROUND_DEG` non typé / non validé | S |
| 12 | Medium | 1822-1846 | `console.log` 25-ligne debug stat sans gating prod | S |

### LOW / NITPICK

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 13 | Low | 1431 | `frameLocalDateTime.slice(11, 16)` fragile | S |
| 14 | Low | 1506 | `u8View` helper créé per-frame | S |
| 15 | Low | 860, 953 | Pre-alloc + trim sans documentation | S |
| 16 | Nitpick | 1524, 1654, 1751 | `Math.round(*1000)/1000` magic number × 3 | S |
| 17 | Nitpick | 1432, 2809 | `Math.ceil(count / 8)` dupliqué | S |

## Candidats d'extraction (priorisés)

| Module | Source | Réduction | Effort |
|---|---|---|---|
| `shadow-dispatch.ts` | dispatch logic 1115-1419 | ~150L | M |
| `point-evaluator.ts` | hot loop 1672-1741 | ~120L | M |
| `tile-prep.ts` | point prep 836-1081 | ~250L | L |
| `horizon-angle-cache.ts` | 1521 + 1647-1659 dedup | ~80L | S |

## Synthèse

| Sévérité | Count |
|---|---|
| Critical | 3 |
| High | 5 |
| Medium | 4 |
| Low | 3 |
| Nitpick | 2 |

17 findings. Les 3 critical (polymorphisme/dispatch/5-D state) sont des dettes architecturales qui devraient être traitées ensemble. Refacto `shadow-dispatch.ts` + `point-evaluator.ts` réduit ~400L et débloque les autres findings.

## Mise à jour 2026-05-06 — Phase G (commit `5922b89`)

Le fix Phase G est une **manifestation des Critical 1-3** : le polymorphisme via `typeof === "function"` cast (Critical 1) + dispatch dispersé sur 4 sites (Critical 2) + matrice 5-D (Critical 3) ont permis qu'un bit silently-dropped passe inaperçu pendant des semaines. Trois bugs coordonnés (Rust readback gate, Node `hasTerrain`, evaluation-context CPU evaluator non-gated) résultaient en `phaseE=false` malgré tous les masques GPU corrects.

Voir `docs/audits/refactor-baselines/phase-e-terrain-fix-2026-05-06.md` et ADR-0011 Phase G.

Justifie d'autant plus l'extraction `shadow-dispatch.ts` recommandée — un test de capacité unifié (et non pas 4 `typeof` dispersés) aurait empêché la divergence.
