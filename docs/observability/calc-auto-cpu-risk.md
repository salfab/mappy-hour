# Risque CPU du re-fetch automatique sur changement d'UI (`/maplibre-preview`)

**Contexte** : depuis le commit `760df40` (`fix(maplibre-preview): unify daily SSE so UI toggles drive the overlay`), toute modification d'un paramètre côté UI (`cacheOnly`, `sampleEveryMinutes`, `buildingHeightBiasMeters`, `ignoreVegetationShadow`, `date`, `basemap`, …) relance immédiatement la requête `/api/sunlight/timeline/stream`. Avant, il fallait cliquer "Calculer". On craint qu'un utilisateur qui clique vite plusieurs toggles sature Mitch (NUC Windows 11 modeste, Intel consumer-grade CPU, Docker + WSL2 + Tailscale Funnel).

Cette note documente ce qui peut se passer côté CPU, à partir d'une lecture du code et des benchmarks existants. Aucun test live sur Mitch n'a été fait par cette note — les chiffres sont extraits d'ADR-0024 et de la structure du pipeline.

---

## 1. Coût d'une requête SSE typique

Pipeline `/api/sunlight/timeline/stream` (`src/app/api/sunlight/timeline/stream/route.ts` + `streamTilesForBbox` dans `src/lib/precompute/sunlight-tile-service.ts`) :

1. **Résolution région + manifest** (`loadManifestCached`, TtlCache 60s × 64 entrées). Effectivement gratuit après le 1er hit (~0 ms).
2. **Calcul des positions solaires par tuile** (`SunCalc.getPosition` × ~60 frames). Trivial : ~1 ms / tuile.
3. **Chargement atlas** (`loadPrecomputedTileAtlas` → shards `zstd-10` ou monolithe `gzip`). Le default `MAPPY_ATLAS_MEMORY_CACHE_ENTRIES=0` désactive le cache mémoire : chaque tuile = lecture disque + décompression.
4. **Lookup angle → bucket → masque** (`lookupAtlasByAngle`) + extraction des masques `outdoor`, `sun`, `sunNoVeg`. Cheap (~ms).
5. **Per-frame mask remap** : pour chaque outdoor cell × frame, copie un bit du masque solaire de la tuile vers le masque `dst` du frame. ~60 frames × ~500 outdoor cells = 30k ops, ~ms.
6. **Encoding output** `encodeTileMasksBlob` : concat brut + `gzipSync` level 1 + base64. À grid step 1 m / tuile 250 m, masque brut ≈ 7.8 KB × 121 (1 outdoor + 60 × 2) = ~940 KB raw → ~150-300 KB gzipped. **`gzipSync` est synchrone** : il bloque l'event loop ~5-15 ms par tuile.
7. **`controller.enqueue`** : envoi du SSE event. Trivial.

### Chiffres mesurés (ADR-0024, sur Mitch, format shardé `16 buckets/shard` = format runtime actuel)

| Étape | Coût typique par tuile |
|---|---|
| Decompress + decode atlas (zstd-10, 16 buckets) | 45–83 ms |
| `gzipSync` output (estimation, level 1, ~940 KB) | 5–15 ms |
| Parse + remap + lookup | 5–10 ms |
| **Total CPU bloquant / tuile** | **~60–110 ms** |

Pour une bbox typique homepage (Lausanne, zoom 14 ≈ **30 tuiles**, sample every 15 min, fenêtre 04:00→22:00 = ~72 frames) :

- **Wall time** ≈ 2.5–4 s sur Mitch (ADR-0024 a mesuré 2.49 s pour 9 tuiles, donc ~280 ms/tuile incluant I/O série).
- **CPU brûlé** ≈ 1.8–3.3 s.
- **Mémoire pic** : ~520 MB Node après requête (shortcut 3.7 dans `shortcuts-registry.md`).
- **Volume réseau out** : 30 tuiles × ~200 KB gzip = ~6 MB.

---

## 2. Scénarios

### 2.1 Idéal — 1 utilisateur, 1 toggle

L'`AbortController` côté frontend (`timelineAbortRef`, ll. 312, 860-862 de `maplibre-preview-client.tsx`) annule la précédente requête avant de fetcher la nouvelle. Côté serveur, `request.signal` est branché sur un flag `streamAborted` (route.ts ll. 308-313, 430) qui sort de la boucle des tuiles à la prochaine itération. **Pas de superposition de requêtes complètes** : coût isolé = celui d'une SSE classique.

### 2.2 Stress modeste — 1 utilisateur, 5 toggles en 5 s

Risque réel mais borné :

- **Pas de debounce sur les toggles UI**. `refreshTimeline` est recréée via `useCallback` à chaque changement de dep ; le `useEffect` (l. 993-997) la rappelle immédiatement. Aucun `setTimeout` entre les deux.
- Comparer avec **moveend pan/zoom** : un `setTimeout(setRecalcSignal, 1000)` (l. 1167-1175) débouce la SSE après mouvement de la carte. Cette latence est absente pour les toggles.

