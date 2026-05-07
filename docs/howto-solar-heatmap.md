# Générer une heatmap solaire annuelle (mode panneau solaire)

Calcule les heures d'ensoleillement direct par pixel sur une année entière pour une petite zone (1 tuile 250m × 250m). Produit un JSON exploitable pour une visualisation Leaflet/OSM.

## Prérequis

- Le precompute Vulkan fonctionne (`pnpm precompute:all-regions:vulkan`)
- Les données terrain + bâtiments + VHM sont ingérées pour la région cible
- Python 3 + rasterio installé (pour l'ingestion VHM si pas encore faite)

## 1. Choisir la zone

Trouver les coordonnées LV95 du centre de la zone :

```bash
npx tsx -e '
import { wgs84ToLv95 } from "./src/lib/geo/projection.ts";
const r = wgs84ToLv95(6.1754, 46.4133);  // lon, lat
console.log("LV95:", r.easting, r.northing);
console.log("Tile:", "e" + Math.floor(r.easting/250)*250 + "_n" + Math.floor(r.northing/250)*250 + "_s250");
'
```

Créer le fichier de sélection (adapter `tileId` et `region`) :

```bash
cat > data/processed/precompute/ma-zone.json << 'EOF'
{
  "generatedAt": "2026-04-16T00:00:00Z",
  "selectionVersion": 1,
  "source": "manual - solar heatmap",
  "tileSizeMeters": 250,
  "areas": [{
    "id": "nyon",
    "label": "Nyon",
    "region": "nyon",
    "selectedTiles": [{
      "tileId": "e2502750_n1141000_s250",
      "score": 1, "totalPlaces": 0, "parks": 0, "terraceCandidates": 0
    }]
  }],
  "tiles": [
    { "region": "nyon", "tileId": "e2502750_n1141000_s250", "score": 1 }
  ]
}
EOF
```

**Important** : le champ `tiles` (flat array avec `region` + `tileId`) est requis par le script de precompute. Le champ `areas` est pour le groupement par zone.

## 2. Générer le grid metadata (une seule fois par tuile)

Le precompute Vulkan a besoin du zenith indoor mask pour distinguer les points intérieur/extérieur. Ça se génère une fois :

```bash
MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster npx tsx scripts/precompute/precompute-tile-grid-metadata.ts \
  --region=nyon \
  --tile-selection-file=data/processed/precompute/ma-zone.json
```

Durée : ~20s par tuile. Utilise le shadow map gpu-raster pour projeter le soleil au zénith et détecter les points sous un toit.

## 3. Precompute l'année (résumable)

```bash
pnpm precompute:all-regions:vulkan -- \
  --tile-selection-file=data/processed/precompute/ma-zone.json \
  --start-date=2026-01-01 --days=365
```

- 1 tuile × 365 jours × 60 frames (06h-21h toutes les 15 min)
- Durée estimée : **~20 min** à 3s/tuile
- **Résumable** : `skip-existing=true` par défaut. Interromps et relance librement.
- Progression : le script affiche le jour en cours et l'ETA

Pour vérifier l'avancement :

```bash
npx tsx scripts/export-gingins-heatmap.ts --days-available
```

## 4. Exporter la heatmap (résumable)

```bash
npx tsx scripts/export-gingins-heatmap.ts
```

- Lit les artefacts `.json.gz` du cache jour par jour
- Accumule les minutes de soleil par pixel (avec et sans végétation)
- Sauvegarde la progression dans `data/tmp/gingins-heatmap-progress.json` tous les 10 jours
- **Résumable** : relance et il reprend où il s'est arrêté
- Exporte `C:\sources\seesharpch\assets\data\gingins-heatmap.json`

## 5. Format de sortie

```json
{
  "tileId": "e2502750_n1141000_s250",
  "daysProcessed": 365,
  "gridSize": 250,
  "minEasting": 2502750, "minNorthing": 1141000,
  "maxEasting": 2503000, "maxNorthing": 1141250,
  "sunnyHours": [1420.5, 1380.2, ...],        // heures/an par pixel (avec végétation)
  "sunnyNoVegHours": [1520.0, 1480.5, ...],    // heures/an par pixel (sans végétation)
  "indoor": [false, false, true, ...]           // true = intérieur de bâtiment
}
```

- `sunnyHours` : heures d'ensoleillement direct annuel en tenant compte du terrain, des bâtiments ET de la végétation
- `sunnyNoVegHours` : idem mais en ignorant la végétation (= potentiel si on coupait les arbres)
- La différence `sunnyNoVegHours - sunnyHours` = heures perdues à cause des arbres

## 6. Interpréter les résultats

| Heures/an | Interprétation |
|---|---|
| > 1400 | Excellent pour panneaux solaires |
| 1000-1400 | Bon, rendement correct |
| 600-1000 | Moyen, ombre partielle significative |
| < 600 | Mauvais, trop d'ombre |

Pour référence : Lausanne reçoit ~1600-1700 heures de soleil direct par an en terrain dégagé (pas d'obstacles). Un pixel à 1400h reçoit ~85% du maximum théorique.

## 7. Adapter à une autre zone

1. Changer les coordonnées dans l'étape 1
2. Adapter `TILE_ID` et `REGION` dans `scripts/export-gingins-heatmap.ts`
3. Relancer les étapes 2 et 3

Pour couvrir une zone plus grande (plusieurs tuiles), ajouter des entrées dans `selectedTiles` et adapter le script d'export pour fusionner les résultats.

## Ingestion VHM (si pas encore faite)

Le VHM (Vegetationshöhenmodell) remplace le DSM (SwissSURFACE3D) pour la végétation. Il isole les arbres des bâtiments — plus propre pour le calcul.

```bash
python scripts/ingest/compose-vhm-canopy.py --region=nyon
```

Fait un seul HTTP range request vers le COG national (EnviDat), compose `terrain + VHM = canopy` pour chaque tuile 1km, et écrit les GeoTIFF dans le même dossier que les anciennes tuiles SwissSURFACE3D.
