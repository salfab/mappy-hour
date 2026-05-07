# Golden Baseline — Avant refacto dédup terrain

**Date** : 2026-05-04
**Tag git** : `baseline/dedup-terrain-2026-05-04`
**Commit** : `c5fbff4` (post-fix vevey region parser)

## Contexte

Capture de l'état avant le refacto de `loadTerrainMetadata` qui doit dédupliquer les tuiles SwissALTI3D (millésime × résolution). Détails du plan dans `~/.claude/projects/.../memory/project_terrain_dedup_refactor.md`.

## Tuiles capturées (7 tuiles, 4 régions)

| Région | Tile ID | Label | Atlas size | SHA256 (16 chars) |
|---|---|---|---|---|
| morges | e2527000_n1150750_s250 | morges-west-StSulpice-north | 45 MB | 3f42eb5cdd018fc9 |
| morges | e2530500_n1151000_s250 | morges-Preverenges-plage | 17 MB | 6fc70f6aa1e47ebb |
| lausanne | e2536750_n1152000_s250 | lausanne-Montriond | 58 MB | 7b9d943a94c56145 |
| lausanne | e2533000_n1153000_s250 | lausanne-west-Renens | 0.86 MB | 735fd9ee36b996ba |
| geneve | e2499000_n1118000_s250 | geneve-Rive | 5.3 MB | 475d947b4b4fcf7a |
| geneve | e2499000_n1116000_s250 | geneve-Carouge-sud | 4.8 MB | 38e8e6f58c47127d |
| vevey | e2549000_n1147000_s250 | vevey-Lavaux-est | 0.73 MB | 28a6ffcaae8bf2de |

Hashes complets : `atlas-hashes.json` (SHA256 + size + mtime + path).

## Modèles régions au moment de la capture

```
lausanne: d43fe24cbb9190af
morges:   c9de8e41eb148fe8
nyon:     7bf203237ff6647b   (non utilisé ici, pas de tuile golden Nyon)
geneve:   16657d851e53a837
vevey:    7958337d601590db   (capturé pour la première fois)
```

## Variation des tailles d'atlas

Les tailles varient de 0.73 MB (vevey) à 58 MB (lausanne-Montriond). Ces écarts reflètent le **nombre de buckets accumulés** dans l'atlas existant, pas une caractéristique stable des tuiles. Plusieurs tuiles avaient déjà été précomputées sur de larges plages de dates dans des runs antérieurs ; le golden vevey est tout petit car c'est le premier compute (1 bucket × 12:00-12:15).

**À garder en tête** : les hashes "avant" et "après" ne seront comparables qu'à condition de précompute la MÊME plage de dates × tuiles dans les deux phases. Le narrow window (12:00-12:15, 1 jour) est utilisé comme proxy rapide pour valider l'algorithme — pas de bit-parity attendue sur les buckets autres que 12:00.

## Baseline CPU vs Vulkan (check-atlas-vs-cpu-multi.ts)

5 cibles centre-Lausanne, chacune sur 57 frames sur 1 date (2026-04-29) :

| Target | Total | Mismatch | Miss | Mism% |
|---|---|---|---|---|
| LAU Rumine ouest | 57 | 2 | 1 | **3.5%** |
| LAU St-François N | 57 | 0 | 1 | 0.0% |
| LAU Cathédrale N | 57 | 1 | 1 | 1.8% |
| LAU Pont Bessières | 57 | 1 | 1 | 1.8% |
| LAU Chauderon | 57 | 0 | 1 | 0.0% |

**Moyenne** : ~1.4% (sous le seuil 2% sauf Rumine ouest à 3.5%).

Direction des mismatches : tous "C=SHAD / A=SUN" (l'atlas rate des ombres). Probablement une caractéristique du backend Vulkan vs CPU déjà connue (cf. ADR-0011, gap mesuré ~1-2%).

Output complet : `cpu-vs-vulkan.log`.

## Timing baseline

- 5 tuiles déjà cachées (skip < 1s chacune) — aucun signal perf
- 1 tuile vevey calculée fraîche : **45s** sur 1 bucket × narrow window 12:00-12:15

Ce timing 45s couvre :
- mesh load (cache hit, ~10ms)
- focus update vulkan (~few ms)
- buffer upload (terrain + vegetation + horizon + buildings)
- compute shader dispatch
- readback + atlas write

Pour un benchmark perf significatif post-refacto, **il faudra forcer un recompute frais** (`--skip-existing=false`) sur plusieurs tuiles, idéalement sur des tuiles à fort overlap terrain (morges-west par exemple) où le dédup aura le plus d'impact.

## Procédure post-refacto

1. Bump `modelVersionHash` (via inclusion d'un champ `terrainSelectionStrategy: "max-year-best-res"` dans le payload de `getSunlightModelVersion`).
2. Re-runner exactement la même commande golden :
   ```
   pnpm precompute:all-regions:vulkan -- \
     --tile-selection-file=data/processed/precompute/golden-dedup-terrain-2026-05-04.json \
     --start-date=2026-05-01 --days=1 \
     --start-local-time=12:00 --end-local-time=12:15 \
     --skip-existing=false
   ```
   (skip-existing=false pour forcer recompute frais ; le nouveau hash isole les nouveaux atlas dans un autre dir, l'ancien est préservé)
3. Hasher avec le même script :
   ```
   PYTHONIOENCODING=utf-8 python scripts/diag/_capture-golden-baseline.py
   ```
4. Comparer hash avant/après — diff attendu (terrain sampling change).
5. Re-runner `check-atlas-vs-cpu-multi.ts` sur les 5 cibles Lausanne, vérifier que mism% reste sous 2% en moyenne.
6. Mesurer perf : durée totale du run golden — comparer aux 45s du vevey baseline (idéalement -10 à -25%).

## Critères de décision GO/NO-GO post-refacto

- ✅ **GO** : mism% moyen < 2% ET vevey baseline timing < 90% (= < 40s)
- ⚠️ **À examiner** : mism% > 2% mais < 5% — peut être dû au shift de précision 0.5m → 2m. Validation visuelle requise (test golden CPU sur même tuile).
- ❌ **NO-GO** : mism% > 5% ou anomalie sur direction des mismatches → revert refacto.

## Files in this baseline

- `atlas-hashes.json` — hashes structurés des 7 atlas
- `precompute-run.log` — log brut du run de capture
- `cpu-vs-vulkan.log` — output complet `check-atlas-vs-cpu-multi.ts`
- `README.md` — ce fichier
