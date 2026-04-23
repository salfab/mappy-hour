# Atlas angle-keyé — trade-off résolution / taille / précision

Bench pour article seesharp.ch sur l'optimisation espace/temps et la réutilisabilité
(référence rainbow tables).

Contexte : ADR-0013 définit un atlas qui réindexe les masques d'ombre par
`(azBucket, altBucket)` au lieu de `(date, frame)`. L'idée : le Soleil repasse
par les mêmes angles chaque année, donc un masque calculé pour `(az=120°, alt=35°)`
est **réutilisable à l'infini** — on amortit le coût GPU sur toutes les dates.

La résolution du bucket est le paramètre clé du trade-off :
- Plus fin → plus de buckets à stocker et précomputer, mais erreur d'arrondi plus faible
- Plus gros → moins de stockage et compute, mais on approxime davantage

## Setup

- Tuile : `e2538000_n1152500_s250` (The Great Escape, Lausanne — 25 656 points outdoor)
- Grid : 1 m, sample : 15 min
- Atlas construit avec **Vulkan-native** (`computeAndMergeAtlasForTile`) — les
  positions sol évaluées sont **exactement les centres de bucket**
  `((azB+0.5)·r, (altB+0.5)·r)`, pas une approximation mining sur frames cachées.
- Dates balayées pour la construction : 8 dates couvrant une année
  (équinoxes, solstices, dates intermédiaires : 2026-03-20, 2026-04-18, 2026-05-15,
  2026-06-21, 2026-07-22, 2026-09-22, 2026-10-21, 2026-12-21).
  Fenêtre locale 04:00–22:00, sample 15 min.
- Baseline pour l'évaluation d'erreur : tile caches **date-keyés régénérés avec
  le même backend Vulkan** (filtre mtime > 2026-04-18 13:30 ; les anciens caches
  pré-Vulkan-validation sont exclus).
- Machine : Intel Arc sur ThinkPad X1, Vulkan natif via `wgpu`.

## Cross-validation préalable — parité de backend (Vulkan GPU vs CPU détaillé)

Sur 4 fenêtres couvrant horizon-mask (Jetée de la Compagnie, sunrise/sunset)
et ombres bâtiments (Great Escape, matin/soir), au même **angle solaire exact**
par frame :

| Fenêtre | Frames | Sun XOR | noVeg XOR | Buildings XOR | Veg XOR |
|---|---|---|---|---|---|
| Jetée-sunrise (07:00-07:30, 5 min) | 6 | **0.012 %** | **0.0003 %** | 0.004 % | 0.012 % |
| Jetée-sunset (20:00-20:15, 5 min) | 3 | 0.27 % | 0.040 % | 3.35 %¹ | 0.30 % |
| GE-morning (08:00-10:30, 15 min) | 10 | 0.37 % | 0.29 % | 0.29 % | 0.55 % |
| GE-evening (17:00-19:00, 15 min) | 8 | 0.36 % | 0.25 % | 0.25 % | 0.53 % |

¹ Anomalie isolée à 20:10 : les deux backends reportent sun=0 % (classification
ombre correcte), mais le compteur intermédiaire « buildings blocked » diverge
car le CPU détaillé court-circuite l'évaluation bâtiment quand l'horizon-mask
exclut déjà tout ; Vulkan évalue quand même. Aucun impact sur la sortie sun/ombre.

**Conclusion** : les deux backends produisent des masques quasi-identiques à angle
solaire exact. On peut donc comparer l'atlas (qui approxime par bucketing) à
n'importe lequel des deux sans biais.

## Atlas — résultats à 3 résolutions

### Temps de build et amortissement (Vulkan)

| Résolution | Total (8 dates) | 1ʳᵉ date | Moyenne dates 2–8 | Buckets finaux |
|---|---|---|---|---|
| 1°     | **18.4 s** | 4.4 s | 2.0 s/date | 383 |
| 0.75°  | 24.9 s²    | 10.3 s² | 2.1 s/date | 398 |
| 0.5°   | **19.9 s** | 4.7 s | 2.2 s/date | 404 |

² Le run 0.75° inclut une recompilation Rust à froid (5.7 s) dans le 1ᵉʳ
date ; hors recompile, on retomberait à ~4.6 s sur la 1ʳᵉ date et ~19 s au total.

