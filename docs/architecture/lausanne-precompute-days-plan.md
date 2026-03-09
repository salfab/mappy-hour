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

- Dans ce run, le tuilage est massivement plus performant.
- Pour un precompute en production, il faut traiter Lausanne par tuiles et non par une seule grosse requete.
- Les resultats confirment qu'une "grosse bbox unique" n'est pas un chemin fiable a grande echelle.

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

- Sur Nyon, utiliser un masque centre Lausanne donne un ecart de `2.263 deg` sur l'angle d'horizon.
- Cet ordre de grandeur peut changer la frontiere soleil/ombre autour des heures basses (matin/soir).
- Pour un precompute fiable a l'echelle Lausanne et au-dela: **masque local par tuile obligatoire**.
