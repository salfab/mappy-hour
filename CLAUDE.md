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
