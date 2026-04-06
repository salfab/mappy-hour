# ADR-0007 : Compression blob gzip des masks SSE

**Date** : 2026-04-06
**Statut** : Accepté
**Contexte** : ADR-0006 (streaming tile architecture)

## Contexte

L'architecture SSE tile-by-tile (ADR-0006) envoie les bitmasks d'ensoleillement par tuile via Server-Sent Events. Chaque tuile contient :

- 1 outdoor mask (7 812 octets bruts pour une grille 250x250 à 1m)
- 66 frames x 2 masks (sun + sunNoVegetation) = 132 masks par tuile
- Chaque mask encodée individuellement en base64 (~10.4 KB)
- Total par tuile : **~1.4 MB** de JSON
- Pour 12 tuiles visibles : **~16.8 MB** transférés

Le navigateur mettait **1m42s** pour recevoir et parser ces données, alors que `curl` les recevait en 3s. Le goulot d'etranglement etait triple :

1. `EventSource` parse les events caractere par caractere — catastrophique pour des payloads de 1 MB
2. 133 strings base64 separees = 133x l'overhead d'encodage/decodage
3. Aucune compression (SSE avec `Content-Encoding: none` pour eviter le buffering)

## Decision

### 1. Remplacer EventSource par fetch + ReadableStream

```typescript
// Avant
const stream = new EventSource(`/api/.../stream?${query}`);
stream.addEventListener("tile", (event) => { ... });

// Apres
const response = await fetch(`/api/.../stream?${query}`, { signal });
const reader = response.body.getReader();
// Parse SSE manuellement : "event: tile\ndata: {...}\n\n"
```

**Pourquoi** : `fetch` + `ReadableStream` recoit des chunks de 64 KB+ que le navigateur decode d'un coup, au lieu du parsing byte-by-byte d'EventSource. Supporte aussi `AbortController` pour l'annulation propre.

**Impact** : 1m42s -> 1m07s (gain 1.5x)

### 2. Concatener + gzip toutes les masks en un seul blob

Au lieu de 133 strings base64 dans le JSON, on :

1. **Serveur** : concatene les masks brutes (`Uint8Array`) dans un buffer contigu, le compresse avec `zlib.gzipSync()`, et envoie une seule string base64
2. **Client** : decompresse avec `DecompressionStream` natif (C++ dans le navigateur), puis slice le buffer

```
// Layout du blob (avant gzip) :
[outdoorMask: maskBytes octets]
[frame0_sunMask: maskBytes]
[frame0_sunMaskNoVeg: maskBytes]
[frame1_sunMask: maskBytes]
[frame1_sunMaskNoVeg: maskBytes]
...
```

Le client connait `maskBytes = ceil(gridWidth * gridHeight / 8)` et `frameCount`, donc il peut slicer determiniquement.

**Pourquoi gzip compresse si bien** :
- **Coherence spatiale** : les bitmasks ont de grandes zones contigues de 0 ou 1 (batiments = indoor, places = outdoor)
- **Coherence temporelle** : entre 2 frames a 15 min d'intervalle, l'ombre bouge de quelques metres — les masks sont quasi-identiques
- gzip exploite les deux via ses dictionnaires de repetition (LZ77)

**Impact sur la taille** : 1.4 MB/tuile -> ~120 KB/tuile (**reduction de 91%**)

### 3. Decompression parallele (non-bloquante)

Le point critique : la decompression via `DecompressionStream` est asynchrone. Si on `await` chaque tuile sequentiellement dans la boucle de parsing SSE, on bloque le parsing des events suivants pendant la decompression.

Solution : on pousse les tuiles immediatement dans le state (sans masks decodees), et on lance toutes les decompressions en parallele. A la reception de l'event `done`, on fait `await Promise.all(pendingBlobDecodes)` puis on flush le state final.

```typescript
// Dans handleSseEvent("tile", ...):
pendingBlobDecodes.push(
  decodeTileMasksBlob(blob, maskBytes, frameCount).then((decoded) => {
    tileEntry.decodedMasks = decoded;
  }),
);
pendingTilesRef.current.push(tileEntry);

// Apres la fin du stream:
await Promise.all(pendingBlobDecodes);
// Flush final avec masks decodees
```

**Impact** : la decompression de 12 tuiles se fait en ~1s en parallele au lieu de ~60s sequentiellement.

## Format fil (wire format)

```json
// Avant (par tuile, ~1.4 MB) :
{
  "tileId": "e2538000_n1152500_s250",
  "grid": { "width": 250, "height": 250, ... },
  "outdoorMaskBase64": "base64...",
  "frames": [
    { "index": 0, "sunMaskBase64": "base64...", "sunMaskNoVegetationBase64": "base64...", ... },
    // x66 frames
  ]
}

// Apres (par tuile, ~120 KB) :
{
  "tileId": "e2538000_n1152500_s250",
  "grid": { "width": 250, "height": 250, ... },
  "masksEncoding": "gzip-concat-v1",
  "masksBase64": "H4sIAAAAAAAAA...",  // seul blob compresse
  "frames": [
    { "index": 0, "localTime": "06:00", "sunnyCount": 1234, "sunnyCountNoVegetation": 1300 },
    // x66 frames — metadata seulement, pas de masks
  ]
}
```

## Resultats mesures

| Configuration | Temps navigateur | Donnees transferees |
|---|---|---|
| EventSource + base64 individuelles | 1m42s (102s) | ~16.8 MB (12 tuiles) |
| fetch + ReadableStream + base64 | 1m07s (67s) | ~16.8 MB |
| fetch + blob gzip + decompression parallele | **5s** | **~1.4 MB** |

**Acceleration totale : 20x**

## Fichiers modifies

- `src/lib/encoding/mask-codec-server.ts` — concatenation + gzip cote serveur
- `src/lib/encoding/mask-codec-client.ts` — decompression + slicing cote client
- `src/app/api/sunlight/timeline/stream/route.ts` — encodage blob dans l'event SSE
- `src/components/sunlight-map-client.tsx` — fetch streaming, decompression parallele, helpers `getTileMask`/`getTileOutdoorMask`

## Compatibilite

- `DecompressionStream("gzip")` : Chrome 80+, Firefox 113+, Safari 16.4+
- Le client supporte les deux formats (presence de `masksEncoding` = nouveau format, sinon fallback base64)
- Le format SSE reste du texte (`text/event-stream`), pas de changement de protocole

## Evolutions futures

- **Phase 2 — Delta XOR** : encoder `frame[i] = frame[i] XOR frame[i-1]` avant gzip. Les deltas sont tres creux -> compression encore meilleure (estimation : -30-60% supplementaires)
- **Phase 3 — Stocker Uint8Array directement** : supprimer le cache lazy-decode, les masks sont pretes a l'emploi des la reception
