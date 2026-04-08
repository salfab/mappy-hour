# ADR-0008 — Filtrage spatial du VBO pour le support multi-région

**Date** : 2026-04-08  
**Statut** : Accepté  
**Contexte** : L'ajout de Morges et Genève a étendu l'index des bâtiments à 168K obstacles couvrant 61km × 54km. Le shadow map GPU (4096²) ne peut pas couvrir cette zone avec assez de résolution.

## Problème

Le GPU shadow backend charge **tous** les bâtiments de l'index dans un seul VBO. Le shadow map 4096² couvre le bbox de la scène entière (61km × 54km) → résolution de ~15m/pixel. Les bâtiments hors du frustum focus sont rendus mais gaspillent de la résolution. Les tuiles éloignées du centre (Morges, Genève) ont une résolution insuffisante → tout apparaît à l'ombre.

## Options considérées

### Option 1 — Index par région
Un fichier d'index séparé par région (lausanne, morges, genève, nyon). Le serveur charge l'index de la région demandée.

**Pour** : Simple à implémenter, VBO petit.  
**Contre** : Duplication si des bâtiments chevauchent les frontières. Les ombres inter-régions sont perdues. Ajouter une ville = créer un nouvel index.

### Option 2 — Filtrage spatial du VBO ✅
Garder un seul index. Avant de créer le VBO, filtrer les obstacles par bbox autour du frustum focus (+ marge pour les ombres portées).

**Pour** : Source de vérité unique. Ombres inter-régions correctes. Pas de duplication. Ajouter une ville = juste télécharger les DXF.  
**Contre** : Le VBO doit être recréé quand le frustum change de zone (~200ms, rare).

### Option 3 — Augmenter la résolution du shadow map
Passer à 16384². Résolution 3.7m/pixel pour 61km.

**Pour** : 1 ligne de code.  
**Contre** : 1GB de VRAM. Très lent en software rendering (headless-gl). Ne scale pas.

## Décision

**Option 2 — Filtrage spatial du VBO.**

Le filtrage est un simple test de bbox sur les obstacles (~1ms pour 168K). Le VBO ne contient que les bâtiments dans un rayon de ~5km autour du frustum. Le shadow map 4096² couvre ~10km → résolution de ~2.5m/pixel, suffisant.

Le VBO est recréé uniquement quand le frustum change de zone (pas entre tuiles adjacentes). Impact perf négligeable (~200ms par recréation, 0-1 fois par session de precompute).

## Implémentation

1. `loadGpuMeshes` accepte un paramètre optionnel `focusBbox` avec marge
2. Seuls les obstacles dont le bbox intersecte `focusBbox` sont chargés
3. Le cache GPU mesh est indexé par `focusBbox` (pas par le nombre total d'obstacles)
4. `buildSharedPointEvaluationSources` passe le `lv95Bounds` étendu comme `focusBbox`
5. Le VBO est recréé si le `focusBbox` change significativement

## Impact

- **Morges/Genève** : passent de "tout à l'ombre" à fonctionnel
- **Lausanne** : pas de changement (le filtrage donne les mêmes bâtiments)
- **Precompute** : le VBO est recréé ~1 fois par changement de row de tuiles
- **Index** : reste unique pour toutes les régions
