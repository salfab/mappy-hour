# Mappy Hour (Lausanne)

Application Next.js pour calculer l'ensoleillement d'une zone urbaine avec un modele a deux niveaux :

1. Relief (montagnes, collines, horizon lointain transfrontalier Suisse + France)
2. Batiments 3D (swissBUILDINGS3D pour Lausanne)

## Etat actuel

- Ingestion automatisee des batiments Lausanne via STAC swisstopo
- Ingestion automatisee du terrain suisse local (swissALTI3D, 2 m)
- Ingestion automatisee d'un DEM transfrontalier (Copernicus DEM 30 m) pour l'horizon lointain
- API `POST /api/sunlight/point` pour un calcul d'ensoleillement journalier a un point
- Endpoint `GET /api/datasets` pour verifier la presence des donnees

Le masque d'horizon est encore un placeholder (`flat-placeholder`) tant que la phase de pretraitement DEM -> horizon n'est pas branchee.
Le calcul d'ombre des batiments sera branche dans l'iteration suivante.

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

### 4) Generation du masque d'horizon (placeholder V1)

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

## Arborescence donnees

- `data/raw/swisstopo/swissbuildings3d_2`
- `data/raw/swisstopo/swissalti3d_2m`
- `data/raw/copernicus-dem30`
- `data/processed/horizon/lausanne-horizon-mask.json`

