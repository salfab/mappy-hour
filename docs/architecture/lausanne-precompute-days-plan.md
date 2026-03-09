# Plan de precompute fiable (Lausanne, periode en jours)

Date: 9 mars 2026  
Perimetre: precompute des points ensoleilles/ombrages sur Lausanne, avec verification de l'impact parallax des masques horizon.

## 1) Objectif

Construire une pipeline qui pre-calcule des resultats exploitables par le frontend pour une periode donnee (N jours), avec:

- fiabilite geometrique (masque horizon local a la zone calculee),
- stabilite operationnelle (jobs resumables),
- cout/temps previsible (throughput mesure),
- verification explicite de l'impact "grandes zones" vs "petites zones".

## 2) Benchmark execute (mesures reelles)

Script:

```bash
pnpm --dir mappy-hour run benchmark:precompute:lausanne -- \
  --start-date=2026-03-08 \
  --days=1 \
  --local-time=17:00 \
  --grid-step-meters=250 \
  --tile-cols=4 \
  --tile-rows=4
```

Resultats bruts:

- Fichier JSON: `docs/progress/benchmarks/precompute-lausanne-2026-03-08-d1-g250.json`
- BBox Lausanne: `LAUSANNE_LOCAL_BBOX = [6.54, 46.49, 6.74, 46.62]`

### 2.1 Grande zone unique vs tuilage 4x4

- Grande zone unique (1 requete):
  - 3417 points outdoor
  - 1,198,811.723 ms mur (~19m59s)
  - 2.85 points/s
- Tuilage 4x4 (16 requetes):
  - 3630 points outdoor
  - 23,302.201 ms mur (~23.3s)
  - 155.779 points/s
- Ratio observe:
  - temps tuiles / temps grande zone: `0.019`
  - throughput tuiles / throughput grande zone: `54.653`

Interpretation pratique:

- Ici, "massivement plus performant" parle explicitement de performance de calcul
  (temps mur et throughput), pas de precision geometrique.
- La comparaison est bien faite a surface equivalente:
  - 1 grande requete sur toute la bbox Lausanne
  - 16 tuiles qui couvrent exactement la meme bbox Lausanne
  - et les chiffres ci-dessus sont deja agreges sur l'ensemble des 16 tuiles.
- Pour un precompute en production, il faut traiter Lausanne par tuiles et non par une seule grosse requete.
- Les resultats confirment qu'une "grosse bbox unique" n'est pas un chemin fiable a grande echelle.

Pourquoi ce resultat est contre-intuitif (overhead par tuile):

- Oui, il existe un overhead par requete/tuile (validation, serialisation, initialisation).
- Mais dans l'implementation actuelle, le cout dominant vient surtout:
  - du chargement a froid des donnees (DEM/vegetation/index),
  - et de boucles CPU lourdes par point.
- Sur un run "a chaud", la meme grande zone est deja beaucoup plus rapide:
  - run-1: `275,556.919 ms`
  - run-2: `14,424.242 ms`
- Donc:
  - le tuilage reste utile pour la robustesse et la parallelisation,
  - mais le ratio `54.653x` mesure dans le premier benchmark est aussi influence par l'effet cache (scenario froid vs chaud), pas uniquement par la geometrie de tuilage.

### 2.2 Impact parallax horizon (Lausanne vs Nyon)

Test demande:

- evaluer un point a Nyon avec masque horizon centre Lausanne,
- comparer a un masque local Nyon,
- comparer aussi a une petite zone 100 m autour de Nyon.

Mesures:

- Point Nyon `(46.3833, 6.239)` a `17:00`, le `8 mars 2026`
- Horizon angle avec masque centre Lausanne: `0.917 deg`
- Horizon angle avec masque centre Nyon: `3.18 deg`
- Ecart: `+2.263 deg` (non negligeable)
- Zone 100 m autour de Nyon: le point central retrouve `3.18 deg` avec masque local
- Distance entre centres Lausanne/Nyon: `33,770.602 m`
- Difference de "ridge distance" sur le meme azimut: `32,000 m` (53 km vs 21 km)

### 2.3 Impact chiffrable en metres et en points (plus interpretable)

Script:

```bash
pnpm --dir mappy-hour run benchmark:parallax:nyon -- \
  --date=2026-03-08 \
  --local-time=17:00 \
  --sample-step-minutes=1
```

Resultats bruts:

- Fichier JSON: `docs/progress/benchmarks/nyon-parallax-impact-20260308-1700.json`
- Ecart equivalent de longueur d'ombre (reference 17:00):
  - obstacle 5 m: `222.387 m`
  - obstacle 10 m: `444.774 m`
  - obstacle 20 m: `889.548 m`
- Derive temporelle du blocage terrain (point Nyon):
  - debut ombre du soir: `18:06` (masque Nyon) vs `18:19` (masque Lausanne) -> `13 min` d'ecart
  - fin ombre du matin: `07:19` (masque Nyon) vs `07:24` (masque Lausanne) -> `5 min` d'ecart
- Impact sur les points calcules (grille 100 m x 100 m, pas 10 m, 121 points):
  - desaccord max: `121 / 121 points` en meme temps (`12,100 m2`)
  - total journalier: `2,178 point-minutes` (`36.3 point-heures`) en desaccord

Conclusion:

