/**
 * Diagnostic en boucle : compare les deux backends GPU (ANGLE/WebGL vs rust-wgpu-vulkan)
 * sur une même tuile, en appelant DIRECTEMENT les classes, sans précompute ni cache.
 *
 * Usage :
 *   npx tsx scripts/diag/check-vulkan-vs-gpuraster.ts \
 *     --tile=e2538000_n1152500_s250 --region=lausanne --date=2026-04-22 \
 *     [--max-points=500] [--top=20]
 *
 * Pipeline :
 *   1. Charge l'ensemble des obstacles bâtiments
 *   2. Filtre spatialement autour de la tuile (marge 5 km — même marge que le precompute)
 *   3. Instancie GpuBuildingShadowBackend (ANGLE) et RustWgpuVulkanShadowBackend
 *      sur EXACTEMENT le même jeu d'obstacles et la même focus zone
 *   4. Charge les points outdoor depuis la grid metadata
 *   5. Pour chaque frame (15 min) de la journée :
 *        - gpu-raster : prepareSunPosition + evaluate par point
 *        - vulkan    : evaluateBatch
 *        - compare les masques
 *   6. Rapport : frames divergentes, points les plus souvent divergents
 */

import SunCalc from "suncalc";

import { loadBuildingsObstacleIndex } from "../../src/lib/sun/buildings-shadow";
import { GpuBuildingShadowBackend } from "../../src/lib/sun/gpu-building-shadow-backend";
import { RustWgpuVulkanShadowBackend } from "../../src/lib/sun/rust-wgpu-vulkan-shadow-backend";
import { loadTileGridMetadata } from "../../src/lib/precompute/tile-grid-metadata";
import { getSunlightModelVersion } from "../../src/lib/precompute/model-version";
import { buildTilePoints, buildRegionTiles } from "../../src/lib/precompute/sunlight-cache";
import type { PrecomputedRegionName } from "../../src/lib/precompute/sunlight-cache";
import {
  buildSharedPointEvaluationSources,
  buildPointEvaluationContext,
} from "../../src/lib/sun/evaluation-context";
import { evaluateInstantSunlight } from "../../src/lib/sun/solar";

const RAD_TO_DEG = 180 / Math.PI;
const TILE_MARGIN_METERS = 5000;

interface Args {
  tileId: string;
  region: PrecomputedRegionName;
  date: string;
  maxPoints: number;
  topDivergentPoints: number;
}

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = { maxPoints: 0, topDivergentPoints: 20 };
  for (const arg of argv) {
    if (arg.startsWith("--tile=")) a.tileId = arg.slice(7);
    else if (arg.startsWith("--region=")) a.region = arg.slice(9) as PrecomputedRegionName;
    else if (arg.startsWith("--date=")) a.date = arg.slice(7);
    else if (arg.startsWith("--max-points=")) a.maxPoints = Number(arg.slice(13));
    else if (arg.startsWith("--top=")) a.topDivergentPoints = Number(arg.slice(6));
  }
  if (!a.tileId) throw new Error("--tile= requis (ex: e2538000_n1152500_s250)");
  if (!a.region) throw new Error("--region= requis (lausanne|morges|nyon|geneve)");
  if (!a.date) throw new Error("--date=YYYY-MM-DD requis");
  return a as Args;
}

function tileBoundsFromId(tileId: string): { minX: number; minY: number; maxX: number; maxY: number; size: number } {
  const match = /^e(\d+)_n(\d+)_s(\d+)$/.exec(tileId);
  if (!match) throw new Error(`Tile id invalide : ${tileId}`);
  const minX = Number(match[1]);
  const minY = Number(match[2]);
  const size = Number(match[3]);
  return { minX, minY, maxX: minX + size, maxY: minY + size, size };
}

function isoWithTz(date: string, time: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  // DST Europe/Zurich 2026 : summer 29 mar → 25 oct
  const isSummer = (m > 3 && m < 10) || (m === 3 && d >= 29) || (m === 10 && d < 25);
  const tz = isSummer ? "+02:00" : "+01:00";
  return `${date}T${time}:00${tz}`;
  void y;
}

