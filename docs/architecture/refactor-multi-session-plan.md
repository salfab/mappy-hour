# Plan refacto multi-session — backend Rust/wgpu Vulkan

**Statut** : Phase 3 complète + validée + benché. Phases 1A–3 commitées. Sweet spot **N=2 depth=3** (60.5 tiles/min, +83 % vs N=2 depth=1). N=3 : failure TOCTOU fixée (2026-05-07) — à re-bencher pour valider 67.5 t/min sans failure.

## Pourquoi

Bench post-Phase-G + bucket-cache (commit `04a45ec`) a clarifié le profil dispatch :

| Phase | Moy / tuile | % dispatch |
|---|---|---|
| lockWait | 360 ms | 33 % |
| ensure | 278 ms | 25 % |
| upload | 220 ms | 20 % |
| serverIpc | 184 ms | 17 % |
| decode | 2 ms | 0 % |

Multi-session attaque le `lockWait` (élimine la sérialisation backend) + permet l'overlap CPU prep / GPU compute entre tuiles. Gain attendu **~20-25 %** wall-time post-fix (estimation revue à la baisse à cause du cache thrashing veg/terrain encore non résolu).

## Architecture cible

Aujourd'hui : un process Rust = un device wgpu = une `DepthShadowEngine` qui contient une `Option<EngineSession>` (1 session sérielle).

Cible :

```
DepthShadowEngine {
  // PROCESS-WIDE
  device, queue, pipelines, render_pipeline, bind_group_layout
  vertex_buffer (mesh)
  raw_bounds, focus_bounds, resolution
  scene: SceneResources           // shared across sessions
  sessions: HashMap<SessionId, EngineSession>
}

SceneResources {
  horizon_masks_buffer, has_horizon
  veg: Option<VegetationScene>    // raster + meta + params
  terrain: Option<TerrainScene>   // raster + meta + params
  origin_x, origin_y
}

EngineSession {
  session_id: SessionId
  points_buffer, params_buffer
  result_buffer + readback (per point_count)
  terrain_result + readback
  veg_result + readback
  sunny_result + readback
  sunny_no_veg_result + readback
  horizon_indices_buffer (1 entry per outdoor point)
  bind_group  (refs session buffers + scene buffers)
  point_count, result_word_count, result_copy_size, workgroup_count
  depth_texture, depth_view  // PER-SESSION for multi-session GPU concurrency
}
```

## Phasage

### Phase 1A — Renaming + comments ✓ commit `53edc87`

- ✓ `ShadowComputeResources` → `EngineSession`
- ✓ `create_shadow_compute_resources` → `create_engine_session`
- ✓ Champs commentés en 3 catégories : PER-SESSION, SCENE-SHARED, PROCESS-WIDE

**Effort** : 30 min. **Gain** : 0. **Bénéfice** : balise architecturale visible dans le code.

### Phase 1B — Extraire `SceneResources`

- Créer struct `SceneResources` avec les champs SCENE-SHARED actuellement dans EngineSession.
- L'attacher à `DepthShadowEngine` au lieu de `EngineSession`.
- Mettre à jour `create_engine_session` : retourne `(SceneResources, EngineSession)` au cold start ; n'a plus besoin de SceneResources sur les reload_points (la scène est préservée naturellement car elle n'est pas recréée).
- Mettre à jour `reload_points` : ne touche que la session, plus du tout aux scene buffers. Élimine le bug "drop veg/terrain à chaque reload_points".
- Mettre à jour les méthodes `upload_horizon_masks` / `upload_vegetation_rasters` / `upload_terrain_rasters` pour muter `self.scene` au lieu de `self.shadow_compute`.
- Mettre à jour les call sites lecteurs (`shadow.has_horizon` → `self.scene.has_horizon`, etc.).

**Effort** : 2-3 heures. **Gain attendu** : ~10-15 % wall-time (élimine les re-uploads veg+terrain bursty observés dans le bench).

**Validation obligatoire** : atlas SHA256 bit-parity sur tuiles bench. Mism% golden tool ≤ 2 %. Tag de baseline avant.

### Phase 1C — Extraire `bind_group_layout` + `pipeline` au niveau `DepthShadowEngine`

- Ces ressources sont process-wide, pas session-wide.
- Bouger les fields hors d'EngineSession.
- Le `bind_group` reste par-session (références aux buffers session+scene).
- Les call sites lecteurs (`shadow.pipeline`, `shadow.bind_group_layout`) → `self.pipeline`, `self.bind_group_layout`.

**Effort** : 1 heure. **Gain** : 0 mais déduplique la création du pipeline si on a N sessions.

### Phase 2A — Multi-session struct (toujours N=1 par défaut)

- Renommer `shadow_compute: Option<EngineSession>` → `sessions: HashMap<SessionId, EngineSession>`.
- Pour conserver la compat single-session, par défaut une seule session id="default".
- Update IPC handlers : `evaluate`, `evaluate_batch`, `reload_points` → prennent un `session_id` optionnel (default to "default" if absent).
- Update Node `RustWgpuVulkanShadowServer` : pas de changement par défaut (utilise session_id="default").

**Effort** : 1-2 jours. **Gain** : 0 (toujours 1 session). Préparation.

**Validation** : atlas bit-parity en mode default.

### Phase 2B — Depth texture par-session

- Aujourd'hui une seule `depth_view` partagée. Pour multi-session, chaque session doit avoir la sienne (sinon les shadow passes se polluent).
- Bouger `depth_texture` + `depth_view` dans `EngineSession`.
- Coût VRAM : 64 MB × N sessions à résolution 4096².

**Effort** : 1 jour. **Gain** : 0. Précondition concurrence.

### Phase 3 — Activation multi-session ✓ commits `862e308` + fixes `2026-05-07`

