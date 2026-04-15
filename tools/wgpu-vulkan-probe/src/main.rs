use std::borrow::Cow;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

const SHADOW_WORKGROUP_SIZE: u32 = 256;
// 64 (mat4x4f) + 16 (resolution/bias/point_count/has_horizon)
// + 16 (azimuth/altitude/_pad/_pad)
// + 32 (has_vegetation/num_veg_tiles/step/max_distance/min_clearance/nodata/origin_x/origin_y)
// = 128 bytes
const SHADOW_PARAMS_SIZE: u64 = 128;
const SHADOW_BIAS: f32 = 0.0002;
const HORIZON_BINS: u32 = 360;
// Size of each VegetationTileMeta struct in the storage buffer (8 × 4 bytes).
const VEG_TILE_META_SIZE: u64 = 32;
const DEFAULT_POINT_COUNT: u32 = 32_186;

#[derive(Debug)]
struct Config {
    mode: Mode,
    iterations: u32,
    triangles: u32,
    resolution: u32,
    point_count: Option<u32>,
    azimuth_deg: f32,
    azimuth_step_deg: f32,
    altitude_deg: f32,
    mesh_bin: Option<PathBuf>,
    points_bin: Option<PathBuf>,
    focus_bounds: Option<FocusBounds>,
}

#[derive(Clone, Copy, Debug)]
struct MeshBounds {
    min_x: f32,
    max_x: f32,
    min_y: f32,
    max_y: f32,
    min_z: f32,
    max_z: f32,
}

#[derive(Clone, Copy, Debug)]
struct FocusBounds {
    min_x: f32,
    min_z: f32,
    max_x: f32,
    max_z: f32,
    max_building_height: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Adapter,
    Render,
    Server,
    Shadow,
}

fn main() -> ExitCode {
    match Config::parse().and_then(|config| pollster::block_on(run(config))) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("[wgpu-vulkan-probe] fatal: {error}");
            ExitCode::FAILURE
        }
    }
}

impl Config {
    fn parse() -> Result<Self, String> {
        let mut config = Config {
            mode: Mode::Adapter,
            iterations: 50,
            triangles: 100_000,
            resolution: 2048,
            point_count: None,
            azimuth_deg: 180.0,
            azimuth_step_deg: 0.0,
            altitude_deg: 20.0,
            mesh_bin: None,
            points_bin: None,
            focus_bounds: None,
        };
        let mut focus_bounds_values: Option<[f32; 4]> = None;
        let mut focus_max_building_height = 100.0;

        for arg in std::env::args().skip(1) {
            if arg == "--help" || arg == "-h" {
                println!(
                    "Usage: wgpu-vulkan-probe [--mode=adapter|render|shadow|server] [--iterations=N] [--triangles=N] [--resolution=N] [--points=N] [--azimuth-deg=N] [--azimuth-step-deg=N] [--altitude-deg=N] [--mesh-bin=PATH] [--points-bin=PATH] [--focus-bounds=minX,minZ,maxX,maxZ] [--focus-max-height=N]"
                );
                std::process::exit(0);
            }

            let Some((key, value)) = arg.split_once('=') else {
                return Err(format!("Unsupported argument: {arg}"));
            };

            match key {
                "--mode" => {
                    config.mode = match value {
                        "adapter" => Mode::Adapter,
                        "render" => Mode::Render,
                        "server" => Mode::Server,
                        "shadow" => Mode::Shadow,
                        _ => return Err(format!("Unsupported mode: {value}")),
                    };
                }
                "--iterations" => config.iterations = parse_u32(key, value, 1)?,
                "--triangles" => config.triangles = parse_u32(key, value, 1)?,
                "--resolution" => config.resolution = parse_u32(key, value, 1)?,
                "--points" => config.point_count = Some(parse_u32(key, value, 1)?),
                "--azimuth-deg" => config.azimuth_deg = parse_f32(key, value)?,
                "--azimuth-step-deg" => config.azimuth_step_deg = parse_f32(key, value)?,
                "--altitude-deg" => config.altitude_deg = parse_f32(key, value)?,
                "--mesh-bin" => config.mesh_bin = Some(PathBuf::from(value)),
                "--points-bin" => config.points_bin = Some(PathBuf::from(value)),
                "--focus-bounds" => focus_bounds_values = Some(parse_f32_tuple4(key, value)?),
                "--focus-max-height" => focus_max_building_height = parse_f32(key, value)?,
                _ => return Err(format!("Unsupported argument: {arg}")),
            }
        }

        config.focus_bounds = focus_bounds_values.map(|[min_x, min_z, max_x, max_z]| FocusBounds {
            min_x,
            min_z,
            max_x,
            max_z,
            max_building_height: focus_max_building_height,
        });

        Ok(config)
    }
}

fn parse_u32(key: &str, value: &str, min: u32) -> Result<u32, String> {
    let parsed = value
        .parse::<u32>()
        .map_err(|error| format!("{key} must be a positive integer, got {value}: {error}"))?;
    if parsed < min {
        return Err(format!("{key} must be >= {min}, got {parsed}"));
    }
    Ok(parsed)
}

fn parse_f32(key: &str, value: &str) -> Result<f32, String> {
    let parsed = value
        .parse::<f32>()
        .map_err(|error| format!("{key} must be a finite number, got {value}: {error}"))?;
    if !parsed.is_finite() {
        return Err(format!("{key} must be finite, got {parsed}"));
    }
    Ok(parsed)
}

fn parse_f32_tuple4(key: &str, value: &str) -> Result<[f32; 4], String> {
    let parts = value
        .split(',')
        .map(|part| parse_f32(key, part.trim()))
        .collect::<Result<Vec<_>, _>>()?;
    let [a, b, c, d]: [f32; 4] = parts
        .try_into()
        .map_err(|parts: Vec<f32>| format!("{key} must contain 4 numbers, got {}", parts.len()))?;
    Ok([a, b, c, d])
}

async fn run(config: Config) -> Result<(), String> {
    eprintln!(
        "[wgpu-vulkan-probe] start os={} arch={} rust={} mode={:?} iterations={} triangles={} resolution={} points={} azimuth_deg={} azimuth_step_deg={} altitude_deg={} mesh_bin={} points_bin={} focus_bounds={}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        option_env!("RUSTC_VERSION").unwrap_or("unknown"),
        config.mode,
        config.iterations,
        config.triangles,
        config.resolution,
        config
            .point_count
            .map(|value| value.to_string())
            .unwrap_or_else(|| "default/all".to_owned()),
        config.azimuth_deg,
        config.azimuth_step_deg,
        config.altitude_deg,
        config
            .mesh_bin
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "synthetic".to_owned()),
        config
            .points_bin
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "synthetic".to_owned()),
        config
            .focus_bounds
            .map(|focus| focus.format())
            .unwrap_or_else(|| "none".to_owned()),
    );

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });

    let adapters = instance.enumerate_adapters(wgpu::Backends::VULKAN).await;
    eprintln!("[wgpu-vulkan-probe] adapters={}", adapters.len());
    for (index, adapter) in adapters.iter().enumerate() {
        let info = adapter.get_info();
        eprintln!(
            "[wgpu-vulkan-probe] adapter[{index}] backend={:?} type={:?} vendor=0x{:04x} device=0x{:04x} name={} driver={} driver_info={}",
            info.backend,
            info.device_type,
            info.vendor,
            info.device,
            info.name,
            info.driver,
            info.driver_info,
        );
    }

    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        })
        .await
        .map_err(|error| format!("No Vulkan adapter: {error:?}"))?;

    let info = adapter.get_info();
    eprintln!(
        "[wgpu-vulkan-probe] selected backend={:?} type={:?} vendor=0x{:04x} device=0x{:04x} name={} driver={} driver_info={}",
        info.backend,
        info.device_type,
        info.vendor,
        info.device,
        info.name,
        info.driver,
        info.driver_info,
    );

    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .map_err(|error| format!("request_device failed: {error:?}"))?;

    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-storage"),
        size: 1024,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&buffer, 0, &[1, 2, 3, 4]);
    drop(buffer);

    eprintln!("[wgpu-vulkan-probe] device-create-buffer-ok");

    match config.mode {
        Mode::Adapter => {}
        Mode::Render | Mode::Shadow => {
            run_depth_render_probe(
                &device,
                &queue,
                config.iterations,
                config.triangles,
                config.resolution,
                config.azimuth_deg,
                config.azimuth_step_deg,
                config.altitude_deg,
                config.mesh_bin.as_deref(),
                config.points_bin.as_deref(),
                config.mode == Mode::Shadow,
                config.point_count,
                config.focus_bounds,
            )?;
        }
        Mode::Server => {
            run_shadow_server(&device, &queue, &config)?;
        }
    }

    drop(queue);
    drop(device);

    Ok(())
}

