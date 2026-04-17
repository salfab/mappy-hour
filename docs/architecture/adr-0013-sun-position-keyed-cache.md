# ADR-0013 - Cache d'ombrage keyé par position solaire (az, alt) plutôt que par date

**Date** : 2026-04-17
**Statut** : Proposé (pas implémenté)
**Références** : ADR-0011 (Vulkan précompute), ADR-0012 (runtime shadow backend), commits `066fa89` (format binaire), `513b3e3` (tile lookup fast path)

## Contexte

Le cache actuel stocke les masques d'ombrage par `(région, modelHash, gridStepMeters, sampleEveryMinutes, date, timeWindow, tileId)`. Une tuile = 60 frames (pour 06:00-21:00 sample=15min), chaque frame a un `(localTime, utcTime)` et les bits sunny/not-sunny par cellule.

**Observation physique** : le seul paramètre qui influence l'ombre (pour un mesh bâtiments + terrain + végétation figé par `modelHash`) est la position du soleil `(azimut, altitude)`. La date n'est qu'un proxy utilisé pour calculer cette position via `SunCalc.getPosition(utcDate, lat, lon)`.

**Conséquence** : deux dates différentes qui produisent la même `(az, alt)` au même lieu ont exactement le même masque d'ombrage. Le cache actuel les stocke séparément.

## Pourquoi c'est pertinent maintenant

1. **Reuse multi-années gratuit** (voir discussion du 2026-04-17) : entre deux années consécutives sur la même date calendaire, la position du soleil varie de ~0.1-0.2° (dérive du cycle bissextile). Avec un cache keyé par angle, 2026-04-15 12:00 et 2027-04-15 12:00 sont le même bucket → zéro re-précompute entre années.
2. **Déduplication intra-saison** : à Lausanne 46.5°N, sur un an à 15min de sample, il y a ~21900 couples `(az, alt)` dans le cache, mais seulement ~1500-2000 buckets uniques à 1° de résolution. Dédup ~10-15×.
3. **Agnostic aux fuseaux horaires / DST** : la position solaire ne dépend pas du fuseau. Le cache actuel doit gérer `timezone` et `localTime` partout — simplification architecturale.
4. **Précompute coût constant** : aujourd'hui, précomputer 200 jours = 200× le coût d'un jour. Avec `(az, alt)`, précomputer "toutes les positions visitées dans une année" = un coût fini, valable pour toutes les dates passées/futures.

## Proposition

### Structure de cache

Par tuile, un seul **atlas** sparse :

```
data/cache/sunlight/{region}/{modelHash}/g{grid}/angles/{tileId}.atlas.bin.gz
```

L'atlas contient :
- Header : magic, version, nombre de buckets, grille de résolution
- Index : tableau `(az_bucket, alt_bucket) → offset` (ou map triée)
- Données : pour chaque bucket, les 5 masques (`sunMask`, `sunMaskNoVeg`, `terrainBlocked`, `buildingsBlocked`, `vegetationBlocked`) bit-packed

Format bit-pack et taille mask identiques au format binaire tuile actuel (ADR-0011). Seul le keying change.

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

#### Reco révisée

**1° est largement acceptable** :
- 0.57% de divergence au niveau bit
- À comparer avec la divergence **Vulkan vs gpu-raster** documentée dans ADR-0011 : **1.2-1.3% sur sunMask final**
- Le bucketing à 1° introduit **deux fois moins d'erreur que le choix de backend lui-même**. Architecturalement c'est du bruit.

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

## Étapes d'implémentation (si retenu)

1. **Design format atlas** : header + index + bit-packed data, extension `.atlas.bin.gz`
2. **Atlas writer** : `encodeTileAtlasToBinary(buckets: Map<BucketKey, FrameMasks>)` 
3. **Atlas reader** : `decodeTileAtlasFromBinary(raw)` + `lookupShadowByAngle`
4. **Bucket enumeration** : script qui génère la liste des buckets à précomputer pour une région donnée (dense ou empirique selon config)
5. **Précompute route** : nouvelle commande `pnpm precompute:atlas --region=lausanne --resolution=adaptive`, réutilise le backend Vulkan avec angles directs
6. **Runtime wiring** : fallback dans `loadPrecomputedSunlightTileBinary` — si l'atlas existe pour la tuile, utiliser l'atlas ; sinon utiliser l'ancien cache date-keyed
7. **Migration optionnelle** : script qui relit les caches date-keyed existants et les convertit en atlas (attention : c'est juste un re-keying, pas une re-compute)
8. **Tests** : bench divergence atlas vs date-keyed sur 3-5 tuiles, mesurer l'erreur au niveau bit (attendu <1% sauf près de l'horizon)
9. **Déprécation** : une fois l'atlas stable, arrêter d'écrire le cache date-keyed et supprimer les anciens fichiers (regain disque énorme)

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
