# ADR-0027 — Streaming DXF parser pour `gpu-mesh-loader` + cascade quarantine preflight

Statut : Accepté

Date : 2026-05-17

## Contexte

Symptôme observé sur le preflight Zurich (2026-05-17) : des dizaines de tuiles grid-metadata centrales (Wiedikon, Enge, rive est du Zürichsee — tissu urbain dense, 100+ obstacles dans la bbox de chaque tuile) ressortaient avec `indoorCount = 0`. Le diagnostic initial soupçonnait soit une exclusion lac (fausse piste : ces tuiles sont sur terre), soit un index buildings absent (rejeté : `zurich-buildings-index.json` contient bien 30 746 obstacles dont 131 dans la tuile suspecte `e2683000_n1247000`).

Audit GPU vs CPU bbox-footprint sur la tuile `e2683000_n1247000` :
- 131 obstacles attendus
- CPU bbox-footprint : 44 988 points indoor (72 % de la tuile)
- GPU shadow map (gpu-raster ANGLE) : **0 points indoor**
- GPU rust-wgpu-vulkan : **0 points indoor (identique)**

Les deux backends GPU produisent le même résultat bit-pour-bit, ce qui élimine un bug shader et pointe vers un composant en amont partagé : le binary mesh cache.

Inspection du header `gpu-mesh-2683067-1248181-30746.json` :

```json
{
  "obstacleCount": 30746,
  "dxfObstacleCount": 18453,
  "fallbackObstacleCount": 0,
  ...
}
```

**12 293 obstacles silencieusement absents du mesh** (40 % du dataset Zurich). Pattern reproduit sur tous les caches `gpu-mesh-*` Zurich. Aucune autre région touchée (~20 caches vérifiés à 100 % matched).

Root cause identifiée dans `parsePolyfacesFromZip` (`src/lib/sun/gpu-mesh-loader.ts`) :

```ts
const lines = dxfEntry.getData().toString("latin1").split(/\r?\n/);
```

Le DXF `swissbuildings3d_2_2021-05_1091-41_2056_5728.dxf` (Zurich centre) fait **714 148 171 octets décompressé**. V8 cappe les strings à `0x1fffffe8 ≈ 512 MB` ; `Buffer.toString("latin1")` lève alors `RangeError: Cannot create a string longer than 0x1fffffe8 characters`. L'erreur était absorbée par un `try / catch { continue }` au call site, qui retournait une liste vide de polyfaces → tous les obstacles du DXF étaient classés "non matchés" et silencieusement skippés (le fallback footprint extrusion ayant été retiré antérieurement avec le commentaire "100 % of buildings have DXF meshes" — vrai en moyenne, faux sur le tile 1091-41).

Impact silencieux mesuré : Zurich entier précomputé avec ~55-60 % des obstacles seulement. Total indoor sur les 316 tuiles haute-priorité = 3 011 418 points (incorrect) vs **5 469 549 points après fix** (+82 %, soit 2.5M points de gain). Les tuiles dont les 0 indoor étaient visibles n'étaient que la partie émergée : toutes les tuiles Zurich étaient dégradées à des degrés divers.

## Décision

Trois changements pour fixer la cause et instaurer une défense en profondeur.

### 1. Streaming line parser dans `parsePolyfacesFromZip`

Remplacer `buf.toString("latin1").split(/\r?\n/)` par une itération `Buffer.indexOf(0x0a)` qui décode une ligne à la fois (`buf.toString("latin1", start, end)`). Mémoire bornée à quelques dizaines d'octets par ligne au lieu de l'intégralité du fichier.

```ts
function* iterateLatin1Lines(buf: Buffer): Generator<string> {
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      const end = i > 0 && buf[i - 1] === 0x0d ? i - 1 : i;
      yield buf.toString("latin1", start, end);
      start = i + 1;
    }
  }
  if (start < buf.length) yield buf.toString("latin1", start, buf.length);
}
```

Le format DXF (paires `group code` / `value` sur deux lignes consécutives) est trivialement compatible avec un parsing line-by-line ; un buffer `pendingCode` matérialise la paire courante.

### 2. Crash-loud dans `loadGpuMeshes`

Suppression du `try { ... } catch { continue }` qui swallow l'erreur de parse. Désormais :

```ts
if (!zipPath) {
  throw new Error(`[gpu-mesh-loader] sourceZip missing on disk: ${zipName} (${n} obstacles would be silently skipped)`);
}
const polyfaces = parsePolyfacesFromZip(zipPath);
if (polyfaces.length === 0) {
  throw new Error(`[gpu-mesh-loader] zero polyfaces parsed from ${zipName} (${n} obstacles would be silently skipped)`);
}
```

Toute erreur de chargement de mesh fait planter le preflight au lieu de produire un mesh tronqué.