fn run_depth_render_probe(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    iterations: u32,
    triangles: u32,
    resolution: u32,
    azimuth_deg: f32,
    azimuth_step_deg: f32,
    altitude_deg: f32,
    mesh_bin: Option<&Path>,
    points_bin: Option<&Path>,
    run_shadow_compute: bool,
    point_count: Option<u32>,
    focus_bounds: Option<FocusBounds>,
) -> Result<(), String> {
    let probe_label = if run_shadow_compute {
        "depth-shadow"
    } else {
        "depth-render"
    };
    eprintln!("[wgpu-vulkan-probe] {probe_label}-setup-start");

    let engine = DepthShadowEngine::create(DepthShadowEngineConfig {
        device,
        queue,
        triangles,
        resolution,
        mesh_bin,
        points_bin,
        run_shadow_compute,
        point_count,
        focus_bounds,
    })?;

    eprintln!(
        "[wgpu-vulkan-probe] {probe_label}-setup-ok source={} vertex_count={} triangle_count={} depth={}x{} vertex_bytes={} raw_bounds={} points={}",
        engine.vertex_source,
        engine.vertex_count,
        engine.triangle_count(),
        engine.resolution,
        engine.resolution,
        engine.vertex_bytes,
        engine.raw_bounds.format(),
        engine.point_count().unwrap_or(0),
    );

    let mut elapsed_ms = Vec::with_capacity(iterations as usize);
    let mut last_blocked_count = None;
    for iteration in 1..=iterations {
        let iteration_azimuth = azimuth_deg + (iteration - 1) as f32 * azimuth_step_deg;
        let result = engine.evaluate(device, queue, iteration_azimuth, altitude_deg, iteration)?;
        let elapsed = result.elapsed_ms;
        elapsed_ms.push(elapsed);
        last_blocked_count = result.blocked_count;
        match result.blocked_count {
            Some(blocked) => eprintln!(
                "[wgpu-vulkan-probe] {probe_label} iteration={iteration}/{iterations} elapsed_ms={elapsed:.2} blocked_points={blocked}/{}",
                engine.point_count().unwrap_or(0)
            ),
            None => eprintln!(
                "[wgpu-vulkan-probe] {probe_label} iteration={iteration}/{iterations} elapsed_ms={elapsed:.2}"
            ),
        }
    }

    elapsed_ms.sort_by(f64::total_cmp);
    let median = elapsed_ms[elapsed_ms.len() / 2];
    let max = elapsed_ms[elapsed_ms.len() - 1];
    match last_blocked_count {
        Some(blocked) => eprintln!(
            "[wgpu-vulkan-probe] {probe_label}-ok iterations={iterations} median_ms={median:.2} max_ms={max:.2} last_blocked_points={blocked}/{}",
            engine.point_count().unwrap_or(0)
        ),
        None => eprintln!(
            "[wgpu-vulkan-probe] {probe_label}-ok iterations={iterations} median_ms={median:.2} max_ms={max:.2}"
        ),
    }

    Ok(())
}

#[derive(Debug, serde::Deserialize)]
struct ServerRequest {
    #[serde(default)]
    id: Option<serde_json::Value>,
    #[serde(default, alias = "type")]
    command: String,
    #[serde(default, alias = "azimuthDeg")]
    azimuth_deg: Option<f32>,
    #[serde(default, alias = "altitudeDeg")]
    altitude_deg: Option<f32>,
    #[serde(default, alias = "includeMask")]
    include_mask: bool,
    // reload_points / reload_mesh paths (absolute file paths written by Node)
    #[serde(default, alias = "pointsBin")]
    points_bin: Option<String>,
    #[serde(default, alias = "meshBin")]
    mesh_bin: Option<String>,
    // reload_focus fields
    #[serde(default, alias = "minX")]
    min_x: Option<f32>,
    #[serde(default, alias = "minZ")]
    min_z: Option<f32>,
    #[serde(default, alias = "maxX")]
    max_x: Option<f32>,
    #[serde(default, alias = "maxZ")]
    max_z: Option<f32>,
    #[serde(default, alias = "maxBuildingHeight")]
    max_building_height: Option<f32>,
    // upload_horizon_masks: two file paths (masks = f32[], indices = u32[])
    #[serde(default, alias = "horizonMasksBin")]
    horizon_masks_bin: Option<String>,
    #[serde(default, alias = "horizonIndicesBin")]
    horizon_indices_bin: Option<String>,
    // upload_vegetation_rasters: meta + data paths + march params
    #[serde(default, alias = "vegMetaBin")]
    veg_meta_bin: Option<String>,
    #[serde(default, alias = "vegDataBin")]
    veg_data_bin: Option<String>,
    #[serde(default, alias = "vegNodata")]
    veg_nodata: Option<f32>,
    #[serde(default, alias = "vegStepMeters")]
    veg_step_meters: Option<f32>,
    #[serde(default, alias = "vegMaxDistanceMeters")]
    veg_max_distance_meters: Option<f32>,
    #[serde(default, alias = "vegMinClearance")]
    veg_min_clearance: Option<f32>,
    #[serde(default, alias = "originX")]
    origin_x: Option<f32>,
    #[serde(default, alias = "originY")]
    origin_y: Option<f32>,
}

