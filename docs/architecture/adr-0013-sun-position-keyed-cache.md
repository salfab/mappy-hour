# ADR-0013 - Cache d'ombrage keyé par position solaire (az, alt) plutôt que par date

**Date** : 2026-04-17
**Statut** : Proposé (pas implémenté)
**Références** : ADR-0011 (Vulkan précompute), ADR-0012 (runtime shadow backend), commits `066fa89` (format binaire), `513b3e3` (tile lookup fast path)

## Contexte

Le cache actuel stocke les masques d'ombrage par `(région, modelHash, gridStepMeters, sampleEveryMinutes, date, timeWindow, tileId)`. Une tuile = 60 frames (pour 06:00-21:00 sample=15min), chaque frame a un `(localTime, utcTime)` et les bits sunny/not-sunny par cellule.

**Observation physique** : le seul paramètre qui influence l'ombre (pour un mesh bâtiments + terrain + végétation figé par `modelHash`) est la position du soleil `(azimut, altitude)`. La date n'est qu'un proxy utilisé pour calculer cette position via `SunCalc.getPosition(utcDate, lat, lon)`.

**Conséquence** : deux dates différentes qui produisent la même `(az, alt)` au même lieu ont exactement le même masque d'ombrage. Le cache actuel les stocke séparément.

## Pourquoi c'est pertinent maintenant

Un cache keyé par angle dédoublonne sur **trois échelles physiques distinctes**, exploitées simultanément :

### 1. Reuse multi-années (même date civile)

Entre deux années consécutives sur la même date, la position du soleil varie de ~0.1-0.2° (dérive du cycle bissextile). Avec un bucketing à 1°, `2026-04-15 12:00` et `2027-04-15 12:00` tombent **systématiquement dans le même bucket**. Dedup ~4× sur un horizon 4 ans (plus si on réutilise sur plus longtemps).

### 2. Reuse jour-à-jour (même heure civile)

Entre deux jours consécutifs à la même heure horloge, la déclinaison varie de ~0.1°/jour (près des solstices) à ~0.4°/jour (près des équinoxes). À 1° de bucket, un même bucket est donc partagé par **2-10 jours consécutifs selon la saison**.

**Mesure** (bench `sun-bucket-consecutive-days.ts`, Lausanne 2026) — longueur moyenne du run de jours consécutifs partageant le même bucket à 1° :

| Résolution | Run moyen | Médiane | Min | Max |
|---|---|---|---|---|
| 2° | 4.5 | 4 | 1 | 24 |
| 1° | 2.7 | 2 | 1 | 10 |
| 0.5° | 1.7 | 1 | 1 | 8 |
| 0.25° | 1.2 | 1 | 1 | 5 |

Variation saisonnière à 1° / 12:00 :
- Équinoxes (mars, septembre, octobre) : **1 jour seulement** — la déclinaison bouge vite (~0.4°/jour)
- Solstice d'été (juillet) : **6 jours consécutifs** — la déclinaison est quasi-stable (~0.1°/jour)
- Solstice d'hiver (juin) : 4 jours

Le partage jour-à-jour est donc un mécanisme de dedup **modeste mais réel à 1°** (~2.7× en moyenne), et **négligeable à 0.5°**. C'est un argument en faveur de garder 1° comme résolution cible.

### 3. Déduplication intra-saison (configurations croisées)

Au-delà des deux mécanismes ci-dessus, deux `(date, heure)` éloignés peuvent accidentellement produire le même `(az, alt)` — par exemple "matin d'un jour" vs "soir d'un autre jour" symétrique. Ces recouvrements occasionnels contribuent aussi au total.

**Résultat agrégé** : à Lausanne 46.5°N, sur un an à 15min de sample, il y a ~21 900 couples `(az, alt)` dans le cache, mais seulement **~1 500-2 000 buckets uniques à 1°**. Dedup global ~10-15×.

### 4. Autres avantages

- **Agnostic aux fuseaux horaires / DST** : la position solaire ne dépend pas du fuseau. Le cache actuel doit gérer `timezone` et `localTime` partout — simplification architecturale.
- **Précompute coût constant** : aujourd'hui, précomputer 200 jours = 200× le coût d'un jour. Avec `(az, alt)`, précomputer "toutes les positions visitées dans une année" = un coût fini, valable pour toutes les dates passées/futures.

## Proposition