- Côté Rust : nouvelles commandes IPC `open_session(id, points_bin)` / `close_session(id)`.
- Côté Node : `RustWgpuVulkanShadowBackend` orchestre N sessions. `withBackendLock` devient un sémaphore FIFO par-session.
- `MAPPY_RUST_VULKAN_SESSIONS=N` env var (default = 1, max = 3 sur Intel Arc 8 GB).
- Bench : sweep N=2 depth=1,2,3 validé. N=3 reste instable (failure sporadique non résolue).

**Effort** : 2-3 jours. **Gain mesuré (N=2, lausanne, 8 tuiles)** :

| depth | tiles/min | speedup |
|---|---|---|
| 1 | 33.02 | 1.00× |
| 2 | 56.76 | 1.72× |
| 3 | 60.48 | 1.83× |

Zéro failure à tous les depths. Sweet spot : **N=2 depth=3** (60.5 tiles/min).

**Bench N=3** (2026-05-07) : 55.7 tiles/min + 1 failure sporadique post-fix-FIFO
(`upload_horizon_masks` — condition de course focus×points à 3 sessions). Root cause identifiée et fixée (2026-05-07).
Perf warm mesurée à 67.5 t/min sur run propre.

**Root cause TOCTOU** (2026-05-07) : `uploadHorizonMasksForSlot` vérifie `this.server` alive, puis écrit 2 fichiers avec `await`. Pendant ces awaits, le crash handler d'une autre slot peut tuer le serveur + le relancer via `coldStartServer` avec d'autres points → la session "default" du nouveau serveur a un `point_count` différent. L'appel `upload_horizon_masks` Rust arrive sur le nouveau serveur avec `indices_count ≠ point_count` → failure.

**Fix** : compteur `serverGeneration` incrémenté à chaque cold start. Capturé au début de `uploadHorizonMasksForSlot`, re-vérifié après les deux file writes. Si changé → sentinel `STALE_SERVER_RESTART` → retry unique depuis `ensureSlot` dans `evaluateBatchFramesWithShadowsOnSlot`.

**Fixes correctifs 2026-05-07** :
- Cold start race : `serverStartPromise` mutex (assignation synchrone avant tout await)
- Promise.race spurious multi-fire : remplacé par sémaphore FIFO (`slotAvailable[]` + `slotWaiters`)
- Rust `engine.point_count()` retournait toujours la session `"default"` : corrigé en `sessions.get(sid).map(|s| s.point_count)` dans les handlers `evaluate` et `evaluate_batch`

**Validation 2026-05-06** : check-vulkan-vs-gpuraster (lausanne e2538000_n1152500_s250, 200 pts, 57 frames) :
- Vulkan vs gpu-raster : **0.00%** (bit-parity parfaite)
- Phase E (sunnyMask == !buildingsMask) : **0.00%**
- Full pipeline vs CPU (horizon+veg) : **0.43%** (seuil ≤ 2 %)

### Phase 4 (optionnelle) — Cache multi-entry Node

- `serverHorizonHash`, `serverVegetationHash`, `serverTerrainHash` deviennent des `Set<hash>` au lieu d'une seule entrée.
- Rust de son côté garde les buffers vivants tant qu'au moins une session les utilise (refcount).
- Élimine le thrashing aux transitions de bucket.

**Effort** : 2-3 jours. **Gain** : ~5-10 % additionnel sur multi-session, ou stand-alone.

## Risques

- **Bind group lifetimes** : si une session A est en flight et une session B ferme + recrée son bind_group, attention aux Arc<Buffer>. wgpu gère normalement, mais à valider.
- **Origine partagée** : si 2 sessions sur des zones très éloignées partagent le même `origin_x/origin_y`, les coords flottantes peuvent perdre en précision (~1 cm à 30 km de l'origine). Pas un bug mais à noter.
- **VRAM** : N=3 = 3× les depth textures = 192 MB en plus. Acceptable sur Intel Arc 8 GB.
- **Drift atlas** : la mémoire `project_zenith_shadow_non_deterministic` documente déjà ~3-5 points/tuile qui flippent indoor/outdoor. Multi-session pourrait amplifier marginalement (l'ordre des dispatches GPU change). À surveiller mais le drift est déjà accepté avec recovery Option A+.

## Workflow non-régression OBLIGATOIRE

Avant chaque phase :
1. Tag git `baseline/multi-session-phaseN-YYYY-MM-DD`.
2. Snapshot atlas SHA256 sur 5+ tuiles + mism% golden.
3. Implémenter la phase.
4. Re-bench atlas SHA256 + mism%.
5. Si régression : revert au tag.

Tester en particulier :
- `scripts/diag/check-atlas-vs-cpu-multi.ts` (mism% ≤ 2 %)
- `scripts/diag/check-vulkan-vs-gpuraster.ts` (bit-parity Vulkan vs gpu-raster)
- `scripts/benchmark/precompute-tile-pipeline-depth.ts` (perf gain mesuré)

## Commits liés

- `04a45ec perf(precompute): cache veg/terrain tile lists at 1km focus-bucket grain` (préparation)
- `5922b89 perf(precompute): activate Phase E for GPU-terrain-only path (10x speedup)` (cause d'analyse)
- `b93edea feat(rust-ipc): GPU timestamp microbench` (instrumentation pour mesurer)
- `ea1cc95 feat(rust-ipc): dispatch-wall split instrumentation` (idem)

## Critère d'arrêt

Si après Phase 1B (~3 h) le gain mesuré est < 5 %, considérer le ROI insuffisant et stopper. Le multi-session vaut sa peine seulement si Phase 1B confirme empiriquement le modèle (préservation des buffers VEG/terrain élimine la majorité des re-uploads).
