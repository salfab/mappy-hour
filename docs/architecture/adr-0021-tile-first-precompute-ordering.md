# ADR-0021 — Tile-first precompute ordering

**Date** : 2026-05-08
**Statut** : Accepté
**Références** : ADR-0013 (sun-position-keyed atlas), ADR-0019 (single-worker default), bench `bench-tile-first-vs-day-first.ps1`

## Contexte

Le pipeline de précompute calculait les ombres en mode **day-first** : boucle externe = dates (365 jours),
boucle interne = tuiles. Pour chaque tuile × jour, on dispatchait au GPU les positions solaires du jour,
puis on mergait les résultats dans l'atlas.

Problèmes observés :

- **I/O atlas × N** : pour une tuile couverte sur 365 jours, on lisait/écrivait l'atlas 365 fois.
  Chaque write = gzip/zstd + écriture atomique ~800 KB. Coût répété à chaque jour.
- **Vulkan focus race** : `setFrustumFocus`/`updateMesh` muaient l'état global du backend en dehors
  du lock de session. Avec `PIPELINE_DEPTH > 1`, deux tuiles concurrentes pouvaient corrompre le
  frustum de l'autre mid-dispatch (mismatch ~36 % constaté sur Cathédrale).
- **Zone change serialization** : le changement de mesh par zone forçait le pipeline à serialiser
  (drain complet + updateMesh dans le lock), annulant le bénéfice du pipeline depth.

## Décision

Adopter le mode **tile-first** : boucle externe = tuiles, boucle interne = toutes les dates.

Pour chaque tuile :
1. Union des positions solaires sur tous les jours demandés → set de buckets `(azBucket, altBucket)` uniques.
2. Soustraction des buckets déjà dans l'atlas (via sidecar `.atlas.idx`, ~2 KB).
3. Dispatch GPU unique sur les buckets manquants (chunked à 512 frames pour éviter l'OOM descriptor pool Vulkan).
4. Merge + write atlas une seule fois.

Fixes structurels associés :
- **Per-call focus capsule** : `buildVulkanFocusCapsule()` capture l'état frustum au moment de la
  préparation de la tuile et l'injecte dans `evaluateBatchFramesWithShadows` — le backend applique
  le focus atomiquement dans `withSessionLock`, éliminant la race.
- **Drain barrier** : sur changement de zone, l'orchestrateur draine les tuiles en vol puis appelle
  `prepareVulkanZoneIfChanged` hors lock (updateMesh non-sérialisé), avant de reprendre le pipeline.

## Avantages mesurés

### Bench A/B (2026-05-08, 801 tuiles multi-région, 2 jours, cold, depth=3)

| Ordre | Wall time | Speedup |
|---|---|---|
| day-first | 17.1 min | référence |
| tile-first | 11.1 min | **1.54×** |

Source du gain :

| Métrique | day-first | tile-first | Ratio |
|---|---|---|---|
| Atlas merges/writes | 1602 | 801 | **2× moins** |
| newBuckets GPU (cold) | 91 314 | 69 594 | 1.31× (artefact cold) |

Le facteur 1.31× sur newBuckets est un **artefact du bench cold avec `skip-existing=false`**.
En production (`skipExisting=true`, défaut), day-first filtrait déjà les buckets existants avant
dispatch (ligne `missing = targetBuckets.filter(...)`). La déduplication GPU cross-day était déjà
présente dans day-first — tile-first n'apporte pas de gain GPU supplémentaire à ce niveau.

**Le gain réel de tile-first est exclusivement I/O** : N atlas reads/writes réduits à 1 par tuile.

### Run 365j all-regions (2026-05-08, en cours)

Sur cache partiellement warm (run day-first interrompu à ~65 %) :
- `existing=true` + `newBuckets ≈ 27 %` → ~73 % des buckets skippés grâce à l'atlas existant.
- ETA ~22h pour la couverture complète toutes régions.

## Possibilité : packages de région publiables

Le mode tile-first produit un atlas complet par tuile en une seule passe. Ce format est directement
exploitable pour distribuer des **snapshots de région pré-calculés** :

- Archiver le répertoire `data/precomputed/<region>/` après un run complet → archive tar/zip par région.
- Publier comme **GitHub Release assets** (ex. `lausanne-atlas-v1.0.tar.zst`) téléchargeables sans
  re-calcul GPU.
- Les atlas sont auto-suffisants : le serveur les lit directement, pas de dépendance au pipeline de
  précompute pour les utilisateurs finaux.
- Format versionné par `modelVersionHash` → une release par version de modèle 3D + résolution de grille.

Cela permettrait à terme de séparer la phase de production (nécessite GPU Vulkan + données Swisstopo)
de la phase de déploiement (téléchargement d'assets + `next start`).

## Conséquences

- `MAPPY_PRECOMPUTE_ORDER=tile-first` est le nouveau défaut (via `cache-admin.ts`).
- `MAPPY_PRECOMPUTE_ORDER=day-first` reste disponible pour comparaison.
- `MAPPY_TILE_PIPELINE_DEPTH` (défaut 3) contrôle le nombre de tuiles en vol simultané —
  le GPU traite une tuile à la fois, le CPU prépare les suivantes en parallèle (triple buffering).
- Les atlas existants (day-first ou tile-first) sont interchangeables : même format binaire,
  même sémantique de bucket.

## Vérification

- [x] Bench A/B 801 tuiles (cold, 2 jours) — 1.54× speedup confirmé
- [x] Correctness check-atlas-vs-cpu-multi post-fix focus race (mism% ≤ 2 %)
- [x] Run 365j all-regions en cours sans OOM ni panic (chunking 512 frames, ADR-0019 single-worker)