**Courbe de bucket growth sur les 8 dates** (ce qui donne l'amortissement) :

| Date | 1° | 0.75° | 0.5° |
|---|---|---|---|
| 2026-03-20 | 48 | 48 | 48 |
| 2026-04-18 | 102 (+54) | 102 (+54) | 102 (+54) |
| 2026-05-15 | 161 (+59) | 161 (+59) | 161 (+59) |
| 2026-06-21 | 223 (+62) | 223 (+62) | 223 (+62) |
| 2026-07-22 | 283 (+60) | 283 (+60) | 283 (+60) |
| 2026-09-22 | 308 (+25) | 323 (+40) | 329 (+46) |
| 2026-10-21 | 350 (+42) | 365 (+42) | 371 (+42) |
| 2026-12-21 | 383 (+33) | 398 (+33) | 404 (+33) |

**Observation clé** — les 5 premières dates donnent strictement le même nombre
de buckets à toutes les résolutions. Pourquoi ? Avec un sample de 15 min, deux
frames consécutives sont séparées d'environ **3.75° d'azimut**, ce qui dépasse
même la maille la plus fine (0.5°). Chaque nouveau frame tombe donc dans un
bucket distinct, quelle que soit la résolution. Le bucketing ne « compresse »
rien tant que les trajectoires de deux dates ne se recouvrent pas.

La divergence apparaît au 6ᵉ date (septembre équinoxe) : la trajectoire repasse
sur une zone déjà couverte en mars, et à 1° les nouveaux frames retombent plus
souvent dans des buckets existants (+25 seulement) qu'à 0.5° (+46).

### Taille sur disque

| Résolution | Taille fichier (.bin.gz) | Δ vs 1° |
|---|---|---|
| 1°     | 1 817 564 B (1.73 MB) | — |
| 0.75°  | 1 882 240 B (1.80 MB) | +3.6 % |
| 0.5°   | 1 896 704 B (1.81 MB) | +4.4 % |

Chaque bucket stocke 5 masques de bits (sun, sunNoVeg, buildings, vegetation,
terrain) × 25 656 points / 8 = 3 207 octets par masque + header → ~16 KB brut,
~4.7 KB après gzip. La dominante de la taille est le **nombre de buckets** ;
passer à une résolution plus fine ne multiplie pas le stockage proportionnellement.

### Erreur d'approximation — XOR vs tile cache Vulkan date-keyé

21 frames réelles de 2026-04-18 (windows 08:00–10:30, 17:00–17:45, 17:00–19:00),
comparées aux masques retournés par `lookupAtlasBucket((azB, altB))`.

**Masque sun (ensoleillé = 1) — l'indicateur final rendu à l'utilisateur :**

| Résolution | mean | median | p95 | max |
|---|---|---|---|---|
| 1°      | 0.379 % | 0.355 % | 0.604 % | 0.916 % |
| 0.75°   | 0.332 % | 0.312 % | 0.546 % | 0.573 % |
| 0.5°    | 0.262 % | 0.265 % | 0.448 % | 0.651 % |

**Masques désagrégés (utilisés par l'UI pour la légende « à cause de quoi ? »)
à 1°** :

| Kind | mean | median | p95 | max |
|---|---|---|---|---|
| sun        | 0.379 % | 0.355 % | 0.604 % | 0.916 % |
| sunNoVeg   | 0.528 % | 0.413 % | 0.986 % | 1.041 % |
| buildings  | 0.528 % | 0.413 % | 0.986 % | 1.041 % |
| vegetation | 0.431 % | 0.230 % | 1.006 % | 1.610 % |

**Top-8 pires cas à 1°** — tous sub-1 %, concentrés à moyenne altitude solaire
(14–35°) où l'ombre balaie vite et le bucketing d'1° vaut ~2.5 min de temps
solaire :

```
2026-04-18 10:15  az=114.09° alt=34.99°  sunXOR=0.92%
2026-04-18 18:45  az=268.85° alt=16.11°  sunXOR=0.60%
2026-04-18 08:15  az= 90.09° alt=14.89°  sunXOR=0.53%
2026-04-18 09:15  az=101.37° alt=25.16°  sunXOR=0.48%
2026-04-18 10:00  az=110.72° alt=32.60°  sunXOR=0.47%
2026-04-18 08:45  az= 95.61° alt=20.05°  sunXOR=0.45%
2026-04-18 09:45  az=107.48° alt=30.16°  sunXOR=0.39%
2026-04-18 17:30  az=254.39° alt=28.84°  sunXOR=0.37%
```

## Interprétation — le trade-off

- Passer de 1° à 0.5° **divise l'erreur moyenne par ~1.5** (0.38 % → 0.26 %)
  et l'erreur p95 par ~1.35 (0.60 % → 0.45 %). Pour un surcoût disque de
  **+4.4 % seulement** (1.73 MB → 1.81 MB) et un coût de build quasi-identique
  (18.4 s → 19.9 s).
- À ce niveau d'erreur, le **choix de résolution a peu d'importance pratique** :
  même la maille la plus grossière testée (1°) garde l'erreur moyenne bien
  sous 1 % sur tous les frames, dans les pires conditions (basse altitude,
  ombre rasante en fin de journée).
- Le vrai gain conceptuel est ailleurs : **une fois l'atlas peuplé**, toute
  date future réutilise les mêmes buckets. Le coût GPU est amorti sur toutes
  les dates où l'utilisateur demandera un heatmap pour cette tuile. L'amortissement
  se voit dans la courbe : après 8 dates, à 1° on ajoute 33 buckets pour la
  8ᵉ date vs 48 pour la 1ʳᵉ, et **après une couverture complète de l'année,
  la 9ᵉ date ajoutera ~0 bucket**.

## Analogie rainbow tables

On troque du compute pour du stockage précalculé, en exploitant le fait que
l'espace des entrées (positions solaires) est **beaucoup plus petit et prévisible**
que l'espace des sorties (masques d'ombre par tuile).

- Sans atlas : 35 040 frames/an × 250 tuiles × 3 207 B = **~27 GB** pour une
  couverture annuelle à 15 min.
- Avec atlas 1° : ~400 buckets × 250 tuiles × 16 KB ≈ **~1.6 GB**, soit **17×
  moins**, et la couverture reste exacte modulo 0.38 % de XOR moyen sur les
  masques.
- Et surtout : l'atlas est **calculé une fois**. Un heatmap utilisateur au
  30 avril 2027 tape dans les mêmes buckets qu'un heatmap au 15 mars 2026.
