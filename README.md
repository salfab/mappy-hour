# Mappy Hour (Lausanne + Nyon)

Application Next.js pour calculer l'ensoleillement d'une zone urbaine avec un modèle à deux niveaux :

1. Relief (montagnes, collines, horizon lointain transfrontalier Suisse + France)
2. Bâtiments 3D (swissBUILDINGS3D pour Lausanne et Nyon)

## État actuel

- Ingestion automatisée des bâtiments Lausanne/Nyon via STAC swisstopo
- Ingestion automatisée du terrain suisse local (swissALTI3D, 2 m)
- Ingestion automatisée d'un DEM transfrontalier (Copernicus DEM 30 m) pour l'horizon lointain
- Ingestion automatisée des lieux OSM Lausanne/Nyon (parcs + terrasses candidates)
- Prétraitement du DEM transfrontalier -> masque d'horizon réel (`copernicus-dem30-raycast-v1`)
- Prétraitement des bâtiments DXF -> index d'obstacles (empreintes + meshes polyface, `dxf-footprint-prism-v1`)
- API `POST /api/sunlight/point` pour un calcul d'ensoleillement journalier à un point
- API `POST /api/sunlight/area` pour calculer une grille soleil/ombre sur bbox
- API `GET /api/places` + `POST /api/places/windows` pour les fenêtres d'ensoleillement des lieux
- Endpoint `GET /api/datasets` pour vérifier la présence des données

Le calcul bâtiments consomme directement les maillages 3D polyface des DXF swissBUILDINGS3D sur le chemin GPU (`gpu-raster`, `rust-wgpu-vulkan`). Les empreintes extrudées en prismes verticaux restent un fallback CPU (mode `two-level` / `prism`) et servent au culling spatial. Voir ADR-0010.

## Prérequis

- Node.js 20+
- pnpm 9+

## Lancer l'app

```bash
pnpm install
pnpm dev
```

Option Windows (recommandée quand il y a beaucoup de fichiers DEM/3D) :

```powershell
$env:MAPPY_DATA_ROOT='D:\mappy-hour-data'
pnpm dev
```

`pnpm dev` utilise Turbopack (Next 16 par défaut).
En cas de problème de filewatcher sous Windows, la solution recommandée est de
mettre les données lourdes hors du repo avec `MAPPY_DATA_ROOT`.

## Récupérer tous les jeux 3D/DEM (script unique)

Les gros fichiers 3D/DEM sont ignorés par git (`data/raw/...`) pour éviter de saturer le repo
et réduire la charge du filewatcher en développement.

Pour tout récupérer/reconstruire en une commande :

```bash
pnpm setup
```

Ou par ville :

```bash
pnpm setup:lausanne
pnpm setup:nyon
```

Ce script exécute :

- `ingest:all`
- `preprocess`

## Ingestion des données Nyon

### 1) Bâtiments 3D Nyon (swissBUILDINGS3D)

```bash
pnpm ingest:nyon:buildings
```

### 2) Terrain suisse local Nyon (swissALTI3D 2 m)

```bash
pnpm ingest:nyon:terrain:ch
```

### 3) Végétation de surface Nyon (swissSURFACE3D raster)

```bash
pnpm ingest:nyon:vegetation:surface
```

### 4) Terrain transfrontalier horizon Nyon (Copernicus DEM 30 m)

```bash
pnpm ingest:nyon:terrain:horizon
```

### 5) Lieux OSM Nyon (parcs + terrasses candidates)

```bash
pnpm ingest:nyon:places
```

## Ingestion des données Lausanne

### 1) Bâtiments 3D Lausanne (swissBUILDINGS3D)

```bash
pnpm ingest:lausanne:buildings
```

Test rapide :

```bash
pnpm ingest:lausanne:buildings -- --dry-run --max-items=20
```

### 2) Terrain suisse local (swissALTI3D 2 m)

```bash
pnpm ingest:lausanne:terrain:ch
```

Test rapide :

```bash
pnpm ingest:lausanne:terrain:ch -- --dry-run --max-items=20
```

### 3) Terrain transfrontalier horizon (Copernicus DEM 30 m)

```bash
pnpm ingest:lausanne:terrain:horizon
```

Test rapide :

```bash
pnpm ingest:lausanne:terrain:horizon -- --dry-run
```

### 4) Lieux OSM (parcs + terrasses candidates)

```bash
pnpm ingest:lausanne:places
```

### 5) Génération de l'index d'obstacles bâtiments