fn run_shadow_server(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    config: &Config,
) -> Result<(), String> {
    eprintln!("[wgpu-vulkan-probe] server-setup-start");
    let mut engine = DepthShadowEngine::create(DepthShadowEngineConfig {
        device,
        queue,
        triangles: config.triangles,
        resolution: config.resolution,
        mesh_bin: config.mesh_bin.as_deref(),
        points_bin: config.points_bin.as_deref(),
        run_shadow_compute: true,
        point_count: config.point_count,
        focus_bounds: config.focus_bounds,
    })?;

    write_server_message(serde_json::json!({
        "type": "ready",
        "backend": "wgpu-vulkan",
        "resolution": engine.resolution,
        "vertexCount": engine.vertex_count,
        "triangleCount": engine.triangle_count(),
        "pointCount": engine.point_count().unwrap_or(0),
        "mesh": engine.vertex_source,
        "rawBounds": engine.raw_bounds.format(),
        "focusBounds": engine.focus_bounds.map(|focus| focus.format()),
    }))?;

    eprintln!(
        "[wgpu-vulkan-probe] server-ready triangle_count={} point_count={}",
        engine.triangle_count(),
        engine.point_count().unwrap_or(0)
    );

    let stdin = io::stdin();
    let mut sequence = 0_u32;
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("stdin read failed: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }

        let request = match serde_json::from_str::<ServerRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                write_server_message(serde_json::json!({
                    "type": "error",
                    "message": format!("invalid JSON request: {error}"),
                }))?;
                continue;
            }
        };
        let id = request.id.clone();

        match request.command.as_str() {
            "evaluate" => {
                sequence += 1;
                let azimuth_deg = match request.azimuth_deg {
                    Some(value) => value,
                    None => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": "evaluate requires azimuthDeg/azimuth_deg",
                        }))?;
                        continue;
                    }
                };
                let altitude_deg = match request.altitude_deg {
                    Some(value) => value,
                    None => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": "evaluate requires altitudeDeg/altitude_deg",
                        }))?;
                        continue;
                    }
                };
                let result = engine.evaluate(device, queue, azimuth_deg, altitude_deg, sequence)?;
                write_server_message(serde_json::json!({
                    "type": "result",
                    "id": id,
                    "sequence": sequence,
                    "azimuthDeg": azimuth_deg,
                    "altitudeDeg": altitude_deg,
                    "elapsedMs": round2(result.elapsed_ms),
                    "blockedPoints": result.blocked_count.unwrap_or(0),
                    "blockedWords": if request.include_mask { result.blocked_words } else { None },
                    "terrainBlockedPoints": result.terrain_blocked_count,
                    "terrainBlockedWords": if request.include_mask { result.terrain_blocked_words } else { None },
                    "vegetationBlockedPoints": result.vegetation_blocked_count,
                    "vegetationBlockedWords": if request.include_mask { result.vegetation_blocked_words } else { None },
                    "pointCount": engine.point_count().unwrap_or(0),
                }))?;
            }
            "reload_points" => {
                let path = match request.points_bin.as_deref() {
                    Some(p) => PathBuf::from(p),
                    None => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": "reload_points requires pointsBin/points_bin",
                        }))?;
                        continue;
                    }
                };
                let started = Instant::now();
                match engine.reload_points(device, queue, &path) {
                    Ok(new_count) => {
                        write_server_message(serde_json::json!({
                            "type": "reloaded_points",
                            "id": id,
                            "pointCount": new_count,
                            "elapsedMs": round2(started.elapsed().as_secs_f64() * 1000.0),
                        }))?;
                    }
                    Err(error) => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": format!("reload_points failed: {error}"),
                        }))?;
                    }
                }
            }
            "reload_focus" => {
                let focus = match (
                    request.min_x,
                    request.min_z,
                    request.max_x,
                    request.max_z,
                    request.max_building_height,
                ) {
                    (Some(mx), Some(mz), Some(xx), Some(xz), Some(mh)) => FocusBounds {
                        min_x: mx,
                        min_z: mz,
                        max_x: xx,
                        max_z: xz,
                        max_building_height: mh,
                    },
                    _ => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": "reload_focus requires minX, minZ, maxX, maxZ, maxBuildingHeight",
                        }))?;
                        continue;
                    }
                };
                engine.reload_focus(focus);
                write_server_message(serde_json::json!({
                    "type": "reloaded_focus",
                    "id": id,
                    "focusBounds": focus.format(),
                }))?;
            }
            "reload_mesh" => {
                let path = match request.mesh_bin.as_deref() {
                    Some(p) => PathBuf::from(p),
                    None => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": "reload_mesh requires meshBin/mesh_bin",
                        }))?;
                        continue;
                    }
                };
                let started = Instant::now();
                match engine.reload_mesh(device, queue, &path) {
                    Ok(new_triangle_count) => {
                        write_server_message(serde_json::json!({
                            "type": "reloaded_mesh",
                            "id": id,
                            "triangleCount": new_triangle_count,
                            "rawBounds": engine.raw_bounds.format(),
                            "elapsedMs": round2(started.elapsed().as_secs_f64() * 1000.0),
                        }))?;
                    }
                    Err(error) => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": format!("reload_mesh failed: {error}"),
                        }))?;
                    }
                }
            }
            "upload_horizon_masks" => {
                let masks_path = match request.horizon_masks_bin.as_deref() {
                    Some(p) => PathBuf::from(p),
                    None => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": "upload_horizon_masks requires horizonMasksBin",
                        }))?;
                        continue;
                    }
                };
                let indices_path = match request.horizon_indices_bin.as_deref() {
                    Some(p) => PathBuf::from(p),
                    None => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": "upload_horizon_masks requires horizonIndicesBin",
                        }))?;
                        continue;
                    }
                };
                let started = Instant::now();
                match engine.upload_horizon_masks(device, queue, &masks_path, &indices_path) {
                    Ok((mask_count, point_count)) => {
                        write_server_message(serde_json::json!({
                            "type": "uploaded_horizon_masks",
                            "id": id,
                            "maskCount": mask_count,
                            "pointCount": point_count,
                            "elapsedMs": round2(started.elapsed().as_secs_f64() * 1000.0),
                        }))?;
                    }
                    Err(error) => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": format!("upload_horizon_masks failed: {error}"),
                        }))?;
                    }
                }
            }
            "upload_vegetation_rasters" => {
                let meta_path = match request.veg_meta_bin.as_deref() {
                    Some(p) => PathBuf::from(p),
                    None => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": "upload_vegetation_rasters requires vegMetaBin",
                        }))?;
                        continue;
                    }
                };
                let data_path = match request.veg_data_bin.as_deref() {
                    Some(p) => PathBuf::from(p),
                    None => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": "upload_vegetation_rasters requires vegDataBin",
                        }))?;
                        continue;
                    }
                };
                let nodata = request.veg_nodata.unwrap_or(f32::NAN);
                let step = request.veg_step_meters.unwrap_or(2.0);
                let max_d = request.veg_max_distance_meters.unwrap_or(120.0);
                let min_clear = request.veg_min_clearance.unwrap_or(4.0);
                let ox = request.origin_x.unwrap_or(0.0);
                let oy = request.origin_y.unwrap_or(0.0);
                let started = Instant::now();
                match engine.upload_vegetation_rasters(
                    device, queue, &meta_path, &data_path, nodata, step, max_d, min_clear, ox, oy,
                ) {
                    Ok((tile_count, data_bytes)) => {
                        write_server_message(serde_json::json!({
                            "type": "uploaded_vegetation_rasters",
                            "id": id,
                            "tileCount": tile_count,
                            "dataBytes": data_bytes,
                            "elapsedMs": round2(started.elapsed().as_secs_f64() * 1000.0),
                        }))?;
                    }
                    Err(error) => {
                        write_server_message(serde_json::json!({
                            "type": "error",
                            "id": id,
                            "message": format!("upload_vegetation_rasters failed: {error}"),
                        }))?;
                    }
                }
            }
            "ping" => {
                write_server_message(serde_json::json!({
                    "type": "pong",
                    "id": id,
                    "sequence": sequence,
                }))?;
            }
            "shutdown" => {
                write_server_message(serde_json::json!({
                    "type": "shutdown",
                    "id": id,
                    "sequence": sequence,
                }))?;
                break;
            }
            _ => {
                write_server_message(serde_json::json!({
                    "type": "error",
                    "id": id,
                    "message": format!("unsupported command: {}", request.command),
                }))?;
            }
        }
    }

    eprintln!("[wgpu-vulkan-probe] server-exit");
    Ok(())
}

fn write_server_message(message: serde_json::Value) -> Result<(), String> {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    serde_json::to_writer(&mut handle, &message)
        .map_err(|error| format!("failed to write JSON response: {error}"))?;
    writeln!(handle).map_err(|error| format!("failed to write response newline: {error}"))?;
    handle
        .flush()
        .map_err(|error| format!("failed to flush JSON response: {error}"))?;
    Ok(())
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

struct DepthShadowEngineConfig<'a> {
    device: &'a wgpu::Device,
    queue: &'a wgpu::Queue,
    triangles: u32,
    resolution: u32,
    mesh_bin: Option<&'a Path>,
    points_bin: Option<&'a Path>,
    run_shadow_compute: bool,
    point_count: Option<u32>,
    focus_bounds: Option<FocusBounds>,
}

struct DepthShadowEngine {
    vertex_buffer: wgpu::Buffer,
    vertex_count: u32,
    vertex_source: String,
    vertex_bytes: usize,
    _depth_texture: wgpu::Texture,
    depth_view: wgpu::TextureView,
    render_uniform_buffer: wgpu::Buffer,
    render_bind_group: wgpu::BindGroup,
    render_pipeline: wgpu::RenderPipeline,
    shadow_compute: Option<ShadowComputeResources>,
    raw_bounds: MeshBounds,
    focus_bounds: Option<FocusBounds>,
    resolution: u32,
}

struct DepthShadowEvaluation {
    elapsed_ms: f64,
    blocked_count: Option<u32>,
    blocked_words: Option<Vec<u32>>,
    // Filled only when horizon masks have been uploaded.
    terrain_blocked_count: Option<u32>,
    terrain_blocked_words: Option<Vec<u32>>,
    // Filled only when vegetation rasters have been uploaded.
    vegetation_blocked_count: Option<u32>,
    vegetation_blocked_words: Option<Vec<u32>>,
}

