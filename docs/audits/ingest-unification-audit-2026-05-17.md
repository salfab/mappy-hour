# Ingest pipeline unification — audit & plan (2026-05-17)

## Contexte

Motivation côté Fabio (entrée mémoire `project_ingest_unification`, 2026-04-24) :
quand on étend la couverture (nouvelle région ou nouvelles tuiles), il y a un
risque réel d'oublier de télécharger un type de source — typiquement le VHM,
qui a déjà laissé des trous silencieux dans le masque végétation. L'objectif est
un **orchestrateur unique** qui, donné une **région** (et plus tard un set de
tuiles LV95), enchaîne toutes les sources nécessaires de manière **idempotente**.

Cet audit couvre exclusivement `scripts/ingest/` (+ `package.json` et le seul
helper runtime concerné, `src/lib/ingest/horizon-dem.ts`). Aucun changement de
code runtime n'est proposé : tout le scope reste côté scripts.

---

## Phase 1 — Audit de l'existant

### 1.1 `scripts/ingest/cli.ts` — ce que c'est vraiment

**Ce n'est pas un orchestrateur.** Le fichier (48 lignes) exporte uniquement
`parseIngestCliArgs(argv)` qui lit trois flags globaux partagés par tous les
downloaders :

- `--dry-run`
- `--overwrite`
- `--max-items=N` (cap STAC items, utile pour smoke-tests)

Il ne connaît ni les régions, ni les sources, ni l'enchaînement. Aujourd'hui
l'orchestration vit dans `package.json` (chaînes `pnpm run X && pnpm run Y`,
cf. `ingest:lausanne`, `ingest:nyon`, `ingest:all`, `setup:*`).

### 1.2 Téléchargeurs globaux (interface `--region=<name>`)

Tous lisent `<REGION>_CONFIG.localBbox` (et `horizonBbox` pour Copernicus) et
écrivent un manifest par région sous `data/raw/.../manifest-<region>.json`.

| Script | Source / collection | Régions supportées | Idempotence | Manifest |
|---|---|---|---|---|
| `download-buildings.ts` | swisstopo STAC `swissbuildings3d_2` (DXF .zip) | lausanne, nyon, morges, geneve, vevey, vevey_city, neuchatel, la_chaux_de_fonds, bern, zurich, thun | `--overwrite` requis pour re-download ; sinon skip si fichier présent (`http.ts:downloadFile`) | `manifest-<region>.json` |
| `download-terrain.ts` | swisstopo STAC `swissalti3d` (TIFF) | idem | idem | `manifest-<region>.json` |
| `download-vegetation.ts` | swisstopo STAC `swisssurface3d-raster` (TIFF MNS) | idem | idem | `manifest-<region>.json` |
| `download-vegetation-vhm.ts` | EnviDat VHM via Python (`download-vhm.py` + `compose-vhm-canopy.py`) | idem + `--region=all` | `--overwrite` propagé au Python | (manifest produit par les scripts Python) |
| `download-horizon-dem.ts` | Copernicus DEM 30 m (S3) — wrapper autour de `src/lib/ingest/horizon-dem.ts::ensureHorizonDemManifestForRegion` | idem + `--region=all` (via `getKnownHorizonRegions()`) | `--overwrite` ; sinon skip si tile présente ; **auto-fixé aussi par la preflight precompute** | `manifest-<region>-horizon.json` |
| `download-places-osm.ts` | Overpass | `--regions=a,b,c` (note : pluriel et CSV, hors convention) | re-télécharge à chaque run (pas d'idempotence : POST Overpass est l'oracle de vérité) | `<region>-places-overpass.json` + `<region>-places.json` + `places.json` combiné |

**Dépendances entre sources** :

1. `download-vegetation-vhm.ts` (`compose-vhm-canopy.py`) **lit** le terrain
   swissALTI3D pour composer `canopy_abs = terrain + max(0, vhm)`.
   → **Le terrain doit être téléchargé avant le VHM** (en pratique avant l'étape
   `compose`). C'est la seule dépendance dure dans le pipeline.
