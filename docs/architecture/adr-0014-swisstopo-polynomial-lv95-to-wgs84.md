# ADR-0014 - Algorithme rigoureux Swisstopo pour LV95→WGS84 dans `buildTilePoints`

**Date** : 2026-04-20
**Statut** : Accepté
**Références** : ADR-0011 (Vulkan précompute), commit `7c9b9eb` (Niveau 3 — skip 62500 async calls), `scripts/diag/validate-lv95-fast-vs-proj4.ts`, `scripts/diag/bench-lv95-3algos.ts`

## Contexte

Le précompute construit pour chaque tuile un tableau de ~62500 points (grille 1m × 250m × 250m). Chaque point a besoin d'un `(lat, lon)` WGS84 pour (1) le rendu cartographique, (2) l'angle solaire (`SunCalc.getPosition`), (3) les exports GeoJSON.

Initialement `buildTilePoints` (`src/lib/precompute/sunlight-cache.ts:538`) appelait `lv95ToWgs84(easting, northing)`, qui route vers le pipeline générique de `proj4-js` (`+proj=somerc +ellps=bessel +towgs84=...`). Ce pipeline fait une cascade d'allocations et de trigos : **~230 000 - 380 000 pts/s mesurés** selon la charge, soit ~165-270 ms pour 62500 points.

L'instrumentation par sous-phase a montré que `buildTilePoints` représentait 100% de la phase `pre` (~200 ms/tuile) — deuxième plus gros hotspot du précompute après la phase `points` (traitée par Niveau 3 `7c9b9eb`).

## Décision

Dans `buildTilePoints` uniquement, remplacer `lv95ToWgs84` par `lv95ToWgs84Precise` — une **implémentation inline de l'algorithme rigoureux Swisstopo** en TypeScript, sans allocation ni abstraction de pipeline.

L'algorithme suit la méthode officielle Swisstopo :
1. LV95 → offsets depuis le point fondamental de Bern
2. Plan → sphère (Mercator oblique inverse)
3. Sphère oblique → sphère équatoriale
4. Sphère → latitude Bessel (itération 3×)
5. Bessel géodésique → géocentrique + translation 3-paramètres (CH1903+ → ETRS89)
6. Géocentrique → WGS84 géodésique (itération 3×)

Source : Swisstopo "Formeln und Konstanten für die Berechnung der Schweizerischen schiefachsigen Zylinderprojektion und der Transformation zwischen Koordinatensystemen".

Les autres usages de `lv95ToWgs84` (bbox corners dans `buildRegionTiles`, conversions ponctuelles) **restent sur proj4** : appels rares hors du chemin chaud, pas d'enjeu perf.

## Pourquoi pas la formule approximative (polynomiale) ?

Une première version de cet ADR proposait `lv95ToWgs84Fast`, l'approximation polynomiale officielle Swisstopo (degré 3, ~15 multiplications, aucune trigo). Validation initiale sur Lausanne donnait max 1.08m de delta vs proj4 — acceptable.

Un bench étendu (`scripts/diag/bench-lv95-3algos.ts`, 1.96M points sur Geneva) a révélé que la polynomiale diverge avec la distance à Bern :

| Région | Max delta Fast vs proj4 |
|---|---|
| Lausanne | 1.08 m |
| Geneva | **2.60 m** |

Cette variabilité inter-région rend Fast difficile à documenter sans clauses spéciales par région. L'algorithme rigoureux élimine ce risque — précision uniforme partout en Suisse.

## Validation

### Précision (rigoureux vs proj4)

`scripts/diag/bench-lv95-3algos.ts`, Geneva, 1.96M points :

| Metric | Precise vs proj4 | Fast vs proj4 |
|---|---|---|
| Mean delta | **0.0000 m** | 2.2756 m |
| p99 | **0.0000 m** | 2.5550 m |
| Max | **0.0000 m** (sub-mm) | 2.6016 m |

L'algorithme rigoureux match proj4 à l'arrondi flottant près — **aucune perte de précision observable**.