```bash
pnpm preprocess:buildings:index
```

### 6) Génération du masque d'horizon DEM

```bash
pnpm preprocess:horizon:mask
```

## API

### Vérifier les datasets

```bash
curl http://localhost:3000/api/datasets
```

### Calcul d'ensoleillement à un point

```bash
curl -X POST http://localhost:3000/api/sunlight/point \
  -H "Content-Type: application/json" \
  -d "{\"lat\":46.5197,\"lon\":6.6323,\"date\":\"2026-06-21\",\"timezone\":\"Europe/Zurich\",\"sampleEveryMinutes\":15}"
```

### Calcul d'ensoleillement sur zone (bbox)

```bash
curl -X POST http://localhost:3000/api/sunlight/area \
  -H "Content-Type: application/json" \
  -d "{\"bbox\":[6.61,46.51,6.65,46.53],\"date\":\"2026-06-21\",\"timezone\":\"Europe/Zurich\",\"mode\":\"instant\",\"localTime\":\"12:00\",\"gridStepMeters\":200}"
```

### Lister les lieux OSM

```bash
curl "http://localhost:3000/api/places?category=terrace_candidate&limit=20"
```

### Fenêtres d'ensoleillement pour lieux

```bash
curl -X POST http://localhost:3000/api/places/windows \
  -H "Content-Type: application/json" \
  -d "{\"date\":\"2026-06-21\",\"timezone\":\"Europe/Zurich\",\"category\":\"park\",\"limit\":10,\"sampleEveryMinutes\":15}"
```

## Précompute du cache d'ensoleillement (GPU raster)

Le précompute pré-calcule les données soleil/ombre tuile par tuile pour une période donnée
et les stocke dans `data/cache/sunlight/`. Le frontend les sert ensuite directement sans recalcul.

### Prérequis précompute

1. Données 3D et DEM ingérées et préprocessées (`pnpm setup:lausanne` ou `pnpm setup:nyon`).
2. Métadonnées de grille pré-calculées (classification indoor/outdoor + élévation par point, dépendant
   uniquement du modèle bâtiments — à refaire uniquement si les données 3D changent) :

```bash
pnpm precompute:grid-metadata
```

### Mode GPU raster (recommandé)

Utilise le rendu WebGPU (Dawn/D3D12) pour le calcul des ombres bâtiments. Nettement plus rapide
que le mode CPU. Le script est séquentiel et single-process pour éviter les segfaults Dawn en mode forké.

**Commande type — Lausanne, 3 semaines :**

```bash
MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster \
  pnpm exec tsx scripts/precompute/precompute-webgpu.ts \
  --region=lausanne \
  --start-date=2026-04-09 \
  --days=21 \
  --grid-step-meters=1 \
  --sample-every-minutes=15 \
  --start-local-time=06:00 \
  --end-local-time=21:00 \
  --bbox=6.618,46.505,6.645,46.526 \
  --skip-existing=true
```

Ou via le script npm pré-configuré (mêmes paramètres) :

```bash
pnpm precompute -- --start-date=2026-04-09 --days=21
```

Pour un appel raster générique sans bbox prédéfinie :

```bash
pnpm precompute:raster -- --region=lausanne --start-date=2026-04-09 --days=21
```

### Tuiles à haute valeur

Le catalogue complet des tuiles prioritaires est régénéré avec :

```bash
pnpm precompute:high-value:build
```

La version plus courte, orientée **top priority**, est dérivée du catalogue complet avec :

```bash
pnpm precompute:high-value:build:top-priority
```

Fichiers générés :

- `data/processed/precompute/high-value-tile-selection.json`
- `data/processed/precompute/high-value-tile-selection.top-priority.json`

Illustration OSM des tuiles top priority (carte dynamique Leaflet) :

[Ouvrir la carte interactive →](docs/assets/high-value-tiles-top-priority-map.html)

**Paramètres :**