impl DepthShadowEngine {
    fn create(config: DepthShadowEngineConfig<'_>) -> Result<Self, String> {
        let (vertices, vertex_source, raw_bounds) =
            load_vertices(config.triangles, config.mesh_bin)?;
        let vertex_bytes = bytemuck::cast_slice(&vertices);
        let vertex_count = (vertices.len() / 3) as u32;
        let vertex_buffer = config.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wgpu-vulkan-probe-vertices"),
            size: vertex_bytes.len() as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        config.queue.write_buffer(&vertex_buffer, 0, vertex_bytes);
        config.queue.submit([]);

        let depth_texture = config.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("wgpu-vulkan-probe-depth"),
            size: wgpu::Extent3d {
                width: config.resolution,
                height: config.resolution,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let depth_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let shader = config
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("wgpu-vulkan-probe-depth-shader"),
                source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(
                    r#"
struct U {
    light_mvp: mat4x4f,
};

struct VertexOut {
    @builtin(position) position: vec4f,
};

@group(0) @binding(0) var<uniform> u: U;

@vertex
fn vs(@location(0) position: vec3f) -> VertexOut {
    var out: VertexOut;
    out.position = u.light_mvp * vec4f(position, 1.0);
    return out;
}
"#,
                )),
            });

        let render_uniform_buffer = config.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wgpu-vulkan-probe-light-mvp"),
            size: 64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group_layout =
            config
                .device
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("wgpu-vulkan-probe-bgl"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                });
        let render_bind_group = config.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("wgpu-vulkan-probe-bg"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: render_uniform_buffer.as_entire_binding(),
            }],
        });
        let pipeline_layout =
            config
                .device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("wgpu-vulkan-probe-pipeline-layout"),
                    bind_group_layouts: &[Some(&bind_group_layout)],
                    immediate_size: 0,
                });

        let attributes = [wgpu::VertexAttribute {
            format: wgpu::VertexFormat::Float32x3,
            offset: 0,
            shader_location: 0,
        }];
        let buffers = [wgpu::VertexBufferLayout {
            array_stride: 12,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &attributes,
        }];
        let render_pipeline =
            config
                .device
                .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("wgpu-vulkan-probe-depth-pipeline"),
                    layout: Some(&pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some("vs"),
                        compilation_options: wgpu::PipelineCompilationOptions::default(),
                        buffers: &buffers,
                    },
                    primitive: wgpu::PrimitiveState {
                        topology: wgpu::PrimitiveTopology::TriangleList,
                        cull_mode: None,
                        ..wgpu::PrimitiveState::default()
                    },
                    depth_stencil: Some(wgpu::DepthStencilState {
                        format: wgpu::TextureFormat::Depth32Float,
                        depth_write_enabled: Some(true),
                        depth_compare: Some(wgpu::CompareFunction::Less),
                        stencil: wgpu::StencilState::default(),
                        bias: wgpu::DepthBiasState::default(),
                    }),
                    multisample: wgpu::MultisampleState::default(),
                    fragment: None,
                    multiview_mask: None,
                    cache: None,
                });

        let shadow_compute = if config.run_shadow_compute {
            Some(create_shadow_compute_resources(
                config.device,
                config.queue,
                &depth_view,
                raw_bounds,
                config.resolution,
                config.point_count,
                config.points_bin,
            )?)
        } else {
            None
        };

        Ok(Self {
            vertex_buffer,
            vertex_count,
            vertex_source,
            vertex_bytes: vertex_bytes.len(),
            _depth_texture: depth_texture,
            depth_view,
            render_uniform_buffer,
            render_bind_group,
            render_pipeline,
            shadow_compute,
            raw_bounds,
            focus_bounds: config.focus_bounds,
            resolution: config.resolution,
        })
    }

    fn evaluate(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        azimuth_deg: f32,
        altitude_deg: f32,
        sequence: u32,
    ) -> Result<DepthShadowEvaluation, String> {
        let light_mvp = compute_light_mvp(
            self.raw_bounds,
            self.focus_bounds,
            azimuth_deg,
            altitude_deg,
        );
        queue.write_buffer(
            &self.render_uniform_buffer,
            0,
            bytemuck::cast_slice(&light_mvp),
        );
        if let Some(shadow) = &self.shadow_compute {
            let shadow_params = encode_shadow_params(
                light_mvp,
                self.resolution,
                shadow.point_count,
                SHADOW_BIAS,
                shadow.has_horizon,
                azimuth_deg,
                altitude_deg,
                shadow.has_vegetation,
                shadow.num_veg_tiles,
                shadow.veg_step_meters,
                shadow.veg_max_distance_meters,
                shadow.veg_min_clearance,
                shadow.veg_nodata,
                shadow.origin_x,
                shadow.origin_y,
            );
            queue.write_buffer(&shadow.params_buffer, 0, &shadow_params);
        }

        let started_at = Instant::now();
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("wgpu-vulkan-probe-shadow-encoder"),
        });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("wgpu-vulkan-probe-depth-pass"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            render_pass.set_pipeline(&self.render_pipeline);
            render_pass.set_bind_group(0, &self.render_bind_group, &[]);
            render_pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
            render_pass.draw(0..self.vertex_count, 0..1);
        }

        if let Some(shadow) = &self.shadow_compute {
            encoder.clear_buffer(&shadow.result_buffer, 0, Some(shadow.result_copy_size));
            encoder.clear_buffer(
                &shadow.terrain_result_buffer,
                0,
                Some(shadow.result_copy_size),
            );
            encoder.clear_buffer(
                &shadow.veg_result_buffer,
                0,
                Some(shadow.result_copy_size),
            );

            {
                let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("wgpu-vulkan-probe-shadow-compute-pass"),
                    timestamp_writes: None,
                });
                compute_pass.set_pipeline(&shadow.pipeline);
                compute_pass.set_bind_group(0, &shadow.bind_group, &[]);
                compute_pass.dispatch_workgroups(shadow.workgroup_count, 1, 1);
            }

            encoder.copy_buffer_to_buffer(
                &shadow.result_buffer,
                0,
                &shadow.readback_buffer,
                0,
                shadow.result_copy_size,
            );
            if shadow.has_horizon {
                encoder.copy_buffer_to_buffer(
                    &shadow.terrain_result_buffer,
                    0,
                    &shadow.terrain_readback_buffer,
                    0,
                    shadow.result_copy_size,
                );
            }
            if shadow.has_vegetation {
                encoder.copy_buffer_to_buffer(
                    &shadow.veg_result_buffer,
                    0,
                    &shadow.veg_readback_buffer,
                    0,
                    shadow.result_copy_size,
                );
            }
        }

        let submission = queue.submit([encoder.finish()]);
        device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: Some(Duration::from_secs(30)),
            })
            .map_err(|error| format!("device poll failed at evaluation {sequence}: {error:?}"))?;

        let (
            blocked_count,
            blocked_words,
            terrain_blocked_count,
            terrain_blocked_words,
            vegetation_blocked_count,
            vegetation_blocked_words,
        ) = if let Some(shadow) = &self.shadow_compute {
            let readback = read_shadow_results(device, shadow, sequence)?;
            let (terrain_count, terrain_words) = if shadow.has_horizon {
                let terrain = read_terrain_results(device, shadow, sequence)?;
                (Some(terrain.blocked_count), Some(terrain.words))
            } else {
                (None, None)
            };
            let (veg_count, veg_words) = if shadow.has_vegetation {
                let veg = read_bitmask_buffer(
                    device,
                    &shadow.veg_readback_buffer,
                    shadow.result_copy_size,
                    shadow.result_word_count,
                    sequence,
                    "vegetation",
                )?;
                (Some(veg.blocked_count), Some(veg.words))
            } else {
                (None, None)
            };
            (
                Some(readback.blocked_count),
                Some(readback.words),
                terrain_count,
                terrain_words,
                veg_count,
                veg_words,
            )
        } else {
            (None, None, None, None, None, None)
        };

        Ok(DepthShadowEvaluation {
            elapsed_ms: started_at.elapsed().as_secs_f64() * 1000.0,
            blocked_count,
            blocked_words,
            terrain_blocked_count,
            terrain_blocked_words,
            vegetation_blocked_count,
            vegetation_blocked_words,
        })
    }

    fn triangle_count(&self) -> u32 {
        self.vertex_count / 3
    }

    fn point_count(&self) -> Option<u32> {
        self.shadow_compute
            .as_ref()
            .map(|shadow| shadow.point_count)
    }

    /// Replace the focus bounds used for light MVP projection.
    /// Cheap: no GPU resource change.
    fn reload_focus(&mut self, focus: FocusBounds) {
        self.focus_bounds = Some(focus);
    }

    /// Replace the points used by the shadow-compute pass.
    /// Recreates only the shadow-compute resources; mesh, render pipeline
    /// and depth texture are untouched.
    fn reload_points(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        points_bin: &Path,
    ) -> Result<u32, String> {
        let compute = create_shadow_compute_resources(
            device,
            queue,
            &self.depth_view,
            self.raw_bounds,
            self.resolution,
            None,
            Some(points_bin),
        )?;
        let new_count = compute.point_count;
        self.shadow_compute = Some(compute);
        Ok(new_count)
    }

    /// Replace the horizon masks used by the terrain-blocked check in the
    /// compute shader. After this call, evaluate() will produce both the
    /// buildings bitmask (as before) and a terrain-blocked bitmask.
    ///
    /// `masks_bin` is a raw Float32 blob of (mask_count × 360) values.
    /// `indices_bin` is a raw Uint32 blob of (point_count) mask indices,
    /// one per outdoor point in the same order as the points buffer.
    fn upload_horizon_masks(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        masks_bin: &Path,
        indices_bin: &Path,
    ) -> Result<(u32, u32), String> {
        let shadow = self
            .shadow_compute
            .as_mut()
            .ok_or_else(|| "upload_horizon_masks: no active shadow compute".to_string())?;

        // Read mask file
        let masks_bytes = std::fs::read(masks_bin)
            .map_err(|e| format!("failed to read horizon masks {}: {e}", masks_bin.display()))?;
        if masks_bytes.is_empty() || masks_bytes.len() % (HORIZON_BINS as usize * 4) != 0 {
            return Err(format!(
                "horizon masks file must be mask_count × {} × 4 bytes, got {} for {}",
                HORIZON_BINS,
                masks_bytes.len(),
                masks_bin.display(),
            ));
        }
        let mask_count = (masks_bytes.len() / (HORIZON_BINS as usize * 4)) as u32;

        // Read indices file
        let indices_bytes = std::fs::read(indices_bin).map_err(|e| {
            format!("failed to read horizon indices {}: {e}", indices_bin.display())
        })?;
        if indices_bytes.len() % 4 != 0 {
            return Err(format!(
                "horizon indices file must be u32-aligned, got {} for {}",
                indices_bytes.len(),
                indices_bin.display(),
            ));
        }
        let indices_count = (indices_bytes.len() / 4) as u32;
        if indices_count != shadow.point_count {
            return Err(format!(
                "horizon indices count {} does not match point count {}",
                indices_count, shadow.point_count,
            ));
        }

        // Recreate the masks + indices storage buffers at the right size
        // and upload the data.
        let masks_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wgpu-vulkan-probe-horizon-masks"),
            size: masks_bytes.len() as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&masks_buffer, 0, &masks_bytes);

        let indices_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wgpu-vulkan-probe-horizon-indices"),
            size: indices_bytes.len() as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&indices_buffer, 0, &indices_bytes);

        // Rebuild the bind group with the new buffers.
        let new_bind_group = build_compute_bind_group(
            device,
            &shadow.bind_group_layout,
            &shadow.params_buffer,
            &shadow.depth_view_ref,
            &shadow.points_buffer,
            &shadow.result_buffer,
            &masks_buffer,
            &indices_buffer,
            &shadow.terrain_result_buffer,
            &shadow.veg_tiles_meta_buffer,
            &shadow.veg_data_buffer,
            &shadow.veg_result_buffer,
        );

        shadow.horizon_masks_buffer = masks_buffer;
        shadow.horizon_indices_buffer = indices_buffer;
        shadow.bind_group = new_bind_group;
        shadow.has_horizon = true;
        Ok((mask_count, indices_count))
    }

    /// Replace the vegetation rasters used by the shader ray-march. The
    /// masks + indices horizon state is preserved.
    ///
    /// - `meta_bin`: packed (tile_count × 32 bytes) VegTileMeta blob.
    ///   Each tile header = (minX, minY, maxX, maxY, width, height,
    ///   data_offset_in_floats, _pad).
    /// - `data_bin`: concatenated rasters as f32 (a single flat storage
    ///   buffer; tile_i rows = width*height floats starting at data_offset).
    /// - `nodata`: value treated as no-data (common across all tiles).
    /// - `step_meters` / `max_distance_meters` / `min_clearance`: matches
    ///   the DEFAULT_* values of createVegetationShadowEvaluator().
    /// - `origin_x` / `origin_y`: LV95 offset used by the points buffer
    ///   (the shader converts point.x/z back to LV95 space for the march).
    #[allow(clippy::too_many_arguments)]
    fn upload_vegetation_rasters(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        meta_bin: &Path,
        data_bin: &Path,
        nodata: f32,
        step_meters: f32,
        max_distance_meters: f32,
        min_clearance: f32,
        origin_x: f32,
        origin_y: f32,
    ) -> Result<(u32, u64), String> {
        let shadow = self
            .shadow_compute
            .as_mut()
            .ok_or_else(|| "upload_vegetation_rasters: no active shadow compute".to_string())?;

        let meta_bytes = std::fs::read(meta_bin)
            .map_err(|e| format!("failed to read veg meta {}: {e}", meta_bin.display()))?;
        if meta_bytes.is_empty() || meta_bytes.len() % (VEG_TILE_META_SIZE as usize) != 0 {
            return Err(format!(
                "veg meta file must be a multiple of {} bytes, got {} for {}",
                VEG_TILE_META_SIZE,
                meta_bytes.len(),
                meta_bin.display(),
            ));
        }
        let tile_count = (meta_bytes.len() / VEG_TILE_META_SIZE as usize) as u32;

        let data_bytes = std::fs::read(data_bin)
            .map_err(|e| format!("failed to read veg data {}: {e}", data_bin.display()))?;
        if data_bytes.len() % 4 != 0 {
            return Err(format!(
                "veg data file must be f32-aligned, got {} for {}",
                data_bytes.len(),
                data_bin.display(),
            ));
        }
        let data_bytes_len = data_bytes.len() as u64;

        let meta_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wgpu-vulkan-probe-veg-tiles-meta"),
            size: meta_bytes.len() as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&meta_buffer, 0, &meta_bytes);

        let data_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wgpu-vulkan-probe-veg-data"),
            size: data_bytes.len() as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&data_buffer, 0, &data_bytes);

        let new_bind_group = build_compute_bind_group(
            device,
            &shadow.bind_group_layout,
            &shadow.params_buffer,
            &shadow.depth_view_ref,
            &shadow.points_buffer,
            &shadow.result_buffer,
            &shadow.horizon_masks_buffer,
            &shadow.horizon_indices_buffer,
            &shadow.terrain_result_buffer,
            &meta_buffer,
            &data_buffer,
            &shadow.veg_result_buffer,
        );

        shadow.veg_tiles_meta_buffer = meta_buffer;
        shadow.veg_data_buffer = data_buffer;
        shadow.bind_group = new_bind_group;
        shadow.has_vegetation = true;
        shadow.num_veg_tiles = tile_count;
        shadow.veg_nodata = nodata;
        shadow.veg_step_meters = step_meters;
        shadow.veg_max_distance_meters = max_distance_meters;
        shadow.veg_min_clearance = min_clearance;
        shadow.origin_x = origin_x;
        shadow.origin_y = origin_y;
        Ok((tile_count, data_bytes_len))
    }

    /// Replace the mesh (buildings geometry) used for shadow-map rendering.
    /// Recreates the vertex buffer and updates raw_bounds. Render pipeline
    /// stays the same (layout unchanged). Shadow-compute resources are also
    /// untouched (they reference depth_view, not the mesh).
    fn reload_mesh(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        mesh_bin: &Path,
    ) -> Result<u32, String> {
        let (vertices, vertex_source, raw_bounds) = load_vertices(0, Some(mesh_bin))?;
        let vertex_bytes = bytemuck::cast_slice(&vertices);
        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wgpu-vulkan-probe-vertices"),
            size: vertex_bytes.len() as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&vertex_buffer, 0, vertex_bytes);
        queue.submit([]);
        self.vertex_buffer = vertex_buffer;
        self.vertex_count = (vertices.len() / 3) as u32;
        self.vertex_source = vertex_source;
        self.vertex_bytes = vertex_bytes.len();
        self.raw_bounds = raw_bounds;
        Ok(self.vertex_count / 3)
    }
}

