# Registre exhaustif des raccourcis délibérés

**But** : tenir à jour la liste complète des choix d'optimisation qui reposent sur une hypothèse implicite. Chaque raccourci = un gain mesurable acheté contre une condition d'invalidité à surveiller.

**Maintenance** : mettre à jour **systématiquement** à chaque nouveau raccourci (nouvelle optim, nouvel ADR, nouveau bench). Cf. CLAUDE.md.

Légende statut : **A** = actif, **R** = reverté, **D** = désactivé conditionnellement.

---

## 1. Approximations géométriques et astronomiques

| # | Raccourci | Gain mesuré | Hypothèse implicite | Condition d'invalidité | Référence | Statut |
|---|---|---|---|---|---|---|
| 1.1 | SunCalc calculé au centre de tuile (1 appel / frame / tuile au lieu de 62500) | ~50-80s / run Lausanne (940M appels évités) | Variation `(az, alt)` sur 250m sub-pixel à 1m | Bâtiments > 100m + grazing < 10°, ou tuiles > 250m, ou grille sub-métrique | ADR-0015, `bench-suncalc-tile-center-precision.ts` | A |
| 1.2 | LV95→WGS84 via algo rigoureux inline (pas proj4) | 6.2× vs proj4, −226 ms/tuile, −41s Lausanne | `h=0` pour la conversion géodésique→géocentrique (OK sol uniquement) | Points à élévation non-nulle passés à `lv95ToWgs84Precise` | ADR-0014, `bench-lv95-3algos.ts` | A |
| 1.3 | Round-trip LV95→WGS84→LV95 supprimé avant upload GPU | Corrige ~11 cm de dérive (perf marginale) | `PreparedOutdoorPoint` porte `lv95Easting/Northing` directs | Nouveau code qui repart de `(lat, lon)` vers le GPU | ADR-0014, `sunlight-tile-service.ts:1055` | A |
| 1.4 | Grille 1m comme résolution plancher | Seuil "sub-pixel" à 500mm sur les masques | Précision cible utilisateur ≥ 1m | Exigence précision < 0.5m (ex. études thermiques fines) | choix historique | A |
| 1.5 | Tuiles 250m × 250m | Valide 1.1, limite la RAM GPU | Variation angulaire solaire sur 250m < résolution masque | Tuiles > 250m (re-valider 1.1) | ADR-0002 | A |
| 1.6 | Ombre "deux niveaux" bâtiments | Skip bâtiments trop bas pour bloquer le soleil | `height_threshold = tan(alt) · distance` | Soleil très bas où tous les bâtiments comptent | ADR-0005 | A |
| 1.7 | Translation **Swisstopo 3-paramètres** (Helmert simplifié) CH1903+ → WGS84 (`DX=674.374, DY=15.056, DZ=405.346`) | Suffisant pour grille 1m | Précision ~1-3m absolue, relative sub-mm | Exigence géoréférencement absolu sub-métrique | `projection.ts:67-70`, commentaire "simplified 3-parameter" | A |
| 1.8 | Arrondi **`lat/lon` à 6 décimales** (~11cm) sur `PrecomputedSunlightPoint` | Réduit taille cache/SSE | Jamais reconverti en `(E, N)` pour usage précis | Si un nouveau code refait `wgs84ToLv95(point.lat, point.lon)` → dérive 11cm (cf. bug corrigé ADR-0014) | `sunlight-cache.ts:542-543`, `grid.ts:33-34` | A |
| 1.9 | Arrondi **`lv95Easting/Northing` à 3 décimales** (1mm) | Compacité | Précision 1mm largement sous la grille 1m | Grille sub-millimétrique (impossible) | `sunlight-cache.ts:544-545` | A |
| 1.10 | Quantification **angles horizon à 3 décimales** (milli-degré ≈ 17 µrad) | Compacité masques, déduplication cache | Erreur angulaire sub-pixel sur grille 1m | Exigence précision angulaire < 0.001° | `buildings-shadow.ts:304,1469`, `dynamic-horizon-mask.ts:49` | A |
| 1.11 | Sun-position quantization optionnelle `MAPPY_SUN_POSITION_ROUND_DEG` | Active les atlas buckets ADR-0013 | Divergence masque acceptable aux résolutions ≥ 0.15° | Atlas avec résolution > 0.5° (trop grossier) | ADR-0013, `sunlight-tile-service.ts:1221` | A (sur atlas) |

## 2. Hot loop précompute