| Paramètre | Défaut | Description |
| --- | --- | --- |
| `--region` | `lausanne` | Région cible (`lausanne`, `nyon`, `morges` ou `geneve`) |
| `--start-date` | `2026-04-06` | Date de début (YYYY-MM-DD) |
| `--days` | `1` | Nombre de jours à calculer |
| `--bbox` | _(aucun)_ | Sous-zone lon/lat `minLon,minLat,maxLon,maxLat` — résout les tuiles intersectantes |
| `--tile-selection-file` | _(aucun)_ | Fichier JSON listant des tuiles prioritaires par région ; si combiné avec `--bbox`, le script prend l'intersection |
| `--grid-step-meters` | `1` | Résolution de la grille en mètres |
| `--sample-every-minutes` | `15` | Pas d'échantillonnage temporel |
| `--start-local-time` | `06:00` | Début de la fenêtre horaire |
| `--end-local-time` | `21:00` | Fin de la fenêtre horaire |
| `--skip-existing` | `true` | Saute les tuiles/jours déjà cachés — permet la reprise |
| `--building-height-bias-meters` | `0` | Biais de hauteur bâtiments (calibration) |

**Notes importantes :**

- Le script est **resumable** : relancer la même commande avec `--skip-existing=true` reprend
  là où il s'est arrêté sans réécraser ce qui est déjà calculé.
- La variable d'environnement `MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster` est obligatoire pour
  activer le backend WebGPU. Sans elle, le calcul tombe en mode CPU (très lent).
- `--tile-selection-file=data/processed/precompute/high-value-tile-selection.json` permet de cibler
  un sous-ensemble de tuiles prioritaires par région.
- Pour un run plus court, utiliser de préférence
  `data/processed/precompute/high-value-tile-selection.top-priority.json`.
- Sous Windows, utiliser Git Bash ou WSL pour la syntaxe `VAR=value commande`. En PowerShell :

```powershell
$env:MAPPY_BUILDINGS_SHADOW_MODE='gpu-raster'
pnpm exec tsx scripts/precompute/precompute-webgpu.ts `
  --region=lausanne --start-date=2026-04-09 --days=21 `
  --grid-step-meters=1 --sample-every-minutes=15 `
  --start-local-time=06:00 --end-local-time=21:00 `
  --bbox=6.618,46.505,6.645,46.526 --skip-existing=true
```

Exemple avec fichier de tuiles prioritaires top priority :

```bash
pnpm precompute:raster -- \
  --region=lausanne \
  --start-date=2026-04-09 \
  --days=21 \
  --grid-step-meters=1 \
  --sample-every-minutes=15 \
  --start-local-time=06:00 \
  --end-local-time=21:00 \
  --skip-existing=true \
  --tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json
```

### Mode Vulkan natif (expérimental, performances maximales)

Le backend `rust-wgpu-vulkan` délègue le calcul d'ombres à un processus Rust natif via wgpu/Vulkan.
C'est le mode le plus rapide en production sur cette machine (Intel Arc).

**Commande type — toutes régions, 1 jour :**

```powershell
pnpm precompute:all-regions:vulkan -- `
  --tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json `
  --start-date=2027-05-01 `
  --days=1 `
  --skip-existing=false
```

**Variables d'environnement spécifiques au backend Vulkan :**

| Variable | Défaut | Description |
|---|---|---|
| `MAPPY_RUST_VULKAN_SESSIONS` | `1` | Nombre de sessions GPU concurrentes (voir note ci-dessous) |
| `MAPPY_TILE_PIPELINE_DEPTH` | `5` | Tuiles en vol simultané dans le pipeline Node |
| `MAPPY_ATLAS_COMPRESSION` | `zstd` | Format de compression de l'atlas (`zstd` ou `gzip`) |

**Note sur `MAPPY_RUST_VULKAN_SESSIONS` :**

- **Intel Arc (et toute carte avec une seule queue Vulkan)** : laisser à `1`. La carte sérialise les
  dispatches GPU au niveau hardware — ajouter des sessions ne fait qu'introduire de l'overhead IPC
  sans gain GPU. Mesuré : 0 % d'overlap GPU à N=2, GPU busy seulement 8.8 % du wall à N=1. Le
  bottleneck est le event loop Node (IPC, atlas merge, décodage JS), pas le GPU.
- **NVIDIA / AMD avec async compute (multi-queue)** : N=2 ou N=3 *pourrait* exposer un vrai overlap
  GPU et améliorer le throughput. Non mesuré — si vous avez une telle carte, comparer le wall time
  à N=1 vs N=2 avant de changer le défaut.
- La valeur est clampée à 4 maximum. Le code de correctness (sémaphore FIFO, garde TOCTOU) s'applique
  quel que soit N, y compris N=1. Voir `rust-wgpu-vulkan-shadow-backend.ts` et ADR-0019.

### Métadonnées de grille (pré-requis une fois par modèle)