struct ShadowComputeResources {
    params_buffer: wgpu::Buffer,
    result_buffer: wgpu::Buffer,
    readback_buffer: wgpu::Buffer,
    // Terrain (horizon-based) blocked bitmask output.
    terrain_result_buffer: wgpu::Buffer,
    terrain_readback_buffer: wgpu::Buffer,
    // Horizon storage inputs. Dummy (4 bytes each) when no horizon has been
    // uploaded yet; the shader skips the horizon check in that case via
    // params.has_horizon == 0.
    horizon_masks_buffer: wgpu::Buffer,
    horizon_indices_buffer: wgpu::Buffer,
    has_horizon: bool,
    // Vegetation ray-march inputs. Dummy until upload_vegetation_rasters.
    veg_tiles_meta_buffer: wgpu::Buffer,
    veg_data_buffer: wgpu::Buffer,
    veg_result_buffer: wgpu::Buffer,
    veg_readback_buffer: wgpu::Buffer,
    has_vegetation: bool,
    num_veg_tiles: u32,
    veg_nodata: f32,
    veg_step_meters: f32,
    veg_max_distance_meters: f32,
    veg_min_clearance: f32,
    origin_x: f32,
    origin_y: f32,
    points_buffer: wgpu::Buffer,
    depth_view_ref: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
    bind_group_layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
    point_count: u32,
    result_word_count: u32,
    result_copy_size: u64,
    workgroup_count: u32,
}

struct ShadowReadback {
    blocked_count: u32,
    words: Vec<u32>,
}

