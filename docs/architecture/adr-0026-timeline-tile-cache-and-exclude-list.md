# ADR-0026 — Cache LRU des tuiles décodées côté front + exclusion serveur

Statut : Accepté

Date : 2026-05-14

## Contexte

Sur la page `/maplibre-preview` (en route vers la prod via la migration Leaflet → MapLibre), chaque pan ou changement de date déclenche un nouveau fetch SSE de `/api/sunlight/timeline/stream`. Le serveur retransmet alors **toutes** les tuiles intersectant le bbox, même celles que le client avait déjà reçues quelques secondes plus tôt. Pour chaque tuile le client paie :

- ~16-30 ko gzip transitant par le SSE
- une décompression gzip + parsing du mask blob (`decodeTileMasksBlob`) — quelques ms par tuile en main-thread
- la création/upload des textures GPU dans `MapLibreSunlightCustomLayer.setTimeline`

En panning typique sur Lausanne au zoom 15-17, 60-80 % des tuiles d'une nouvelle requête sont déjà en mémoire dans la requête précédente. La répétition gaspillait à la fois la bande passante backend et le CPU front.

## Décision

Deux mécanismes complémentaires.

### 1. Cache LRU côté front

`src/components/maplibre-preview/timeline-tile-cache.ts` — un `Map<string, CacheValue>` keyé sur `(date, tileId)` qui stocke les **masques déjà décodés** (outdoor + frames sun/sunNoVeg) ainsi que les `tileCorners` et la `frame metadata`.

- Capacité : **1000 tuiles** (~480 MB max à 250×250 cells × 31 frames). Choix calibré pour absorber un fetch complet à l'échelle d'une ville sans s'auto-évincer pendant le streaming.
- LRU via touch-on-read : `getCachedTile` supprime puis ré-insère la clé pour la déplacer en MRU end. Éviction du `keys().next().value` quand `size > 1000`.
- API : `getCachedTile(date, tileId)`, `putCachedTile(date, tile)`, `getCachedTileIdsInBbox(date, bbox, max)` (utilisé pour produire la liste d'exclusion), `clearTileCache()`.

### 2. Liste d'exclusion serveur via `excludeTileIds`

Nouveau paramètre query string sur la route SSE. Le client envoie les tile IDs déjà détenus pour la date courante **et** intersectant le bbox. Le serveur les `continue` dans la boucle de streaming → ni encode ni envoi.

#### Encodage compact partagé

`src/lib/encoding/tile-id-compact.ts` est importé des deux côtés. Format `<e/s>_<n/s>` (par exemple `e2537750_n1152000_s250` → `10151_4608`) — 10 caractères au lieu de 23, ~2,3× plus compact. Toutes les tuiles d'une requête partagent le même `s` (le `gridStepMeters` de la query), donc l'information est récupérable côté serveur sans surcharge.

- Cap client : 1000 IDs ≈ 11 KB de query string, sous les ~16 KB tolérés par les proxies courants.
- Cap serveur : 2000 IDs (filet de sécurité contre un client malformé).

#### Flux final

```
fetchTimeline(map, date)
  ├─ bbox = map.getBounds()
  ├─ cachedIdsInBbox = getCachedTileIdsInBbox(date, bbox, 1000)
  ├─ collected = []
  ├─ GET /api/.../stream?excludeTileIds=<compact(cachedIdsInBbox)>...
  │     ├─ event "start" → seedFromCache() pousse les cached tiles dans collected
  │     ├─ event "tile" (server-side filtré) → décodage + putCachedTile + push
  │     └─ event "done" → onResult({ tiles: collected, ... })
  └─ setTimeline(collected, currentFrameIndex, ...)
```

## Conséquences

**Bénéfices** :

- Retour visuel quasi-instant pour la portion overlap de la viewport (zéro decode + zéro RTT serveur sur ces tuiles).
- Moins de charge backend : un panning serré envoie principalement de l'overlap, donc le serveur ne calcule que la bande nouvellement révélée.
- La position du slider est préservée à travers les fetches (commit séparé).

**Coûts / raccourcis** :

- **Mémoire** : 480 MB max. Acceptable sur desktop, à surveiller en mobile. Pas d'éviction par pression mémoire encore — un futur GC pourra hook `navigator.deviceMemory` ou `performance.memory.usedJSHeapSize`.
- **Précision géographique du filtre bbox** : `getCachedTileIdsInBbox` fait un test d'overlap par boîte axée (NW/SE corners). Si dans le futur les tuiles ne sont plus axes-alignées (LV95) ce test deviendra trop laxiste — à revoir si on s'étend hors Suisse.
- **Convention partagée d'encodage compact** : client et serveur doivent rester synchronisés sur `tile-id-compact.ts`. Couvert par le fait que c'est le même module importé des deux côtés.
- **Pas de Vary header / pas d'invalidation push** : si le précompute regénère un atlas, le client tient potentiellement une version périmée jusqu'à ce que la tuile soit évincée. À ce stade le client n'a pas de signalisation de version d'atlas — limitation acceptée tant qu'on reste sur des données stables (atlas immuables sauf re-ingest).
- **API surface** : un nouveau paramètre query exposé. Documenté dans cet ADR.

## Tests / validation

- Test manuel : panning continu sur Lausanne zoom 15-17, observation dans DevTools Network que la taille des réponses SSE successives diminue (proportionnellement à l'overlap).
- Test manuel : changement de date → cache invalidé naturellement (clé inclut la date), nouveau decode complet.
- Pas de test unitaire automatisé encore — cache et encoder sont purs, faciles à tester si on en a besoin.

## Liens

- Commits : `feat(maplibre-preview): LRU cache for decoded sunlight tiles` + `feat(api/sunlight/timeline): excludeTileIds query param + compact encoding`
- Voir aussi `docs/architecture/shortcuts-registry.md` pour les hypothèses implicites.
