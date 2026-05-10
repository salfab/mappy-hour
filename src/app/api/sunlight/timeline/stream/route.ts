import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import SunCalc from "suncalc";
import { z } from "zod";

import { MAX_OUTDOOR_POINTS, DEFAULT_MAX_OUTDOOR_POINTS } from "@/lib/config/grid-limits";
import { lv95ToWgs84Precise, wgs84ToLv95Precise } from "@/lib/geo/projection";
import {
  streamTilesForBbox,
  resolveRegionForBbox,
  lookupAtlasByAngle,
} from "@/lib/precompute/sunlight-tile-service";
import {
  isMaskBitSet,
  pointInBbox,
  setMaskBit,
} from "@/lib/precompute/sunlight-cache";
import {
  getFrameMask,
  MASK_KIND_SUN,
  MASK_KIND_SUN_NO_VEG,
  type BinaryTileArtifact,
} from "@/lib/precompute/sunlight-cache-binary";
import type { BinaryTileAtlas } from "@/lib/precompute/sunlight-cache-atlas";
import { getAtlasBucketMasks } from "@/lib/precompute/sunlight-cache-atlas";
import type { PrecomputedSunlightTileArtifact } from "@/lib/precompute/sunlight-cache";
import { normalizeShadowCalibration } from "@/lib/sun/shadow-calibration";
import { encodeTileMasksBlob } from "@/lib/encoding/mask-codec-server";
import { getZonedDayRangeUtc, zonedDateTimeToUtc } from "@/lib/time/zoned-date";

export const runtime = "nodejs";

