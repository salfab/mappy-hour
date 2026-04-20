# ADR-0014 - Approximation polynomiale Swisstopo pour LV95→WGS84 dans `buildTilePoints`

**Date** : 2026-04-20
**Statut** : Accepté
**Références** : ADR-0011 (Vulkan précompute), commit `7c9b9eb` (Niveau 3 — skip 62500 async calls), `scripts/diag/validate-lv95-fast-vs-proj4.ts`

## Contexte

Le précompute construit pour chaque tuile un tableau de ~62500 points (grille 1m × 250m × 250m). Chaque point a besoin d'un `(lat, lon)` WGS84 pour (1) le rendu cartographique, (2) l'angle solaire (`SunCalc.getPosition`), (3) les exports GeoJSON.

Actuellement `buildTilePoints` (`src/lib/precompute/sunlight-cache.ts:538`) appelle `lv95ToWgs84(easting, northing)` dans la boucle chaude. Cette fonction route vers le pipeline générique de `proj4-js` (`+proj=somerc +ellps=bessel +towgs84=...`), qui fait une cascade d'allocations et de trigos : **~380 000 pts/s mesurés** soit ~165 ms pour 62500 points.

L'instrumentation par sous-phase a montré que `buildTilePoints` représente 100% de la phase `pre` (~200 ms/tuile) — c'est le deuxième plus gros hotspot du précompute après la phase `points` (traitée par Niveau 3 `7c9b9eb`).

## Décision

Dans `buildTilePoints` uniquement, remplacer `lv95ToWgs84` par `lv95ToWgs84Fast`, une approximation polynomiale issue des **formules officielles Swisstopo** (« Approximate formulas for the transformation between Swiss projection coordinates and WGS84 », révision Dec 2016).

La formule (`src/lib/geo/projection.ts:42`) normalise `(E-2600000, N-1200000)` à l'origine de Bern divisée par 10^6, puis applique deux polynômes de degré 3 pour obtenir `(λ, φ)` en centièmes de secondes d'arc. Pas d'allocation, pas de trigo — ~15 multiplications.

Les autres usages de `lv95ToWgs84` (bbox corners dans `buildRegionTiles`, conversions ponctuelles) **restent sur proj4** : ce sont des appels rares hors du chemin chaud, et la précision sub-mm de proj4 est utile pour le bornage géométrique.

## Fix associé — supprimer le round-trip LV95→WGS84→LV95 dans le batch GPU