### Structure de cache : un atlas par tuile

Chemin :

```
data/cache/sunlight/{region}/{modelHash}/g{grid}/atlas/{tileId}.atlas.bin.gz
```

**Pourquoi un atlas par tuile et pas autre chose** :

| Layout alternatif | Pourquoi pas |
|---|---|
| Un fichier par bucket par tuile (sparse total) | 181 tuiles × ~3 500 buckets = **~630 000 fichiers par région**. NTFS se traîne à cet ordre de grandeur d'inodes, gzip est peu efficace sur des fichiers de ~36 KB, et chaque requête UI devrait ouvrir 60 fichiers par tuile. |
| Un fichier par bucket × toutes les tuiles (sheet) | Lire une seule tuile à un angle donné nécessite d'ouvrir un fichier qui contient les 181 tuiles — beaucoup de data jetée pour chaque query. |
| **Un atlas par tuile** (recommandé) | Aligné sur les access patterns timeline (N tuiles × 60 buckets → N fichiers, lookup interne) et places/windows (1 tuile → 1 fichier). ~181 fichiers par région, très filesystem-friendly. |

**Structure interne** (analogue à `sunlight-cache-binary.ts` actuel, avec keying modifié) :

```
Header (32 B fixes, little-endian) :
  magic u32, version u16, flags u16,
  pointCount u32, bucketCount u32,
  maskBytesPerFrame u32,
  resolutionDegAz f32, resolutionDegAlt f32,
  pointStride u32, metaJsonLen u32,
  bucketIndexOffset u32, bucketDataOffset u32

Metadata JSON (~5 KB) :
  { region, modelVersionHash, tile: RegionTileSpec, model, warnings, stats,
    pointIds?, indoorBuildingIds?, pointElevationMeters?,
    pointLv95Easting?, pointLv95Northing? }

Points (pointCount × 32 B) :
  inchangé vs format tuile actuel — on a toujours besoin de
  ix/iy/outdoorIndex/flags pour résoudre (lat, lon) → cellule.

Bucket Index (bucketCount × 8 B) trié par (altBucket, azBucket) :
  { azBucket: u16, altBucket: u16, dataOffset: u32 }

Bucket Data (bucketCount × entry) :
  pour chaque bucket :
    sunnyCount u32, sunnyNoVegCount u32,
    sunMask, sunMaskNoVegMask, terrainMask, buildingsMask, vegetationMask
    (5 × maskBytesPerFrame, bit-packed contigus)
```

Format bit-pack et taille mask identiques au format binaire tuile actuel (ADR-0011). Seul le keying change.

### Tailles estimées (Lausanne, bucket 1°, ~3 500 buckets par tuile)

Par atlas :
- Points : 62 500 × 32 B = 2 MB
- Bucket index : 3 500 × 8 B = 28 KB
- Bucket data : 3 500 × 5 × 7 812 B ≈ 135 MB raw
- **Total raw : ~137 MB** → gzippé à ~50 MB (les masks bit-packed compriment moyennement)

× 181 tuiles = **~9 GB pour tout Lausanne**.

**Comparaison stockage** :

| Config | Taille disque | Couverture temps |
|---|---|---|
| Cache actuel (date-keyed, 200 jours) | ~15 GB | 200 jours fixes |
| Cache actuel (date-keyed, année complète) | ~55 GB | 1 an fixe |
| **Atlas 1°** | **~9 GB** | **Tous les ans** |
| Atlas 0.5° | ~18 GB | Tous les ans |

L'atlas à 1° prend **moins de disque que le cache actuel pour une seule année**, et couvre toutes les années futures.

### Lookup : structure de l'index bucket

Deux options pour le bucket index à l'intérieur de l'atlas :

1. **Index trié + binary search** (O(log n) en ~12 comparaisons pour 3 500 buckets)
   - Taille : `bucketCount × 8 B` → ~28 KB par tuile
   - Simple, sparse, efficace
2. **Grid dense 2D** (O(1) lookup direct par `azBucket * gridH + altBucket`)
   - Taille : `360 × 90 × 4 B` = 130 KB par tuile à 1° — plus de surcoût, mais constant et pas de search
   - × 181 tuiles = 23 MB de surcoût total pour Lausanne, probablement acceptable pour la simplicité

**À trancher à l'implémentation**. Le dense grid est sans doute plus simple à débugger et le surcoût négligeable comparé aux 9 GB totaux. Mais l'index trié reste plus naturel pour une structure vraiment sparse.

