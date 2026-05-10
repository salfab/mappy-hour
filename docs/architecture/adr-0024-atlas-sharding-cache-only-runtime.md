# ADR-0024 — Sharding des atlas pour le runtime cache-only

Statut : Accepté

Date : 2026-05-10

## Contexte

Sur Mitch (NUC Windows), les requêtes timeline cache-only étaient dominées par la décompression des atlas monolithiques. Une requête de 9 tuiles Lausanne sur `2026-05-10`, `08:00-12:00`, `sampleEveryMinutes=15` chargeait 16 buckets solaires par tuile, mais devait décompresser des atlas complets de 20-39 MB compressés chacun.

Le reader a donc été rendu compatible avec deux formats en parallèle :

- monolithe historique : `*.atlas.bin.gz` ;
- format shardé : `*.atlas.shards.json` + `*.atlas.base.bin.zst` + `*.atlas.shard-XXXX.bin.zst`.

Le sidecar `*.atlas.idx` reste distinct et obligatoire pour le chemin rapide cache-only : il permet de savoir quels buckets lire avant d'ouvrir le manifest shardé.

## Décision

Les atlas release/self-hosted seront convertis en shards zstd niveau 10, avec **16 buckets par shard** comme valeur par défaut.

Les atlas monolithiques restent le **format de travail du précompute**. Le précompute écrit un fichier par tuile, plus simple à merger/réécrire, et le fait en zstd niveau 1 pour minimiser la backpressure CPU pendant que le GPU doit rester alimenté. Le format shardé est un format de distribution/runtime, produit après coup par conversion.

Le runtime lit en priorité le format shardé lorsqu'un petit ensemble de buckets est demandé, puis retombe sur le monolithe si le manifest ou les shards sont absents/corrompus. Cette compatibilité permet une migration progressive et limite le risque de casse.

La conversion est une étape post-précompute / packaging, pas une étape du hot path de précompute. Le précompute doit garder le GPU nourri ; compresser des centaines de shards zstd10 pendant la génération risquerait d'ajouter de la backpressure CPU/I/O et d'augmenter le walltime.

## Benchmarks

Machine : Mitch, NUC Windows, Node production.

Requête :

```text
GET /api/sunlight/timeline/stream
  ?minLon=6.62&minLat=46.515&maxLon=6.625&maxLat=46.52
  &date=2026-05-10
  &timezone=Europe/Zurich
  &startLocalTime=08:00&endLocalTime=12:00
  &sampleEveryMinutes=15
  &gridStepMeters=1
  &cacheOnly=true&maxComputeTiles=0
```

Résultats sur les mêmes 9 tuiles :

| Format | `curl time_total` | `done.elapsedMs` | Shards pour 9 tuiles | Taille shardée pour 9 tuiles |
|---|---:|---:|---:|---:|
| Monolithe, 1 tuile shardée seulement | 10.46s | 10.43s | n/a | n/a |
| 8 buckets/shard | 2.20s | 2.14s | 8515 | 268.5 MiB |
| 16 buckets/shard | 2.49s | 2.48s | ~4260 | ~251.1 MiB |
| 64 buckets/shard | 3.75s | 3.71s | 1071 | ~241.4 MiB |

Observation par tuile :

- monolithe : décompression typique ~850-1180 ms par tuile ;
- 16 buckets/shard : décompression typique ~45-83 ms par tuile ;
- 8 buckets/shard : décompression typique ~34-75 ms par tuile ;
- 64 buckets/shard : décompression typique ~124-205 ms par tuile.

## Conséquences

`8 buckets/shard` est le plus rapide sur le runtime mesuré, mais double le nombre de fichiers par rapport à `16` et produit une taille totale plus élevée. À l'échelle du cache complet, cela augmente fortement le coût NTFS, antivirus, packaging tar, extraction et suppression.

`64 buckets/shard` réduit fortement le nombre de fichiers, mais décompresse trop de données inutiles pour une timeline courte et ralentit nettement le NUC.

`16 buckets/shard` est retenu comme compromis par défaut : gros gain runtime vs monolithe, taille raisonnable, et nombre de fichiers moins extrême que `8`.

Le packaging release doit inclure :

- `*.atlas.idx` ;
- `*.atlas.shards.json` ;
- `*.atlas.base.bin.zst` ;
- `*.atlas.shard-XXXX.bin.zst` ;
- éventuellement `*.atlas.bin.gz` pendant les phases mixtes.

Le téléchargement/installation release doit compter les tuiles via les fichiers atlas disponibles, pas seulement via `*.atlas.bin.gz`, car une release shardée peut ne plus contenir de monolithes.

## Conditions d'invalidation

Rebench obligatoire si :

- le nombre de frames demandées par timeline augmente fortement ;
- on sert des plages horaires beaucoup plus longues que 4h ;
- le format atlas change ;
- le filesystem cible n'est plus NTFS/local disk ;
- GitHub Release ou l'installation locale devient dominée par le nombre de fichiers ;
- une région a des atlas avec un nombre de buckets ou une densité de masques très différente de Lausanne.

## Scripts

- `scripts/precompute/convert-atlas-to-shards.ts`
- `scripts/diag/bench-atlas-sharding.ts`
- `scripts/headless-server-selfhosting/mitch-profile-timeline-curl.ps1`