fn create_shadow_compute_resources(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    depth_view: &wgpu::TextureView,
    raw_bounds: MeshBounds,
    resolution: u32,
    point_count: Option<u32>,
    points_bin: Option<&Path>,
) -> Result<ShadowComputeResources, String> {
    let (points, points_source) = load_query_points(raw_bounds, point_count, points_bin)?;
    let point_count = (points.len() / 4) as u32;
    let point_bytes = bytemuck::cast_slice(&points);
    let points_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-shadow-points"),
        size: point_bytes.len() as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&points_buffer, 0, point_bytes);

    let params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-shadow-params"),
        size: SHADOW_PARAMS_SIZE,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let result_word_count = (point_count + 31) / 32;
    let result_payload_size = u64::from(result_word_count) * 4;
    let result_copy_size = align_to(result_payload_size.max(4), 256);
    let result_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-shadow-results"),
        size: result_copy_size,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let readback_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-shadow-readback"),
        size: result_copy_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    // Terrain bitmask (same layout as buildings).
    let terrain_result_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-terrain-results"),
        size: result_copy_size,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let terrain_readback_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-terrain-readback"),
        size: result_copy_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    // Dummy horizon buffers (replaced by upload_horizon_masks).
    let horizon_masks_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-horizon-masks-dummy"),
        size: 16, // minimal, must be >= binding size min
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let horizon_indices_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-horizon-indices-dummy"),
        size: 16,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    // Dummy vegetation buffers (replaced by upload_vegetation_rasters).
    let veg_tiles_meta_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-veg-tiles-meta-dummy"),
        size: 32, // at least one VegTileMeta struct
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let veg_data_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-veg-data-dummy"),
        size: 16,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let veg_result_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-veg-results"),
        size: result_copy_size,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let veg_readback_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wgpu-vulkan-probe-veg-readback"),
        size: result_copy_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("wgpu-vulkan-probe-shadow-compute-shader"),
        source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(
            r#"
struct ShadowParams {
    light_mvp: mat4x4f,
    resolution: f32,
    bias: f32,
    point_count: u32,
    has_horizon: u32,
    azimuth_deg: f32,
    altitude_deg: f32,
    _pad0: f32,
    _pad1: f32,
    has_vegetation: u32,
    num_veg_tiles: u32,
    veg_step_meters: f32,
    veg_max_distance_meters: f32,
    veg_min_clearance: f32,
    veg_nodata: f32,
    origin_x: f32,
    origin_y: f32,
};

struct VegTileMeta {
    min_x: f32,
    min_y: f32,
    max_x: f32,
    max_y: f32,
    width: u32,
    height: u32,
    data_offset: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> params: ShadowParams;
@group(0) @binding(1) var shadow_map: texture_depth_2d;
@group(0) @binding(2) var<storage, read> points: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> results: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> horizon_masks: array<f32>;
@group(0) @binding(5) var<storage, read> point_mask_indices: array<u32>;
@group(0) @binding(6) var<storage, read_write> terrain_results: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read> veg_tiles_meta: array<VegTileMeta>;
@group(0) @binding(8) var<storage, read> veg_data: array<f32>;
@group(0) @binding(9) var<storage, read_write> vegetation_results: array<atomic<u32>>;

fn sample_veg_elevation(sx: f32, sy: f32) -> f32 {
    // Linear scan — in practice only 2-10 tiles are loaded per region,
    // so the cost is bounded. Returns -1e6 when no tile covers (sx,sy)
    // or when the sample is nodata.
    for (var i = 0u; i < params.num_veg_tiles; i = i + 1u) {
        let tm = veg_tiles_meta[i];
        if (sx < tm.min_x || sx > tm.max_x || sy < tm.min_y || sy > tm.max_y) {
            continue;
        }
        let u = (sx - tm.min_x) / (tm.max_x - tm.min_x);
        let v = (tm.max_y - sy) / (tm.max_y - tm.min_y);
        let fx = clamp(floor(u * f32(tm.width)), 0.0, f32(tm.width - 1u));
        let fy = clamp(floor(v * f32(tm.height)), 0.0, f32(tm.height - 1u));
        let idx = u32(fy) * tm.width + u32(fx) + tm.data_offset;
        let val = veg_data[idx];
        if (abs(val - params.veg_nodata) < 0.000001) {
            return -1.0e6;
        }
        return val;
    }
    return -1.0e6;
}

@compute @workgroup_size(256)
fn cs(@builtin(global_invocation_id) global_id: vec3u) {
    let point_index = global_id.x;
    if (point_index >= params.point_count) {
        return;
    }

    let word_index = point_index / 32u;
    let bit = 1u << (point_index & 31u);
    let point = points[point_index].xyz;

    // ── Terrain blocked check (horizon mask lookup) ────────────────────
    if (params.has_horizon != 0u) {
        let mask_idx = point_mask_indices[point_index];
        var az = params.azimuth_deg;
        if (az < 0.0) { az = az + 360.0; }
        let az_bin = u32(round(az)) % 360u;
        let horizon_angle = horizon_masks[mask_idx * 360u + az_bin];
        if (params.altitude_deg <= horizon_angle) {
            atomicOr(&terrain_results[word_index], bit);
        }
    }

    // ── Vegetation ray-march (swisssurface3d-raster-step-ray-v1) ──────
    if (params.has_vegetation != 0u && params.altitude_deg > 0.0) {
        let az_rad = params.azimuth_deg * 3.14159265 / 180.0;
        let dir_x = sin(az_rad);
        let dir_y = cos(az_rad);
        let point_x_lv95 = point.x + params.origin_x;
        let point_y_lv95 = point.z + params.origin_y;
        let point_elev = point.y;

        var dist = params.veg_step_meters;
        loop {
            if (dist > params.veg_max_distance_meters) { break; }
            let sx = point_x_lv95 + dir_x * dist;
            let sy = point_y_lv95 + dir_y * dist;
            let surface_elev = sample_veg_elevation(sx, sy);
            if (surface_elev > -1.0e5) {
                let clearance = surface_elev - point_elev;
                if (clearance >= params.veg_min_clearance) {
                    let blocker_angle = atan2(clearance, dist) * 180.0 / 3.14159265;
                    if (params.altitude_deg <= blocker_angle) {
                        atomicOr(&vegetation_results[word_index], bit);
                        break;
                    }
                }
            }
            dist = dist + params.veg_step_meters;
        }
    }

    // ── Buildings shadow-map sampling (unchanged semantics) ────────────
    let clip = params.light_mvp * vec4f(point, 1.0);
    let ndc = clip.xyz / clip.w;
    if (
        ndc.x < -1.0 || ndc.x > 1.0 ||
        ndc.y < -1.0 || ndc.y > 1.0 ||
        ndc.z < 0.0 || ndc.z > 1.0
    ) {
        return;
    }

    let u_coord = (ndc.x * 0.5 + 0.5) * params.resolution;
    let v_coord = (0.5 - ndc.y * 0.5) * params.resolution;
    let px = i32(floor(u_coord));
    let py = i32(floor(v_coord));
    let resolution = i32(params.resolution);

    if (px < 0 || px >= resolution || py < 0 || py >= resolution) {
        return;
    }

    let point_depth = ndc.z;
    let threshold = point_depth - params.bias;

    let px1 = select(max(px - 1, 0), min(px + 1, resolution - 1), (u_coord - f32(px)) >= 0.5);
    let py1 = select(max(py - 1, 0), min(py + 1, resolution - 1), (v_coord - f32(py)) >= 0.5);

    let d00 = textureLoad(shadow_map, vec2i(px, py), 0);
    let d10 = textureLoad(shadow_map, vec2i(px1, py), 0);
    let d01 = textureLoad(shadow_map, vec2i(px, py1), 0);
    let d11 = textureLoad(shadow_map, vec2i(px1, py1), 0);

    if (d00 < threshold || d10 < threshold || d01 < threshold || d11 < threshold) {
        atomicOr(&results[word_index], bit);
    }
}
"#,
        )),
    });

    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("wgpu-vulkan-probe-shadow-compute-bgl"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Depth,
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            // horizon_masks (read)
            wgpu::BindGroupLayoutEntry {
                binding: 4,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            // point_mask_indices (read)
            wgpu::BindGroupLayoutEntry {
                binding: 5,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            // terrain_results (read_write)
            wgpu::BindGroupLayoutEntry {
                binding: 6,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            // veg_tiles_meta (read)
            wgpu::BindGroupLayoutEntry {
                binding: 7,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            // veg_data (read)
            wgpu::BindGroupLayoutEntry {
                binding: 8,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            // vegetation_results (read_write)
            wgpu::BindGroupLayoutEntry {
                binding: 9,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    });
    let bind_group = build_compute_bind_group(
        device,
        &bind_group_layout,
        &params_buffer,
        depth_view,
        &points_buffer,
        &result_buffer,
        &horizon_masks_buffer,
        &horizon_indices_buffer,
        &terrain_result_buffer,
        &veg_tiles_meta_buffer,
        &veg_data_buffer,
        &veg_result_buffer,
    );
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("wgpu-vulkan-probe-shadow-compute-pipeline-layout"),
        bind_group_layouts: &[Some(&bind_group_layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("wgpu-vulkan-probe-shadow-compute-pipeline"),
        layout: Some(&pipeline_layout),
        module: &shader,
        entry_point: Some("cs"),
        compilation_options: wgpu::PipelineCompilationOptions::default(),
        cache: None,
    });

    eprintln!(
        "[wgpu-vulkan-probe] shadow-compute-setup-ok source={points_source} points={point_count} point_bytes={} result_words={result_word_count} result_copy_bytes={result_copy_size} resolution={resolution}",
        point_bytes.len()
    );

    Ok(ShadowComputeResources {
        params_buffer,
        result_buffer,
        readback_buffer,
        terrain_result_buffer,
        terrain_readback_buffer,
        horizon_masks_buffer,
        horizon_indices_buffer,
        has_horizon: false,
        veg_tiles_meta_buffer,
        veg_data_buffer,
        veg_result_buffer,
        veg_readback_buffer,
        has_vegetation: false,
        num_veg_tiles: 0,
        veg_nodata: 0.0,
        veg_step_meters: 2.0,
        veg_max_distance_meters: 120.0,
        veg_min_clearance: 4.0,
        origin_x: 0.0,
        origin_y: 0.0,
        points_buffer,
        depth_view_ref: depth_view.clone(),
        bind_group,
        bind_group_layout,
        pipeline,
        point_count,
        result_word_count,
        result_copy_size,
        workgroup_count: point_count.div_ceil(SHADOW_WORKGROUP_SIZE),
    })
}

#[allow(clippy::too_many_arguments)]
fn build_compute_bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    params: &wgpu::Buffer,
    depth_view: &wgpu::TextureView,
    points: &wgpu::Buffer,
    results: &wgpu::Buffer,
    horizon_masks: &wgpu::Buffer,
    horizon_indices: &wgpu::Buffer,
    terrain_results: &wgpu::Buffer,
    veg_tiles_meta: &wgpu::Buffer,
    veg_data: &wgpu::Buffer,
    vegetation_results: &wgpu::Buffer,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("wgpu-vulkan-probe-shadow-compute-bg"),
        layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(depth_view) },
            wgpu::BindGroupEntry { binding: 2, resource: points.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: results.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: horizon_masks.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: horizon_indices.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: terrain_results.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 7, resource: veg_tiles_meta.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 8, resource: veg_data.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 9, resource: vegetation_results.as_entire_binding() },
        ],
    })
}