### Lookup runtime

Pour toute requête `(date, localTime, lat, lon)` :

```ts
const utcDate = zonedDateTimeToUtc(date, localTime, timezone);
const pos = SunCalc.getPosition(utcDate, lat, lon);
const az = normalizeAzimuth(pos.azimuth);  // 0-360
const alt = pos.altitude * RAD_TO_DEG;      // -90 à 90
const azBucket = Math.floor(az / BUCKET_RES_AZ);
const altBucket = Math.floor(alt / BUCKET_RES_ALT);
const masks = atlas.lookup(azBucket, altBucket);
```

Si le bucket exact n'est pas précomputé → fallback nearest-neighbor, ou compute on-the-fly pour ce seul bucket et l'ajouter à l'atlas.

### Résolution des buckets

**Point clé** : quelle granularité d'arrondi pour `az` et `alt` ?

Le chiffre "1°" mentionné plus tôt est **l'arrondi d'idempotence du backend `gpu-raster`** (évite de re-render le même shadow map à moins d'1° près). Ce **n'est pas** la précision actuelle des masques stockés — les masques sont calculés avec l'angle exact de SunCalc.

#### Mesures (bench `sun-bucket-resolution-bench.ts`, commit `1a390fa`)

Divergence mesurée sur une tuile Lausanne centre (`e2538000_n1152250_s250`), 2026-04-13, fenêtre 06:00-21:00 (60 frames), 32186 points outdoor → 1.93M bits/masque comparés par résolution, via le backend Rust/wgpu Vulkan :

| Résolution | sunMask div | sunMaskNoVeg div |
|---|---|---|
| 0.25° | **0.268%** | 0.318% |
| 0.5° | **0.368%** | 0.444% |
| 1° | **0.570%** | 0.666% |
| 2° | 0.992% | 1.172% |

**Breakdown par bande d'altitude (sunMask)** :

| Bande | 0.25° | 0.5° | 1° | 2° |
|---|---|---|---|---|
| alt < 5° | 0.16% | 0.33% | 0.33% | 1.05% |
| alt 5-15° | 0.16% | 0.29% | 0.71% | 1.25% |
| alt 15-30° | 0.30% | 0.43% | 0.81% | 1.35% |
| alt ≥ 30° | 0.36% | 0.45% | 0.61% | 1.01% |

**Observations** :

1. L'hypothèse initiale "il faut de la résolution fine près de l'horizon" n'est **pas validée** par les mesures. À 1°, `alt<5°` diverge à 0.33%, tandis que `alt≥30°` diverge à 0.61%. L'altitude haute est en fait plus sensible parce que le soleil y bouge plus vite en azimut (360° d'azimut traversés en 12h à midi vs quelques degrés au lever/coucher) et les ombres portées sont plus nombreuses.
2. Près de l'horizon, peu de cellules sont ensoleillées (ombres des bâtiments couvrent l'essentiel) → peu de bits à "flipper" au bucketing.
3. La **résolution adaptative n'est pas nécessaire** — un bucketing uniforme suffit.

#### Mesures sur le dataset complet — 200 jours, 179 tuiles (bench `atlas-divergence-from-dataset.ts`, 2026-04-17)

Divergence réelle calculée sur les bits stockés dans le cache date-keyed de Lausanne (200 jours, fenêtre 00:00-23:59, 96 frames/jour, 20 tuiles sondées ~19 800 frames chacune) :

| Résolution | Overall | alt<5° | alt 5-15° | alt 15-30° | alt≥30° | Dedup |
|---|---|---|---|---|---|---|
| 0.25° | **0.000%** | 0.000% | 0.000% | 0.000% | 0.000% | 1.22× |
| 0.5° | **0.126%** | 0.100% | 0.221% | 0.271% | 0.195% | 1.76× |
| 1° | **0.457%** | 0.102% | 0.616% | 0.647% | 0.955% | 3.19× |
| 2° | **1.070%** | 0.461% | 1.498% | 1.726% | 2.127% | 6.86× |

