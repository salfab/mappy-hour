# Mappy Hour (Lausanne + Nyon)

Application Next.js pour calculer l'ensoleillement d'une zone urbaine avec un modele a deux niveaux :

1. Relief (montagnes, collines, horizon lointain transfrontalier Suisse + France)
2. Batiments 3D (swissBUILDINGS3D pour Lausanne et Nyon)

## Etat actuel

- Ingestion automatisee des batiments Lausanne/Nyon via STAC swisstopo
- Ingestion automatisee du terrain suisse local (swissALTI3D, 2 m)
- Ingestion automatisee d'un DEM transfrontalier (Copernicus DEM 30 m) pour l'horizon lointain
- Ingestion automatisee des lieux OSM Lausanne/Nyon (parcs + terrasses candidates)
- Pretraitement DEM transfrontalier -> masque d'horizon reel (`copernicus-dem30-raycast-v1`)
- Pretraitement batiments DXF -> index d'obstacles footprint/prism (`dxf-footprint-prism-v1`)
- API `POST /api/sunlight/point` pour un calcul d'ensoleillement journalier a un point
- API `POST /api/sunlight/area` pour calculer une grille soleil/ombre sur bbox
- API `GET /api/places` + `POST /api/places/windows` pour les fenetres d'ensoleillement des lieux
- Endpoint `GET /api/datasets` pour verifier la presence des donnees

Le calcul batiments utilise des empreintes polygonales 2D extrudees en prismes verticaux.

## Prerequis

- Node.js 20+
- pnpm 9+

## Lancer l'app

```bash
pnpm install
pnpm dev
```

Option Windows (recommande quand beaucoup de fichiers DEM/3D):

```powershell
$env:MAPPY_DATA_ROOT='D:\mappy-hour-data'
pnpm dev
```

`pnpm dev` utilise Turbopack (Next 16 par defaut).
En cas de probleme de filewatcher sous Windows, la solution recommandee est de
mettre les donnees lourdes hors repo avec `MAPPY_DATA_ROOT`.

## Recuperer tous les jeux 3D/DEM (script unique)

Les gros fichiers 3D/DEM sont ignores par git (`data/raw/...`) pour eviter de saturer le repo
et reduire la charge du filewatcher en developpement.

Pour tout recuperer/reconstruire en une commande :

```bash
pnpm setup
```

Ou par ville :

```bash
pnpm setup:lausanne
pnpm setup:nyon
```

Ce script execute :

- `ingest:all`
- `preprocess`

## Ingestion des donnees Nyon

### 1) Batiments 3D Nyon (swissBUILDINGS3D)

```bash
pnpm ingest:nyon:buildings
```

### 2) Terrain suisse local Nyon (swissALTI3D 2 m)

```bash
pnpm ingest:nyon:terrain:ch
```

### 3) Vegetation surface Nyon (swissSURFACE3D raster)

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

## Ingestion des donnees Lausanne

### 1) Batiments 3D Lausanne (swissBUILDINGS3D)

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

### 5) Generation de l'index d'obstacles batiments

```bash
pnpm preprocess:buildings:index
```

### 6) Generation du masque d'horizon DEM

```bash
pnpm preprocess:horizon:mask
```

## API

### Verifier les datasets

```bash
curl http://localhost:3000/api/datasets
```

### Calcul d'ensoleillement a un point

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

### Fenetres d'ensoleillement pour lieux

```bash
curl -X POST http://localhost:3000/api/places/windows \
  -H "Content-Type: application/json" \
  -d "{\"date\":\"2026-06-21\",\"timezone\":\"Europe/Zurich\",\"category\":\"park\",\"limit\":10,\"sampleEveryMinutes\":15}"
```

## Arborescence donnees

- `data/raw/swisstopo/swissbuildings3d_2`
- `data/raw/swisstopo/swissalti3d_2m`
- `data/raw/copernicus-dem30`
- `data/raw/osm/lausanne-places-overpass.json`
- `data/raw/osm/nyon-places-overpass.json`
- `data/processed/buildings/lausanne-buildings-index.json`
- `data/processed/horizon/lausanne-horizon-mask.json`
- `data/processed/places/lausanne-places.json`
- `data/processed/places/nyon-places.json`

