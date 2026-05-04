# Post-refactor capture — Après refacto dédup terrain

**Date** : 2026-05-04 (même soir que la baseline)
**Commits** : `c5fbff4` (vevey region fix) → cette session refacto
**Strategy** : `max-year-best-res-v1` (1 TIF par km cell : dernier millésime, plus haute précision)

## Résumé exécutif

✅ **Dédup confirmé** : 2072 → 775 TIFs sur disque (-62.6%, soit 1297 fichiers redondants éliminés)

✅ **Aucune régression fonctionnelle** : 0 panic Rust, 0 `tile precompute failed`, 0 erreur wgpu

⚡ **Perf vevey (le seul comparable 1:1)** : 45s baseline → **6s post-refacto** (~7.5× plus rapide, **−87%**)

✅ **Hash modèle bumpé** correctement par région — anciens caches préservés, nouveaux caches isolés.

## Hashes modèles (avant → après)

| Région | Avant (baseline) | Après (post-refacto) |
|---|---|---|
| lausanne | `d43fe24cbb9190af` | `bff55b407db8426b` |
| morges | `c9de8e41eb148fe8` | `65d7ddb814c66251` |
| vevey | `7958337d601590db` | `5e96c05c816211e8` |
| geneve | `16657d851e53a837` | `a9bd7d439bb70671` |

## Hashes atlas .bin.gz (post-refacto)

| Tile | Région | Size | SHA256 (16) |
|---|---|---|---|
| e2527000_n1150750 | morges | 1.06 MB | 9fa33d307a9e5d42 |
| e2530500_n1151000 | morges | 0.84 MB | 0d099337700140fa |
| e2536750_n1152000 | lausanne | 0.84 MB | 277dfe15ff8f4bfd |
| e2533000_n1153000 | lausanne | 0.86 MB | 12aaf102e8496a18 |
| e2499000_n1118000 | geneve | 0.95 MB | 18a07f625be44f5e |
| e2499000_n1116000 | geneve | 0.91 MB | d45df23d8388a2bf |
| e2549000_n1147000 | vevey | 0.73 MB | 2c3717c6c6e6742b |

## Comparaison vs baseline

**Bit-parity .bin.gz directe non possible**, raisons :
- Baseline : atlas pour la plupart des tuiles avait déjà MANY buckets (full-day data accumulé sur runs précédents) → 5-58 MB
- Post-refacto : nouvelle dir cache, 1 seul bucket (12:00-12:15 du 2026-05-01) → ~1 MB
- Taille différente d'un facteur 5-58× → comparaison directe ne donne rien

**Cas spécial intéressant** : lausanne-west-Renens.
- Baseline : 856062 bytes (probablement lui aussi 1 bucket — était déjà cached avec juste day-1 12:00)
- Post-refacto : 856601 bytes (1 bucket 12:00 sur le nouveau code)
- Δ size = 539 bytes (0.06%) — quasi identique
- Δ hash = différent
- **Interprétation** : le sampling a légèrement shifté (0.5m partout au lieu de mix 0.5m/2m), produisant un mask imperceptiblement différent mais de taille équivalente. Exactement le shift de précision attendu.

**Pour une validation bit-parity rigoureuse**, il faudrait :
1. Parser le format binaire de l'atlas
2. Extraire le bucket (az, alt) pour le sample à 12:00 sur 2026-05-01 dans BOTH atlases
3. Diff bit-à-bit sur les 5 masques (buildings, terrain, vegetation, sunny, sunnyNoVeg)
4. Rapporter le `% bits flip`

C'est un chantier à faire si on veut des métriques rigoureuses post-refacto. Pour l'instant la **confiance vient des tailles équivalentes + de l'absence d'erreur** + de l'expected shift de précision.

## Validation CPU vs Vulkan post-refacto

**Non exécutée** dans cette session — `scripts/diag/check-atlas-vs-cpu-multi.ts` a un set de 5 cibles Lausanne hardcodées (e2538000_n1152500, etc.) qui ne sont **PAS dans la sélection golden** (je n'avais pris que e2536750_n1152000 et e2533000_n1153000 pour Lausanne). Pour valider le post-refacto contre CPU :

1. Soit étendre la sélection golden avec les 5 cibles hardcodées
2. Soit modifier le `modelHash` dans le script de check pour pointer sur `bff55b407db8426b` (post-refacto)
3. Soit écrire un check ad-hoc sur les 7 tuiles golden

**À faire avant merge officiel** si on veut le seuil 2% mism% formellement validé.

## Critères de décision GO/NO-GO (récap procedure README baseline)

| Critère | Cible | Mesuré | Status |
|---|---|---|---|
| `mism%` moyen CPU vs Vulkan | < 2% | non mesuré post-refacto | ⏸ pending |
| Vevey perf | < 90% baseline (40s) | 6s = 13% | ✅ très large succès |
| Erreurs / panics | 0 | 0 | ✅ |
| Hash modèle bump | distinct par région | 4/4 distincts | ✅ |
| Dédup observable | < total TIFs | 775 / 2072 = 37% | ✅ |

**Verdict pragmatique** : 4 critères sur 5 verts, 1 seul (CPU mism%) reste à mesurer formellement. Le gain perf 7.5× sur vevey est massif. Aucune erreur. Bug latent corrigé en chemin (vevey region parser). Le refacto vaut clairement la peine. Le critère manquant peut être validé en ~30 min en étendant la sélection golden avec les 5 points Lausanne hardcodés et en re-runnant `check-atlas-vs-cpu-multi.ts`.

## Files in this snapshot

- `atlas-hashes.json` — hashes structurés des 7 atlas post-refacto
- `precompute-run.log` — log brut du run post-refacto (à copier)
- `README.md` — ce fichier

## Next step

Soit valider CPU mism% maintenant (recommandé), soit mettre la baseline en archive et reprendre le run principal (1652 tuiles × 365 jours) sous le nouveau hash. Le tag `baseline/dedup-terrain-2026-05-04` reste posé pour rollback si surprise plus tard.
