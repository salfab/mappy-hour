# Mappy Hour (Lausanne)

Application Next.js pour calculer l'ensoleillement d'une zone urbaine avec un modele a deux niveaux :

1. Relief (montagnes, collines, horizon lointain transfrontalier Suisse + France)
2. Batiments 3D (swissBUILDINGS3D pour Lausanne)

## Etat actuel

- Ingestion automatisee des batiments Lausanne via STAC swisstopo
- Ingestion automatisee du terrain suisse local (swissALTI3D, 2 m)
- Ingestion automatisee d'un DEM transfrontalier (Copernicus DEM 30 m) pour l'horizon lointain
- Ingestion automatisee des lieux OSM Lausanne (parcs + terrasses candidates)
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
pnpm preprocess:lausanne:buildings
```

### 6) Generation du masque d'horizon DEM

```bash
pnpm preprocess:lausanne:horizon
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
- `data/processed/buildings/lausanne-buildings-index.json`
- `data/processed/horizon/lausanne-horizon-mask.json`
- `data/processed/places/lausanne-places.json`

