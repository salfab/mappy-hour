# ADR-0020 — Atlas compression gzip → zstd

**Date** : 2026-05-07 (implémentation) / 2026-05-08 (bench complet)
**Statut** : Accepté
**Références** : ADR-0019 (single-worker default), bench scripts `bench-354ec22-zstd.ps1`, `bench-354ec22-baseline.ps1`

## Contexte

Les atlas de précompute sont des fichiers `.atlas.bin.gz` (format gzip) stockés par tuile × jour.
À chaque run, le pipeline lit les atlas existants (merge avec les nouvelles frames), les décompresse,
les modifie et les réécrit. Sur Lausanne, un atlas moyen fait ~132 MB raw / ~26 MB gzip.

Instrumenté via `[atlas-load-trace]` (reverté après diag, 2026-05-07) :
- Décompression gzip par tuile : **3007 ms** (p50)
- Représentait **95 % du temps de `loadPrecomputedTileAtlas`**

## Décision

Adopter `zstd` comme format de compression pour les nouvelles écritures.
Migration transparente via auto-détection des magic bytes à la lecture :
- `1F 8B` → gzip (backward compat, anciens atlas lisibles)
- `28 B5 2F FD` → zstd

Dépendance ajoutée : `@mongodb-js/zstd` (binding natif napi).
Override possible : `MAPPY_ATLAS_COMPRESSION=gzip|zstd` (défaut : `zstd`).

Update 2026-05-10 : les monolithes sont désormais le format de travail du précompute, tandis que le format optimisé runtime/release est le sharding zstd10 (ADR-0024). Le niveau zstd du monolithe passe donc de 3 à 1 pour minimiser la backpressure CPU pendant l'écriture des atlas et éviter de starver l'orchestration GPU. La lecture runtime cache-only doit préférer les shards ; le monolithe reste un fallback et un format de merge.

## Mesures

### Microbench (2026-05-07, atlas Lausanne ~132 MB raw)

| Métrique | gzip level 1 | zstd level 3 | Ratio |
|---|---|---|---|
| Décompression | 3007 ms | 454 ms | **6.6× plus rapide** |
| Taille compressée | 25.8 MB | 10.4 MB | −60 % (bonus inattendu) |
| Compression | 89 ms | ~50 ms | 1.8× plus rapide |

### Bench système complet (2026-05-08, 1652 tuiles, 1 jour, cold, depth=5)

Bench reproductible avec `compute_wall` (hors preflight grid-metadata).
Warmup avec `MAPPY_DATA_ROOT` identique pour assurer le même model hash.

| Build | compute_wall | delta |
|---|---|---|
| `354ec22` gzip (baseline) | 635.2 s (10.59 min) | référence |
| `354ec22-zstd` (zstd seul) | 638.1 s (10.64 min) | +0.5 % (bruit) |
| `HEAD` (zstd + multi-session) | 613.3 s (10.22 min) | −3.5 % (bruit) |

**Les trois builds sont statistiquement équivalents sur un cache froid.**

## Interprétation : pourquoi zstd ne change pas le compute_wall à cold ?

Sur un cache **froid** (aucun atlas existant), le pipeline n'a rien à lire/décompresser —
il écrit les atlas from scratch (fire-and-forget). La décompression n'est pas sur le chemin critique.

Le gain de décompression (6.6×) ne se matérialise que sur les runs **warm** (atlas existants à relire) :
- Précompute multi-jours avec `--skip-existing=false` (relecture + merge des frames existantes)
- Relance partielle sur une période déjà calculée
- Serveur en production lisant des atlas en cache

Le gain de taille compressée (−60 %) est **toujours actif**, même en cold : moins de données à écrire,
moins de stockage disque.

### Bench précédent (2026-05-07, apparente contradiction)

Le bench initial mesurait −18.8 % (5m14s → 4m15s) sur 296 tuiles lausanne.
Ce bench incluait probablement des atlas existants à relire (conditions warm), d'où le gain visible.
Le bench 2026-05-08 est plus rigoureux (cache garanti vide, `compute_wall` isolé du preflight).

## Conclusion

| Scenario | Gain attendu |
|---|---|
| Cold cache (from scratch) | ~0 % wall, −60 % stockage |
| Warm cache (relecture atlas existants) | ~15–20 % wall |
| Production (API, lecture atlas) | ~6× décompression |

zstd est la bonne décision : le stockage réduit est gratuit, et les runs warm (le cas courant
en prod et en relance partielle) bénéficient d'un gain substantiel. Le cold-only bench ne capture
pas la valeur réelle.

## Conséquences

- Les anciens atlas gzip restent lisibles sans migration (auto-detect magic bytes).
- Les nouveaux atlas monolithiques écrits par le précompute sont en zstd niveau 1. Pas de migration en masse nécessaire.
- Les releases/self-hosted peuvent convertir ces monolithes en shards zstd niveau 10 (ADR-0024).
- Si `MAPPY_ATLAS_COMPRESSION=gzip` est positionné, tout revient à l'ancien comportement.

## Vérification

- [x] Bench microbench atlas Lausanne (2026-05-07)
- [x] Bench système cold 1652 tuiles avec `compute_wall` isolé (2026-05-08)
- [x] `pnpm tsc --noEmit` clean
- [x] check-atlas-vs-cpu-multi (bit-parity validée — format zstd ne change pas la sémantique)
