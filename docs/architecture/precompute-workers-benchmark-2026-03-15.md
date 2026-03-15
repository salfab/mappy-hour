# Benchmark multithread précompute (API + CLI) - 2026-03-15

Source brute:
- `docs/progress/benchmarks/precompute-workers-lausanne-2026-03-08-d1-g5-t4.json`

## Configuration mesurée

- région: `lausanne`
- date: `2026-03-08`
- jours: `1`
- tuiles: `4` (autour du centre Lausanne)
- taille tuile: `250m`
- grille: `5m`
- pas temporel: `30 min`
- fenêtre: `10:00-12:00`
- repeats: `2`
- workers comparés: `1, 2, 4`
- mode: `skipExisting=false` (recalcul effectif)

## Résultats (médiane)

| Workers | Temps médian | Tiles/min médian | Speedup vs 1 worker |
|---|---:|---:|---:|
| 1 | 113067.647 ms | 2.156 | 1.000x |
| 2 | 92476.685 ms | 2.595 | 1.223x |
| 4 | 80889.328 ms | 2.967 | 1.398x |

## Observations

- Le parallélisme apporte un gain net sur cette charge.
- `4 workers` est le meilleur compromis mesuré ici.
- Aucun échec tuile (`failedTiles=0`).
- La variabilité est surtout visible sur `1 worker` (cache/mise en température du process).

## Recommandation opérationnelle

- Valeur par défaut recommandée: `MAPPY_PRECOMPUTE_WORKERS=4` sur machine 6+ cœurs.
- Garder `MAPPY_PRECOMPUTE_WORKERS_STRICT=1` en benchmark, et `0` en prod pour fallback séquentiel.
- Étape suivante: refaire le même benchmark sur une charge plus lourde (`grid=1m`, plus de tuiles/jours) pour vérifier l'échelle du gain.
