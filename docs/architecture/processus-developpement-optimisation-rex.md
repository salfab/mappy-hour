# Processus de Développement Optimisation - REX

Date: 2026-03-30  
Portée: moteur d'ensoleillement (terrain + horizon + bâtiments + végétation), cache, précompute, UI/admin.

## 1) Contexte fonctionnel cible

Le chantier optimisation n'a jamais été un simple exercice de micro-perf.  
Le contexte fonctionnel visé a été défini ainsi:

1. Prédire correctement les zones soleil/ombre sur des zones urbaines réelles (Lausanne/Nyon).
2. Garder une architecture web exploitable (latence, coût, robustesse).
3. Préserver les diagnostics utiles (cause d'ombre, distances, mode de blocage).
4. Rendre le résultat opérable en produit (stream, progression, annulation, reprise, précompute, cache).

En pratique, le critère de succès n'est pas "aller vite" uniquement, mais:
- **précision suffisante sur des hotspots réels**,  
- **coût CPU maîtrisé**,  
- **comportement stable en prod web**.

## 2) Méthode de développement utilisée

Approche itérative appliquée en boucle:

1. Formuler une hypothèse (ex: "ce filtre va réduire le coût bâtiments").
2. Instrumenter (counters + breakdown CPU + scripts de comparaison).
3. Benchmarker (avant/après, même scénario).
4. Valider fonctionnellement (parité résultat, hotspots terrain).
5. Décider: garder / ajuster / retirer.
6. Commit atomique + trace documentaire.

Cette discipline a évité de garder des "optimisations" qui semblaient logiques mais dégradaient la perf réelle ou la qualité.

## 3) Essais, échecs et décisions

## 3.1 Essais non retenus (ou corrigés)

1. **Masque d'horizon global unique Lausanne**
- Constats: précision insuffisante (parallaxe/relief local), erreurs sensibles.
- Décision: rejeté pour le runtime général; maintien d'une approche locale/adaptative.

2. **Garde azimut bâtiments (feature flag)**
- Hypothèse: réduire les checks bâtiments.
- Résultat mesuré: pas de gain net, voire régression selon scénarios.
- Décision: retiré (`refactor(sun): remove building azimuth guard path and feature flag`).

3. **Heuristique globale de réduction de hauteur toiture**
- Hypothèse: corriger rapidement certains faux positifs.
- Risque: biais systématique, non robuste entre zones.
- Décision: retirée, puis remplacée par amélioration de la géométrie footprint.

4. **Footprints bâtiments avec artefacts en "étoile"**
- Problème observé: angles aigus non réalistes, impacts indoor/outdoor incorrects.
- Décision: normalisation dédiée des footprints (`building-footprint.ts`) + fallback hull contrôlé.

## 3.2 Essais retenus (leviers validés)

1. **P1-1 Index spatial + corridor bâtiments**
- Gain majeur sur le nombre d'obstacles testés.
- Qualité conservée (parité stricte sur les comparatifs).

2. **P1-2 Contexte partagé par tuile**
- Évite la reconstruction répétitive des mêmes sources.
- Gain CPU massif sur préparation.

3. **P1-4 Partage adaptatif masque horizon**
- Réduction du coût avec budget d'erreur explicite + fallback local.

4. **Pool de workers process**
- Gain net jusqu'à ~4 workers.
- Plateau/régression au-delà selon charge -> valeur opérationnelle recommandée: 4.

## 4) Cadre de décision (ce qui a servi à trancher)

Une optimisation est acceptée seulement si:

1. Elle améliore le temps/throughput sur benchmark comparable.
2. Elle ne dégrade pas la qualité au-delà du budget autorisé.
3. Elle reste opérable côté produit (messages d'erreur, UX, cache, maintenabilité).
4. Son coût de complexité est justifié.

Sinon: rollback ou refonte.

## 5) Scripts de validation (preuve reproductible)

## 5.1 Validation générale

```bash
pnpm test
pnpm run lint
pnpm run typecheck
```

## 5.2 Benchmarks perf/cpu

```bash
pnpm run benchmark:precompute:cpu:lots
pnpm run benchmark:precompute:cpu:breakdown
pnpm run benchmark:precompute:workers
pnpm run benchmark:horizon:tile-vs-global:lausanne
pnpm run benchmark:horizon:macro:lausanne
pnpm run benchmark:cache:warm
```

## 5.3 Scripts d'analyse fonctionnelle hotspots/modèles

```bash
pnpm exec tsx scripts/analysis/compare-mccarthys-terrace-models.ts
pnpm exec tsx scripts/analysis/compare-great-escape-v2-v3-grid1m.ts
pnpm exec tsx scripts/analysis/compare-great-escape-v3-vs-detailed-grid1m.ts
pnpm exec tsx scripts/analysis/great-escape-7days-evening-scan.ts
pnpm exec tsx scripts/analysis/great-escape-7days-pointdiff-1745.ts
pnpm exec tsx scripts/analysis/pepinet-7days-evening-scan.ts
pnpm exec tsx scripts/analysis/pepinet-7days-instant-low-sun-diff.ts
pnpm exec tsx scripts/analysis/pepinet-maccarthys-7days-daily-diff.ts
```

## 5.4 Précompute/cache opérationnel

```bash
pnpm run precompute:region -- --help
pnpm run precompute:lausanne:terraces:next-weekends
pnpm run cache:verify
pnpm run cache:purge -- --help
```

## 6) Protocole fonctionnel terrain (pratique)

1. Sélectionner un hotspot réel (terrasse/place) + créneau soleil bas (lever/coucher).
2. Lancer instant (et/ou timeline) avec grille fine.
3. Vérifier diagnostic cause d'ombre (terrain/bâtiment/végétation/horizon).
4. Comparer avec observation terrain ou orthophoto/satellite.
5. En cas d'écart:
- instrumenter,
- reproduire via script benchmark/analysis,
- corriger,
- re-mesurer.

## 7) Ce qu'on a appris (résumé)

1. Les gains les plus solides viennent de "ne pas calculer inutilement".
2. Une bonne optimisation sans validation qualité est dangereuse.
3. Le couplage perf + UX (stream/progress/cancel/reprise/cache) est essentiel.
4. Le chantier est pilotable seulement avec métriques et scripts reproductibles.

## 8) Documents liés

- `docs/architecture/web-performance-throughput-and-cost-playbook.md`
- `docs/architecture/optimisation-checklist-execution.md`
- `docs/architecture/optimisations-et-cache-synthese.md`
- `docs/architecture/precompute-cpu-lots-report-2026-03-15.md`
- `docs/architecture/precompute-workers-benchmark-2026-03-15.md`