Le code historique (`sunlight-tile-service.ts:1055`) reconvertissait `(lat, lon)` en `(E, N)` via `wgs84ToLv95` juste avant l'upload GPU batch. Avec proj4 partout, ce round-trip introduisait déjà ~11cm d'erreur (dominée par l'arrondi 6 décimales sur le lat/lon stocké) — historiquement invisible sur nos masques.

Avec `lv95ToWgs84Fast`, cette erreur passerait à ~0.96m, potentiellement suffisante pour flipper un pixel près d'un mur de bâtiment. **Correction appliquée dans le même commit** : `PreparedOutdoorPoint` porte désormais `lv95Easting/lv95Northing` directement depuis `buildTilePoints`, et l'upload batch utilise ces valeurs exactes. Zéro round-trip, zéro dérive, quel que soit l'algo de projection.

## Validation

Script : `npx tsx scripts/diag/validate-lv95-fast-vs-proj4.ts --region=lausanne`

- Points échantillonnés : **227 437 500** (3639 tuiles × grille 1m, toute la région Lausanne)
- Mesure : delta en mètres entre `lv95ToWgs84` (proj4) et `lv95ToWgs84Fast`, histogramme streaming pour percentiles

| Métrique | Valeur |
|---|---|
| Mean delta | 0.853 m |
| p50 | 0.852 m |
| p90 | 0.990 m |
| p99 | 1.049 m |
| p99.9 | 1.070 m |
| **Max** | **1.080 m** (E=2531000.5 N=1149000.5) |
| Points différant après arrondi 6 décimales | 100% |
| Max delta post-arrondi | 1.134 m |

Runtime sur les 227M points :

| Fonction | Temps | Débit |
|---|---|---|
| `lv95ToWgs84` (proj4) | 599 834 ms | 379 168 pts/s |
| `lv95ToWgs84Fast` (poly) | 3 064 ms | 74 237 739 pts/s |
| **Speedup** | **195.8×** | |

Soit **~164 ms gagnés par tuile** (62500 points), à comparer aux ~200 ms de la phase `pre` actuelle.

## Pourquoi 1m est acceptable ici

Le pipeline de précompute utilise LV95 comme vérité géométrique :

- **Ray-march** : tourne en `(easting, northing)` ; le lat/lon n'intervient pas.
- **Identité du point** : `id = "ix{ix}-iy{iy}"` (indices de grille LV95), indépendant du lat/lon calculé.
- **Indexation spatiale** : les bbox de tuiles sont calculées avec `lv95ToWgs84` (proj4), inchangé.
- **Angle solaire** : `SunCalc.getPosition(date, lat, lon)` est insensible à 1m à l'échelle solaire (1m → <0.000001° d'angle).
- **Rendu cartographique** : un décalage de 1m est sous-pixel à partir du zoom 16, invisible à zoom 18+.
- **Stockage** : les `lat/lon` sont déjà arrondis à 6 décimales ≈ 11cm au latitude CH. Le signal utile s'arrête bien en dessous du delta mesuré.

Les 100% de points différant post-arrondi sont donc un artefact de la mesure (la formule Swisstopo est systématiquement décalée d'un offset quasi-uniforme de 0.85m), **pas** un signe de non-déterminisme ou d'erreur localisée.

## Conséquences

Positives :

- gain ~164 ms/tuile → **~27 s sur un run Lausanne 181 tuiles**, stacks avec Niveau 3 (qui gagnait ~27 s sur la phase `points`) ;
- portée chirurgicale : un seul call site changé, aucun état, aucun cache additionnel ;
- aucun changement de format cache ou de protocole IPC ;
- formule officielle Swisstopo (pas un empirique maison), citable et stable.

Compromis :

- **offset ~0.85m constant** sur toute la Suisse ouest — un point précompute peut apparaître décalé d'~1m par rapport à un lieu géocodé via proj4. Acceptable dans notre pipeline (voir section précédente), mais **ne pas réutiliser `lv95ToWgs84Fast` hors de `buildTilePoints`** sans revoir le contrat.
- la précision Swisstopo est annoncée à ~1m sur l'**extent national** ; les tuiles alpines ou tessinoises pourraient montrer un max supérieur. Relancer la validation sur une région orientale avant extension, si pertinent.
- la formule inverse (WGS84→LV95) n'est pas fournie — si jamais on a besoin d'un aller-retour rapide, il faudra la coder aussi.

## Vérification attendue

- [x] Validation statistique sur toute la région Lausanne (227M points, script ci-dessus)
- [ ] Après un run précompute complet, vérifier que la phase `pre` tombe de ~200ms → ~40ms
- [ ] Après un run précompute complet, vérifier qu'**aucun masque d'ombre** ne diverge vs la version proj4 (les masques dépendent des coords LV95, pas du lat/lon — divergence attendue : nulle)
- [ ] Si la précision max >1.5m sur Zurich/Tessin, revoir la décision (ajouter terme d'ordre supérieur, ou exclure la région)

## Références

- Script de validation : `scripts/diag/validate-lv95-fast-vs-proj4.ts`
- Implémentation : `src/lib/geo/projection.ts:42` (`lv95ToWgs84Fast`)
- Call site : `src/lib/precompute/sunlight-cache.ts:538`
- Source des coefficients : Swisstopo, « Approximate formulas for the transformation between Swiss projection coordinates and WGS84 » (Dec 2016)
