# ADR-0015 - Approximation SunCalc au centre de tuile pour le batch GPU

**Date** : 2026-04-21
**Statut** : Accepté
**Références** : ADR-0011 (Vulkan précompute), ADR-0014 (LV95→WGS84 rigoureux), `scripts/diag/bench-suncalc-tile-center-precision.ts`, `src/lib/precompute/sunlight-tile-service.ts:1244`

## Contexte

Pour chaque frame temporelle (typiquement 50-100 par jour), le précompute a besoin d'une position solaire `(azimut, altitude)` qui alimente le shader GPU. `SunCalc.getPosition(date, lat, lon)` est une lib astro qui travaille en coordonnées géographiques sphériques — impossible d'y couper.

Deux stratégies étaient possibles :

- **Par point** : 62500 appels SunCalc / frame / tuile — précision maximale, chaque point utilise son propre `(az, alt)`.
- **Centre de tuile** : 1 appel SunCalc / frame / tuile, propagé à tous les 62500 points. Approximation valide tant que la variation du soleil sur 250m × 250m reste sous la résolution des masques (grille 1m).

Le code (`sunlight-tile-service.ts:1244`) implémente l'option centre-de-tuile depuis longtemps, mais sans validation chiffrée documentée. Cet ADR comble ce trou.

## Décision

**Garder l'approximation tile-center.** Le shader GPU reçoit un unique `(az, alt)` calculé sur `tileCenterWgs84`, appliqué à tous les points de la tuile.

Économies : **62499 appels SunCalc / frame / tuile évités**. Sur Lausanne (301 tuiles × ~50 frames) : ~940M appels évités par run précompute. SunCalc coûte ~3-5 μs/appel → économie de **50-80s par run** minimum.

## Validation

Bench `scripts/diag/bench-suncalc-tile-center-precision.ts` — tuile 250m × 250m à Lausanne, grille de 21×21 sample points, 31 frames au-dessus de l'horizon pour le 21 juin (solstice d'été, 05:00 → 21:00 UTC+2).

### Delta angulaire vs point central

| Mesure | mean | p99 | max |
|---|---|---|---|
| Azimut | 3.6″ | 13.3″ | 15.7″ |
| Altitude | 2.1″ | 5.0″ | 5.7″ |

(en secondes d'arc ; 1″ ≈ 1/3600°)

### Déplacement d'ombre résultant (ce qui compte pour les masques booléens)

Erreur calculée comme `max(shift le long de l'ombre, shift latéral)` :
- le long : `h · δalt / sin²(alt)`
- latéral : `L · δaz` où `L = h / tan(alt)`

| Hauteur bâtiment | mean | p99 | max |
|---|---|---|---|
| 5 m | 3.6 mm | 78 mm | 122 mm |
| 10 m | 7 mm | 157 mm | 243 mm |
| 20 m | 14 mm | 313 mm | 486 mm |
| 50 m | 36 mm | 783 mm | 1215 mm |

### Lecture

Notre grille est à 1m. **Tout ce qui reste sous 500mm est sub-pixel** et donc invisible dans les masques finaux.

- Bâtiments ≤ 20m (≈ 100% de la couverture Lausanne/Morges/Nyon/Genève) : p99 < 50cm, max < 50cm → **jamais détectable**.
- Bâtiments 50m (high-rises isolés type tour Taoua, tour du Flon, CEVA Genève) : p99 ~78cm (proche du pixel), max ~1.2m (un pixel visible) — **uniquement au coin extrême d'une tuile avec soleil rasant < 10°**. Régime marginal.

### Quand l'approximation commencerait à poser problème — "Si Lausanne était New York"

Si on élargissait MappyHour à une ville de gratte-ciels (Manhattan : bâtiments 200-400m, certains > 500m), la situation changerait :

| Hauteur | max shift (projection linéaire) |
|---|---|
| 200 m | ~4.9 m |
| 400 m | ~9.7 m |
| 500 m | ~12.1 m |

À ces hauteurs, au grazing (soleil < 10°), l'ombre d'un bâtiment traverse plusieurs tuiles et l'approximation tile-center devient **visible à l'œil nu** sur les masques (plusieurs pixels de dérive entre le coin nord et le coin sud d'une même tuile pour le même bâtiment).

**Dans ce régime**, il faudrait soit :
- raccourcir les tuiles (passer à 50m × 50m, erreur divisée par 5)
- soit repasser à SunCalc par-point (coût +50-80s / run — acceptable une fois par ville)
- soit interpoler bilinéairement `(az, alt)` entre les 4 coins de la tuile (compromis : 4× appels SunCalc au lieu de 1× ou 62500×, erreur résiduelle ~4× plus faible).

Pour la Suisse actuelle (bâti max ~150m, quasi aucun building > 50m dans nos régions), **aucune action nécessaire**.

## Conséquences

Positives :
- 940M appels SunCalc évités par run Lausanne complet — gain perf significatif, caché dans la structure même du batch GPU ;
- code shader identique (un seul `(az, alt)` par frame, uniforme sur toute la tuile) ;
- pas de duplication ni de cache additionnel.

Compromis :
- **Limite explicite** : invalide si bâtiments > 100m dans la région + exigence précision sub-pixel au grazing. Documenter dans tout nouveau scope (extensions internationales, CBD densement vertical).
- **Invariant de tuilage** : l'approximation suppose des tuiles ≤ 250m × 250m. Si on passe à des tuiles plus grandes (ex. 500m pour réduire les coûts I/O), l'erreur angulaire quadruple approximativement — à rebencher.
- **Hypothèse grille 1m** : si on passait à une grille sub-métrique (0.5m, 0.25m), il faudrait rebencher. À 0.5m, le seuil "sub-pixel" tombe à 250mm et certaines configurations 20m-grazing deviendraient visibles.

## Vérification

- [x] Bench angulaire sur 21 juin Lausanne (tuile 250m, grille 21×21, 31 frames) — deltas sub-arcmin partout
- [x] Conversion en déplacement d'ombre pour bâtiments 5/10/20/50m — sub-pixel jusqu'à 20m
- [ ] Si extension à une région avec high-rises > 50m : relancer `bench-suncalc-tile-center-precision.ts` avec la tuile cible et valider que max < 500mm (seuil pixel).

## Références

- Bench : `scripts/diag/bench-suncalc-tile-center-precision.ts`
- Call site : `src/lib/precompute/sunlight-tile-service.ts:1244`
- ADR-0011 : décisions Vulkan précompute
- ADR-0014 : projection LV95→WGS84 rigoureuse (source des `(lat, lon)` du centre de tuile)
