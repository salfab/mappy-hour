@echo off
REM ============================================================
REM  MappyHour - Resume WebGPU experiment session
REM  Last state: 2026-04-06
REM ============================================================
REM
REM CONTEXT:
REM   Branch: feature/gpu-raster
REM   Le benchmark WebGPU compute shader montre 4.7x speedup (7.7ms vs 29ms)
REM   et 126x dans le vrai pipeline (15 us/eval vs 1900 us/eval).
REM   Le code est propre, sans workarounds, pret pour un GPU non-bugge.
REM
REM INTEL ARC 140V - BUG CONFIRME (driver v32.0.101.8626):
REM   - D3D12: SIGSEGV (0xC0000005) apres ~90ms d'idle GPU avec gros buffers
REM   - Non-deterministe (~50%% des creations de device)
REM   - Dawn ne supporte pas device destroy+recreate dans le meme process
REM   - Keepalive JS impossible (SIGSEGV tue le process depuis thread natif D3D12)
REM   - Vulkan: vulkan-1.dll installee mais le package webgpu@0.4.0 est
REM     compile D3D12-only (pas de backend Vulkan dans le binaire Dawn)
REM
REM CONCLUSION INTEL ARC:
REM   Le WebGPU compute ne peut pas tourner en production sur cette machine.
REM   Le headless-gl (software) reste le mode par defaut.
REM   Le code WebGPU est pret pour un GPU NVIDIA/AMD ou un Intel avec
REM   driver D3D12 non-bugge.
REM
REM ============================================================

echo.
echo === MappyHour WebGPU experiment - status 2026-04-06 ===
echo.
echo Driver: Intel Arc 140V, D3D12 v32.0.101.8626
echo Branch: feature/gpu-raster
echo webgpu npm: 0.4.0 (D3D12-only, pas de Vulkan)
echo.
echo ============================================================
echo  TESTS SUR CETTE MACHINE (Intel Arc - benchmark only)
echo ============================================================
echo.
echo --- Benchmark (fonctionne, pas d'idle) ---
echo MAPPY_BUILDINGS_SHADOW_MODE=webgpu-compute npx tsx scripts/benchmark/webgpu-compute-bench.ts
echo   Attendu: 3.7-4.7x speedup, pas de crash
echo.
echo --- Idle test (CRASHE sur Intel Arc, OK sur NVIDIA/AMD) ---
echo MAPPY_BUILDINGS_SHADOW_MODE=webgpu-compute npx tsx scripts/benchmark/webgpu-idle-test.ts
echo   Intel Arc: segfault apres ~90ms d'idle
echo   NVIDIA/AMD: devrait afficher "Done" sans crash
echo.
echo ============================================================
echo  TESTS SUR GPU NVIDIA/AMD (tout devrait marcher)
echo ============================================================
echo.
echo --- Test 1: Idle 10s ---
echo MAPPY_BUILDINGS_SHADOW_MODE=webgpu-compute npx tsx scripts/benchmark/webgpu-idle-test.ts
echo   Attendu: "Done" sans segfault
echo.
echo --- Test 2: Compute d'une tuile complete ---
echo MAPPY_BUILDINGS_SHADOW_MODE=webgpu-compute npx tsx scripts/benchmark/webgpu-compute-tile-test.ts
echo   Attendu: "Saved to cache" + "exiting cleanly" sans segfault
echo.
echo --- Test 3: Precompute complet (4 tuiles, 1 frame) ---
echo MAPPY_BUILDINGS_SHADOW_MODE=webgpu-compute npx tsx scripts/precompute/precompute-webgpu.ts --region=lausanne --start-date=2026-04-08 --days=1 --grid-step-meters=1 --sample-every-minutes=15 --start-local-time=12:00 --end-local-time=12:15 --bbox=6.633,46.5205,6.634,46.521 --skip-existing=false
echo   Attendu: "completed: 4 computed" sans segfault
echo.
echo --- Test 4: Precompute reel (9 tuiles, 66 frames, 1 jour) ---
echo MAPPY_BUILDINGS_SHADOW_MODE=webgpu-compute npx tsx scripts/precompute/precompute-webgpu.ts --region=lausanne --start-date=2026-04-08 --days=1 --grid-step-meters=1 --sample-every-minutes=15 --start-local-time=06:00 --end-local-time=21:00 --bbox=6.618,46.505,6.645,46.526 --skip-existing=false
echo   Comparer le temps avec le mode headless-gl
echo.
echo ============================================================
echo  FICHIERS CLES
echo ============================================================
echo.
echo   src/lib/sun/webgpu-compute-shadow-backend.ts  -- Backend Dawn + compute shader
echo   src/lib/sun/webgpu-ipc-client.ts              -- Client IPC (subprocess stdin/stdout)
echo   src/lib/sun/webgpu-worker-process.ts          -- Worker GPU (subprocess dedie)
echo   src/lib/sun/evaluation-context.ts             -- Wiring mode webgpu-compute
echo   src/lib/precompute/sunlight-tile-service.ts   -- Batch eval + horizon skip
echo   scripts/benchmark/webgpu-compute-bench.ts     -- Benchmark headless-gl vs WebGPU
echo   scripts/benchmark/webgpu-idle-test.ts         -- Test idle D3D12
echo   scripts/benchmark/webgpu-compute-tile-test.ts -- Test tuile complete + save
echo   scripts/precompute/precompute-webgpu.ts       -- Script precompute single-process
echo.
echo ============================================================
echo  METRIQUES DE REFERENCE (Intel Arc 140V)
echo ============================================================
echo.
echo   headless-gl (software): 29ms/frame, 1900 us/eval
echo   WebGPU (benchmark):     7.7ms/frame, 15 us/eval, 3.7-4.7x plus rapide
echo   99 tuiles x 1 jour:     headless-gl ~3.1 min, WebGPU ~0.8 min
echo.
echo ============================================================
echo  OPTIONS POUR VULKAN SUR CETTE MACHINE
echo ============================================================
echo.
echo   1. Rebuilder Dawn avec -DDAWN_ENABLE_VULKAN=ON (fork webgpu npm)
echo   2. Utiliser wgpu-native (runtime Rust, Vulkan par defaut)
echo   3. Tester avec Deno (WebGPU natif via wgpu)
echo.