#[allow(clippy::too_many_arguments)]
fn encode_shadow_params(
    light_mvp: Mat4,
    resolution: u32,
    point_count: u32,
    bias: f32,
    has_horizon: bool,
    azimuth_deg: f32,
    altitude_deg: f32,
    has_vegetation: bool,
    num_veg_tiles: u32,
    veg_step_meters: f32,
    veg_max_distance_meters: f32,
    veg_min_clearance: f32,
    veg_nodata: f32,
    origin_x: f32,
    origin_y: f32,
) -> [u8; SHADOW_PARAMS_SIZE as usize] {
    let mut bytes = [0; SHADOW_PARAMS_SIZE as usize];
    let mut offset = 0;

    for value in light_mvp {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        offset += 4;
    }
    // resolution, bias
    for value in [resolution as f32, bias] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        offset += 4;
    }
    // point_count, has_horizon
    for value in [point_count, if has_horizon { 1 } else { 0 }] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        offset += 4;
    }
    // azimuth_deg, altitude_deg
    for value in [azimuth_deg, altitude_deg] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        offset += 4;
    }
    // _pad0, _pad1
    for _ in 0..2 {
        bytes[offset..offset + 4].copy_from_slice(&0.0_f32.to_le_bytes());
        offset += 4;
    }
    // has_vegetation, num_veg_tiles
    for value in [if has_vegetation { 1u32 } else { 0 }, num_veg_tiles] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        offset += 4;
    }
    // veg_step_meters, veg_max_distance_meters, veg_min_clearance, veg_nodata
    for value in [
        veg_step_meters,
        veg_max_distance_meters,
        veg_min_clearance,
        veg_nodata,
    ] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        offset += 4;
    }
    // origin_x, origin_y
    for value in [origin_x, origin_y] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        offset += 4;
    }

    bytes
}

fn read_shadow_results(
    device: &wgpu::Device,
    shadow: &ShadowComputeResources,
    iteration: u32,
) -> Result<ShadowReadback, String> {
    read_bitmask_buffer(
        device,
        &shadow.readback_buffer,
        shadow.result_copy_size,
        shadow.result_word_count,
        iteration,
        "buildings",
    )
}

fn read_terrain_results(
    device: &wgpu::Device,
    shadow: &ShadowComputeResources,
    iteration: u32,
) -> Result<ShadowReadback, String> {
    read_bitmask_buffer(
        device,
        &shadow.terrain_readback_buffer,
        shadow.result_copy_size,
        shadow.result_word_count,
        iteration,
        "terrain",
    )
}

fn read_bitmask_buffer(
    device: &wgpu::Device,
    readback_buffer: &wgpu::Buffer,
    copy_size: u64,
    word_count: u32,
    iteration: u32,
    label: &str,
) -> Result<ShadowReadback, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    readback_buffer.map_async(
        wgpu::MapMode::Read,
        0..copy_size,
        move |result| {
            let _ = sender.send(result);
        },
    );
    device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })
        .map_err(|error| {
            format!("device poll for {label} readback failed at iteration {iteration}: {error:?}")
        })?;

    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|error| {
            format!("{label} readback callback timed out at iteration {iteration}: {error}")
        })?
        .map_err(|error| format!("{label} readback map failed at iteration {iteration}: {error:?}"))?;

    let payload_size = u64::from(word_count) * 4;
    let words = {
        let data = readback_buffer.get_mapped_range(0..payload_size);
        data.chunks_exact(4)
            .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect::<Vec<_>>()
    };
    readback_buffer.unmap();
    let blocked_count = words.iter().map(|word| word.count_ones()).sum();

    Ok(ShadowReadback {
        blocked_count,
        words,
    })
}

fn load_vertices(
    triangles: u32,
    mesh_bin: Option<&Path>,
) -> Result<(Vec<f32>, String, MeshBounds), String> {
    match mesh_bin {
        Some(path) => {
            let bytes = std::fs::read(path)
                .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
            if bytes.len() % 12 != 0 {
                return Err(format!(
                    "mesh bin byte length must be a multiple of 12, got {} for {}",
                    bytes.len(),
                    path.display()
                ));
            }
            let vertices = bytes
                .chunks_exact(4)
                .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect::<Vec<_>>();
            let bounds = compute_bounds(&vertices)?;
            Ok((vertices, path.display().to_string(), bounds))
        }
        None => {
            let vertices = make_vertices(triangles);
            let bounds = compute_bounds(&vertices)?;
            Ok((vertices, format!("synthetic-{triangles}-triangles"), bounds))
        }
    }
}

fn load_query_points(
    raw_bounds: MeshBounds,
    point_count: Option<u32>,
    points_bin: Option<&Path>,
) -> Result<(Vec<f32>, String), String> {
    match points_bin {
        Some(path) => {
            let bytes = std::fs::read(path)
                .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
            if bytes.len() % 16 != 0 {
                return Err(format!(
                    "points bin byte length must be a multiple of 16, got {} for {}",
                    bytes.len(),
                    path.display()
                ));
            }
            let total_points = bytes.len() / 16;
            let limit = point_count
                .map_or(total_points, |limit| limit as usize)
                .min(total_points);
            if limit == 0 {
                return Err(format!("points bin contains no points: {}", path.display()));
            }

            let floats = bytes
                .chunks_exact(4)
                .take(limit * 4)
                .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect::<Vec<_>>();
            validate_query_points(&floats, path)?;
            let source = if limit == total_points {
                path.display().to_string()
            } else {
                format!("{} first {limit}/{total_points}", path.display())
            };
            Ok((floats, source))
        }
        None => {
            let count = point_count.unwrap_or(DEFAULT_POINT_COUNT);
            Ok((
                make_query_points(raw_bounds, count),
                format!("synthetic-{count}-points"),
            ))
        }
    }
}

fn validate_query_points(points: &[f32], path: &Path) -> Result<(), String> {
    if points.is_empty() || points.len() % 4 != 0 {
        return Err(format!(
            "points must contain packed vec4<f32> values, got {} floats for {}",
            points.len(),
            path.display()
        ));
    }

    for point in points.chunks_exact(4) {
        if !point.iter().all(|value| value.is_finite()) {
            return Err(format!(
                "non-finite point value in {}: {}, {}, {}, {}",
                path.display(),
                point[0],
                point[1],
                point[2],
                point[3]
            ));
        }
    }

    Ok(())
}

fn compute_bounds(vertices: &[f32]) -> Result<MeshBounds, String> {
    if vertices.is_empty() || vertices.len() % 3 != 0 {
        return Err(format!(
            "vertices must contain packed vec3<f32> values, got {} floats",
            vertices.len()
        ));
    }

    let mut bounds = MeshBounds {
        min_x: f32::INFINITY,
        max_x: f32::NEG_INFINITY,
        min_y: f32::INFINITY,
        max_y: f32::NEG_INFINITY,
        min_z: f32::INFINITY,
        max_z: f32::NEG_INFINITY,
    };

    for vertex in vertices.chunks_exact(3) {
        let [x, y, z] = [vertex[0], vertex[1], vertex[2]];
        if !x.is_finite() || !y.is_finite() || !z.is_finite() {
            return Err(format!("non-finite vertex value: {x}, {y}, {z}"));
        }
        bounds.min_x = bounds.min_x.min(x);
        bounds.max_x = bounds.max_x.max(x);
        bounds.min_y = bounds.min_y.min(y);
        bounds.max_y = bounds.max_y.max(y);
        bounds.min_z = bounds.min_z.min(z);
        bounds.max_z = bounds.max_z.max(z);
    }

    Ok(bounds)
}

impl MeshBounds {
    fn format(self) -> String {
        format!(
            "x[{:.2},{:.2}] y[{:.2},{:.2}] z[{:.2},{:.2}]",
            self.min_x, self.max_x, self.min_y, self.max_y, self.min_z, self.max_z
        )
    }
}

impl FocusBounds {
    fn format(self) -> String {
        format!(
            "x[{:.2},{:.2}] z[{:.2},{:.2}] max_h={:.2}",
            self.min_x, self.max_x, self.min_z, self.max_z, self.max_building_height
        )
    }
}

type Mat4 = [f32; 16];

