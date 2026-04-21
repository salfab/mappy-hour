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
