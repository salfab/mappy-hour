# Audit `src/lib/sun/buildings-shadow.ts` (1819 lignes)

## Sections (sommaire)

| Plage | Rôle |
|-------|------|
| 1-70 | Schémas Zod + interfaces |
| 72-230 | Caches globaux + constantes |
| 236-428 | Chargement index + grille spatiale |
| 430-616 | Géométrie 2D : ray-polygon, containment |
| 617-815 | Parsage DXF polyfaces |
| 817-1040 | Préparation triangles + BVH prep |
| 1043-1199 | BVH construction + intersection |
| 1201-1307 | Mesh loading/caching |
| 1310-1419 | BVH traversal (detailed) |
| 1421-1472 | `createDetailedBuildingShadowVerifier()` |
| 1477-1713 | **`evaluateBuildingsShadow()`** — variante CPU principale |
| 1715-1819 | **`evaluateBuildingsShadowTwoLevel()`** — variante hybrid (deprecated) |

## Variantes d'implémentation

### A. `evaluateBuildingsShadow()` (1477-1713) — ACTIVE
Ray-polygon 2D + altitude angle. Hot path golden reference. Utilisée par `cpu-building-shadow-backend.ts:50`, scripts analysis/benchmark.

### B. `evaluateBuildingsShadowTwoLevel()` (1715-1819) — DEPRECATED candidate
Pass 1 base + verifier 3D si marge < 2°. Loop max 3 itérations. **0 callsites en `src/lib/`** — utilisée seulement scripts analysis/benchmark. Supersédée par GPU Vulkan.

### C. `createDetailedBuildingShadowVerifier()` (1421-1472)
BVH mesh traversal Möller-Trumbore. Utilisé indirectement via B uniquement.

## Findings

### HIGH — Allocations en hot loop debug (M, 1620-1621)
`checkedObstacleIds.push(obstacle.id)` poussé N fois dans hot loop si `collectDebug`. Préallouer ou collector callback incrémental. **Effort: S**

### HIGH — Allocations BVH stack (M, 1350, 1405-1409)
DFS stack `[root]` alloué à chaque `findNearestIntersectionInMesh()`. Pool d'objets ou iterative pattern. **Effort: M**

### HIGH — Epsilon incohérent (M, 603/630/975/1056)
3 seuils différents (1e-6, 1e-9, 1e-12) sans pattern clair. `building-footprint.ts` définit déjà `EPSILON = 1e-9` non importé ici. Centraliser `sun/geometry-constants.ts`. **Effort: S**

### MEDIUM — Magic threshold non documenté (1242)
`if (score > 6) continue` — seuil arbitraire pour match polyface. Constante nommée + comment. **Effort: S**

### MEDIUM — `evaluateBuildingsShadowTwoLevel` deprecated (1715-1819)
0 callsites prod, supersédée par Vulkan. Marquer `@deprecated` ou move vers `_legacy/experimental-two-level.ts`. **Effort: M**

### MEDIUM — Optim early-return × 7 (1557-1617)
Hot loop avec 7 `continue` imbriqués (allowed/excluded/distance/lateral/bbox/blocked/altitude). Lisibilité dégradée. Extraire `shouldSkipObstacle()`. **Effort: M**

### MEDIUM — Redondance Zod schema vs interface (18-70)
`obstacleSchema` + `BuildingObstacle` infer + `SpatialGridCellEntry` interface manuelle dupliquent structure. **Effort: M**

### LOW — Imports lourds non-lazy
`AdmZip` chargé même si `detailedVerifier` non utilisé (rare). Lazy dans `parsePolyfacesFromZip()`. **Effort: M**

### LOW — Comments historiques (1474-1475)
`// findContainingBuilding removed` — note d'ombre obsolète.

## Candidats d'extraction

| Cible | Lignes source | Effort |
|---|---|---|
| `_legacy/experimental-two-level.ts` | 1715-1819 | M |
| `sun/geometry-constants.ts` | constants from 603/630/975/1056/1242 | S |
| `sun/mesh-bvh-builder.ts` | 1106-1199, 1310-1419 | M |
| `sun/polyface-parser.ts` | 817-948, 756-815 | M |
| `sun/ray-polygon-2d.ts` | 589-676, 727-738 | S |
| `sun/spatial-grid-utils.ts` | 366-458 | S |

## Code mort probable

- `evaluateBuildingsShadowTwoLevel` (1715-1819) — HAUTE confiance, 0 src callsites
- `createDetailedBuildingShadowVerifier` (1421-1472) — MOYENNE confiance, jamais branché en prod
- `parsePolyfacesFromZip` + DXF parsing (817-948) — utilisé seulement si verifier activé

## Synthèse

| Sévérité | Count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 4 |
| Low | 2 |
| Nitpick | 2 |

Effort cumulé : ~3 jours fixes critiques, ~2 semaines refactor complet.