2. `places-osm` est indépendant (Overpass).
3. `horizon-dem` est indépendant.
4. `buildings`, `terrain`, `vegetation` (surface MNS) sont indépendants entre eux.

**Gestion d'erreurs** : tous se contentent d'un `process.exitCode = 1` au catch
top-level. Pas de retry au niveau script (le retry vit dans le client STAC /
`downloadFile`). `download-vegetation-vhm.ts` bail-out dès le premier échec et
ne tente pas la région suivante.

### 1.3 Téléchargeurs legacy par ville (`download-lausanne-*.ts`, `download-nyon-*.ts`)

Huit fichiers, **fonctionnellement identiques aux globaux** mais avec la région
hardcodée :

| Legacy | Équivalent global | Verdict |
|---|---|---|
| `download-lausanne-buildings.ts` | `download-buildings.ts --region=lausanne` | duplicate exact (à 1 import + manifest name près) |
| `download-lausanne-terrain-ch.ts` | `download-terrain.ts --region=lausanne` | duplicate |
| `download-lausanne-vegetation-surface.ts` | `download-vegetation.ts --region=lausanne` | duplicate |
| `download-lausanne-horizon-dem.ts` | `download-horizon-dem.ts --region=lausanne` | duplicate sémantique, mais **n'utilise PAS** `ensureHorizonDemManifestForRegion` (chemin code différent — copie-collé d'avant la factorisation). À remplacer pour éviter qu'un fix au cœur (lib) bypass cette voie. |
| `download-nyon-buildings.ts` | `download-buildings.ts --region=nyon` | duplicate |
| `download-nyon-terrain-ch.ts` | `download-terrain.ts --region=nyon` | duplicate |
| `download-nyon-vegetation-surface.ts` | `download-vegetation.ts --region=nyon` | duplicate |
| `download-nyon-horizon-dem.ts` | `download-horizon-dem.ts --region=nyon` | duplicate sémantique (même remarque que lausanne) |

**Call sites** (`grep -r "download-lausanne\|download-nyon"`) :

- `package.json` (10 entrées : voir `ingest:lausanne:*`, `ingest:nyon:*`, et les
  méta-cibles `ingest:lausanne`, `ingest:nyon`, `setup:lausanne`, `setup:nyon`,
  `fetch:lausanne:3d`, `fetch:nyon:3d`).
- `docs/architecture/building-model-vs-osm.md` (une référence textuelle dans un
  tableau récap — pas un appel, juste de la doc à mettre à jour).
- **Aucun appel depuis du code TypeScript / runtime.** Ces scripts sont des
  binaires CLI uniquement.

**Recommandation** : tous supprimables une fois les `package.json` scripts
migrés vers les globaux. Aucune fonctionnalité unique n'est perdue.

### 1.4 Trous identifiés (sources / régions)

- **VHM** n'est ingéré que par `ingest:<region>:vegetation:vhm` et n'apparaît
  pas dans les méta-cibles legacy `ingest:lausanne` / `ingest:nyon`… **sauf**
  vérification : il y est en fait (`ingest:lausanne:vegetation:vhm` est dans la
  chaîne `ingest:lausanne` ligne 62, idem nyon ligne 63). Donc le VHM est bien
  couvert pour les 2 villes ayant une méta-cible. **Mais aucune méta-cible
  n'existe pour morges, geneve, vevey, vevey_city, neuchatel,
  la_chaux_de_fonds, bern, zurich, thun.** Pour ces 9 régions, il n'y a que
  `ingest:morges:vegetation:vhm` / `ingest:geneve:vegetation:vhm` et
  `ingest:all:vegetation:vhm` — pas de chaîne complète buildings + terrain +
  vegetation surface + VHM + horizon + places. C'est précisément le risque
  d'oubli évoqué dans la mémoire.

- **`download-places-osm.ts`** utilise `--regions=a,b,c` (pluriel + CSV) au
  lieu de `--region=X` comme les autres. Incohérence à corriger ou à wrapper.