Confirmation et raffinement des chiffres single-tile (bench 2026-04-15) :
- La divergence à 1° sur l'ensemble du dataset (0.457%) est **légèrement inférieure** à celle mesurée sur une seule tuile (0.570%) — les 200 jours avec fenêtre complète produisent en réalité moins de collision problématique qu'une journée de printemps seule.
- À 0.25°, la divergence est **exactement 0.000%** sur tous les buckets multi-frames : les frames dans un même bucket 0.25° ont des masques d'ombrage bit-identiques. Ce résultat n'était pas attendu avec cette certitude.
- À 0.5°, la divergence est < 0.3% sur toutes les bandes d'altitude.

Wallclock estimate sur le dataset complet (`atlas-wallclock-estimate.ts`, 179 tuiles, 1 839 221 frames lit) :
- 1° : 577 138 frames atlas = 31.4% du date-keyed → **3.19× moins de compute**
- 0.5° : 1 044 482 frames atlas = 56.8% → 1.76× moins de compute
- 0.25° : 1 507 061 frames atlas = 81.9% → 1.22× moins de compute
- 2° : 268 150 frames atlas = 14.6% → 6.86× moins de compute

#### Reco révisée

**1° est largement acceptable** :
- 0.457% de divergence au niveau bit (dataset réel, 200 jours)
- À comparer avec la divergence **Vulkan vs gpu-raster** documentée dans ADR-0011 : **1.2-1.3% sur sunMask final**
- Le bucketing à 1° introduit **3× moins d'erreur que le choix de backend lui-même**. Architecturalement c'est du bruit.

**0.5° comme sweet spot si on veut être prudent** :
- 0.37% de divergence
- ~4× plus de buckets que 1° (~6 000 vs ~1 500)
- Marge supplémentaire confortable sous le seuil de perception UX

**0.25° probablement overkill** :
- 0.27% de divergence (-30% par rapport à 0.5°)
- 4× plus de buckets que 0.5° (~25 000), pour un gain de précision marginal invisible à l'œil

Décision pragmatique : **démarrer à 1°**, réévaluer à 0.5° si un cas d'usage révèle des artefacts visibles (ombres qui clignotent, terrasses qui basculent sunny/shadow entre deux frames adjacentes). L'atlas étant sparse, on peut "densifier" un angle problématique à 0.5° à la demande sans tout recalculer.

### Enumération des buckets à précomputer

Deux stratégies :

1. **Dense** : précomputer tous les buckets possibles sur la surface 2D `(az, alt)`. À Lausanne le soleil visite `az ∈ [60°, 300°]` environ (lever au NE, coucher au NW), `alt ∈ [-20°, 67°]`. À 1°, ça fait ~240 × 87 = ~21 000 buckets. Couverture absolue, robuste aux futures dates/fenêtres.
2. **Empirique** : précomputer les buckets effectivement visités pour une couverture temporelle donnée (un an civil × 15min sample × toute la plage 00:00-23:59). ~1 500-2 000 buckets. Plus léger mais doit être étendu si on veut à l'avenir des sampleEveryMinutes plus petits ou des heures exotiques.

Le **hybride** est probablement la bonne approche : précomputer le dense sur la plage altitude > -5° (au-dessus du crépuscule astronomique) à la résolution choisie, laisser les altitudes très négatives non précomputées (de toute façon la nuit, `sunMask = 0`).

### Impact sur le précompute

Le pipeline actuel (`pnpm precompute:all-regions -- --days=200`) itère sur `(date, tile, frame)`. Avec l'atlas, il itérerait sur `(tile, bucket)`.

Architecturalement **plus simple** : pas de gestion de timezone/DST/date offsets dans le précompute. Juste "pour chaque tuile, pour chaque bucket cible, dispatch compute".

Le backend Vulkan accepte déjà `(az, alt)` en entrée du shader — aucune modification côté Rust. Le changement est 100% côté orchestration Node.

Estimation coût :
- 181 tuiles × 2 000 buckets × ~0.05s/bucket (phase E GPU) = ~6 h de compute total, **une fois**, puis valable à jamais.
- À comparer avec l'approche actuelle : 181 tuiles × 200 dates × 60 frames × ~0.05s = ~30 h pour couvrir 200 jours. Gain 5×.
- Sur 4 ans de coverage : 4 × 30 h = 120 h actuel vs 6 h avec atlas = **20× gain**.

### Impact sur le runtime (lookup)

Minimal : ajouter un module `atlas-lookup.ts` avec :