const querySchema = z
  .object({
    minLon: z.coerce.number(),
    minLat: z.coerce.number(),
    maxLon: z.coerce.number(),
    maxLat: z.coerce.number(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().default("Europe/Zurich"),
    startLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("00:00"),
    endLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("23:59"),
    sampleEveryMinutes: z.coerce.number().int().min(1).max(60).default(15),
    gridStepMeters: z.coerce.number().int().min(1).max(2000).default(250),
    maxPoints: z.coerce.number().int().min(1).max(MAX_OUTDOOR_POINTS).default(DEFAULT_MAX_OUTDOOR_POINTS),
    buildingHeightBiasMeters: z.coerce.number().min(-20).max(20).default(0),
    cacheOnly: z.string().default("false").transform(v => v === "true" || v === "1"),
    maxComputeTiles: z.coerce.number().int().min(0).max(500).default(50),
  })
  .refine(
    (value) =>
      value.minLon < value.maxLon &&
      value.minLat < value.maxLat &&
      value.minLon >= -180 &&
      value.maxLon <= 180 &&
      value.minLat >= -90 &&
      value.maxLat <= 90,
    {
      message:
        "Invalid bbox. Expected minLon < maxLon and minLat < maxLat in WGS84 bounds.",
      path: ["minLon"],
    },
  );

function createUtcSamples(
  date: string,
  timeZone: string,
  sampleEveryMinutes: number,
  startLocalTime: string,
  endLocalTime: string,
): Date[] {
  const { startUtc: dayStartUtc, endUtc: dayEndUtc } = getZonedDayRangeUtc(date, timeZone);
  const rangeStartUtc = zonedDateTimeToUtc(date, startLocalTime, timeZone);
  const rangeEndUtc = zonedDateTimeToUtc(date, endLocalTime, timeZone);
  const startUtc = new Date(
    Math.max(dayStartUtc.getTime(), rangeStartUtc.getTime()),
  );
  const endUtc = new Date(Math.min(dayEndUtc.getTime(), rangeEndUtc.getTime()));
  if (endUtc.getTime() <= startUtc.getTime()) {
    return [];
  }
  const sampleEveryMs = sampleEveryMinutes * 60_000;
  const result: Date[] = [];

  for (
    let cursor = startUtc.getTime();
    cursor < endUtc.getTime();
    cursor += sampleEveryMs
  ) {
    result.push(new Date(cursor));
  }

  return result;
}

function percent(done: number, total: number): number {
  if (total <= 0) {
    return 100;
  }

  return Math.max(0, Math.min(100, (done / total) * 100));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function normalizeTimelineWarning(warning: string): string {
  if (
    warning.startsWith("Adaptive terrain horizon resolution failed for tile ") &&
    warning.includes("Unexpected non-whitespace character after JSON")
  ) {
    return (
      "Adaptive terrain horizon resolution failed for some cached tiles " +
      "(corrupt adaptive horizon assignment JSON). Cached sunlight atlas is served as-is."
    );
  }

  if (
    warning ===
    "No horizon mask. Callers should supply `terrainHorizonOverride` (live API: buildDynamicHorizonMask; precompute: resolveAdaptiveTerrainHorizonForTile). Far-horizon blocking will be ignored."
  ) {
    return "Some cached tiles were generated without a terrain horizon mask; far-horizon blocking may be missing for those cached tiles.";
  }

  return warning;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawQuery = Object.fromEntries(url.searchParams.entries());
  const parsed = querySchema.safeParse(rawQuery);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request query.",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  try {
    const started = performance.now();
    const query = parsed.data;
    const shadowCalibration = normalizeShadowCalibration({
      buildingHeightBiasMeters: query.buildingHeightBiasMeters,
    });
    const signal = request.signal;
    let streamAborted = false;

    signal.addEventListener("abort", () => {
      streamAborted = true;
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let controllerClosed = false;

        const sendEvent = (event: string, payload: unknown) => {
          if (controllerClosed || streamAborted) return;
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
            );
          } catch {
            controllerClosed = true;
          }
        };

        const run = async () => {
          sendEvent("progress", {
            phase: query.cacheOnly ? "loading-cache" : "loading-scene",
            done: 0,
            total: 1,
            percent: 0,
            etaSeconds: null,
          });
          await yieldToEventLoop();

          const bbox = {
            minLon: query.minLon,
            minLat: query.minLat,
            maxLon: query.maxLon,
            maxLat: query.maxLat,
          };
          const tileStream = streamTilesForBbox({
            bbox,
            date: query.date,
            timezone: query.timezone,
            sampleEveryMinutes: query.sampleEveryMinutes,
            gridStepMeters: query.gridStepMeters,
            startLocalTime: query.startLocalTime,
            endLocalTime: query.endLocalTime,
            shadowCalibration,
            cacheOnly: query.cacheOnly,
            onTileComputeProgress: (event) => {
              const etaSeconds =
                event.elapsedMs > 3000 && event.percent > 0.01
                  ? Math.round(
                      (event.elapsedMs / event.percent) *
                        (100 - event.percent) /
                        1000,
                    )
                  : null;
              sendEvent("progress", {
                phase: event.phase,
                tileIndex: event.tileIndex,
                totalTiles: event.totalTiles,
                tileId: event.tileId,
                stage: event.stage,
                done: event.stageCompleted,
                total: event.stageTotal,
                percent: event.percent,
                etaSeconds,
                elapsedMs: Math.round(event.elapsedMs),
              });
            },
          });

          const region = resolveRegionForBbox(bbox);
          const timelineUtcSamples = createUtcSamples(
            query.date,
            query.timezone,
            query.sampleEveryMinutes,
            query.startLocalTime,
            query.endLocalTime,
          );
          const timelineFrameLocalTimes = timelineUtcSamples.map((utcDate) =>
            utcDate.toLocaleTimeString("fr-CH", {
              timeZone: query.timezone,
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }),
          );

          let sentStart = false;
          let totalPointCount = 0;
          let totalGridPointCount = 0;
          let totalIndoorExcluded = 0;
          const totalPointsWithElevation = 0;
          let tileStreamTotalEvaluations = 0;
          let tilesFromCache = 0;
          let tilesComputed = 0;
          let frameCount = 0;
          const allWarnings = new Set<string>();
          // Track global col/row extremes for precise overlay bounds
          let globalMinCol = Infinity, globalMaxCol = -Infinity;
          let globalMinRow = Infinity, globalMaxRow = -Infinity;

          const perTileTiming = { parse: 0, remap: 0, encode: 0, indoor: 0, send: 0, streamNext: 0, totalYielded: 0 };
          const tStreamNext0 = performance.now();
          let result = await tileStream.next();
          perTileTiming.streamNext += performance.now() - tStreamNext0;
          while (!result.done) {
            if (streamAborted) return;
            const tileT0 = performance.now();
            const { tileId, tileIndex, totalTiles, artifact, binary, atlases, layer } = result.value;
            // Meta (points, model, warnings) is identical across all resolutions
            // of a tile's atlas, so the first one is a valid spokesperson.
            const atlas = atlases?.[0];

            // For atlas: enumerate time samples from query params (date-agnostic format).
            const atlasUtcSamples = atlas ? timelineUtcSamples : null;

            const viewPointCount = atlas ? atlas.pointCount : (binary ? binary.pointCount : artifact!.points.length);
            const viewFrameCount = atlas ? (atlasUtcSamples?.length ?? 0) : (binary ? binary.frameCount : artifact!.frames.length);
            const viewModel = atlas ? (atlas.meta.model ?? {}) : (binary ? binary.meta.model : artifact!.model);
            const viewWarnings = atlas ? atlas.meta.warnings : (binary ? binary.meta.warnings : artifact!.warnings);

            if (!sentStart) {
              sendEvent("start", {
                date: query.date,
                timezone: query.timezone,
                startLocalTime: query.startLocalTime,
                endLocalTime: query.endLocalTime,
                sampleEveryMinutes: query.sampleEveryMinutes,
                gridStepMeters: query.gridStepMeters,
                totalTiles,
                frameCount: viewFrameCount,
                model: viewModel,
              });
              await yieldToEventLoop();
              sentStart = true;
              frameCount = viewFrameCount;
            }

            if (layer === "L1" || layer === "L2") {
              tilesFromCache += 1;
            } else {
              tilesComputed += 1;
            }

            // Build grid-indexed tile data. Instead of sending individual
            // point IDs (~800KB), we send grid bounds + outdoor mask + grid-
            // indexed frame masks (~260KB total, ~4x reduction).
            let tileGridCount = 0;
            let tileIndoorExcluded = 0;
            let tileOutdoorCount = 0;
            let tileMinIx = Infinity, tileMaxIx = -Infinity;
            let tileMinIy = Infinity, tileMaxIy = -Infinity;
            // Atlas and binary both use the same typed-array point layout.
            const binaryLikePoints = atlas ?? binary;
            if (binaryLikePoints) {
              const { pointLon, pointLat, pointIx, pointIy, pointOutdoorIndex, pointFlags } = binaryLikePoints;
              for (let i = 0; i < viewPointCount; i++) {
                if (!pointInBbox(pointLon[i], pointLat[i], bbox)) continue;
                tileGridCount += 1;
                if ((pointFlags[i] & 1) !== 0 || pointOutdoorIndex[i] < 0) {
                  tileIndoorExcluded += 1;
                } else {
                  tileOutdoorCount += 1;
                }
                const ix = pointIx[i], iy = pointIy[i];
                if (ix < tileMinIx) tileMinIx = ix;
                if (ix > tileMaxIx) tileMaxIx = ix;
                if (iy < tileMinIy) tileMinIy = iy;
                if (iy > tileMaxIy) tileMaxIy = iy;
              }
            } else {
              for (const p of artifact!.points) {
                if (!pointInBbox(p.lon, p.lat, bbox)) continue;
                tileGridCount += 1;
                if (p.insideBuilding || p.outdoorIndex === null) {
                  tileIndoorExcluded += 1;
                } else {
                  tileOutdoorCount += 1;
                }
                if (p.ix < tileMinIx) tileMinIx = p.ix;
                if (p.ix > tileMaxIx) tileMaxIx = p.ix;
                if (p.iy < tileMinIy) tileMinIy = p.iy;
                if (p.iy > tileMaxIy) tileMaxIy = p.iy;
              }
            }

            totalPointCount += tileOutdoorCount;
            totalGridPointCount += tileGridCount;
            totalIndoorExcluded += tileIndoorExcluded;
            tileStreamTotalEvaluations += tileOutdoorCount * viewFrameCount;
            for (const w of viewWarnings) {
              allWarnings.add(normalizeTimelineWarning(w));
            }

            if (!query.cacheOnly && layer === "MISS" && tilesComputed > query.maxComputeTiles) {
              sendEvent("error", {
                error: "Too many tiles to compute.",
                details: `Already computed ${tilesComputed} tiles (limit: ${query.maxComputeTiles}). Use cache-only mode or reduce the area.`,
              });
              return;
            }

            // Track global col/row extremes
            if (tileMinIx < globalMinCol) globalMinCol = tileMinIx;
            if (tileMaxIx > globalMaxCol) globalMaxCol = tileMaxIx;
            if (tileMinIy < globalMinRow) globalMinRow = tileMinIy;
            if (tileMaxIy > globalMaxRow) globalMaxRow = tileMaxIy;

            if (tileMinIx > tileMaxIx || tileMinIy > tileMaxIy) {
              // No points in bbox for this tile
              result = await tileStream.next();
              continue;
            }

            const tRemapStart = performance.now();
            perTileTiming.parse += tRemapStart - tileT0;
            // Build grid cell → artifact outdoorIndex mapping.
            // Indoor/outdoor comes from zenith grid metadata (independent
            // of date), not from the cached tile's insideBuilding flags.
            const tileW = tileMaxIx - tileMinIx + 1;
            const tileH = tileMaxIy - tileMinIy + 1;
            const gridCellCount = tileW * tileH;
            const outdoorMask = new Uint8Array(Math.ceil(gridCellCount / 8));
            const outdoorCells = new Int32Array(gridCellCount);
            const outdoorIndexes = new Int32Array(gridCellCount);
            let outdoorCellCount = 0;

            // Load zenith indoor mask from grid metadata
            const { loadTileGridMetadata } = await import("@/lib/precompute/tile-grid-metadata");
            const { getSunlightModelVersion } = await import("@/lib/precompute/model-version");
            const tileSizeMeters = 250;
            const tileMinE = Math.floor(tileMinIx / tileSizeMeters) * tileSizeMeters;
            const tileMinN = Math.floor(tileMinIy / tileSizeMeters) * tileSizeMeters;
            const gmTileId = `e${tileMinE}_n${tileMinN}_s${tileSizeMeters}`;
            const gmModelVersion = region ? await getSunlightModelVersion(
              region as import("@/lib/precompute/sunlight-cache").PrecomputedRegionName,
              shadowCalibration,
            ) : null;
            const gridMetadata = region && gmModelVersion ? await loadTileGridMetadata(
              region, gmModelVersion.gridMetadataHash, query.gridStepMeters, gmTileId,
            ) : null;

            if (atlas ?? binary) {
              const { pointLon, pointLat, pointIx, pointIy, pointOutdoorIndex, pointFlags } = (atlas ?? binary)!;
              const gmW = Math.ceil(tileSizeMeters);
              for (let i = 0; i < viewPointCount; i++) {
                const lon = pointLon[i], lat = pointLat[i];
                if (!pointInBbox(lon, lat, bbox)) continue;
                const ix = pointIx[i], iy = pointIy[i];
                let isIndoor: boolean;
                if (gridMetadata) {
                  const gmIx = ix - tileMinE;
                  const gmIy = iy - tileMinN;
                  const gmIdx = gmIy * gmW + gmIx;
                  isIndoor = gridMetadata.indoor[gmIdx] ?? false;
                } else {
                  isIndoor = (pointFlags[i] & 1) !== 0;
                }
                const oi = pointOutdoorIndex[i];
                if (isIndoor || oi < 0) continue;
                const cellIdx = (iy - tileMinIy) * tileW + (ix - tileMinIx);
                setMaskBit(outdoorMask, cellIdx);
                outdoorCells[outdoorCellCount] = cellIdx;
                outdoorIndexes[outdoorCellCount] = oi;
                outdoorCellCount += 1;
              }
            } else {
              for (const p of artifact!.points) {
                if (!pointInBbox(p.lon, p.lat, bbox)) continue;
                let isIndoor: boolean;
                if (gridMetadata) {
                  const gmIx = p.ix - tileMinE;
                  const gmIy = p.iy - tileMinN;
                  const gmW = Math.ceil(tileSizeMeters);
                  const gmIdx = gmIy * gmW + gmIx;
                  isIndoor = gridMetadata.indoor[gmIdx] ?? false;
                } else {
                  isIndoor = p.insideBuilding;
                }
                if (isIndoor || p.outdoorIndex === null) continue;
                const cellIdx = (p.iy - tileMinIy) * tileW + (p.ix - tileMinIx);
                setMaskBit(outdoorMask, cellIdx);
                outdoorCells[outdoorCellCount] = cellIdx;
                outdoorIndexes[outdoorCellCount] = p.outdoorIndex;
                outdoorCellCount += 1;
              }
            }

            // Build grid-indexed frame masks and collect raw buffers for blob encoding
            const frameMaskBuffers: Array<{ sun: Uint8Array; sunNoVeg: Uint8Array }> = [];
            const tileFrameMeta: Array<{ index: number; localTime: string; sunnyCount: number; sunnyCountNoVegetation: number }> = [];
            if (atlas && atlasUtcSamples) {
              // Tile center for sun position computation
              const tileCenterLv95E = (tileMinIx + (tileMaxIx + 1)) / 2 * query.gridStepMeters;
              const tileCenterLv95N = (tileMinIy + (tileMaxIy + 1)) / 2 * query.gridStepMeters;
              const { lat: tileLat, lon: tileLon } = lv95ToWgs84Precise(tileCenterLv95E, tileCenterLv95N);
              const RAD_TO_DEG = 180 / Math.PI;
              for (let f = 0; f < atlasUtcSamples.length; f++) {
                const utcDate = atlasUtcSamples[f];
                const pos = SunCalc.getPosition(utcDate, tileLat, tileLon);
                const alt = pos.altitude * RAD_TO_DEG;
                const localTime = timelineFrameLocalTimes[f] ?? "";
                const dstMask = new Uint8Array(Math.ceil(gridCellCount / 8));
                const dstNoVeg = new Uint8Array(Math.ceil(gridCellCount / 8));
                let sunnyCount = 0, sunnyNoVeg = 0;
                if (alt > 0) {
                  let az = (pos.azimuth * RAD_TO_DEG + 180) % 360;
                  if (az < 0) az += 360;
                  const bucket = lookupAtlasByAngle(atlases!, az, alt);
                  if (bucket) {
                    const { sunMask, sunNoVegMask } = bucket;
                    for (let i = 0; i < outdoorCellCount; i++) {
                      const cellIdx = outdoorCells[i];
                      const oi = outdoorIndexes[i];
                      if (oi >= 0 && isMaskBitSet(sunMask, oi)) {
                        setMaskBit(dstMask, cellIdx);
                        sunnyCount += 1;
                      }
                      if (oi >= 0 && isMaskBitSet(sunNoVegMask, oi)) {
                        setMaskBit(dstNoVeg, cellIdx);
                        sunnyNoVeg += 1;
                      }
                    }
                  }
                }
                frameMaskBuffers.push({ sun: dstMask, sunNoVeg: dstNoVeg });
                tileFrameMeta.push({ index: f, localTime, sunnyCount, sunnyCountNoVegetation: sunnyNoVeg });
              }
            } else if (binary) {
              for (let f = 0; f < viewFrameCount; f++) {
                const srcMask = getFrameMask(binary, f, MASK_KIND_SUN);
                const dstMask = new Uint8Array(Math.ceil(gridCellCount / 8));
                let sunnyCount = 0;
                for (let i = 0; i < outdoorCellCount; i++) {
                  const cellIdx = outdoorCells[i];
                  const oi = outdoorIndexes[i];
                  if (oi >= 0 && isMaskBitSet(srcMask, oi)) {
                    setMaskBit(dstMask, cellIdx);
                    sunnyCount += 1;
                  }
                }
                const srcNoVeg = getFrameMask(binary, f, MASK_KIND_SUN_NO_VEG);
                const dstNoVeg = new Uint8Array(Math.ceil(gridCellCount / 8));
                let sunnyNoVeg = 0;
                for (let i = 0; i < outdoorCellCount; i++) {
                  const cellIdx = outdoorCells[i];
                  const oi = outdoorIndexes[i];
                  if (oi >= 0 && isMaskBitSet(srcNoVeg, oi)) {
                    setMaskBit(dstNoVeg, cellIdx);
                    sunnyNoVeg += 1;
                  }
                }
                frameMaskBuffers.push({ sun: dstMask, sunNoVeg: dstNoVeg });
                const fm = binary.meta.framesMeta[f];
                tileFrameMeta.push({
                  index: fm.index,
                  localTime: fm.localTime,
                  sunnyCount,
                  sunnyCountNoVegetation: sunnyNoVeg,
                });
              }
            } else {
              for (const frame of artifact!.frames) {
                const srcMask = frame.sunMask;
                const dstMask = new Uint8Array(Math.ceil(gridCellCount / 8));
                let sunnyCount = 0;
                for (let i = 0; i < outdoorCellCount; i++) {
                  const cellIdx = outdoorCells[i];
                  const oi = outdoorIndexes[i];
                  if (oi >= 0 && isMaskBitSet(srcMask, oi)) {
                    setMaskBit(dstMask, cellIdx);
                    sunnyCount += 1;
                  }
                }
                const srcNoVeg = frame.sunMaskNoVegetation;
                const dstNoVeg = new Uint8Array(Math.ceil(gridCellCount / 8));
                let sunnyNoVeg = 0;
                for (let i = 0; i < outdoorCellCount; i++) {
                  const cellIdx = outdoorCells[i];
                  const oi = outdoorIndexes[i];
                  if (oi >= 0 && isMaskBitSet(srcNoVeg, oi)) {
                    setMaskBit(dstNoVeg, cellIdx);
                    sunnyNoVeg += 1;
                  }
                }
                frameMaskBuffers.push({ sun: dstMask, sunNoVeg: dstNoVeg });
                tileFrameMeta.push({
                  index: frame.index,
                  localTime: frame.localTime,
                  sunnyCount,
                  sunnyCountNoVegetation: sunnyNoVeg,
                });
              }
            }

            const tEncodeStart = performance.now();
            perTileTiming.remap += tEncodeStart - tRemapStart;
            // Concatenate + gzip all masks into a single compressed blob
            const masksBase64 = encodeTileMasksBlob(outdoorMask, frameMaskBuffers);
            perTileTiming.encode += performance.now() - tEncodeStart;

            // Per-tile corners via lv95ToWgs84Precise for affine transform positioning.
            const gs = query.gridStepMeters;
            const tileSW = lv95ToWgs84Precise(tileMinIx * gs, tileMinIy * gs);
            const tileNE = lv95ToWgs84Precise((tileMaxIx + 1) * gs, (tileMaxIy + 1) * gs);
            const tileNW = lv95ToWgs84Precise(tileMinIx * gs, (tileMaxIy + 1) * gs);
            const tileSE = lv95ToWgs84Precise((tileMaxIx + 1) * gs, tileMinIy * gs);

            const tSendStart = performance.now();
            sendEvent("tile", {
              tileId,
              tileIndex,
              totalTiles,
              pointCount: tileOutdoorCount,
              gridPointCount: tileGridCount,
              indoorPointsExcluded: tileIndoorExcluded,
              grid: { minIx: tileMinIx, maxIx: tileMaxIx, minIy: tileMinIy, maxIy: tileMaxIy, width: tileW, height: tileH },
              tileBounds: { minLat: tileSW.lat, maxLat: tileNE.lat, minLon: tileSW.lon, maxLon: tileNE.lon },
              tileCorners: {
                nw: { lat: tileNW.lat, lon: tileNW.lon },
                ne: { lat: tileNE.lat, lon: tileNE.lon },
                sw: { lat: tileSW.lat, lon: tileSW.lon },
                se: { lat: tileSE.lat, lon: tileSE.lon },
              },
              masksEncoding: "gzip-concat-v1",
              masksBase64,
              frames: tileFrameMeta,
            });
            await yieldToEventLoop();
            perTileTiming.send += performance.now() - tSendStart;
            perTileTiming.totalYielded += 1;

            const tNext0 = performance.now();
            result = await tileStream.next();
            perTileTiming.streamNext += performance.now() - tNext0;
          }

          if (perTileTiming.totalYielded > 0) {
            const n = perTileTiming.totalYielded;
            process.stderr.write(
              `[stream:per-tile-timing] ${n} tiles avg parse=${(perTileTiming.parse / n).toFixed(1)}ms remap=${(perTileTiming.remap / n).toFixed(1)}ms encode=${(perTileTiming.encode / n).toFixed(1)}ms send=${(perTileTiming.send / n).toFixed(1)}ms streamNext=${(perTileTiming.streamNext / n).toFixed(1)}ms | totals parse=${perTileTiming.parse.toFixed(0)} remap=${perTileTiming.remap.toFixed(0)} encode=${perTileTiming.encode.toFixed(0)} send=${perTileTiming.send.toFixed(0)} streamNext=${perTileTiming.streamNext.toFixed(0)}\n`,
            );
          }

          // Generator returned init metadata (or null if region not found)
          if (!sentStart) {
            // No tiles at all — region not found or no intersecting tiles
            sendEvent("error", {
              error: "No tiles found for the requested area.",
            });
            return;
          }

          // Compute precise overlay bounds from global col/row extremes
          let overlayBounds: { minLat: number; maxLat: number; minLon: number; maxLon: number } | undefined;
          if (globalMinCol < Infinity) {
            const gs = query.gridStepMeters;
            const sw = lv95ToWgs84Precise(globalMinCol * gs, globalMinRow * gs);
            const ne = lv95ToWgs84Precise((globalMaxCol + 1) * gs, (globalMaxRow + 1) * gs);
            overlayBounds = { minLat: sw.lat, maxLat: ne.lat, minLon: sw.lon, maxLon: ne.lon };
          }

          sendEvent("done", {
            stats: {
              elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
              evaluationElapsedMs: 0,
              pointsWithElevation: totalPointsWithElevation,
              pointsWithoutElevation: totalPointCount - totalPointsWithElevation,
              indoorPointsExcluded: totalIndoorExcluded,
              frameCount,
              totalEvaluations: tileStreamTotalEvaluations,
              totalPointCount,
              totalGridPointCount,
              tilesComputed,
              tilesFromCache,
            },
            overlayBounds,
            warnings: Array.from(allWarnings),
          });
        };

        void run()
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : "Unknown streaming error";
            sendEvent("error", {
              error: "Timeline streaming failed.",
              details: message,
            });
          })
          .finally(() => {
            if (!controllerClosed) {
              try {
                controller.close();
              } catch {
                controllerClosed = true;
              }
            }
          });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Content-Encoding": "none",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Daily timeline calculation failed.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