- **Pas de manifest global / état partagé.** Chaque source pose son propre
  `manifest-<region>-<asset>.json` à côté de ses fichiers. Aucun fichier dit
  "pour la région X, ces N sources ont été ingérées avec succès à telle date".
  Conséquence : pour vérifier qu'une nouvelle région est complète, il faut
  inspecter manuellement plusieurs répertoires.

- **`download-vegetation-vhm.ts` ne vérifie pas que le terrain est présent
  avant de lancer `compose-vhm-canopy.py`**. Si on appelle vhm avant terrain,
  le compose plante en cours de route. Pas critique (l'erreur Python remonte),
  mais améliorable.

### 1.5 Scripts hors scope du chantier

- `_*.ts` (préfixés underscore) sont des diag / one-shot d'investigation, hors
  pipeline régulier — à ignorer ici.
- `purge-corrupt-cache.ts`, `http.ts`, `stac-client.ts` : helpers internes, à
  garder tels quels.
- `compose-vhm-canopy.py`, `download-vhm.py` : Python tools, gardés tels quels.

---

## Phase 2 — Plan d'unification

### 2.1 Objectif

**Une commande, une région, toutes les sources, idempotente, état lisible.**

```
pnpm ingest:region <region> [--skip-existing] [--sources=...] [--dry-run]
```

### 2.2 Interface cible

```
npx tsx scripts/ingest/cli.ts ingest:region <region>
    [--sources=buildings,terrain,vegetation,vhm,horizon-dem,places]
    [--skip-existing]            # idempotence forte (default: true)
    [--overwrite]                # antagonist de --skip-existing
    [--dry-run]
    [--max-items=N]              # smoke-test
    [--continue-on-error]        # ne s'arrête pas à la 1re source qui plante
```

- **Région positionnelle** plutôt que `--region=` pour signaler que c'est
  l'argument principal (mais on garde aussi `--region=` reconnu pour rétro-compat).
- `--sources` permet de re-rouler une seule source sans relancer les autres
  (ex: `--sources=vhm` après un fix d'un script Python).
- Mode `--bbox=...` / `--tiles=...` : **non inclus en phase 1**. Aujourd'hui
  toutes les sources prennent un bbox (et VHM/horizon prennent en plus un
  `horizonBbox`). Ajouter un mode "bbox arbitraire" demande de réinjecter ce
  bbox dans `<REGION>_CONFIG`-shaped objects, ce qui touche le runtime. À
  re-discuter une fois la unification de base livrée.

### 2.3 Architecture — étendre ou créer ?

`cli.ts` est aujourd'hui une lib de parsing (importée par 13 scripts). En faire
un binaire entrypoint risque de casser les imports si on `process.argv` au
top-level du module. Deux options :

- **Option A (recommandée)** : garder `cli.ts` comme lib de parsing. Créer un
  nouveau `scripts/ingest/run.ts` qui est le binaire orchestrateur. Le binaire
  importe et délègue aux `main()` actuels des `download-*.ts` (à exporter en
  `runForRegion(region, args)` plutôt que `main()` qui lit `process.argv`).
  Coût : refactorer chaque `download-*.ts` pour exporter une fonction async
  pure et n'exécuter `main()` que si appelé directement (`if
  (require.main === module)`).

- **Option B** : créer `scripts/ingest/run.ts` qui lance les `download-*.ts`
  via `spawnSync` (comme `download-vegetation-vhm.ts` le fait déjà pour les
  scripts Python). Plus simple à écrire, isole les crashes, mais ajoute un
  process-fork par source → ~+1s × 6 sources de cold-start tsx, et le
  reporting d'erreurs devient texte-only.

**Recommandation : Option A**. Le coût d'export-de-fonction est faible (~6
fichiers × 5 lignes) et donne du in-process error handling, du progress
reporting unifié, et de la composabilité (tests possibles plus tard).

### 2.4 Manifest agrégé "région complète"

À la fin d'un run, écrire `data/raw/manifest-region-<region>.json` :

```json
{
  "region": "morges",
  "generatedAt": "2026-05-17T14:32:11Z",
  "sources": {
    "buildings": { "status": "ok", "manifestPath": "...", "filesDownloaded": 12, "filesSkipped": 0 },
    "terrain": { "status": "ok", ... },
    "vegetation": { "status": "ok", ... },
    "vhm": { "status": "ok", ... },
    "horizon-dem": { "status": "ok", "manifestPath": "...", "tilesNotFound": 1 },
    "places": { "status": "ok", "totalPlaces": 412 }
  }
}
```

C'est ce fichier qui sert de **safety net** :

- Si une source manque (status absent / `failed`), on le voit en un coup d'œil.
- La precompute preflight peut le lire avant de lancer une région pour vérifier
  qu'aucune source n'est silencieusement skippée (extension future, hors scope
  immédiat).

### 2.5 Migration en phases

**Phase A — Consolider derrière les globaux (sans rien casser)**
1. Refactorer les 6 `download-*.ts` globaux pour exporter `runForRegion(region,
   args)` en plus de leur `main()`.
2. Aligner `download-places-osm.ts` sur `--region=` (single) tout en gardant
   `--regions=` (CSV) pour rétro-compat.
3. Ajouter `scripts/ingest/run.ts` (binaire orchestrateur, Option A).
4. Ajouter dans `package.json` :
   ```
   "ingest:region": "tsx scripts/ingest/run.ts"
   ```
   sans rien retirer.

**Phase B — Migrer les scripts `package.json` legacy**
5. Remplacer `ingest:lausanne:buildings` etc. par
   `tsx scripts/ingest/download-buildings.ts --region=lausanne` (les globaux
   existent déjà). Plus simple : les méta-cibles `ingest:lausanne` et
   `ingest:nyon` peuvent devenir `pnpm run ingest:region lausanne` une fois
   `run.ts` livré.
6. Vérifier qu'aucun outil externe (CI, doc, déploiement mitch) n'appelle les
   noms legacy. Cf. `docs/deploy.md` (entrée mémoire `project_mitch_deployment`).

**Phase C — Supprimer les legacy**
7. `rm scripts/ingest/download-lausanne-*.ts scripts/ingest/download-nyon-*.ts`.
8. Mettre à jour `docs/architecture/building-model-vs-osm.md` (1 référence).
9. Mettre à jour `docs/architecture/shortcuts-registry.md` (pas d'entrée
   raccourci à ajouter ici : c'est du cleanup, pas un raccourci).

**Phase D — Couverture VHM des régions sans méta-cible** (peut être faite avant C)
10. Ajouter pour morges, geneve, vevey, vevey_city, neuchatel,
    la_chaux_de_fonds, bern, zurich, thun les scripts `ingest:<region>`
    équivalents — ou les remplacer dès le départ par `ingest:region <region>`.

**Phase E — Safety net** (extension)
11. Faire émettre par `run.ts` le `manifest-region-<region>.json` agrégé.
12. (Plus tard) Avoir un check dans la preflight precompute qui lit ce
    manifest et warn si une source manque pour la région ciblée.

### 2.6 Idempotence et garde-fous

- Conserver le contrat `--overwrite` actuel (skip si fichier présent par défaut)
  côté chaque `download-*.ts`. Pas de re-définition d'idempotence à un niveau
  supérieur.
- `--continue-on-error` permet de finir l'ingest même si une source flanche
  (ex: Overpass timeout) — on aura au moins les autres téléchargées, et le
  manifest agrégé liste explicitement les sources `status: "failed"`.
- Pas de cache TTL (rebench une région = la rechoper full from upstream). Si
  besoin un jour, c'est `--max-age=Nd` à ajouter, mais ça ne se voit pas dans
  les besoins actuels.

### 2.7 Risques / points à valider avec l'utilisateur

1. **Choix Option A vs Option B** (in-process vs spawn). Recommandation A.
2. **Faut-il un mode `--bbox=...` / `--tiles=...` dès la phase 1 ?** L'audit
   recommande non (touche au runtime, le besoin n'est pas encore là). À
   confirmer.
3. **Ordre d'exécution** : VHM dépend du terrain. Faut-il l'imposer en dur ou
   le documenter ? Recommandation : imposer en dur dans `run.ts` (la liste
   `SOURCES_IN_ORDER = ["terrain", "buildings", "vegetation", "vhm",
   "horizon-dem", "places"]`).
4. **Suppression des legacy en C** : possible breaking change pour qui aurait
   un script externe (genre un cron Mitch) qui appelle un nom direct. À
   confirmer.

---

## Phase 3 — Implémentation : **non exécutée**

Justification :
- L'audit a révélé que `cli.ts` n'est pas un orchestrateur (juste un parser),
  donc "étendre cli.ts" demande en fait soit du refactor (transformer en
  binaire) soit un nouveau fichier `run.ts` — c'est une décision d'archi à
  faire valider avant de coder.
- Le refactor des 6 globaux pour exposer `runForRegion()` (Option A) demande
  de toucher 6 fichiers et touche aussi le pattern `if (require.main ===
  module)` qui n'est pas utilisé ailleurs dans `scripts/`. C'est mécaniquement
  faisable en < 2h, mais ce n'est pas un *POC* — c'est la phase A complète, et
  la consigne projet ("don't add features beyond what the task requires")
  pointe vers : audit + plan d'abord, code après validation.
- L'utilisateur a explicitement écrit "**NE PAS IMPLÉMENTER** sauf si phases
  1+2 sont propres ET < 2h pour un POC". L'effort minimal qui apporte vraiment
  quelque chose dépasse le POC isolé (il faut au minimum 1 fichier orchestreur
  + 1 fichier globalement refactoré pour montrer le pattern, sinon le POC est
  trompeur).

**Décision** : livrer l'audit + plan, laisser l'utilisateur trancher
Option A vs B, mode `--bbox`/`--tiles`, et timing.

---

## Annexe — Inventaire complet `scripts/ingest/`

| Fichier | Statut | Action |
|---|---|---|
| `cli.ts` | Lib parser, gardé | Phase A : étendre ou laisser tel quel selon décision archi |
| `http.ts` | Helper, gardé | — |
| `stac-client.ts` | Helper, gardé | — |
| `download-buildings.ts` | Global actif | Phase A : exporter `runForRegion` |
| `download-terrain.ts` | Global actif | idem |
| `download-vegetation.ts` | Global actif | idem |
| `download-vegetation-vhm.ts` | Global actif | idem, et ajouter check terrain présent |
| `download-horizon-dem.ts` | Global actif | idem |
| `download-places-osm.ts` | Global actif | idem, harmoniser `--region=` (single) |
| `download-vhm.py` | Python tool, gardé | — |
| `compose-vhm-canopy.py` | Python tool, gardé | — |
| `download-lausanne-buildings.ts` | Legacy | Phase C : supprimer |
| `download-lausanne-terrain-ch.ts` | Legacy | Phase C : supprimer |
| `download-lausanne-vegetation-surface.ts` | Legacy | Phase C : supprimer |
| `download-lausanne-horizon-dem.ts` | Legacy (copie hors lib) | Phase C : supprimer (urgent : ne bénéficie pas des fixes lib) |
| `download-nyon-buildings.ts` | Legacy | Phase C : supprimer |
| `download-nyon-terrain-ch.ts` | Legacy | Phase C : supprimer |
| `download-nyon-vegetation-surface.ts` | Legacy | Phase C : supprimer |
| `download-nyon-horizon-dem.ts` | Legacy (copie hors lib) | Phase C : supprimer |
| `purge-corrupt-cache.ts` | Utilitaire, gardé | — |
| `_*.ts` (~25 fichiers) | Diag / one-shot | Hors scope |
