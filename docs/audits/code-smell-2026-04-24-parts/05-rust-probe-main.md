# Audit `tools/wgpu-vulkan-probe/src/main.rs` (3570 lignes)

## Sections

| Plage | Rôle |
|---|---|
| 19-167 | Argv parsing, `Mode` enum, `Config` struct |
| 212-342 | IPC server setup, `run()`, dispatch |
| 344-423 | `run_depth_render_probe` |
| 425-950 | IPC protocol + `run_shadow_server` boucle stdin/stdout |
| 554-930 | Server handlers (evaluate, reload_*, upload_*, evaluate_batch) |
| 979-1023 | `DepthShadowEngine` struct |
| 1027-1200 | Vulkan setup (instance/device/buffers/pipelines) |
| **1063-1080** | **Shader WGSL #1 : Depth Render (vertex, 17L)** |
| 1436-1792 | Batch evaluation (multi-frame GPU) |
| 1814-2120 | Reload handlers (points, horizon, vegetation, terrain) |
| 2161-2370 | `ShadowComputeResources` + bind group builder |
| **2372-2646** | **Shader WGSL #2 : Shadow Compute (274L, 14 bindings)** |
| 2219-3151 | GPU readback + `map_and_split_batch` |
| 3153-3228 | Vertex/points loaders |
| 3308-3567 | Math primitives (Mat4, MVP) |

## Modes (4)

- `Adapter` (315) — noop après init GPU
- `Render` (316) — depth pass only
- `Shadow` (316) — depth pass + compute (fusionné avec Render via flag `run_shadow_compute`)
- `Server` (333) — IPC stdin/stdout, 6 commandes

**Render et Shadow fusionnés** : un seul flag bool, pas de séparation logique. `Option<ShadowComputeResources>` reste `None` si !run_shadow_compute.

## Shaders WGSL

### Shader #1 (1063-1080) — Depth Render
- Vertex shader 17L
- 1 binding (group 0/0 : `light_mvp: mat4x4f`)
- Trivial, pas de copy-paste

### Shader #2 (2372-2646) — Shadow Compute
- 274 lignes, workgroup 256
- Structs : `ShadowParams` (44B), `VegTileMeta` (32B), `TerrainTileMeta` (32B)
- **14 bindings** (group 0, 0-13) :
  - 0 uniform params, 1 depth texture, 2 points,
  - 3 buildings_results, 4 horizon_masks, 5 point_mask_indices,
  - 6 terrain_results, 7 veg_tiles_meta, 8 veg_data, 9 vegetation_results,
  - 10 sunny_results, 11 sunny_no_veg_results, 12 terrain_tiles_meta, 13 terrain_data
- Functions : `sample_terrain_elevation` (18L) + `sample_veg_elevation` (34L) — **copy-paste identique** (boucle, bounds, uv, clamping, nodata) ; WGSL ne supporte pas macro/templates → DRY impossible
- `cs()` compute entrypoint : 140L

### Hash coherence
- Pas de hash explicit côté Rust ; les buffers sont uploadés tels quels
- TS calcule un hash pour dedup, Rust fait confiance
- **Risque** : silent data mismatch si TS/Rust divergent sur encoding

## Buffer management

~15 buffers persistants par engine + N éphémères par batch. RAII gère deallocation correctement.

**1 scénario de leak partiel** : `upload_horizon_masks` (1887-1925) crée buffers + bind group puis update engine. Si `create_bind_group()` panique entre les deux, **anciens buffers + nouveaux orphelins** (engine struct pas mis à jour).

## Error handling

- **Aucun panic / expect / unsafe** ✓
- Pattern `Result<T, String>` cohérent (no custom error type)
- 30+ `?` propagation, 20+ `map_err(format!)` avec contexte
- IPC errors retournés en JSON, process continue ✓

**Soft anti-pattern NaN silencieux** (760-817) :
```rust
nodata: get_optional_f32().unwrap_or(f32::NAN)
```
NaN propagé au shader → `abs(val - tm.nodata) < 0.000001` toujours faux → **silently breaks** au lieu d'erreur claire.

## Findings

### CRITICAL

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 1 | **Critical** | 760-817 | `unwrap_or(f32::NAN)` pour nodata → silencieusement casse equality | M |
| 2 | **Critical** | 1756-1776 | Vec<u32> cloné × 4 par frame en batch (≈32 MiB copies / 1000 frames) | M |
| 3 | **Critical** | 1887-1925 | Buffer leak partiel possible si bind_group creation échoue après buffers | S |

### HIGH

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 4 | High | 2447-2501 | Sample functions dupliquées (terrain vs veg, identiques sauf nom) | S (doc) |
| 5 | High | 552 | `request.id.clone()` per-request en boucle server | S |
| 6 | High | 3085-3089 | Cast bytes→u32 sans bounds-check assertion (assume %4==0) | S |
| 7 | High | 1345, 1694 | `device.poll(timeout: 30/60s)` hardcodé, pas adaptatif | M |

### MEDIUM

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 8 | Medium | 1504 | `let _ = i;` suppression unused warning | S |
| 9 | Medium | 536-539 | `trim().is_empty()` continue silently | S |
| 10 | Medium | 1040 | `queue.submit([])` no-explicit-flush sans comment | S |
| 11 | Medium | 2540-2543 | `3.14159265` × 3 au lieu de PI const | S |
| 12 | Medium | 2620-2623 | `textureLoad` × 4 manuelle (PCF/bilinear), pas de comment | S |

### LOW / NITPICK

| ID | Sévérité | Loc | Symptôme | Effort |
|---|---|---|---|---|
| 13 | Low | 1120 | `Some(&bgl)` wrapper unnecessary | S |
| 14 | Low | 3568 | `debug_assert!` sur fonction `align_to()` non utilisée | S |
| 15 | Low | 241 | `format!() + unwrap_or_else + to_owned` triple alloc startup logging | S |

## Candidats d'extraction (modules Rust)

```
src/
  main.rs                 (façade + IPC server loop)
  config.rs               (Config, Mode, argv)
  ipc/
    protocol.rs
    handlers/
      evaluate.rs
      reload_*.rs
      upload_*.rs
      evaluate_batch.rs
  vulkan/
    setup.rs              (negotiate_required_limits, instance/device)
    engine.rs
    buffers.rs
  shaders/
    depth.wgsl            (replace r#"..."#)
    shadow.wgsl
  gpu/
    readback.rs
    math.rs               (Mat4, compute_light_mvp)
  data/
    loaders.rs            (load_vertices, load_query_points)
```

**Priorité** : extraire shaders en `.wgsl` (debugging IDE) > IPC handlers > GPU math.

## Synthèse

| Sévérité | Count |
|---|---|
| Critical | 3 |
| High | 4 |
| Medium | 5 |
| Low | 3 |

15 findings. Code globalement propre (Rust idiomatique, no unsafe, no panics). Principaux gaps : NaN silencieux, clones évitables, copy-paste shader inhérent à WGSL.