### 3. Cache integrity check + cascade quarantine

Deux niveaux de défense pour les caches déjà sur disque :

**3.a — Auto-invalidation au load** : `loadFromBinaryCache` rejette tout cache dont `(dxfObstacleCount + fallbackObstacleCount) < obstacleCount` en logguant `cache <key> incomplete: N/M matched — invalidating and rebuilding`. Le rebuild emprunte ensuite le chemin crash-loud (2).

**3.b — Preflight mesh cascade** : nouveau module `src/lib/precompute/preflight-mesh-cascade.ts`. À l'init de `precompute-tile-grid-metadata` :

1. `auditGpuMeshCaches()` scanne tous les `gpu-mesh-*.json` et liste ceux à ratio < 100 %.
2. Pour chaque cache incomplet, parse la cache key (`gpu-mesh-<originX>-<originY>-<count>`) et mappe le centre LV95 contre le bbox de chaque région (`PRECOMPUTED_REGION_NAMES` × `getPrecomputedRegionBbox`).
3. Quarantine récursive sous `<DATA_ROOT>/_quarantine/<timestamp>/...` :
   - le `gpu-mesh-*.json/.bin` lui-même (`processed/buildings/...`)
   - `cache/tile-grid-metadata/<region>/` complet
   - `cache/sunlight/<region>/` complet
4. Le run reprend ; tous les artefacts purgés seront recalculés contre le mesh corrigé.

Idempotent : un run avec `auditGpuMeshCaches()` vide est un no-op (`✓ all binary mesh caches are complete (100% obstacles matched)`).

## Relation avec `preflight-atlas-health.ts`

Les deux mécanismes sont **complémentaires et orthogonaux** :

| Mécanisme | Détecte | Granularité |
|---|---|---|
| `preflight-atlas-health.ts` (ADR antérieur) | Atlas individuels au méta incohérent : `terrainHorizonMethod=none`, hash drift, orphelins | par atlas |
| `preflight-mesh-cascade.ts` (cet ADR) | Caches `gpu-mesh-*` à ratio < 100 % en amont | par région entière |

`atlas-health` n'a pas pu détecter le bug Zurich : les atlas étaient parfaitement cohérents avec leur méta, le grid-metadata était cohérent avec son hash, mais le mesh sous-jacent était amputé. Le bug vit un niveau plus bas que ce qu'audite `atlas-health`.

## Conséquences

- Toute extension future à une région contenant un DXF SwissBuildings3D > 512 MB (très rare ; seul `1091-41` est à 714 MB sur l'inventaire actuel) ne déclenchera plus de skip silencieux.
- Tout cache `gpu-mesh-*` incomplet déjà sur disque, peu importe sa cause (DXF futur, zip retiré, etc.), invalide automatiquement les artefacts downstream de sa région.
- Coût additionnel au preflight : un `readdir` + N lectures de petits `.json` (~50 KB chacun). Négligeable.
- Le streaming parser change la signature mémoire du chargement DXF de O(file_size) à O(line_size) — gain réel sur tile 1091-41, neutre ailleurs.

## Vérifications

Avant fix : `cache gpu-mesh-2683067-1248181-30746` avait 18 453/30 746 (60 % matched), 2 188 597 triangles. Toutes les tuiles grid-metadata zurich étaient dégradées (3 011 418 indoor sur 316 tuiles).

Après fix (caches Zurich purgés + preflight relancé) : 30 746/30 746 (100 % matched), 4 076 607 triangles, 5 469 549 indoor sur 316 tuiles, **0 tuile à 0 indoor**.

Scripts de diagnostic utilisés et conservés sous `scripts/diag/` :
- `_zurich-zenith-bug.ts` : compare GPU (ANGLE + Vulkan) vs CPU bbox-footprint sur une tuile (a établi que les 2 backends GPU faillaient identiquement → bug en amont)
- `_zurich-unmatched-obstacles.ts` : identifie quels zips DXF échouent à parser, avec log explicite de la `RangeError` V8

## Bench / Reproducibilité

Pas de bench reproductible isolé pour ce fix (correction de bug, pas optimisation perf). La régression de 60 % de recall indoor à 100 % est observable par diff direct entre les logs du preflight v1 (état d'origine) conservé dans `/tmp/zurich-preflight.log` et v2 (post-fix) dans `/tmp/zurich-preflight-v2.log` durant la session du 2026-05-17.

## Référence registre des raccourcis

Aucun raccourci ajouté ; au contraire, ce fix **retire** un raccourci implicite (le silent catch + commentaire "100 % of buildings have DXF meshes") qui n'avait pas d'entrée dans `docs/architecture/shortcuts-registry.md` et masquait une dégradation systémique.