fn compute_light_mvp(
    scene_bounds: MeshBounds,
    focus_bounds: Option<FocusBounds>,
    azimuth_deg: f32,
    altitude_deg: f32,
) -> Mat4 {
    let az_rad = azimuth_deg.to_radians();
    let alt_rad = altitude_deg.to_radians();
    let sun_dir_x = az_rad.sin() * alt_rad.cos();
    let sun_dir_y = alt_rad.sin();
    let sun_dir_z = az_rad.cos() * alt_rad.cos();
    let bounds = light_frustum_bounds(
        scene_bounds,
        focus_bounds,
        azimuth_deg,
        altitude_deg,
        az_rad,
    );

    let cx = (bounds.min_x + bounds.max_x) * 0.5;
    let cy = (bounds.min_y + bounds.max_y) * 0.5;
    let cz = (bounds.min_z + bounds.max_z) * 0.5;

    let (up_x, up_y, up_z) = if altitude_deg.abs() > 85.0 {
        (0.0, 0.0, -1.0)
    } else {
        (0.0, 1.0, 0.0)
    };

    let focus_radius = ((bounds.max_x - bounds.min_x).powi(2)
        + (bounds.max_y - bounds.min_y).powi(2)
        + (bounds.max_z - bounds.min_z).powi(2))
    .sqrt()
        * 0.5;
    let eye_dist = focus_radius * 3.0;
    let eye_x = cx + sun_dir_x * eye_dist;
    let eye_y = cy + sun_dir_y * eye_dist;
    let eye_z = cz + sun_dir_z * eye_dist;

    let view = mat4_look_at(eye_x, eye_y, eye_z, cx, cy, cz, up_x, up_y, up_z);

    let mut ls_min_x = f32::INFINITY;
    let mut ls_max_x = f32::NEG_INFINITY;
    let mut ls_min_y = f32::INFINITY;
    let mut ls_max_y = f32::NEG_INFINITY;
    let mut ls_min_z = f32::INFINITY;
    let mut ls_max_z = f32::NEG_INFINITY;

    for ix in 0..2 {
        for iy in 0..2 {
            for iz in 0..2 {
                let wx = if ix == 0 { bounds.min_x } else { bounds.max_x };
                let wy = if iy == 0 { bounds.min_y } else { bounds.max_y };
                let wz = if iz == 0 { bounds.min_z } else { bounds.max_z };
                let [lx, ly, lz, lw] = mat4_transform_vec4(view, wx, wy, wz, 1.0);
                let lx = lx / lw;
                let ly = ly / lw;
                let lz = lz / lw;
                ls_min_x = ls_min_x.min(lx);
                ls_max_x = ls_max_x.max(lx);
                ls_min_y = ls_min_y.min(ly);
                ls_max_y = ls_max_y.max(ly);
                ls_min_z = ls_min_z.min(lz);
                ls_max_z = ls_max_z.max(lz);
            }
        }
    }

    let near = -ls_max_z - 1.0;
    let far = -ls_min_z + 1.0;
    let proj = mat4_ortho(ls_min_x, ls_max_x, ls_min_y, ls_max_y, near, far);
    mat4_multiply(proj, view)
}

fn light_frustum_bounds(
    scene_bounds: MeshBounds,
    focus_bounds: Option<FocusBounds>,
    _azimuth_deg: f32,
    altitude_deg: f32,
    az_rad: f32,
) -> MeshBounds {
    let Some(focus) = focus_bounds else {
        return scene_bounds;
    };

    let min_alt_for_extension = altitude_deg.max(2.0);
    let shadow_reach = focus.max_building_height / min_alt_for_extension.to_radians().tan();
    let extension = shadow_reach.min(2500.0);
    let h_sun_x = az_rad.sin();
    let h_sun_z = az_rad.cos();

    let mut min_x = focus.min_x;
    let mut max_x = focus.max_x;
    let mut min_z = focus.min_z;
    let mut max_z = focus.max_z;

    if h_sun_x > 0.0 {
        max_x += extension * h_sun_x;
    } else {
        min_x += extension * h_sun_x;
    }
    if h_sun_z > 0.0 {
        max_z += extension * h_sun_z;
    } else {
        min_z += extension * h_sun_z;
    }

    min_x -= 50.0;
    max_x += 50.0;
    min_z -= 50.0;
    max_z += 50.0;

    MeshBounds {
        min_x: min_x.max(scene_bounds.min_x),
        max_x: max_x.min(scene_bounds.max_x),
        min_y: scene_bounds.min_y,
        max_y: scene_bounds.max_y,
        min_z: min_z.max(scene_bounds.min_z),
        max_z: max_z.min(scene_bounds.max_z),
    }
}

fn mat4_ortho(l: f32, r: f32, b: f32, t: f32, n: f32, f: f32) -> Mat4 {
    let mut m = [0.0; 16];
    m[0] = 2.0 / (r - l);
    m[5] = 2.0 / (t - b);
    // WebGPU uses a 0..1 depth range, unlike OpenGL's -1..1 clip depth.
    m[10] = 1.0 / (n - f);
    m[12] = -(r + l) / (r - l);
    m[13] = -(t + b) / (t - b);
    m[14] = n / (n - f);
    m[15] = 1.0;
    m
}

#[allow(clippy::too_many_arguments)]
fn mat4_look_at(
    eye_x: f32,
    eye_y: f32,
    eye_z: f32,
    cx: f32,
    cy: f32,
    cz: f32,
    up_x: f32,
    up_y: f32,
    up_z: f32,
) -> Mat4 {
    let mut fx = cx - eye_x;
    let mut fy = cy - eye_y;
    let mut fz = cz - eye_z;
    let f_len = (fx * fx + fy * fy + fz * fz).sqrt();
    fx /= f_len;
    fy /= f_len;
    fz /= f_len;

    let mut sx = fy * up_z - fz * up_y;
    let mut sy = fz * up_x - fx * up_z;
    let mut sz = fx * up_y - fy * up_x;
    let s_len = (sx * sx + sy * sy + sz * sz).sqrt();
    sx /= s_len;
    sy /= s_len;
    sz /= s_len;

    let ux = sy * fz - sz * fy;
    let uy = sz * fx - sx * fz;
    let uz = sx * fy - sy * fx;

    let mut m = [0.0; 16];
    m[0] = sx;
    m[1] = ux;
    m[2] = -fx;
    m[4] = sy;
    m[5] = uy;
    m[6] = -fy;
    m[8] = sz;
    m[9] = uz;
    m[10] = -fz;
    m[12] = -(sx * eye_x + sy * eye_y + sz * eye_z);
    m[13] = -(ux * eye_x + uy * eye_y + uz * eye_z);
    m[14] = fx * eye_x + fy * eye_y + fz * eye_z;
    m[15] = 1.0;
    m
}

fn mat4_multiply(a: Mat4, b: Mat4) -> Mat4 {
    let mut out = [0.0; 16];
    for i in 0..4 {
        for j in 0..4 {
            out[j * 4 + i] = a[i] * b[j * 4]
                + a[4 + i] * b[j * 4 + 1]
                + a[8 + i] * b[j * 4 + 2]
                + a[12 + i] * b[j * 4 + 3];
        }
    }
    out
}

fn mat4_transform_vec4(m: Mat4, x: f32, y: f32, z: f32, w: f32) -> [f32; 4] {
    [
        m[0] * x + m[4] * y + m[8] * z + m[12] * w,
        m[1] * x + m[5] * y + m[9] * z + m[13] * w,
        m[2] * x + m[6] * y + m[10] * z + m[14] * w,
        m[3] * x + m[7] * y + m[11] * z + m[15] * w,
    ]
}

fn make_vertices(triangles: u32) -> Vec<f32> {
    let mut vertices = Vec::with_capacity(triangles as usize * 9);
    let columns = (triangles as f64).sqrt().ceil().max(1.0) as u32;
    let step = 1.8 / columns as f32;
    let half = step * 0.42;

    for triangle in 0..triangles {
        let x_index = triangle % columns;
        let y_index = triangle / columns;
        let center_x = -0.9 + (x_index as f32 + 0.5) * step;
        let center_y = -0.9 + (y_index as f32 + 0.5) * step;
        let z = 0.2 + ((triangle % 101) as f32 / 101.0) * 0.7;

        vertices.extend_from_slice(&[
            center_x - half,
            center_y - half,
            z,
            center_x + half,
            center_y - half,
            z,
            center_x,
            center_y + half,
            z,
        ]);
    }

    vertices
}

fn make_query_points(bounds: MeshBounds, point_count: u32) -> Vec<f32> {
    let mut points = Vec::with_capacity(point_count as usize * 4);
    let columns = (point_count as f64).sqrt().ceil().max(1.0) as u32;
    let rows = (point_count + columns - 1) / columns;
    let y = bounds.min_y + (bounds.max_y - bounds.min_y).max(3.0) * 0.15;

    for index in 0..point_count {
        let column = index % columns;
        let row = index / columns;
        let tx = (column as f32 + 0.5) / columns as f32;
        let tz = (row as f32 + 0.5) / rows as f32;
        let x = lerp(bounds.min_x, bounds.max_x, tx);
        let z = lerp(bounds.min_z, bounds.max_z, tz);

        points.extend_from_slice(&[x, y, z, 1.0]);
    }

    points
}

fn lerp(min: f32, max: f32, t: f32) -> f32 {
    min + (max - min) * t
}

fn align_to(value: u64, alignment: u64) -> u64 {
    debug_assert!(alignment.is_power_of_two());
    (value + alignment - 1) & !(alignment - 1)
}