Le script `precompute-tile-grid-metadata.ts` pré-calcule la classification indoor/outdoor et
l'élévation de chaque point de grille. Ce calcul ne dépend pas de la date — il est à refaire
uniquement quand les données bâtiments ou le DEM changent.

```bash
MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster \
  pnpm exec tsx scripts/precompute/precompute-tile-grid-metadata.ts \
  --region=lausanne \
  --grid-step-meters=1 \
  --bbox=6.618,46.505,6.645,46.526
```

Ou via le script npm :

```bash
pnpm precompute:grid-metadata
```

Ou en mode générique avec fichier de tuiles prioritaires :

```bash
pnpm precompute:grid-metadata:raster -- \
  --region=lausanne \
  --grid-step-meters=1 \
  --tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json
```

### Vérifier / purger le cache

```bash
pnpm cache:verify
pnpm cache:purge
```

## Déploiement — Atlas sunlight précompute

Les fichiers atlas (`.atlas.bin.gz` + `.atlas.idx`) sont précomputes une fois avec GPU Vulkan et publiés sur GitHub Releases. Une app déployée sans GPU les télécharge au lieu de les recalculer.

### Structure d'une release

```
atlas-v9-2026-05-08          ← tag GitHub Release
├── release-manifest.json    ← point d'entrée (algorithmVersion, sha256, régions)
├── lausanne-atlas.tar
├── lausanne-atlas.tar.sha256
├── nyon-atlas.tar
├── nyon-atlas.tar.sha256
├── geneve-atlas.tar.part1   ← split auto si > 1.8 GB
├── geneve-atlas.tar.part2
├── geneve-atlas.tar.part1.sha256
└── geneve-atlas.tar.part2.sha256
```

Chaque archive contient :

```
release-info.json            ← métadonnées (region, modelVersionHash, tileCount…)
atlas/r0.75/
  *.atlas.bin.gz
  *.atlas.idx
```

### Publier une release

```bash
# Packager une seule région (produit dist/releases/)
pnpm atlas:package -- --region=lausanne

# Packager + publier toutes les régions (crée une draft release GitHub)
pnpm atlas:publish -- --regions=lausanne,nyon,morges,vevey,geneve --tag=atlas-v9-2026-05-08
```

Prérequis : `gh` CLI authentifié (`gh auth login`). La release est créée en **draft** — à valider manuellement sur GitHub avant de la rendre publique.

### Télécharger et installer

```bash
# Sur une machine sans GPU (app déployée)
pnpm atlas:download -- --repo=owner/repo --regions=lausanne,nyon

# Release spécifique (par défaut : latest)
pnpm atlas:download -- --repo=owner/repo --regions=lausanne --release=atlas-v9-2026-05-08
```

Le script vérifie la compatibilité `algorithmVersion` / `artifactFormatVersion` avec le code local et refuse d'installer une release incompatible. L'installation est idempotente : si l'atlas est déjà présent avec le même `modelVersionHash`, il est sauté.

### Ajouter des tuiles ou une nouvelle région

Publier une nouvelle release (ou un tag patch `atlas-v9-2026-05-08-patch1`) avec seulement les régions mises à jour. Le script de download télécharge uniquement les régions demandées — pas besoin de re-télécharger les régions déjà installées.

### Compatibilité des versions

| Constante | Source | Rôle |
|---|---|---|
| `algorithmVersion` | `src/lib/precompute/model-version.ts` | Identifie l'algo de calcul (`sunlight-cache-v9`) |
| `artifactFormatVersion` | idem | Version du format binaire atlas (actuellement `2`) |
| `modelVersionHash` | calculé à l'exécution | Hash des inputs (bâtiments, terrain, calibration…) — détermine le répertoire cache |

Un changement d'`algorithmVersion` ou d'`artifactFormatVersion` invalide les releases existantes.

## Arborescence des données

- `data/raw/swisstopo/swissbuildings3d_2`
- `data/raw/swisstopo/swissalti3d_2m`
- `data/raw/copernicus-dem30`
- `data/raw/osm/lausanne-places-overpass.json`
- `data/raw/osm/nyon-places-overpass.json`
- `data/processed/buildings/lausanne-buildings-index.json`
- `data/processed/horizon/lausanne-horizon-mask.json`
- `data/processed/places/lausanne-places.json`
- `data/processed/places/nyon-places.json`
- `data/processed/precompute/high-value-tile-selection.json`
- `data/processed/precompute/high-value-tile-selection.top-priority.json`
- `docs/assets/high-value-tiles-top-priority-map.html`