- L'impact parallax n'est pas negligeable sur de grandes distances.
- Un masque "centre Lausanne" applique a Nyon degrade la fidelite (meme si le statut blocked/unblocked est identique a cet instant precis).
- Pour de la fiabilite, il faut un masque horizon local par tuile (ou au minimum par macro-tuile), pas un masque unique sur toute la region.

## 3) Strategie cible de precompute (fiable)

## 3.1 Unites de calcul

- Un job = `(tile_id, date, mode, params_version)`.
- Tile geographique fixe (ex: 500 m ou 1 km).
- Grille point intra-tile fixe (ex: 5 m, 10 m, 20 m selon mode qualite).

## 3.2 Versionnement strict

Versionner chaque lot de precompute avec:

- version donnees batiments,
- version donnees DEM local,
- version DEM horizon,
- version vegetation,
- version calibration (`observerHeightMeters`, `buildingHeightBiasMeters`),
- version algo.

Cle de cache recommande:

`region + tile_id + date + mode + grid_step + sample_step + model_version_hash`

## 3.3 Masque horizon et parallax

- Construire/utiliser un masque horizon centre sur la tuile (ou macro-tuile proche).
- Interdire les masques horizons reutilises a >X km du centre de reference.
- Seuil recommande de securite:
  - si distance point-centre masque > 5 km, recalcul local obligatoire.

## 3.4 Pipeline execution

1. Preparer la liste des jobs sur la periode (`N jours * nb_tuiles`).
2. Distribuer via workers (concurrence controlee).
3. Ecrire un statut de progression par job (`pending/running/done/failed`).
4. Stocker les resultats compacts (bitsets, stats, meta).
5. Exposer une API de lecture precompute (sans recalcul runtime par defaut).

## 3.5 Format de sortie recommande

Par `(tile, jour)`:

- `points` (lat/lon ou index grille),
- masque binaire soleil/ombre pour chaque frame temporelle (bitset),
- agrégats: minutes ensoleillees, premiere/derniere exposition,
- metadata modele + warnings + temps calcul.

## 4) Plan de mise en oeuvre

Phase A (court terme):

1. Generaliser le benchmark pour plusieurs jours (`days=1,7,30`) et plusieurs pas de grille.
2. Ajouter benchmark cold/warm separes (process isole) pour enlever le biais cache.
3. Fixer les tailles de tuiles "prod" a partir des chiffres de throughput.

Phase B (precompute backend):

1. Ajouter une commande CLI batch `precompute:region`.
2. Ajouter reprise sur incident (resume par job).
3. Ajouter persistance des artefacts precompute par lot.

Phase C (lecture frontend/API):

1. Endpoint lecture precompute par bbox/date.
2. Fallback calcul live seulement si precompute absent.
3. Affichage statut couverture (tuiles precomputees / manquantes).

Phase D (qualite et validation terrain):

1. Tests de regression sur points de reference Lausanne + Nyon.
2. Controle de coherence des ombres (batiment/terrain/montagne/vegetation).
3. Suivi des ecarts horizon angle sur points distants.

## 5) Reponse a la question "impact parallax negligeable ou pas ?"

Avec les mesures actuelles: **pas negligeable**.

- Sur Nyon, utiliser un masque centre Lausanne donne:
  - un ecart d'angle de `2.263 deg`,
  - un ecart de distance de ridge de `32 km`,
  - jusqu'a `12,100 m2` de points simultanement en desaccord sur un carre de 100 m.
- Cet ordre de grandeur change effectivement la frontiere soleil/ombre (matin/soir) et pas seulement un indicateur "interne".
- Pour un precompute fiable a l'echelle Lausanne et au-dela: **masque local par tuile obligatoire**.

## 6) Exigence ajoutee: precompute daily a granularite 1 metre

Tu as demande explicitement une granularite 1 m en mode daily.
Cette exigence est prise en compte ici.

Hypothese de surface Lausanne (`LAUSANNE_LOCAL_BBOX`):

- largeur ~ `15,310 m`
- hauteur ~ `14,472 m`
- surface ~ `221,560,436 m2` (ordre de grandeur)
- donc ~ `221.6 millions` de points a 1 m

Volume de donnees brut (bitset soleil/ombre, avant compression, sans metadata):

- daily 15 min (96 frames): ~ `2.48 GB / jour`
- daily 5 min (288 frames): ~ `7.43 GB / jour`
- daily 1 min (1440 frames): ~ `37.14 GB / jour`

Implication:

- Precompute 1 m daily sur toute Lausanne est faisable seulement avec
  orchestration lourde (jobs distribues + stockage optimise + compaction).
- En one-shot, c'est non fiable / non economique avec l'approche point-par-point actuelle.

Adaptation du plan (obligatoire pour 1 m):

1. Tuilage micro (ex: 100 m x 100 m ou 250 m x 250 m) avec precompute batch.
2. Concurrence worker controlee + reprise sur erreur par tuile.
3. Stockage compresse par tuile/jour:
   - bitsets delta entre frames,
   - compression (RLE/zstd),
   - retention selective.
4. Priorisation des zones:
   - niveau 1: zones frequentes (terrasses/parcs) en 1 m,
   - niveau 2: reste de la ville en 5-10 m,
   - affinement 1 m a la demande.
5. Masque horizon local par tuile (pas de masque global centre Lausanne).
