# Mappy Hour - Synthese 1 page (non technique)

Date: 2026-03-18

## Objectif

Rendre l'application plus rapide, plus fiable, et moins coûteuse a faire tourner, tout en gardant une bonne precision sur les zones ensoleillees/ombrees.

## Ce que nous avons ameliore

1. Calcul plus intelligent
- On evite de faire des calculs inutiles.
- On ecarte tres tot les obstacles qui ne peuvent pas bloquer le soleil.
- On reutilise des elements deja prepares au lieu de les reconstruire point par point.

2. Cache a plusieurs niveaux
- Cache en memoire pour les requetes repetitives a court terme.
- Cache sur disque pour reutiliser les resultats lourds deja calcules.
- Deduplication: si 2 requetes identiques arrivent en meme temps, on ne calcule qu'une fois.

3. Precompute (calcul en avance)
- On peut precalculer des zones et des plages horaires.
- Ces donnees sont ensuite servies tres vite dans l'interface.
- Les jobs de precompute sont suivis, annulables, reprenables et purgeables.

4. Parallelisme
- Le precompute est execute en parallele sur plusieurs workers.
- Recommandation actuelle: 4 workers (meilleur compromis observé).

5. Versioning fiable des donnees
- Si un modele, une calibration ou l'algo change, le systeme invalide automatiquement l'ancien cache.
- Cela evite de servir des resultats obsoletes.

## Resultat concret (ordre de grandeur)

- Gros gains CPU sur les optimisations structurelles (selection obstacles + contexte partage).
- Gain net supplementaire avec le multithread (jusqu'a environ x2 sur charge lourde avec 4 workers).
- Interface plus reactive sur les zones deja precalculees.

## Ce qu'il faut retenir

- Le gain principal vient de \"moins calculer inutilement\", pas seulement de \"calculer plus vite\".
- Le cache est devenu central pour la performance.
- Le precompute est la cle pour une experience web fluide a grande echelle.

## Limites actuelles

- Les cas a soleil tres bas restent sensibles sur certains hotspots.
- Le volume de cache peut grandir vite avec des grilles tres fines (1m) sur de grandes zones.
- Il faut continuer a benchmarker chaque optimisation pour ne pas degrader la precision.

## Démystification rapide

- **Precompute**: calculer a l'avance.
- **Cache**: stocker un resultat pour le reutiliser sans recalcul.
- **Worker**: processus en parallele pour accelerer le traitement.
- **DEM**: carte d'altitude du terrain.
- **Masque d'horizon**: profil des montagnes/reliefs qui peuvent cacher le soleil.
- **Tuile**: petit carre de carte traite independamment.

## Prochaine etape simple

Generaliser le precompute sur les zones d'interet prioritaires (terrasses, hotspots), puis monitorer precision/performance en continu.
