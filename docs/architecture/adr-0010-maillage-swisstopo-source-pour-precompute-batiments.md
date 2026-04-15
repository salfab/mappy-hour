# ADR-0010 - Maillage SwissTopo source pour le precompute bâtiments

**Date** : 2026-04-14
**Statut** : Accepté
**Supersède** : ADR-0005 pour le choix actif du calcul bâtiment en precompute

## Contexte

ADR-0005 avait choisi une approche à deux niveaux : prisme rapide, puis vérification maillage SwissTopo uniquement pour les cas limites. Ce choix était raisonnable quand le coût d'un test détaillé systématique semblait trop élevé.

Les optimisations suivantes ont déplacé le problème :

- les tuiles de precompute sont bornées et priorisées par sélection de tuiles chaudes ;
- le filtrage spatial du VBO (ADR-0008) réduit fortement le mesh chargé autour de la tuile ;
- le chemin `gpu-raster` exploite déjà les meshes SwissTopo source quand ils sont disponibles ;
- le spike Rust/wgpu Vulkan (ADR-0009) montre que le même type de mesh peut être évalué dans un process GPU natif long-lived ;
- les faux positifs liés aux empreintes/prismes simplifiés restent visibles sur des bâtiments complexes.

## Décision

Pour le precompute, nous privilégions le maillage SwissTopo source plutôt qu'un calcul prisme simplifié avec vérification détaillée ciblée.

La stratégie active devient :

1. utiliser le mesh SwissTopo source quand il existe ;
2. borner le coût par la sélection de tuiles, le cache de metadata indoor/outdoor et le filtrage spatial ;
3. garder le fallback prisme uniquement comme chemin de secours quand le mesh source est absent ou inutilisable ;
4. ne pas réintroduire de simplification géométrique pour gagner quelques millisecondes si elle augmente les faux positifs d'ombre ;
5. mesurer les backends GPU (`gpu-raster`, Rust/wgpu Vulkan) sur le vrai chemin `computeSunlightTileArtifact`, pas seulement sur un micro-benchmark bâtiment.

## Conséquences

Positives :

- meilleure fidélité sur les bâtiments complexes ;
- moins de cas où une empreinte simplifiée produit une ombre faussement bloquante ;
- cohérence entre le precompute et les chemins GPU qui utilisent déjà le VBO filtré ;
- stratégie plus simple à expliquer : la performance vient du bornage spatial, pas d'une géométrie appauvrie.

Compromis :

- le mesh source reste plus lourd qu'un prisme pur ;
- les perfs doivent rester surveillées sur les tuiles chaudes et les fenêtres longues ;
- les chemins CPU historiques peuvent rester utiles comme fallback ou diagnostic, mais ne doivent plus piloter le choix par défaut du precompute.

## Impact sur ADR-0005

ADR-0005 reste un historique utile : elle explique les faux positifs du prisme et l'introduction de `evaluateBuildingsShadowTwoLevel`.

Elle est cependant supersédée pour la décision de production du precompute. Le deux-niveaux ne doit plus être présenté comme le choix cible : c'est un chemin legacy/diagnostic ou fallback CPU, alors que le precompute doit viser le mesh SwissTopo source filtré spatialement.

## Vérification attendue

Avant de promouvoir un nouveau backend accéléré, comparer au minimum :

- une tuile chaude courte pour le coût fixe de setup ;
- une fenêtre longue sur une tuile chaude pour amortir le setup ;
- une mini-matrice multi-tuiles top-priority ;
- la différence de masque final soleil, pas uniquement le masque bâtiment ;
- le comportement de fallback si un mesh SwissTopo manque.