### Runtime

| Algo | Durée (1.96M pts) | Débit | Speedup |
|---|---|---|---|
| proj4 | 8456 ms | 231k pts/s | 1× |
| **Precise (rigoureux)** | **1374 ms** | **1.4M pts/s** | **6.2×** |
| Fast (polynomial, non retenu) | 37 ms | 53M pts/s | 228× |

Gain par tuile (62500 pts) : **proj4 ~270ms → Precise ~44ms**, soit **~226ms économisés**. Sur 181 tuiles Lausanne : **~41 s gagnés** par run précompute, stacks avec Niveau 3 (gain ~27s sur la phase `points`).

Precise capture **84% du gain maximal théorique** (Fast sauverait 269ms/tuile, Precise 226ms) tout en gardant la précision de proj4.

## Fix associé — supprimer le round-trip LV95→WGS84→LV95 dans le batch GPU

Le code historique (`sunlight-tile-service.ts:1055`) reconvertissait `(lat, lon)` en `(E, N)` via `wgs84ToLv95` juste avant l'upload GPU batch. Avec proj4 partout, ce round-trip introduisait déjà ~11cm d'erreur (dominée par l'arrondi 6 décimales sur le lat/lon stocké) — historiquement invisible sur nos masques.

Même si `lv95ToWgs84Precise` match proj4, le round-trip reste sous-optimal (inutile). **Correction appliquée** : `PreparedOutdoorPoint` porte désormais `lv95Easting/lv95Northing` directement depuis `buildTilePoints`, et l'upload batch utilise ces valeurs exactes. Zéro round-trip, zéro dérive résiduelle.

## Conséquences

Positives :

- gain ~226 ms/tuile, **~41s sur 181 tuiles Lausanne**, stacks avec Niveau 3 ;
- **précision sub-mm garantie sur toute la Suisse** — identique à proj4, pas de clause par région ;
- portée chirurgicale : un seul call site changé, aucun état, aucun cache additionnel ;
- aucun changement de format cache ou de protocole IPC ;
- algorithme officiel Swisstopo, formules documentées et stables.

Compromis :

- ~85 lignes de code supplémentaires dans `projection.ts` (constantes + algo) ;
- deux boucles itératives (latitude Bessel, latitude WGS84) mais qui convergent en 3 itérations grâce aux bonnes initialisations.
- **ne pas réutiliser `lv95ToWgs84Precise` pour des points à élévation non-nulle** sans revoir : l'implémentation suppose `h=0` lors de la conversion géodésique→géocentrique, ce qui est suffisant pour nos grilles de sol mais pas pour des points 3D quelconques.

## Note historique — `lv95ToWgs84Fast` est laissée dans le code

La formule polynomiale `lv95ToWgs84Fast` est conservée dans `src/lib/geo/projection.ts` et utilisée uniquement par le bench de comparaison. Elle n'est **pas branchée dans le pipeline**. À supprimer si elle ne trouve pas d'usage futur.

## Vérification attendue

- [x] Validation statistique sur Geneva (1.96M points, script `bench-lv95-3algos.ts`) — match sub-mm
- [ ] Après un run précompute complet, vérifier que la phase `pre` tombe de ~200ms → ~45ms
- [ ] Après un run précompute complet, vérifier qu'**aucun masque d'ombre** ne diverge vs la version proj4 (divergence attendue : nulle, car les coords LV95 passées au shader sont inchangées grâce au fix du round-trip)

## Références

- Bench tri-algo : `scripts/diag/bench-lv95-3algos.ts`
- Validation initiale Fast : `scripts/diag/validate-lv95-fast-vs-proj4.ts`
- Implémentation : `src/lib/geo/projection.ts` (`lv95ToWgs84Precise`)
- Call site : `src/lib/precompute/sunlight-cache.ts:538`
- Source : Swisstopo, "Formeln und Konstanten für die Berechnung der Schweizerischen schiefachsigen Zylinderprojektion und der Transformation zwischen Koordinatensystemen"
