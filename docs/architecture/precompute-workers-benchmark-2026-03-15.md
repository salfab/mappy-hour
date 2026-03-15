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
- repeats: `1`
- workers comparés: `1, 2, 4, 6, 8, 12`
- mode: `skipExisting=false` (recalcul effectif)

## Résultats (médiane)

| Workers | Temps médian | Tiles/min médian | Speedup vs 1 worker |
|---|---:|---:|---:|
| 1 | 125745.615 ms | 1.909 | 1.000x |
| 2 | 91332.156 ms | 2.628 | 1.377x |
| 4 | 80734.468 ms | 2.973 | 1.558x |
| 6 | 81129.057 ms | 2.958 | 1.550x |
| 8 | 80672.083 ms | 2.975 | 1.559x |
| 12 | 80033.722 ms | 2.999 | 1.571x |

## Observations

- Le parallélisme apporte un gain net sur cette charge.
- Le gros gain arrive entre `1 -> 2 -> 4`.
- Au-delà de `4`, les gains sont marginaux sur cette charge:
  - `4 -> 12` ne gagne qu'environ `+1.6%` en temps.
- Aucun échec tuile (`failedTiles=0`).
- La courbe est clairement en plateau à partir de `4`.

## Recommandation opérationnelle

- Valeur par défaut recommandée: `MAPPY_PRECOMPUTE_WORKERS=4`.
- Optionnel: `6-8` si la machine est dédiée et stable I/O, mais l'intérêt restera faible.
- Garder `MAPPY_PRECOMPUTE_WORKERS_STRICT=1` en benchmark, et `0` en prod pour fallback séquentiel.
- Étape suivante: refaire le même benchmark sur une charge plus lourde (`grid=1m`, plus de tuiles/jours) pour vérifier l'échelle du gain.