| # | Raccourci | Gain mesuré | Hypothèse implicite | Condition d'invalidité | Référence | Statut |
|---|---|---|---|---|---|---|
| 2.1 | Phase D — batch toutes les frames d'une tuile en un seul dispatch GPU | −60% temps eval vs dispatch par frame | Frames × points tient en GPU memory | Tuiles > 500m ou frames > 200/jour à grille fine | commit `83bbed4`, ADR-0011 | A |
| 2.2 | Phase E — bitmasks sunny/sunnyNoVeg dérivés sur GPU | Pas de read-back intermédiaire | Shader capable de l'opération (Vulkan / WebGPU) | Fallback CPU requis (backend détaillé) | commit `c33e7d5`, ADR-0011 | A |
| 2.3 | Phase F — skip de l'évaluateur végétation CPU quand batch GPU | −8% wall | Backend batch gère végétation GPU-side | Backend sans vegetation GPU (detailed, two-level) | commit `bc1c153`, ADR-0011 | A |
| 2.4 | Niveau 3 — skip de 62500 appels async `buildPointEvaluationContext` | −33% prepare-points, ~27s Lausanne | Méthodes résolues une fois depuis le 1er point outdoor sont valides pour toute la tuile | Méthodes dépendant du point individuel (pas notre cas) | commit `7c9b9eb`, ADR-0011 | A |
| 2.5 | Niveau 4 — mutation in-place + pre-alloc | −68% loop body, −34% wall Lausanne | `rawTilePoints` local à la fonction, pas partagé | Future architecture qui partagerait le buffer | commit `224d460` | A |
| 2.6 | Hot loop unifié inlined (pas d'appel `evaluateInstantSunlight`, pas d'alloc `SunSample`) | −20% wall gpu-raster | Sémantique préservée bit-exact vs canonique | Divergence sémantique vs `evaluateInstantSunlight` | commit `5157a5c`, ADR-0011 | A |
| 2.7 | Niveau 2 — early-return dans `buildPointEvaluationContext` | Tenté, **0 gain** (microtasks await dominaient) | — | — | commit `914e9c0` (revert), ADR-0011 | R |
| 2.8 | Cache horizon partagé par masque unique | 89% hit ratio, ~0s lookup | Masques horizon stables sur tuiles voisines | Régions à relief très chaotique | commit `cache-horizon`, instrumentation 2026-04-20 | A |
| 2.9 | Tri spatial des tuiles avant précompute | 21× speedup | Localité d'accès aux rasters | Ordre imposé par tiers | commit `21x speedup` | A |
| 2.10 | Skip du `buildingShadowEvaluator` CPU quand backend batch (Vulkan / WebGPU) | Gain nul mesuré (closure jamais appelé par le hot loop qui utilise `evaluateBatch*`) | `buildPointEvaluationContext` construit pour précompute uniquement | Endpoints live (`/api/sunlight/instant/stream`) consomment le closure pour per-point eval → renvoyer `undefined` casse la viz bâtiments en mode Vulkan | fix 2026-04-23 (ce commit), reproductible via click sur point à l'ombre : API retourne `buildingsBlocked=true` mais cache atlas dit sunny | R |

## 2bis. Évaluateurs d'ombre — raffinement et portée