function buildFramesForDate(date: string, lat: number, lon: number): Array<{ utc: Date; az: number; alt: number; label: string }> {
  const out: Array<{ utc: Date; az: number; alt: number; label: string }> = [];
  for (let h = 5; h <= 21; h++) {
    for (const min of [0, 15, 30, 45]) {
      const label = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      const utc = new Date(isoWithTz(date, label));
      const p = SunCalc.getPosition(utc, lat, lon);
      const alt = p.altitude * RAD_TO_DEG;
      if (alt <= 0) continue;
      let az = (p.azimuth * RAD_TO_DEG + 180) % 360;
      if (az < 0) az += 360;
      out.push({ utc, az, alt, label });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bounds = tileBoundsFromId(args.tileId);

  console.log(`\n[diag] tuile=${args.tileId} région=${args.region} date=${args.date}`);
  console.log(`[diag] bounds LV95: E=${bounds.minX}..${bounds.maxX} N=${bounds.minY}..${bounds.maxY}`);

  // ─── 1) Charger obstacles + filtrer dans la focus zone ─────────────
  const loadedIndex = await loadBuildingsObstacleIndex();
  if (!loadedIndex) throw new Error("Aucun index d'obstacles bâtiments.");
  const allObstacles = loadedIndex.obstacles;

  const focus = {
    minX: bounds.minX - TILE_MARGIN_METERS,
    minY: bounds.minY - TILE_MARGIN_METERS,
    maxX: bounds.maxX + TILE_MARGIN_METERS,
    maxY: bounds.maxY + TILE_MARGIN_METERS,
  };
  const filteredObstacles = allObstacles.filter(
    (o) => o.maxX > focus.minX && o.minX < focus.maxX && o.maxY > focus.minY && o.minY < focus.maxY,
  );
  console.log(`[diag] obstacles: ${filteredObstacles.length}/${allObstacles.length} dans ${TILE_MARGIN_METERS}m de la tuile`);
  const maxH = filteredObstacles.reduce((m, o) => Math.max(m, o.height), 0);

  // ─── 2) Charger points outdoor via grid metadata ────────────────────
  const modelVersion = await getSunlightModelVersion(args.region, { buildingHeightBiasMeters: 0 });
  const metadata = await loadTileGridMetadata(args.region, modelVersion.gridMetadataHash, 1, args.tileId);
  if (!metadata) throw new Error(`Grid metadata absente pour ${args.region}/${args.tileId} (gridHash=${modelVersion.gridMetadataHash}, atlasHash=${modelVersion.modelVersionHash}).`);

  // Reconstruire les points avec le même buildTilePoints que le precompute
  const regionTiles = buildRegionTiles(args.region, bounds.size);
  const tileSpec = regionTiles.find((t) => t.tileId === args.tileId);
  if (!tileSpec) throw new Error(`Tuile ${args.tileId} introuvable dans buildRegionTiles(${args.region}).`);
  const allPoints = buildTilePoints(tileSpec, 1);
  const outdoorPoints = allPoints.filter((_p, i) => !metadata.indoor[i]);
  console.log(`[diag] points outdoor: ${outdoorPoints.length}/${allPoints.length}`);

  const samplePoints = args.maxPoints > 0 && args.maxPoints < outdoorPoints.length
    ? outdoorPoints.filter((_, i) => i % Math.ceil(outdoorPoints.length / args.maxPoints) === 0).slice(0, args.maxPoints)
    : outdoorPoints;
  console.log(`[diag] points testés: ${samplePoints.length}`);

  const centerLat = samplePoints[Math.floor(samplePoints.length / 2)].lat;
  const centerLon = samplePoints[Math.floor(samplePoints.length / 2)].lon;
  const frames = buildFramesForDate(args.date, centerLat, centerLon);
  console.log(`[diag] frames (solaire > 0°) : ${frames.length}\n`);

  // ─── 3) Instancier les deux backends sur les MÊMES obstacles ────────
  console.log("[diag] création backend gpu-raster (ANGLE)…");
  const raster = await GpuBuildingShadowBackend.createWithDxfMeshes(filteredObstacles, 4096);
  raster.setFrustumFocus({ minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY }, maxH);
  console.log(`[diag] gpu-raster prêt : ${raster.name}, ${raster.triangleCount} triangles`);

  console.log("[diag] création backend rust-wgpu-vulkan…");
  const vulkan = await RustWgpuVulkanShadowBackend.createWithDxfMeshes(filteredObstacles, 4096);
  vulkan.setFrustumFocus({ minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY }, maxH);
  console.log(`[diag] vulkan prêt : ${vulkan.name}, ${vulkan.triangleCount} triangles\n`);

  // ─── 4) Préparer points (2 formats) ──────────────────────────────────
  // Vulkan : Float32Array vec4f centré sur son origin
  const vkOrigin = vulkan.getOrigin();
  const vkPoints = new Float32Array(samplePoints.length * 4);
  for (let i = 0; i < samplePoints.length; i++) {
    const p = samplePoints[i];
    vkPoints[i * 4 + 0] = p.lv95Easting - vkOrigin.x;
    vkPoints[i * 4 + 1] = metadata.elevations[allPoints.indexOf(p)] ?? 0;
    vkPoints[i * 4 + 2] = p.lv95Northing - vkOrigin.y;
    vkPoints[i * 4 + 3] = 0;
  }

  // ─── 5) Boucle frames ──────────────────────────────────────────────
  const divergenceByPoint = new Uint32Array(samplePoints.length);
  let totalMismatch = 0;
  let totalRasterSun = 0;
  let totalVulkanSun = 0;
  const worstFrames: Array<{ label: string; az: number; alt: number; mismatch: number; rasterSun: number; vulkanSun: number }> = [];

  for (const frame of frames) {
    // gpu-raster : per-point evaluate
    raster.prepareSunPosition(frame.az, frame.alt);
    const rasterSunny = new Uint8Array(samplePoints.length);
    for (let i = 0; i < samplePoints.length; i++) {
      const p = samplePoints[i];
      const idx = allPoints.indexOf(p);
      const elev = metadata.elevations[idx] ?? 0;
      const res = raster.evaluate({
        pointX: p.lv95Easting,
        pointY: p.lv95Northing,
        pointElevation: elev,
        solarAzimuthDeg: frame.az,
        solarAltitudeDeg: frame.alt,
      });
      rasterSunny[i] = res.blocked ? 0 : 1;
    }

    // vulkan : batch
    const vkMaskU32 = await vulkan.evaluateBatch(vkPoints, samplePoints.length, frame.az, frame.alt);
    const vulkanSunny = new Uint8Array(samplePoints.length);
    for (let i = 0; i < samplePoints.length; i++) {
      const blocked = (vkMaskU32[i >> 5] & (1 << (i & 31))) !== 0;
      vulkanSunny[i] = blocked ? 0 : 1;
    }

    let mismatch = 0;
    let rsun = 0, vsun = 0;
    for (let i = 0; i < samplePoints.length; i++) {
      if (rasterSunny[i]) rsun++;
      if (vulkanSunny[i]) vsun++;
      if (rasterSunny[i] !== vulkanSunny[i]) {
        mismatch++;
        divergenceByPoint[i]++;
      }
    }
    totalMismatch += mismatch;
    totalRasterSun += rsun;
    totalVulkanSun += vsun;
    worstFrames.push({ label: frame.label, az: frame.az, alt: frame.alt, mismatch, rasterSun: rsun, vulkanSun: vsun });

    const pct = ((mismatch / samplePoints.length) * 100).toFixed(2);
    console.log(
      `  ${frame.label}  az=${frame.az.toFixed(1).padStart(6)}°  alt=${frame.alt.toFixed(1).padStart(5)}°  ` +
      `raster=${String(rsun).padStart(5)}sun  vulkan=${String(vsun).padStart(5)}sun  diff=${String(mismatch).padStart(4)} (${pct}%)`,
    );
  }

  // ─── 6) Agrégats ────────────────────────────────────────────────────
  const totalEvals = frames.length * samplePoints.length;
  console.log(`\n══════ AGRÉGAT ══════`);
  console.log(`  frames:          ${frames.length}`);
  console.log(`  points:          ${samplePoints.length}`);
  console.log(`  évaluations:     ${totalEvals}`);
  console.log(`  mismatch total:  ${totalMismatch} (${((totalMismatch / totalEvals) * 100).toFixed(2)}%)`);
  console.log(`  raster total sun:  ${totalRasterSun}`);
  console.log(`  vulkan total sun:  ${totalVulkanSun}  (Δ=${totalVulkanSun - totalRasterSun})`);

  const topFrames = [...worstFrames].sort((a, b) => b.mismatch - a.mismatch).slice(0, 10);
  console.log(`\n  frames les plus divergentes :`);
  for (const f of topFrames) {
    if (f.mismatch === 0) break;
    console.log(`    ${f.label}  az=${f.az.toFixed(1)}°  alt=${f.alt.toFixed(1)}°  diff=${f.mismatch}`);
  }

  const indexed = Array.from(divergenceByPoint).map((c, i) => ({ i, c }));
  indexed.sort((a, b) => b.c - a.c);
  console.log(`\n  top ${args.topDivergentPoints} points les plus divergents :`);
  for (let k = 0; k < Math.min(args.topDivergentPoints, indexed.length); k++) {
    const { i, c } = indexed[k];
    if (c === 0) break;
    const p = samplePoints[i];
    console.log(
      `    #${String(i).padStart(5)}  LV95(E=${p.lv95Easting.toFixed(1)}, N=${p.lv95Northing.toFixed(1)})  ` +
      `WGS84(${p.lat.toFixed(6)}, ${p.lon.toFixed(6)})  diff=${c}/${frames.length}`,
    );
  }

  // ─── 7) Phase-E path : exercer evaluateBatchFramesWithShadows ──────
  // C'est le chemin que prend le précompute (Phase E fast path) et qui
  // écrit directement le sunnyMask dans l'atlas. Si le shader est correct
  // (prouvé par la section ci-dessus), mais que l'atlas est corrompu,
  // la corruption vient soit du format de retour (sunnyWords vs blockedWords)
  // soit de la recomposition côté serveur.
  //
  // Contrôle : sans horizon ni vegetation, on attend
  //   sunnyMask[i] === !buildingsMask[i]  pour tout i
  console.log(`\n══════ CONTRÔLE PHASE E (evaluateBatchFramesWithShadows sans horizon/veg) ══════`);
  const phaseEFrames = frames.slice(0, Math.min(10, frames.length));
  const phaseEResults = await (vulkan as unknown as {
    evaluateBatchFramesWithShadows: (
      frames: Array<{ azimuthDeg: number; altitudeDeg: number }>,
      points: Float32Array,
      pointCount: number,
    ) => Promise<Array<{
      buildingsMask: Uint32Array;
      sunnyMask: Uint32Array;
      sunnyNoVegMask: Uint32Array;
      sunnyCount: number;
    }>>;
  }).evaluateBatchFramesWithShadows(
    phaseEFrames.map((f) => ({ azimuthDeg: f.az, altitudeDeg: f.alt })),
    vkPoints,
    samplePoints.length,
  );

  let phaseEMismatch = 0;
  let phaseETotal = 0;
  let phaseESunnyCountMismatch = 0;
  for (let k = 0; k < phaseEFrames.length; k++) {
    const f = phaseEFrames[k];
    const r = phaseEResults[k];
    let perFrameMismatch = 0;
    let sunnyCountFromMask = 0;
    for (let i = 0; i < samplePoints.length; i++) {
      const blocked = (r.buildingsMask[i >> 5] & (1 << (i & 31))) !== 0;
      const sunny = (r.sunnyMask[i >> 5] & (1 << (i & 31))) !== 0;
      if (sunny) sunnyCountFromMask++;
      // Expected : sunny === !blocked (pas de horizon ni veg)
      if (sunny === blocked) {
        perFrameMismatch++;
      }
      phaseETotal++;
    }
    phaseEMismatch += perFrameMismatch;
    const expectedSunny = samplePoints.length - countBits(r.buildingsMask, samplePoints.length);
    const sunnyCountDelta = r.sunnyCount - expectedSunny;
    if (sunnyCountDelta !== 0) phaseESunnyCountMismatch++;
    console.log(
      `  ${f.label}  az=${f.az.toFixed(1).padStart(6)}°  alt=${f.alt.toFixed(1).padStart(5)}°  ` +
      `blocked=${countBits(r.buildingsMask, samplePoints.length)}  sunny(mask)=${sunnyCountFromMask}  sunny(count)=${r.sunnyCount}  ` +
      `sunny!=¬blocked=${perFrameMismatch}  ΔsunnyCount=${sunnyCountDelta}`,
    );
  }

  console.log(
    `\n  Phase E : ${phaseEMismatch}/${phaseETotal} (${((phaseEMismatch / phaseETotal) * 100).toFixed(2)}%) où sunnyMask != !buildingsMask`,
  );
  console.log(
    `  Phase E : ${phaseESunnyCountMismatch}/${phaseEFrames.length} frames où sunnyCount != expected`,
  );
  if (phaseEMismatch > 0) {
    console.log(`\n  ⚠  Bug identifié : le serveur Rust calcule un sunnyMask incorrect.`);
    console.log(`      Le shader de shadow est correct (section 1) mais la recomposition serveur est buggée.`);
  } else {
    console.log(`\n  ✓ Phase E cohérente avec la réalité shader. Bug ailleurs dans la chaîne.`);
  }

  // ─── 8) FULL PIPELINE : Vulkan sunnyMask (buildings+terrain+veg) vs CPU ────
  // Reproduit exactement ce que fait le précompute Phase E. Si le bug existe
  // quelque part dans la chaîne, il apparaît ici.
  console.log(`\n══════ FULL PIPELINE (Vulkan sunnyMask avec horizon+veg) vs CPU ══════`);

  const sharedSources = await buildSharedPointEvaluationSources({
    lv95Bounds: { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY },
  });

  // Horizon payload : 1 seul horizonMask partagé par tous les points de la tuile
  let horizonPayload: { masks: Float32Array; pointMaskIndices: Uint32Array } | null = null;
  if (sharedSources.horizonMask) {
    const masks = new Float32Array(360);
    const bins = sharedSources.horizonMask.binsDeg;
    for (let b = 0; b < 360; b++) masks[b] = bins[b];
    const pointMaskIndices = new Uint32Array(samplePoints.length); // tous à 0
    horizonPayload = { masks, pointMaskIndices };
    console.log(`  horizonMask présent (method=${sharedSources.horizonMask.method ?? "?"})`);
  } else {
    console.log(`  pas de horizonMask disponible — test terrain skippé`);
  }

  // Vegetation payload : reconstruit le même format que le précompute (sunlight-tile-service.ts:1184-1220)
  let vegetationPayload: {
    meta: Float32Array;
    data: Float32Array;
    nodata: number;
    stepMeters: number;
    maxDistanceMeters: number;
    minClearance: number;
    originX: number;
    originY: number;
  } | null = null;
  const vegTiles = sharedSources.vegetationSurfaceTiles;
  if (vegTiles && vegTiles.length > 0) {
    const meta = new Float32Array(vegTiles.length * 8);
    const metaU32 = new Uint32Array(meta.buffer);
    let totalFloats = 0;
    for (const tile of vegTiles) totalFloats += tile.width * tile.height;
    const data = new Float32Array(totalFloats);
    let offsetFloats = 0;
    for (let i = 0; i < vegTiles.length; i++) {
      const t = vegTiles[i];
      const slot = i * 8;
      meta[slot + 0] = t.minX;
      meta[slot + 1] = t.minY;
      meta[slot + 2] = t.maxX;
      meta[slot + 3] = t.maxY;
      metaU32[slot + 4] = t.width;
      metaU32[slot + 5] = t.height;
      metaU32[slot + 6] = offsetFloats;
      meta[slot + 7] = t.nodata === null ? Number.NaN : t.nodata;
      const n = t.width * t.height;
      if (t.raster instanceof Float32Array) {
        data.set(t.raster.subarray(0, n), offsetFloats);
      } else {
        for (let k = 0; k < n; k++) data[offsetFloats + k] = Number(t.raster[k]);
      }
      offsetFloats += n;
    }
    const vkOrigin = vulkan.getOrigin();
    vegetationPayload = {
      meta, data, nodata: 0,
      stepMeters: 2, maxDistanceMeters: 120, minClearance: 4,
      originX: vkOrigin.x, originY: vkOrigin.y,
    };
    console.log(`  vegetation ${vegTiles.length} tile(s), total ${totalFloats} samples`);
  } else {
    console.log(`  pas de vegetation tiles — test veg skippé`);
  }

  // Build CPU evaluators for each sample point (lent — on limite les frames)
  console.log(`  préparation des évaluateurs CPU par point (${samplePoints.length} points)…`);
  const cpuContexts: Array<Awaited<ReturnType<typeof buildPointEvaluationContext>>> = [];
  for (let i = 0; i < samplePoints.length; i++) {
    const p = samplePoints[i];
    const ctx = await buildPointEvaluationContext(p.lat, p.lon, {
      sharedSources,
      overrideElevation: metadata.elevations[allPoints.indexOf(p)] ?? undefined,
      skipIndoorCheck: true,
    });
    cpuContexts.push(ctx);
    if (i > 0 && i % 100 === 0) console.log(`    ${i}/${samplePoints.length}…`);
  }

  // Limit to ~15 frames (daytime sample) for reasonable runtime
  const fullFrames = frames.filter((_, i) => i % Math.max(1, Math.floor(frames.length / 15)) === 0).slice(0, 15);
  console.log(`  ${fullFrames.length} frames testées (sur ${frames.length})`);

  const vkFullResults = await (vulkan as unknown as {
    evaluateBatchFramesWithShadows: (
      frames: Array<{ azimuthDeg: number; altitudeDeg: number }>,
      points: Float32Array,
      pointCount: number,
      options?: { horizon?: typeof horizonPayload; vegetation?: typeof vegetationPayload },
    ) => Promise<Array<{
      buildingsMask: Uint32Array;
      terrainMask: Uint32Array | null;
      vegetationMask: Uint32Array | null;
      sunnyMask: Uint32Array;
      sunnyNoVegMask: Uint32Array;
    }>>;
  }).evaluateBatchFramesWithShadows(
    fullFrames.map((f) => ({ azimuthDeg: f.az, altitudeDeg: f.alt })),
    vkPoints,
    samplePoints.length,
    {
      horizon: horizonPayload ?? undefined,
      vegetation: vegetationPayload ?? undefined,
    },
  );

  let fullMismatch = 0, fullTotal = 0;
  let cpuSunVkShad = 0, cpuShadVkSun = 0;
  const framePct: Array<{ label: string; mismatch: number; cpuSun: number; vkSun: number }> = [];

  for (let k = 0; k < fullFrames.length; k++) {
    const f = fullFrames[k];
    const vkRes = vkFullResults[k];
    let perFrameMismatch = 0;
    let cpuSunCount = 0, vkSunCount = 0;
    for (let i = 0; i < samplePoints.length; i++) {
      const cpu = evaluateInstantSunlight({
        lat: samplePoints[i].lat, lon: samplePoints[i].lon, utcDate: f.utc, timeZone: "Europe/Zurich",
        horizonMask: cpuContexts[i].horizonMask,
        buildingShadowEvaluator: cpuContexts[i].buildingShadowEvaluator,
        vegetationShadowEvaluator: cpuContexts[i].vegetationShadowEvaluator,
      });
      const cpuSunny = cpu.isSunny;
      const vkSunny = (vkRes.sunnyMask[i >> 5] & (1 << (i & 31))) !== 0;
      if (cpuSunny) cpuSunCount++;
      if (vkSunny) vkSunCount++;
      if (cpuSunny !== vkSunny) {
        perFrameMismatch++;
        if (cpuSunny && !vkSunny) cpuSunVkShad++;
        else cpuShadVkSun++;
      }
      fullTotal++;
    }
    fullMismatch += perFrameMismatch;
    const pct = ((perFrameMismatch / samplePoints.length) * 100).toFixed(2);
    console.log(
      `  ${f.label}  az=${f.az.toFixed(1).padStart(6)}°  alt=${f.alt.toFixed(1).padStart(5)}°  ` +
      `cpu=${String(cpuSunCount).padStart(4)}sun  vk=${String(vkSunCount).padStart(4)}sun  diff=${String(perFrameMismatch).padStart(4)} (${pct}%)`,
    );
    framePct.push({ label: f.label, mismatch: perFrameMismatch, cpuSun: cpuSunCount, vkSun: vkSunCount });
  }

  console.log(
    `\n  TOTAL : ${fullMismatch}/${fullTotal} (${((fullMismatch / fullTotal) * 100).toFixed(2)}%) mismatch Vulkan-vs-CPU`,
  );
  console.log(
    `  direction : CPU=SUN/Vk=SHAD (Vk sur-ombre) = ${cpuSunVkShad} | CPU=SHAD/Vk=SUN (Vk rate ombre) = ${cpuShadVkSun}`,
  );

  if (fullMismatch > 0) {
    const frac = fullMismatch / fullTotal;
    if (frac > 0.01) {
      console.log(`\n  ⚠  BUG REPRODUIT en single-tile. Explorer : horizon ray-march ou vegetation ray-march.`);
    } else {
      console.log(`\n  ⚠  léger écart (<1%) — probablement tolérance numérique (arrondis sub-pixel).`);
    }
  } else {
    console.log(`\n  ✓ Vulkan full-pipeline == CPU en single-tile. Bug dans cross-tile ou ailleurs.`);
  }

  // ─── 9) Cleanup ────────────────────────────────────────────────────
  raster.dispose();
  await vulkan.shutdown();
}

function countBits(mask: Uint32Array, count: number): number {
  let n = 0;
  for (let i = 0; i < count; i++) {
    if ((mask[i >> 5] & (1 << (i & 31))) !== 0) n++;
  }
  return n;
}

main().catch((e) => {
  console.error(`[diag] Erreur : ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