```ts
export async function lookupShadowByAngle(params: {
  region: PrecomputedRegionName;
  modelVersionHash: string;
  gridStepMeters: number;
  tileId: string;
  azimuthDeg: number;
  altitudeDeg: number;
}): Promise<AtlasFrameMasks | null>
```

Le fast-path de `/api/places/windows` (ADR-0012, commit `513b3e3`) fait déjà `SunCalc.getPosition → angle → lookup`. Il suffit de router le lookup sur l'atlas.

La route `/api/sunlight/timeline/stream` cache-only fait actuellement `date → 60 frames`. Avec atlas, elle ferait `date → 60 angles → 60 lookups dans l'atlas`. Même coût mémoire, même bits retournés au navigateur.

## Trade-offs

### Pour

- **Reuse multi-années** : précompute une fois, valable indéfiniment
- **Dédup intra-saison** : ~10-15× moins de masques uniques
- **Précompute 5-20× plus rapide** sur horizon long (multi-années)
- **Architecture plus propre** : la date devient un input au moment de la requête, plus une clé de stockage

### Contre

- **Refactor lourd** : précompute, stockage, reader, client API, tests — ~3-5 jours de dev
- **Migration** : le cache existant (~2.5 GB en binaire aujourd'hui) reste exploitable via fallback, mais ne peut pas être "rematché" automatiquement en atlas (on aurait besoin de ses bits non pas par date mais par angle, donc même algorithme de conversion qu'un nouveau précompute).
- **Interpolation de bucket** : à la résolution choisie, certaines requêtes retombent entre deux buckets précomputés. Nearest-neighbor est acceptable pour les bits binaires, mais l'erreur est non-nulle.
- **Horizon sensibilité** : un bucketing trop grossier près de `alt=0` produit des faux positifs/négatifs "soleil visible". Demande une résolution adaptative (complexité).
- **Premier précompute plus long** : 6 h pour tout un atlas contre 1.5 h pour un seul jour aujourd'hui. Le cold-start pour une nouvelle région prend plus de temps.

## Critères de décision (à réévaluer plus tard)

L'implémentation de cet ADR devient intéressante quand :

1. On veut couvrir **>1 an de dates** avec le précompute (économie multi-années se cumule)
2. On veut supporter des **années glissantes** (toujours avoir les 12 mois à venir précomputés) sans re-précomputer tous les ans
3. Le précompute actuel devient un goulot opérationnel (coût de run, planification des re-runs annuels)
4. On ajoute de nouvelles régions (Lavaux, Genève élargi, etc.) et le coût de dates × tuiles explose

Tant que la couverture reste "2026 pour Lausanne centre" et que le cache existant suffit pour l'usage, le gain est théorique.

## Plan d'implémentation

Deux chantiers distincts qui peuvent se faire séquentiellement : **(A) génération atlas** puis **(B) utilisation runtime**. La coexistence date-keyed + atlas est préservée via fallback pendant toute la migration.

### Phase 0 : Baselines (préalable, fait dans la session 2026-04-17)

- [x] Format binaire date-keyed (commits `066fa89`, `2da1fea`) — baseline de performance et stockage
- [x] Bench divergence single-tile (commit `1a390fa`) — confirme 1° comme résolution cible
- [x] Bench consecutive-day sharing (commit `143a8aa`) — confirme l'intérêt multi-échelles
- [x] Bench scripts prêts (commit `b01017e`) — `atlas-divergence-from-dataset.ts` et `atlas-wallclock-estimate.ts` à lancer quand la précompute date-keyed 200 jours est finie
- [x] **Bench scripts lancés sur le dataset 200 jours (2026-04-17)** — divergence à 1° = 0.457% réel, 3.19× dedup, 0.25° = 0.000% (voir section Mesures ci-dessus)

### Phase A — Génération atlas (~1.5j)

**Module `src/lib/precompute/sunlight-cache-atlas.ts`** (~400 LOC)

Mirror de `sunlight-cache-binary.ts` adapté au format atlas. API :

