# Checklist Exécutable - Chantier Optimisation

Date: 2026-03-29  
Source principale: `docs/architecture/web-performance-throughput-and-cost-playbook.md`

## Objectif

Avoir une checklist simple pour piloter le chantier optimisation sans ambiguïté:
- quoi faire,
- dans quel ordre,
- comment valider.

## Légende statut

- `FAIT`: livré et validé (au moins benchmark/tests ciblés)
- `PARTIEL`: livré en partie, manque de couverture ou d’intégration
- `A FAIRE`: non démarré

## P0 - Quick wins (priorité immédiate)

| ID | Action | Statut | Validation |
|---|---|---|---|
| P0-1 | Métriques standard par requête (`pointCount`, `frameCount`, `point-evaluations`, latence) | `PARTIEL` | Logs/API homogènes sur `area`, `instant/stream`, `timeline/stream` |
| P0-2 | In-flight dedup (requêtes identiques) | `FAIT` | Pas de double calcul concurrent sur même clé |
| P0-3 | Guardrails de charge | `PARTIEL` | Limites cohérentes + message d’erreur actionnable |
| P0-4 | Defaults orientés coût | `PARTIEL` | Valeurs par défaut réalistes UI/API sur zones fréquentes |
| P0-5 | Short-circuit terrain d’abord | `FAIT` | Quand terrain bloque, pas de calcul building/végétation inutile |
| P0-6 | High-sun coarse gate (horizon) | `FAIT` | Bypass terrain check en soleil haut, sans régression résultat |

## P1 - Gros gains CPU

| ID | Action | Statut | Validation |
|---|---|---|---|
| P1-1 | Index spatial bâtiments + corridor candidats | `FAIT` | Baisse `checkedObstaclesCount`, parité résultat |
| P1-2 | Contexte partagé par tuile | `FAIT` | Parité stricte + réduction nette du temps de préparation |
| P1-3 | Parallélisme de calcul | `FAIT` | Worker pool actif, benchmark recommande 4 workers |
| P1-4 | Partage adaptatif masques horizon | `FAIT` | Budget d’erreur respecté + fallback local |
| P1-5 | Optimisation ciblée moteur bâtiments restant | `PARTIEL` | Profil CPU avant/après sur hotspots |

## P2 - Passage à l’échelle web

| ID | Action | Statut | Validation |
|---|---|---|---|
| P2-1 | API job async lourde + progression | `PARTIEL` | Flux job stable et observable |
| P2-2 | Cache persistant frame/tile/day | `FAIT` | Hit cache sur runs précomputés |
| P2-3 | Précompute zones populaires | `PARTIEL` | Packs prêts (terrasses/hotspots) |
| P2-4 | Interpolation tous les K jours + fallback exact | `A FAIRE` | Budget erreur défini et mesuré |

## Prochaine exécution recommandée (ordre concret)

1. Finaliser `P0-3` en ajoutant un budget `point-evaluations` (sync/stream) en plus de `maxPoints`.
2. Finaliser `P0-1` avec une sortie métriques uniforme (API + logs + benchmark scripts).
3. Finaliser `P1-5` via profilage ciblé moteur bâtiments sur 3 hotspots.
4. Fermer `P2-1` en stabilisant le modèle job async côté sunlight (pas seulement admin precompute).

## Critères de “chantier terminé”

- Les items P0 et P1 sont `FAIT`.
- Les endpoints sunlight exposent des métriques comparables.
- On dispose d’un benchmark de non-régression perf + précision versionné.
- Les erreurs de limites sont compréhensibles et proposent une action.

## Commandes utiles (référence rapide)

```bash
pnpm test
pnpm run benchmark:precompute:cpu:breakdown
pnpm run benchmark:precompute:workers
pnpm run precompute:region --help
```

## Références

- `docs/architecture/web-performance-throughput-and-cost-playbook.md`
- `docs/architecture/precompute-cpu-lots-report-2026-03-15.md`
- `docs/architecture/precompute-workers-benchmark-2026-03-15.md`
- `docs/architecture/optimisations-et-cache-synthese.md`
