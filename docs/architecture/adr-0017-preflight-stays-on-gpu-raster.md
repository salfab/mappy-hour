# ADR-0017 - Preflight grid-metadata reste sur gpu-raster, pas de portage Vulkan

**Date** : 2026-04-24
**Statut** : Accepté
**Références** : commit `4e34995` (fix preflight cache-vide), `scripts/precompute/precompute-tile-grid-metadata.ts`, `scripts/precompute/precompute-all-regions-sunlight.ts`, shortcut-registry 2b.12, ADR-0010 (backend Vulkan batch-only)

## Contexte

Le preflight `precompute-tile-grid-metadata` rend une shadow map zénithale par tuile et classe chaque point de la grille 1 m en indoor/outdoor. Il tourne **une fois par hash de modèle bâti** et ses sorties sont cachées dans `data/cache/tile-grid-metadata/<region>/<modelHash>/`.

Implémentation historique : le preflight itère point par point et appelle `BuildingShadowBackend.evaluate()` pour chacun. C'est une API single-point exposée uniquement par le **backend gpu-raster** (WebGL shadow map). Le backend Vulkan (cf. ADR-0010) est **batch-only** — il évalue N points × M frames en un dispatch, et ne propose pas de chemin single-point.

Quand le cache `data/cache/` a été supprimé pour valider l'autonomie de la chaîne (2026-04-24), le preflight a révélé deux bugs couplés, corrigés dans `4e34995` :

1. Le failfast du shortcut 2b.12 (grid-metadata absent → throw) se déclenchait **à l'intérieur même du preflight**. Contourné par un flag `skipZenithIndoorCheck` passé uniquement par le preflight.
2. Le preflight héritait de `MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan` du parent → `gpuShadowBackend = undefined` → tous les points classés outdoor en silence. Corrigé en forçant `MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster` dans le spawn du preflight.

Cette seconde correction pose la question : **faut-il un jour porter le preflight sur Vulkan** pour cohérence avec le reste du pipeline ?

## Décision

**Non. Le preflight reste sur gpu-raster de manière permanente.** La sortie (masque indoor) est backend-agnostique — seul le moyen de la produire change.

### Raisons

- **Coût du portage** : il faudrait réécrire la boucle point-par-point en batch (un dispatch Vulkan par tuile : 62 500 points, soleil au zénith, récupération du masque). C'est ~1-2 jours de refacto + tests de cohérence vs gpu-raster.
- **Gain mesuré** : aujourd'hui le preflight prend **~4 s par tuile** sur gpu-raster une fois le mesh chargé (cold-start ~3 s pour charger le mesh filtré focus 1km, puis ~0.4 s par tuile suivante dans le même bucket focus). Sur tout Lausanne (301 tuiles) : **~2 min one-shot**, amortis sur des milliers d'heures de précompute atlas qui réutilisent le cache.
- **Fréquence de relance** : le cache est invalidé uniquement quand le hash du modèle bâti change (= rarement : modif du DXF, filtrage différent, changement de gabarit). Pas à chaque run.
- **Ratio coût/bénéfice** : économiser ~1 min en hypothèse optimiste ne justifie pas d'introduire une deuxième surface de test (Vulkan preflight vs gpu-raster preflight), surtout quand le cache se rebuild en ~2 min.

### Conséquences assumées

- Le poste de dev doit avoir **gpu-raster fonctionnel** (ANGLE + WebGL 2) pour rebuild le cache à froid. C'est le cas par défaut sur Windows / macOS / Linux avec un GPU moderne.
- **CI** : si on veut un jour précalculer dans un pipeline CI headless, il faudra soit pré-builder le cache tile-grid-metadata et le commiter, soit s'assurer que le runner expose gpu-raster. Pas un souci aujourd'hui (on ne précompute pas en CI).
- Le mix gpu-raster (preflight) + Vulkan (atlas) reste dans le système. C'est déjà le cas depuis l'intro de Vulkan — l'ADR ne fait qu'expliciter que c'est **permanent** et **pas une dette technique**.

## Alternatives considérées

### A. Porter le preflight sur Vulkan batch

Réécrire la boucle en batch : pour chaque tuile, assembler les 62 500 points de la grille 1 m, appeler `evaluateBatchWithShadows` avec un frame zénith (az=0°, alt=90°), lire le masque `buildingsMask`. Tout point bloqué = sous un toit = indoor.

**Rejetée** : coût de refacto non justifié par le gain (cf. ci-dessus). Le backend Vulkan est optimisé pour N frames × N points — le preflight n'a besoin que de 1 frame × N points, donc le sweet spot Vulkan n'est pas exploité.

### B. Supprimer le preflight et revenir au fallback convex-hull

Avant ADR-0010 / shortcut 2b.12, l'indoor detection utilisait un convex hull sur les footprints + un `approxElevation=500` hardcodé. Rapide mais silencieusement faux : mis-classification de ~80% des bâtiments lausannois dont le toit est sous 500 m absolu.

**Rejetée** : la correction 2b.12 était précisément motivée par cette erreur. Reverter serait une régression qualité.

### C. Accepter que le preflight puisse tourner en CPU

Le preflight sans GPU rendrait un ray-march CPU par point. Testé historiquement : trop lent (ordre de 30+ min sur une région) pour un cache qu'il faut pouvoir rebuild rapidement.

**Rejetée** : le gain de portabilité ne vaut pas la dégradation d'ergonomie dev.

## Vérification

- [x] Preflight cache-vide sur 2 tuiles Montriond : 14520 + 15796 indoor = cohérent avec les runs Vulkan antérieurs (`4e34995`)
- [x] Pipeline complet `precompute:all-regions:vulkan` OK depuis `data/cache/` vide
- [ ] Si besoin CI un jour : tagger le cache tile-grid-metadata produit en local et le stocker dans un artefact partagé plutôt que de porter le preflight

## Références

- Commit `4e34995` — fix preflight cache-vide
- `scripts/precompute/precompute-tile-grid-metadata.ts:148-158` — boucle single-point
- `src/lib/sun/evaluation-context.ts:562-584` — création gpuShadowBackend (gpu-raster uniquement)
- ADR-0010 — backend Vulkan batch-only
- Shortcut registry 2b.12 — failfast grid-metadata