```ts
export interface BinaryTileAtlas {
  meta: BinaryTileAtlasMetadata;  // region, modelHash, tile, model, stats, resolutionDeg
  pointCount: number;
  // Points (typed arrays, identique à BinaryTileArtifact)
  pointLon, pointLat, pointIx, pointIy, pointOutdoorIndex, pointFlags;
  // Buckets triés par (altBucket, azBucket)
  bucketCount: number;
  bucketAz: Int16Array;
  bucketAlt: Int16Array;
  bucketOffsets: Uint32Array;
  bucketSunnyCounts: Uint32Array;
  bucketSunnyNoVegCounts: Uint32Array;
  maskBuffer: Uint8Array;  // 5 masks × bucketCount, concaténés
}

export function encodeTileAtlasToBinary(atlas: BinaryTileAtlas): Buffer;
export function decodeTileAtlasFromBinary(raw: Uint8Array): BinaryTileAtlas;
export async function writePrecomputedTileAtlas(...);
export async function loadPrecomputedTileAtlas(...);
export function lookupAtlasBucket(atlas, azBucket, altBucket): AtlasBucketEntry | null;
```

**Script `scripts/precompute/precompute-region-atlas.ts`** (~300 LOC)

```bash
pnpm tsx scripts/precompute/precompute-region-atlas.ts \
  --region=lausanne \
  --coverage-start-date=2026-01-01 --coverage-days=366 \
  --sample-every-minutes=15 \
  --resolution-deg=1
```

Logique par tuile :
1. Enumérer les (az, alt) uniques que le soleil visite sur la période coverage
2. Générer ~3 500 "synthetic frames" avec chacune un utcDate représentatif qui retombe dans ce bucket
3. Appeler l'infrastructure Vulkan existante (`evaluateBatchFramesWithShadows`) avec ces frames dédoublonnées
4. Collecter les masks par bucket, écrire `.atlas.bin.gz`

Le backend Rust/Vulkan prend déjà `(az, alt)` en entrée — **zéro modification côté shader**. La déduplication se fait dans l'orchestration TS.

**Tests** :
- Round-trip encoder/décoder (bitwise exact)
- Lookup par bucket valide / bucket absent
- Cohérence : un atlas régénéré deux fois doit être bit-identique

### Phase B — Utilisation runtime (~1j)

**Adaptation `sunlight-tile-service.ts`**

Dans `loadTileBinaryDiskOnly`, ajouter une tentative atlas avant le fallback date-keyed :

```ts
async function loadTileBinaryDiskOnly(params) {
  // 1. Try atlas (year-independent, covers all dates)
  const atlas = await loadPrecomputedTileAtlas({
    region, modelHash, gridStep, tileId
  });
  if (atlas) return { kind: "atlas", atlas };

  // 2. Fallback: legacy date-keyed
  const binary = await loadPrecomputedSunlightTileBinary({...});
  if (binary) return { kind: "date-keyed", binary };
  return null;
}
```

**Adaptation `/api/sunlight/timeline/stream`**

La boucle actuelle lit 60 frames séquentielles du `.tile.bin.gz`. Avec atlas :

```ts
// Pour chaque frame requise du client :
const utcDate = getFrameUtcDate(frameIndex);
const pos = SunCalc.getPosition(utcDate, tileCenterLat, tileCenterLon);
const azB = Math.floor(pos.az / atlas.resolutionDegAz);
const altB = Math.floor(pos.alt / atlas.resolutionDegAlt);
const bucket = lookupAtlasBucket(atlas, azB, altB);
// Le reste du pipeline (remap outdoorIndex → grid cell, encode masks,
// send SSE) est IDENTIQUE.
```

Le streaming / prefetch restent — on lit 1 atlas par tuile au lieu de 1 bin-gz par tuile.

**Adaptation `/api/places/windows` (fast path, ADR-0012)**

`lookupPointInTile` reste identique. Dans la boucle samples, au lieu d'itérer `binary.meta.framesMeta`, on itère les utcDates du client et on lookup par angle dans l'atlas :

```ts
for (const utcDate of dailySamples) {
  const {az, alt} = sunPositionAt(utcDate, tileCenter);
  const bucket = lookupAtlasBucket(hit.atlas, azB, altB);
  samples.push({
    isSunny: readBit(bucket.sunMask, outdoorIndex),
    localTime: formatLocalTime(utcDate, timezone),
    utcTime: utcDate.toISOString(),
  });
}
```

### Phase C — Validation (~0.5j)

1. Re-précomputer 3-5 tuiles représentatives en atlas (centre urbain dense, périphérie, bord de lac, colline)
2. Lancer un bench end-to-end : `/api/sunlight/timeline/stream` sur bbox couvrant ces tuiles, comparer atlas vs date-keyed
3. Lancer `/api/places/windows` sur 50-100 places dans les tuiles migrées, comparer résultats
4. Divergence attendue : ≤1% sunnyMinutes par place vs baseline date-keyed