| # | Raccourci | Gain mesuré | Hypothèse implicite | Condition d'invalidité | Référence | Statut |
|---|---|---|---|---|---|---|
| 2b.1 | Ray-march végétation — **portée max 120m** (`DEFAULT_MAX_DISTANCE_METERS`) | Circonscrit le bbox de candidats végétation par point | Les arbres au-delà de 120m ne créent d'ombre significative qu'à grazing extrême | Région avec arbres > 120m (impossible en CH) ou exigence de masques au grazing < 5° | `vegetation-shadow.ts:44` | A |
| 2b.2 | Ray-march végétation — **pas 2m** (`DEFAULT_STEP_METERS`) | Divise par 2 le nombre de samples vs pas 1m | Canopées denses > 2m de largeur ne sont jamais franchies sans samples | Troncs fins isolés < 2m de largeur (peut slip-through) | `vegetation-shadow.ts:45` | A |
| 2b.3 | **Clearance minimale 4m** végétation (`DEFAULT_MIN_CLEARANCE_METERS`) | Ignore sous-bois bas | Points < 4m au-dessus du sol pas représentatifs (plutôt sous canopée) | Usages à hauteur 0-4m | `vegetation-shadow.ts:46` | A |
| 2b.4 | Végétation **V1 — clearance = canopy_elev − point_elevation** | Simple, 1 soustraction | Point au sol, pas en altitude (balcon, toit) | Extension aux toits-terrasses, balcons | `vegetation-shadow.ts:469` (commentaire "V1 approximation") | A |
| 2b.5 | Two-level raffinement — **seuil de near 2°** et **max 3 étapes** (`BUILDINGS_TWO_LEVEL_NEAR_THRESHOLD_DEGREES`, `BUILDINGS_TWO_LEVEL_MAX_REFINEMENT_STEPS`) | Raffinement bornée quand le sample est proche du seuil bloqué — **legacy depuis ADR-0010** : chemin CPU prisme→mesh uniquement actif si `MAPPY_BUILDINGS_SHADOW_MODE=two-level`. Les modes production `gpu-raster` et `rust-wgpu-vulkan` consomment les triangles DXF directement, sans étage prisme | Ambiguïté < 2° est raffinée suffisamment en 3 étapes | Bâtiments avec silhouettes très complexes au grazing ; s'applique uniquement au mode two-level CPU (diagnostic/fallback) | `evaluation-context.ts:137-138`, `buildings-shadow.ts:1715`, ADR-0005, ADR-0010 | A (legacy, diagnostic/fallback CPU) |
| 2b.6 | Detailed mode — **max 32 étapes** (`BUILDINGS_DETAILED_MAX_REFINEMENT_STEPS`) | Plafond pour cas pathologiques | 32 étapes suffisent à converger pour silhouettes standard | Scène avec géométrie bâtiment extrême (non observée) | `evaluation-context.ts:139` | A |
| 2b.7 | **Focus margin GPU raster 5km** (`GPU_FOCUS_MARGIN_METERS`) | Backend rechargé par zone ≈ 5km radius (ADR-0008 VBO filtering) | Bâtiments > 5km négligeables à l'échelle grille 1m (pas angulairement mais par distance et grazing) | Vues panoramiques avec skyline lointain (montagne, silhouette urbaine > 5km) | `evaluation-context.ts:145` | A |
| 2b.8 | **Focus margin Vulkan 500m** (`MAPPY_RUST_WGPU_FOCUS_MARGIN_METERS`) | Frustum focus réduit le nombre de triangles uploadés | Ombres portées depuis > 500m hors frustum ignorées (complément du DSM/horizon partagé qui capture les obstacles lointains) | Extension à précompute de bâtiments très hauts dans ville voisine | `evaluation-context.ts:151`, ADR-0011 | A |
| 2b.9 | Horizon partagé — **tolérance 2 min/jour** (`MAX_POINT_MINUTES_MISMATCH_PER_DAY`) et **0.5% points divergents** (`MAX_MISMATCH_POINTS_RATIO`) | Permet de partager le même masque horizon sur macro-cell 2000m × 500m | Divergence statistique ≤ 0.5% × 2min ≈ invisible sur masque annuel | Région avec relief micro-varié (Lavaux, falaises) — fallback automatique sur local | `adaptive-horizon-sharing.ts:18-19`, `docs/architecture/lausanne-horizon-global-vs-tile-benchmark.md` | A |
| 2b.10 | **Footprint spike removal 72%** (`DEFAULT_SPIKE_AREA_RATIO_THRESHOLD`) | Simplifie les géométries de bâtiments avec artefacts — **portée réduite depuis ADR-0010** : le chemin primaire GPU consomme les triangles DXF polyface directement ; le spike removal ne protège plus que (a) l'index de bâtiments à l'ingestion et (b) le fallback `extrudeFootprint` quand le DXF est absent/mal matché | Pics étroits < 72% area ratio = artefact de vectorisation, pas bâti réel | Bâtiments réels à pics fins (antennes, cheminées) ; régions sans DXF swissBUILDINGS3D disponible (le fallback devient primaire) | `building-footprint.ts:11`, `gpu-mesh-loader.ts:267` (fallback), ADR-0010 | A (partiellement obsolète) |
| 2b.11 | Ray-march terrain local — **portée 500m, step 5m, gate altitude < 30°** | Capture les ombres du relief proche (colline cast sur son pied) qui manquaient au horizon mask lointain (> 1km) | Au-delà de 30° le soleil est trop haut pour projeter > 500m d'ombre via relief local ; DEM 30m précision suffisante à step 5m | Régions avec falaises abruptes > 500m de relief à proximité (Lavaux, Jura), grille sub-métrique nécessitant step < 5m | `terrain-shadow.ts`, test `_test-terrain-local-shadow.ts`, fix commit 2026-04-23 | A |
| 2b.12 | **Failfast grid-metadata** (suppression du fallback `approxElevation=500`) | Évite la mis-classification indoor silencieuse (toits < 500m absolu = ~80% de Lausanne invisibles) | Preflight `precompute-tile-grid-metadata` toujours exécuté avant toute régen atlas (inclus dans `precompute:all-regions`) | Appel direct à `computeSunlightTileArtifact` / live API sur tuile jamais précalculée sans preflight → throw explicite demandant de lancer `precompute:grid-metadata` | `evaluation-context.ts:593-620`, commit 2026-04-23 (remplace ancien fallback GPU runtime) | A |