Conséquence : 5 clics → 5 abort + 5 nouvelles fetches. Chaque abort est instantané côté frontend, mais le serveur ne s'arrête qu'**entre deux itérations de la boucle des tuiles** (route.ts l. 430). Une tuile en cours de décompression zstd va jusqu'au bout (~50–100 ms), puis la boucle voit `streamAborted=true` et exit. Donc chaque requête abortée brûle **typiquement 1–2 tuiles avant de s'arrêter**.

Coût d'un spam de 5 toggles : 4 requêtes abortées × ~150 ms CPU + 1 requête complète × ~2.5 s = **~3.1 s CPU**, à comparer à ~2.5 s en idéal. **~25 % de surcoût**, pas catastrophique mais visible.

### 2.3 Stress collectif — 10 utilisateurs simultanés

Sur 4 cores Mitch (hypothèse, à confirmer), Node Next.js sert toutes les requêtes sur le **même event loop** (single-threaded). La concurrence atlas est de surcroît **clampée à 1** sur Mitch (`MAPPY_TIMELINE_CACHE_PREFETCH=1`, shortcut 3.7 du registre).

- 10 SSE concurrentes simultanées = 10 boucles `for` qui veulent lire le disque + décompresser. Une seule boucle accède au disque à la fois si `MAPPY_TIMELINE_CACHE_PREFETCH=1`, donc le débit total est limité à ~10 tuiles/s ≈ **300 tuiles brutes en 30 s pour 10 utilisateurs**. Chacun attend ~3 s pour sa moitié de bbox.
- `gzipSync` étant synchrone, deux requêtes qui tombent en même temps sur le même tick bloquent toutes les autres pendant 5-15 ms. Multiplier par 30 tuiles × 10 utilisateurs = jusqu'à **5 s d'event loop bloqué cumulé** si tout arrive en burst.

À l'échelle du déploiement actuel (zéro trafic, ~quelques curieux/jour via Funnel), cas extrêmement improbable. Mais on n'a pas de garde-fou : **pas de rate limit, pas de queue, pas de back-pressure** côté route SSE.

---

## 3. Recommandations

### Priorité 1 — Debouncer les toggles UI (côté frontend, ~10 lignes)

Aligner les toggles sur le débounce du pan/zoom : ~250–300 ms suffit pour absorber un spam de clic sans introduire une latence perçue (≥ 200 ms reste perceptible mais acceptable). Le code de l'effet `useEffect` ligne 993-997 attend déjà un `recalcSignal` debounced pour pan/zoom : on peut faire transiter les toggles UI par le même `setRecalcSignal` indirect via un `setTimeout` court, ou via un hook `useDebouncedValue`.

**Patch appliquée dans ce commit** : ajout d'un debounce de 250 ms autour du re-trigger via `useEffect`, déclenché seulement quand un paramètre UI change (date / ready ne sont pas debounced). Voir `src/components/maplibre-preview-client.tsx`.

### Priorité 2 — Aucun changement requis sur l'AbortController

Vérifié : l'abort propagation client → serveur est correctement câblée. Code existant.

### Priorité 3 — À mesurer empiriquement avant d'agir

- **Pré-warm cache atlas mémoire** : `MAPPY_ATLAS_MEMORY_CACHE_ENTRIES=8` (TTL 5 min, ligne 120 de `sunlight-tile-service.ts`) éliminerait la décompression répétée pour 5 utilisateurs qui regardent la même zone. **Coût RAM** : ~8 × 30 MB = 240 MB. À tester sur Mitch avant d'activer en prod.
- **Throttle par IP** : peu utile vu le pattern de trafic actuel (chaque utilisateur a sa propre IP via Funnel). Reporter.
- **Migrer `gzipSync` → `zlib.gzip` async** : déboucherait l'event loop entre deux tuiles, utile si on observe des stalls multi-utilisateurs. À profiler d'abord (`process.stderr.write` traces existantes : `[stream:per-tile-timing]`).

---

## 4. Risque global

**Niveau : modéré.** Le pire scénario réaliste (1 utilisateur qui spam-clique) gaspille ~25 % de CPU pour rien. La patch debounce de priorité 1 supprime ce gaspillage à coût quasi nul. Le scénario "10 utilisateurs simultanés" reste théorique (trafic actuel négligeable) et est partiellement mitigé par `MAPPY_TIMELINE_CACHE_PREFETCH=1` qui sérialise déjà le disque.

À surveiller dans les logs Mitch quand le trafic monte :
- Apparition de `[stream:per-tile-timing] … avg encode > 30 ms` : `gzipSync` devient un facteur.
- `[stream:atlas-load] … decompress > 200 ms` répété : le format n'est pas shardé, ou disque saturé.
- Multiples `[stream] bbox=…` en quelques secondes pour la même IP : symptôme spam frontend, le debounce devrait l'éliminer.