### Phase D — Rollout (~1j sur un week-end)

1. Précompute atlas complet pour Lausanne (wallclock estimé ~8-15h selon résolution — tournant la nuit)
2. Vérifier divergence agrégée via `atlas-divergence-from-dataset.ts`
3. Activer le reader atlas sans toucher les anciens caches (coexistence via fallback)
4. Monitorer les métriques UX pendant quelques jours
5. Si stable : supprimer les `.tile.bin.gz` de Lausanne (gain disque ~15 GB pour 200 jours, ~55 GB pour année complète)
6. Répéter pour Nyon, Morges, Genève

### Migration des caches existants

**Pas de migration automatique possible** : l'atlas a besoin de masks à des angles **précis** (centre de bucket), pas aux angles exacts des dates précomputées. Les bits ne sont pas interchangeables — il faut re-précomputer.

Mais c'est fait **une fois** et ça dure éternellement. Une fois l'atlas de Lausanne fait, il couvre 2026, 2027, 2028, ... sans coût supplémentaire.

### Ordre d'exécution recommandé

1. [x] Fin du précompute date-keyed 200 jours (complété 2026-04-17, 179 tuiles, 33 559 tiles)
2. [x] Bench scripts Phase 0 (complétés 2026-04-17) — divergence 1°=0.457%, 3.19× dedup
3. [x] Phase A (génération atlas depuis cache) — complété 2026-04-17 (179 tuiles, ~1.2 GB)
   - **Bug trouvé 2026-04-17** : dates `1999-04-08` et `2018-06-08` sont des precomputes corrompus (sunnyCount=0 pour tous les frames malgré sun > horizon). Le build script choisissait ces frames comme représentants → 98% des buckets avaient un masque tout-à-zéro. Fix : ignorer les frames avec `sunnyCount=0 && alt>2°`. Atlas rebuild lancé avec `--skip-existing=false`.
4. [x] Phase B (runtime — wiring atlas dans les 3 routes API) — complété 2026-04-17
5. ▶ Phase C (validation quantitative sur 5 tuiles) — en cours (script `validate-atlas-vs-datekey.ts`)
6. ▶ Phase D (rollout complet si validation OK)

**Le chemin critique est 2-3j de dev concentrés + une nuit de compute atlas. Aucune interruption de service** grâce au fallback date-keyed.

## Sécurités

- Le `modelVersionHash` reste la clé primaire — les masques atlas sont liés au modèle des bâtiments comme aujourd'hui
- L'ADR-0012 reste compatible : runtime shadow backend (Vulkan ou ANGLE) sert toujours pour les tuiles/bboxes non couverts par un atlas
- Le fallback sur le cache date-keyed évite la régression : si l'atlas est vide ou absent, le comportement est identique à aujourd'hui

## Questions ouvertes

1. ~~**Résolution définitive des buckets** : faire un bench divergence sur plusieurs résolutions avant de figer~~ → **Fait** (commit `1a390fa`). Reco : 1° uniforme, 0.5° si prudent.
2. **Faut-il stocker `utcTime`/`localTime` dans l'atlas ?** Non — c'est dérivable depuis l'angle + lat/lon du lieu + date demandée. L'atlas devient purement géométrique.
3. **Que faire de `sunnyCount` / `sunnyCountNoVeg` ?** Ce sont des comptes sur la grille 2D de la tuile, valides par frame, donc par bucket aussi. À stocker dans le bucket.
4. **Partage entre dates avec léger décalage** : 2026-04-15 12:00 et 2027-04-15 12:00 diffèrent de 0.1-0.2°. À résolution 1°, même bucket. À 0.25°, potentiellement bucket voisin. Tolérance acceptable.
5. **Nearest-neighbor vs interpolation** : pour les bits binaires, nearest-neighbor est OK (les mesures ci-dessus sont justement obtenues par nearest-neighbor via `Math.round(x/step)*step`) ; pour les compteurs (`sunnyCount`), on peut interpoler (moyenne pondérée). À trancher à l'implémentation.
6. **Validation multi-tuiles** : le bench actuel tourne sur UNE tuile (`e2538000_n1152250_s250`). Répéter sur 3-5 tuiles avec topologies différentes (centre urbain dense, bord de lac, colline) avant de figer la résolution définitive.
