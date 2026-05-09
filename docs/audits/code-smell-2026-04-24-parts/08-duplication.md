# Audit transversal : Duplication / parseurs dispersés

## Synthèse

7 clusters, 45+ sites affectés, ~5-7 jours migration totale.

## Cluster 1 — Tile ID `e{E}_n{N}_s{S}` (LOW)

**Format canonique** : `e2538000_n1152250_s250`

**Sites** :
- `src/lib/precompute/sunlight-cache.ts:508` (construction)
- `src/lib/sun/evaluation-context.ts:637` (parsing)
- Scripts : `precompute-region-sunlight.ts`, `build-atlas-from-cache.ts`, `precompute-tile-grid-metadata.ts`

**Constat** : Pas de regex — template literals manuels, format cohérent partout. Drift faible mais centralisation utile.

**Reco** : `src/lib/precompute/tile-id.ts` avec `tileIdFromCoords(e, n, s)` + `parseTileId(id)`. **Effort : 0.5j**

## Cluster 2 — `manifestPathForRegion()` et chemins (MEDIUM)

**Source actuelle** : `src/lib/precompute/model-version.ts:76-95` ternaire `region === "lausanne" ? LAUSANNE_PATH : NYON_PATH`

**Sites duplication** :
- `src/lib/storage/data-paths.ts:21-58` — constantes pré-générées LAUSANNE/NYON only (**pas de support morges/geneve/vevey** !)
- `cache-admin.ts` — référence chemin pour listage

**Drift HIGH** : Si morges/geneve/vevey doivent ajouter manifests, model-version.ts demande edit manuel.

**Reco** : `src/lib/precompute/region-manifests.ts` → `getManifestPaths(region): Record<'buildings'|'terrain'|'vegetation'|'horizon', string>`. **Effort : 1j**

## Cluster 3 — Régions / bbox hardcodés (HIGH)

**TS** :
- `PrecomputedRegionName` type (sunlight-cache.ts:19) : 5 régions
- `src/lib/config/{lausanne,nyon,morges,geneve,vevey}.ts` : bbox WGS84
- `precompute-all-regions-sunlight.ts:28` : `REGION_PRIORITY = ["lausanne", "morges", "nyon", "vevey", "geneve"]`
- `precompute-region-sunlight.ts:71-75` : validation inline (déjà fixée pour vevey en c5fbff4)
- `manage-sunlight-cache.ts:30` : **valide uniquement `["lausanne", "nyon"]`** — bug latent typo silencieuse

**Python** :
- `scripts/ingest/compose-vhm-canopy.py:36-45` : REGIONS dict bbox LV95 dupliqué (PAS sync avec TS)
- `scripts/diag/_capture-golden-baseline.py:24-29` : REGION_MODEL_HASH dict

**Impact** : Ajouter `vevey` requiert edit dans 5+ fichiers. Bug récent `manage-sunlight-cache.ts` reste latent.

**Reco** : `src/lib/config/regions.ts` exportant `SUPPORTED_REGIONS` + `REGION_CONFIGS` typés. Générer Python à partir du TS via script ingest. **Effort : 1.5j**

## Cluster 4 — Parseurs CLI args (HIGH)

**8 réimplémentations indépendantes** :

| Script | Args | Validation région | Notes |
|---|---|---|---|
| precompute-region-sunlight.ts:65-120 | 14 | inline (whitelist 5 régions) | Récemment fixé c5fbff4 |
| precompute-webgpu.ts:43-78 | 11 | **AUCUNE** | Bug latent |
| precompute-tile-grid-metadata.ts:38-51 | 4 | (héritée) | OK |
| precompute-rust-wgpu-vulkan-dry-run.ts:46-110 | 10 | helper `parseRegion()` | Bonne pratique |
| build-atlas-from-cache.ts:57-78 | 6 | aucune | drift potentiel |
| build-high-value-tile-selection.ts | direct argv | aucune | fragile |
| manage-sunlight-cache.ts:14-61 | 6 | **lausanne/nyon only** | Bug silencieux |

**Variations** :
- Parsing : `arg.startsWith("--key=")` partout sauf `build-atlas-from-cache` (`split("=")`)
- Help output : inline strings non centralisé
- Typo `--region=typo` ignorée silencieusement (default appliqué)

