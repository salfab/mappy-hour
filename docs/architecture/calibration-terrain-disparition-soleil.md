# Calibration terrain - heure de disparition du soleil

Date: 2026-03-08

## Reponse courte

Oui, noter le jour et l'heure precise ou le soleil disparait derriere un batiment est tres utile.
Dans beaucoup de cas, c'est meme l'observation la plus informative pour calibrer un modele d'ombre.

## Pourquoi c'est efficace

Quand le soleil "disparait", on est a une condition de seuil:

- juste avant: point encore au soleil
- juste apres: point a l'ombre

Ce seuil est tres sensible a:

- hauteur effective de l'obstacle
- altitude de l'observateur
- georeferencement local (quelques metres peuvent suffire)

Donc cette mesure permet de detecter rapidement un biais vertical (offset) ou geometrique.

## Limites (et comment les compenser)

Cette observation seule ne suffit pas toujours si:

- l'horizon est partiellement masque par vegetation, mobilier urbain, etc.
- la meteo est variable (nuages fins)
- l'horloge ou la timezone sont incorrectes

Compensation recommandee:

1. mesurer aussi l'heure de reapparition (si possible)
2. mesurer sur 2 a 3 jours differents
3. mesurer sur 2 a 3 points differents du meme site

## Protocole terrain recommande

## A. Avant sortie

1. Choisir un point fixe bien identifiable (coordonnees precises).
2. Preparer l'heure locale officielle: `Europe/Zurich`.
3. Noter la hauteur d'observation approx. (yeux, terrasse, etc.).

## B. Sur site

1. Observer le point choisi en continu autour de l'heure critique.
2. Noter:
   - date (`YYYY-MM-DD`)
   - heure locale exacte (`HH:MM:SS`) de disparition du soleil
   - heure de reapparition (si observable)
   - coordonnees du point
   - hauteur observateur estimee
   - photos horodatees
3. Ajouter une marge d'incertitude (ex: +/- 15 s, +/- 30 s).

## C. Dans l'application

1. Reproduire exactement:
   - date
   - heure locale
   - timezone
   - coordonnees
2. Tester les parametres experimentaux:
   - `Obs +m (exp)`
   - `Toit bias m (exp)`
3. Chercher la combinaison qui place le modele au seuil au meme instant que le terrain.

## Comment exploiter les resultats

Si l'ombre apparait trop tot dans le modele:

- baisser `Toit bias m` (valeur negative)
- ou augmenter `Obs +m`

Si l'ombre apparait trop tard:

- augmenter `Toit bias m`
- ou diminuer `Obs +m`

Regle pratique:

- d'abord fixer `Obs +m` a la hauteur humaine realiste (ex: 1.7 m)
- ensuite calibrer `Toit bias m`
- valider sur plusieurs points/heures

## Tableau de releve minimal

| date | point lat/lon | disparition soleil (local) | reapparition (local) | obs +m estime | meteo | commentaire |
|---|---|---|---|---|---|---|
| 2026-03-08 | 46.522861, 6.633199 | 17:00:xx | - | 1.7 | ciel clair | esplanade Great Escape |

## Conclusion

Oui, cette mesure aide beaucoup.
Elle est tres efficace pour calibrer rapidement le raccord DEM + batiments, surtout si elle est repetee sur plusieurs points et horaires.
