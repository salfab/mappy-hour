# Synthese des optimisations et de la gestion du cache

Date: 2026-03-18

## 1) Pourquoi cette synthese

Le projet a evolue vite: moteur d'ombre, indexation batiments, masques d'horizon, cache multi-couches, precompute, jobs admin, multithread, deeplinks.

Ce document sert de reference courte pour comprendre:
- ce que nous avons concretement implemente,
- pourquoi ces choix ont ete faits,
- ce que cela apporte,
- les limites actuelles.

## 2) Ce qui a ete implemente

## 2.1 Pipeline de calcul solaire (point -> decision soleil/ombre)

- Grille de points metrique (LV95), avec exclusion indoor/outdoor avant les limites de points.
- Evaluation des bloqueurs en couches:
  - horizon/montagnes (masque d'horizon),
  - terrain local (DEM),
  - batiments,
  - vegetation.
- Diagnostics conserves par point (source de blocage, distances, methodes).
- Variante native "ignorer la vegetation" sans recalcul lourd (masques dedies deja stockes).

## 2.2 Optimisations CPU majeures

- P1-1: index spatial batiments + corridor oriente point->soleil (au lieu de scanner trop large).
- P1-2: mutualisation du contexte par tuile (evite de reconstruire les memes donnees pour chaque point).
- P1-4: partage adaptatif des masques d'horizon avec budget d'erreur et fallback local.
- Culling altitude/couloir pour reduire les candidats inutiles avant tests geometriques exacts.
- Courts-circuits sur cas triviaux (soleil sous horizon astronomique, etc.).

## 2.3 Moteur batiments

- Approche pragmatique pour garder un bon compromis precision/performance:
  - moteur principal rapide (prismes/index),
  - verification detaillee possible selon le mode.
- Plusieurs iterations ont ete faites pour reduire les faux positifs proches des seuils d'ombre.
- Le modele d'algo est versionne pour invalider proprement le cache lors des changements.

## 2.4 Cache multi-couches (runtime + persistant)

- L0: deduplication in-flight (deux requetes identiques ne recalculent pas en double).
- L1: cache memoire TTL (reponses chaudes, manifests, tuiles frequentes).
- L2: cache disque (artefacts tuiles/jour/frame).
- Cle cache canonique basee sur:
  - region,
  - date,
  - grille,
  - pas temporel,
  - fenetre horaire,
  - calibration,
  - modelVersionHash.
- `modelVersionHash` inclut versions donnees + version algo, pour eviter le stale cache.

## 2.5 Artefacts de precompute

- Un run precompute produit:
  - un manifeste,
  - des artefacts de tuiles compresses (`.json.gz`),
  - des masques binaires pour lecture rapide.
- Les frames stockent notamment:
  - ensoleille/ombre,
  - variante no-vegetation,
  - blocage vegetation,
  - diagnostics utiles.
- Le format a ete enrichi pour garder la parite fonctionnelle entre cache hit et calcul live.

## 2.6 Precompute jobs (admin)

- Gestion de jobs avec etat: `queued`, `running`, `completed`, `cancelled`, `failed`.
- Actions: annuler, reprendre, rejeter/purger.
- Resume robuste apres interruption en reutilisant ce qui est deja ecrit.
- SSE pour suivi live + fallback polling raisonne.
- Progression visible:
  - globale,
  - tuile en cours,
  - ETA,
  - compteurs (tuiles, points, frames).

## 2.7 Multithread / parallelisme

- Pool de workers process (pas `worker_threads` dans cette phase, pour stabilite geotiff).
- Benchmark effectue sur plusieurs niveaux de concurrence.
- Recommandation operationnelle actuelle: 4 workers (meilleur compromis).

## 2.8 UX et navigation cache

- Admin cache: vue des runs, metriques, etat, actions.
- Deeplinks de la carte avec parametres (mode/date/heures/grille/bbox/layers).
- Flux "ouvrir un run sur la carte" pour cadrer la zone et relancer rapidement avec les bons parametres.

## 3) Gains mesures (ordre de grandeur)

Sources:
- `docs/architecture/precompute-cpu-lots-report-2026-03-15.md`
- `docs/architecture/precompute-workers-benchmark-2026-03-15.md`

Resultats marquants:
- Lot A (index corridor batiments): environ **x4.25** sur le bloc evalue.
- Lot B (contexte partage par tuile): environ **x45.8** sur la preparation contextuelle.
- Workers (charge lourde, grille 1m): environ **x2.08** a 4 workers vs 1 worker.

Lecture importante:
- Le plus gros gain vient de "ne pas calculer inutilement".
- Le parallele ajoute ensuite un gain net, mais avec plateau apres ~4 workers selon la charge.

## 4) Ce qui reste suboptimal / points de vigilance

- Precision locale encore sensible sur certains hotspots quand le soleil est tres bas.
- Coût CPU restant majoritairement sur le ray tracing batiments (normal: coeur metier).
- Volume disque qui peut grossir vite avec `grid=1m` + fenetres daily larges.
- Necessite d'une hygiene cache stricte (versioning, purge, observabilite).

## 5) Recommandations d'usage actuel

- Utiliser le precompute par zones cibles (hotspots) en priorite.
- Garder 4 workers par defaut, ajuster selon machine/I/O.
- S'appuyer sur le cache daily pour l'interface au lieu de recalculer a chaque requete.
- Conserver les benchmarks de non-regression precision + perf a chaque optimisation CPU.

## 6) Démystification (jargon explique simplement)

- **DEM (Digital Elevation Model)**:
  une "carte d'altitude" du sol. Chaque pixel/cellule dit "ici le terrain est a X metres".

- **Masque d'horizon**:
  pour chaque direction (azimut), on pre-calcule l'angle minimum a depasser pour voir le soleil. Si le soleil est plus bas, il est cache par relief/montagnes.

- **Ray tracing (ici)**:
  on simule un rayon entre le point observe et la direction du soleil pour verifier si un obstacle coupe la ligne de vue.

- **Rasterisation**:
  transformer une geometrie continue (polygone/3D) en grille de cellules/pixels exploitables rapidement.

- **Tuile (tile)**:
  petit carre de carte (ex: 250 m x 250 m) traite independamment pour mieux paralleliser et mettre en cache.

- **BBOX (bounding box)**:
  rectangle minimal qui encadre une zone. Sert a definir ce qu'on calcule/affiche.

- **LV95**:
  systeme de coordonnees metrique suisse. Pratique pour une grille 1m stable (evite les flottants lat/lon).

- **Bitset / masque binaire**:
  tableau de bits tres compact (0/1) pour stocker vite "ensoleille" ou "ombre" pour beaucoup de points.

- **In-flight dedupe (L0)**:
  si 2 requetes identiques arrivent en meme temps, on fait 1 seul calcul et l'autre attend le resultat.

- **TTL cache (L1)**:
  cache memoire avec duree de vie courte (Time To Live), utile pour les appels repetes.

- **Cache persistant (L2)**:
  cache sur disque, survive aux redemarrages. C'est la base du precompute.

- **SSE (Server-Sent Events)**:
  flux serveur -> client pour pousser l'avancement en direct (progression, etat job, ETA).

- **Culling**:
  eliminer tres tot des candidats impossibles (batiments/cellules) pour economiser du CPU.

- **modelVersionHash**:
  empreinte de version des donnees + algo + calibration. Si ca change, on invalide automatiquement l'ancien cache.

## 7) Documents de reference

- `docs/architecture/adr-0003-caching-implementation-plan.md`
- `docs/architecture/adr-0004-precompute-multithread-worker-pool.md`
- `docs/architecture/adr-0005-batiments-v3-ombre-a-deux-niveaux.md`
- `docs/architecture/precompute-cpu-lots-report-2026-03-15.md`
- `docs/architecture/precompute-workers-benchmark-2026-03-15.md`
- `docs/architecture/web-performance-throughput-and-cost-playbook.md`