**Reco** : `src/lib/precompute/cli-args.ts` avec builder réutilisable + `validateArgs()` strict. **Effort : 2j**

## Cluster 5 — Constantes magiques (MEDIUM)

| Constante | Centralisée ? | Sites |
|---|---|---|
| Tile size 250m | ✓ `CANONICAL_PRECOMPUTE_TILE_SIZE_METERS` (constants.ts:1) | partout |
| Format version | ✓ `SUNLIGHT_CACHE_ARTIFACT_FORMAT_VERSION` (model-version.ts:22) | OK |
| **Grid step 1m** | ✗ hardcodé dans DEFAULT_ARGS de chaque script | dispersé |
| **Sample 15min** | ✗ hardcodé dans DEFAULT_ARGS + APIs | dispersé |
| GPU workgroup 256 | ✗ inline `@workgroup_size(256)` + dispatch logic | webgpu-compute + Rust |
| GPU focus margin 5000m | ✗ `GPU_FOCUS_MARGIN_METERS` evaluation-context vs `DEFAULT_WEBGPU_FOCUS_MARGIN_METERS` webgpu-worker-process | dupliqué |

**Reco** : Étendre `constants.ts` avec `CANONICAL_GRID_STEP_METERS = 1`, `CANONICAL_SAMPLE_EVERY_MINUTES = 15`, `GPU_WORKGROUP_SIZE = 256`, `GPU_FOCUS_MARGIN_METERS = 5000`. **Effort : 0.5j**

## Cluster 6 — Format atlas / mask (LOW)

**Source** : `src/lib/precompute/sunlight-cache-atlas.ts:34-83` (magic `0x4154534C`, version, header 48B, `ATLAS_MASK_KINDS = 5`)

**Sites client** :
- `src/components/sunlight-map-client.tsx:4198` — `masksEncoding === "gzip-concat-v1"`
- `src/lib/encoding/mask-codec-client.ts:7-61` — decoder gzip-concat
- `src/app/api/sunlight/timeline/stream/route.ts` — retourne `masksEncoding`

**Constat** : Pas de mismatch détecté, mais layout constants pas partagés client/serveur.

**Reco** : `src/lib/encoding/atlas-format.ts` exportant `ATLAS_MAGIC`, `MASK_ENCODING_VERSION`, `MASK_KINDS`. **Effort : 0.5j**

## Cluster 7 — Parseurs bbox / boolean (LOW)

- `parseBbox` : 3 implémentations indépendantes (precompute-region-sunlight.ts, precompute-webgpu.ts, precompute-tile-grid-metadata.ts)
- `parseBoolean` : 2 sites (precompute-region-sunlight.ts:44-52 complet, precompute-webgpu.ts:68 inline)

**Reco** : Inclure dans `cli-args.ts` (cluster 4). **Effort : inclus**

## Tableau récap

| # | Cluster | Sévérité | Effort | Priorité |
|---|---|---|---|---|
| 1 | Tile ID | Low | 0.5j | P3 |
| 2 | Manifest paths | Medium | 1j | P2 |
| 3 | Régions/bbox | **High** | 1.5j | P1 |
| 4 | CLI args | **High** | 2j | P1 |
| 5 | Constantes | Medium | 0.5j | P2 |
| 6 | Format atlas | Low | 0.5j | P3 |
| 7 | Parseurs (inclus 4) | Low | - | - |
| **Total** | | | **~5-6j** | |

## Risques résiduels (status quo)

1. **Ajouter région** = 8+ fichiers à modifier, risque oubli silencieux
2. **Changer tile size** = grep+find dispersés, risque inconsistance front/back
3. **CLI args** = fix dans un script, oublié dans 7 autres
4. **manage-sunlight-cache.ts** : valide encore lausanne/nyon only — typo silencieuse latente

## Étapes proposées

| Phase | Livrable | Effort |
|---|---|---|
| 1 — Fondation | `regions.ts` + `constants.ts` étendu | 1j |
| 2 — CLI | `cli-args.ts` + refacto 8 scripts | 2j |
| 3 — Paths | `region-manifests.ts` + 2 fichiers | 1j |
| 4 — Formats | `atlas-format.ts` + `tile-id.ts` | 1j |

**Total : ~5j optimiste / 7j conservateur**
