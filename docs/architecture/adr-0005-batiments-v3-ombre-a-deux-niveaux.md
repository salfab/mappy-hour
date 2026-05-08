# ADR-0005 - Bâtiments V3: ombre à deux niveaux (prisme + vérification détaillée ciblée)

Date: 2026-03-15  
Statut: supersédé par ADR-0010 le 2026-04-14

## Note de supersession

Cette ADR décrit une décision correcte au moment où le calcul bâtiment était encore dominé par le coût CPU d'une vérification maillage détaillée. Elle n'est plus la décision active pour le precompute.

Les travaux ultérieurs ont changé les contraintes :

- la sélection de tuiles chaudes et le tuilage 250m bornent fortement le volume à calculer ;
- le filtrage spatial du VBO (ADR-0008) permet de ne charger que les bâtiments utiles autour de la tuile ;
- les chemins `gpu-raster` et Rust/wgpu Vulkan travaillent directement sur les meshes SwissTopo quand ils sont disponibles ;
- les faux positifs liés aux empreintes/prismes simplifiés coûtent plus cher en qualité que le gain de simplification ne rapporte en performance.

La décision active est donc ADR-0010 : pour le precompute, on privilégie les meshes SwissTopo source, avec filtrage spatial et fallback contrôlé, plutôt qu'une stratégie prisme + vérification détaillée ciblée.

## Contexte

Le moteur bâtiment "prisme" est rapide et robuste, mais peut produire des faux positifs:

- certains bâtiments complexes ont une empreinte simplifiée qui bloque un rayon alors que la géométrie 3D réelle ne bloque pas.
- ces écarts apparaissent surtout près du seuil (quand l'altitude solaire est proche de l'angle limite du bloqueur).

Le test détaillé SwissTopo (maillage DXF) est plus fidèle, mais trop coûteux si on l'applique partout.

## Décision

On adopte une approche **à deux niveaux**:

1. **Niveau 1 (rapide, par défaut)**: calcul prisme (méthode existante, index spatial).
2. **Niveau 2 (ciblé)**: vérification maillage SwissTopo uniquement pour les cas "limites":
   - le prisme bloque,
   - la marge angulaire est faible (`blockerAltitudeAngleDeg - solarAltitudeDeg <= 2°`),
   - et dans une limite de raffinement (`maxRefinementSteps = 3`).

Si la vérification détaillée dit "non bloqué", on exclut ce bloqueur et on retente pour trouver un éventuel second bloqueur.

## Ce qui a été implémenté

- `evaluateBuildingsShadowTwoLevel` dans `src/lib/sun/buildings-shadow.ts`
  - boucle de raffinement près du seuil,
  - exclusion progressive de bloqueurs invalidés.
- `createDetailedBuildingShadowVerifier`
  - chargement/parse des DXF SwissTopo à la demande (cache mémoire),
  - ray-tracing triangle pour confirmer/infirmer le bloqueur candidat.
- activation dans `buildPointEvaluationContext`
  - utilisé automatiquement pour le calcul bâtiments,
  - désactivable via `MAPPY_BUILDINGS_TWO_LEVEL_REFINEMENT=0`.
- version d'algo cache incrémentée:
  - `SUNLIGHT_CACHE_ALGORITHM_VERSION = "sunlight-cache-v4"`.

## Pourquoi ce choix

- **Plus précis** qu'un prisme seul sur les zones où les faux positifs sont visibles.
- **Beaucoup moins coûteux** qu'un maillage détaillé systématique.
- **Générique**: aucune règle hardcodée par bâtiment.

## Compromis

- Coût CPU un peu supérieur au prisme pur sur les zones avec beaucoup de cas limites.
- Dépendance plus forte aux données DXF brutes présentes sur disque.

## Résultat attendu

- Diminution des faux positifs d'ombre bâtiment dans les zones critiques (terrasses/esplanades),
- tout en gardant un temps de calcul compatible avec l'usage web.

## Impact API / contrats

- Aucun changement de schéma API public.
- Le champ diagnostic `buildingsShadowMethod` inclut désormais le suffixe:
  - `|two-level-near-threshold-v1` quand la vérification détaillée est active.

## Tests

- `src/lib/sun/buildings-shadow.test.ts`
  - vérifie qu'un faux bloqueur près du seuil peut être invalidé par le niveau détaillé,
  - vérifie le fallback sur un second bloqueur.
- `src/lib/sun/evaluation-context.test.ts`
  - compatibilité du pipeline de contexte après intégration.