## 3. Cache et I/O

| # | Raccourci | Gain mesuré | Hypothèse implicite | Condition d'invalidité | Référence | Statut |
|---|---|---|---|---|---|---|
| 3.1 | Gzip niveau 1 (au lieu de 6) pour tiles + atlas | Compression ~2× plus rapide, taille +10% | Bande passante réseau + disque plus chère que CPU | Scénario très contraint en stockage | commit `799fd4f` | A |
| 3.2 | Format binaire tile artifact (remplace JSON) | 9.5× faster end-to-end | Endianness little (x86/ARM standard) | Plateforme big-endian (impossible en prod) | commit `binary tile` | A |
| 3.3 | Atlas skip cache in-memory + warm-up parallèle (concurrency=16) | Hoist SunCalc hors boucle par-jour (29k → 96 appels/jour) | Nombre de tuiles tient en RAM | Run multi-régions > ~10k tuiles sans sharding | commit `91fd0cb` | A |
| 3.4 | Atomic atlas writes (temp + rename) + sidecar `.atlas.idx` | Crash consistency, lookup O(1) sur buckets | FS POSIX rename atomique (Windows NTFS OK) | FS sans rename atomique | commit `5ba3fe2` | A |
| 3.5 | Atlas cache clé par position solaire (angle-keyed) | Réutilise masques entre jours à az/alt proches | Résolution de quantification `atlas-resolution-deg` suffisante | Exigence masque instantané non-quantifié | ADR-0013 | A |
| 3.6 | Skip-existing via `readdir` une fois / dossier (pas de gunzip par tuile) | −90% skip check time | Nommage tuiles déterministe | Changement de schéma de nommage | commit `batch skip-existing` | A |

## 4. Architecture / contraintes figées

| # | Raccourci | Gain mesuré | Hypothèse implicite | Condition d'invalidité | Référence | Statut |
|---|---|---|---|---|---|---|
| 4.1 | `MAPPY_PRECOMPUTE_WORKERS=1` verrouillé | Évite le worker pool Node cassé | Un worker suffit grâce à Vulkan + hot loop optimisé | Si goulot CPU réapparaît | ADR-0011 §6 | A |
| 4.2 | Build Rust `release` par défaut | ~10× vs debug | `cargo` disponible dans l'env CI/dev | Env sans toolchain Rust | ADR-0011 §1 | A |
| 4.3 | `MAPPY_VULKAN_FRUSTUM_FOCUS=1` — frustum collé à la tuile | −50% triangles rastérisés | Obstacles hors tuile filtrés avant upload | Ombres portées depuis très loin (montagne proche) | ADR-0011 | A |
| 4.4 | Vulkan IPC stdin/stdout JSON (pas binaire) | Suffisant (~0.58 ms/call, 10% du compute) | IPC pas dominant dans le budget | Si compute GPU devenait << 0.5ms | `vulkan-ipc-overhead-probe.ts` | A |

---

## Comment ajouter un raccourci

1. Implémenter + bencher (créer un script `scripts/diag/bench-*` reproductible).
2. Si l'hypothèse implicite est non-triviale → ADR dédié.
3. **Ajouter une ligne ici** avec tous les champs. Pas de raccourci sans entrée dans ce registre.
4. Dans le message de commit, mentionner `shortcuts-registry.md` pour la traçabilité.

## Comment auditer

- Sur un nouveau déploiement / nouvelle région / changement de résolution de grille : **parcourir la colonne "Condition d'invalidité"** et rebencher ce qui est remis en cause.
- Sur un changement d'algo astronomique ou géométrique : vérifier 1.1 à 1.6.
- Sur un changement de format cache : vérifier 3.1 à 3.6.
