# MappyHour — Instructions projet

## Langue
Répondre en français. Commits en anglais (convention du repo).

## Registre des raccourcis — MAINTENANCE OBLIGATOIRE

Le fichier `docs/architecture/shortcuts-registry.md` recense **tous les raccourcis délibérés** (approximations, optimisations à hypothèse implicite, contraintes figées). Il est la source de vérité pour auditer la correction du système quand on étend le scope (nouvelle région, nouvelle résolution, nouveau bâti).

**Règle** : à chaque fois que tu introduis un raccourci, une approximation, une optim qui repose sur une hypothèse implicite, ou que tu revert un raccourci existant :

1. **Mettre à jour `docs/architecture/shortcuts-registry.md`** dans le même commit (ou un commit suivant immédiat).
2. Renseigner toutes les colonnes : raccourci, gain mesuré, hypothèse implicite, condition d'invalidité, bench/ADR, statut.
3. Si l'hypothèse est non-triviale → ADR dédié référencé depuis le registre.
4. Mentionner `shortcuts-registry.md` dans le message de commit pour traçabilité.

**Pas de raccourci sans entrée dans le registre.** Si tu en découvres un non documenté en lisant le code, propose de l'ajouter.

**Audit systématique** : avant de changer la résolution de grille, la taille de tuile, la région cible, le format de cache, ou d'étendre à des bâtiments > 50m, **parcourir la colonne "Condition d'invalidité"** du registre et rebencher ce qui est remis en cause.

## Benchs
Tout raccourci doit avoir un script reproductible dans `scripts/diag/bench-*`. Les mesures dans un ADR sans script bench sont non-reproductibles et donc fragiles.

## ADRs
`docs/architecture/adr-NNNN-*.md`. Numérotation continue. Statut : Proposé / Accepté / Reverté.

## Correction du pipeline de précompute — OBLIGATOIRE

Dès qu'une modif touche la logique de **régénération / écriture / lecture d'une tuile atlas** (backend de shadow, merge de buckets, encode/decode binaire, ordre des masques, indexation outdoor, shader, pipeline d'évaluation), il faut **valider la cohérence du résultat** avant de considérer la tâche terminée. Historique : on a dérivé plusieurs fois en optimisant les perfs sans test comparatif, et la corruption n'est devenue visible qu'après coup.

Deux niveaux de test, à utiliser selon le scope de la modif :

1. **Test unitaire avec tuile de référence précalculée** (rapide, déterministe, doit tourner en CI) :
   - `src/lib/precompute/sunlight-cache-atlas.test.ts` couvre déjà le merge (fresh write + overwrite + round-trip encode/decode).
   - Si la modif change le format binaire ou la sémantique d'un mask, ajouter/mettre à jour un test unitaire avec vecteurs d'entrée/sortie fixés.

2. **Test de cohérence vs CPU raytracing** (lent, empirique, à lancer manuellement après régénération) :
   - `npx tsx scripts/diag/check-atlas-vs-cpu-multi.ts` compare l'atlas sur disque au golden CPU `evaluateInstantSunlight` sur plusieurs tuiles × dates.
   - Seuil : `mism%` attendu ≤ 2% (gap intrinsèque Vulkan-vs-CPU mesuré). Au-dessus = régression.
   - `scripts/diag/check-vulkan-vs-gpuraster.ts` pour valider le backend en isolation (shader + Phase E + full pipeline).

**Règle** : toute PR qui touche ces fichiers doit mentionner dans la description quel test de cohérence a été exécuté et le résultat obtenu. Pas de merge sans ce contrôle.
