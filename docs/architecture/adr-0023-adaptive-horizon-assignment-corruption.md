# ADR-0023: Corruption des assignations d'horizon adaptatif

**Date:** 2026-05-10
**Status:** Proposed

## Context

En production self-hosted sur Mitch, une requete timeline en mode cache-only a termine avec une longue liste de warnings du type:

```text
Adaptive terrain horizon resolution failed for tile e2537500_n1150500_s250 (Unexpected non-whitespace character after JSON at position 110942).
No horizon mask. Callers should supply `terrainHorizonOverride` (...). Far-horizon blocking will be ignored.
```

Le symptome etait visible dans l'UI, mais la cause probable est en amont: certaines tuiles atlas ont ete generees pendant un precompute ou la resolution d'horizon adaptatif n'a pas pu relire un fichier JSON d'assignation. La timeline cache-only ne recalculait pas ces masques; elle servait les atlas existants et propageait les warnings stockes dans les metadonnees.

Le runtime a ete durci cote UX pour condenser ces warnings repetitifs, mais cette condensation n'est pas une correction de fond. Les atlas concernes peuvent manquer de masque d'horizon lointain et donc surestimer l'ensoleillement quand le relief lointain bloque le soleil.

## Diagnostic

Le chemin suspect est `src/lib/sun/adaptive-horizon-sharing.ts`:

- `loadAssignment()` lit un fichier d'assignation et applique `JSON.parse(raw)`.
- `persistAssignment()` reecrit ce fichier via `fs.writeFile(targetPath, JSON.stringify(...))`.
- Plusieurs appels de precompute peuvent toucher la meme assignation adaptive si les tuiles partagent la meme macro-cellule, le meme bucket temporel et le meme hash de modele.

Un `Unexpected non-whitespace character after JSON` indique typiquement que le fichier commence par un JSON valide mais contient des octets supplementaires apres la fin attendue. Les causes a verifier sont:

1. ecriture interrompue ou partielle pendant le precompute;
2. deux ecritures concurrentes sur le meme `targetPath`;
3. ancien contenu plus long non remplace proprement;
4. copie/synchronisation de cache interrompue;
5. bug de persistance non atomique dans `persistAssignment()`.

Le point important: ce n'est probablement pas une erreur "live" de timeline. C'est un artefact de cache/precompute que la timeline a revele en lisant les atlas deja calcules.

## Decision

Traiter les assignations d'horizon adaptatif comme un cache critique du pipeline de precompute, pas comme une simple optimisation opportuniste.

Avant de regenerer massivement les atlas ou d'etendre la zone, il faut creuser et fermer les points suivants:

1. ajouter un script de diagnostic qui scanne `processed/horizon/adaptive-sharing/**.json`, parse chaque fichier, et liste les fichiers invalides avec taille, mtime et chemin;
2. rendre `persistAssignment()` crash-safe avec ecriture vers fichier temporaire puis rename atomique;
3. verifier s'il existe une concurrence possible entre workers/processus sur le meme fichier et, si oui, ajouter un verrou local ou une deduplication in-flight par `targetPath`;
4. decider d'une strategie de quarantaine: renommer les JSON invalides en `.corrupt-<timestamp>` et forcer une regeneration controlee, plutot que continuer silencieusement sans horizon;
5. apres regeneration des tuiles touchees, lancer le test de coherence atlas vs CPU (`npx tsx scripts/diag/check-atlas-vs-cpu-multi.ts`) sur un echantillon couvrant les tuiles signalees.

## Consequences

### Positive

- On evite de masquer un probleme de correction sous une simple amelioration UI.
- Le cache d'horizon adaptatif devient auditable avant un deploy ou une regeneration.
- Une ecriture atomique reduit le risque de reproduire des atlas partiellement prives d'horizon lointain.

### Negative

- Une regeneration apres quarantaine peut etre couteuse.
- Le diagnostic doit distinguer les caches vraiment corrompus des caches obsoletes ou simplement absents.
- Si la corruption est due a plusieurs processus de precompute lances en parallele, le fix doit couvrir l'orchestration, pas seulement l'ecriture fichier.

### Current Mitigation

La route timeline stream normalise maintenant les warnings repetitifs:

- les erreurs JSON d'assignation adaptive sont regroupees en un warning unique;
- le warning "No horizon mask" est reformule pour indiquer que l'atlas cache peut manquer de blocage par horizon lointain.

Cette mitigation reduit le bruit UI, mais ne change pas les donnees cachees. Les atlas deja produits restent a auditer/regenerer.

## Follow-up

- Creer `scripts/diag/check-adaptive-horizon-assignments.ts`.
- Ajouter un bench ou diagnostic reproductible si une optimisation de concurrence/ecriture est introduite.
- Regenerer les tuiles impactees sur Mitch apres correction.
- Documenter dans le runbook self-hosting comment auditer `C:\mappy-data\processed\horizon\adaptive-sharing`.

## References

- `src/lib/sun/adaptive-horizon-sharing.ts`
- `src/app/api/sunlight/timeline/stream/route.ts`
- `docs/architecture/shortcuts-registry.md` entree 2b.9
- ADR-0013: Sun-position keyed cache
- ADR-0020: Zstd atlas compression
