import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import { z } from "zod";

import { MAX_OUTDOOR_POINTS, DEFAULT_MAX_OUTDOOR_POINTS } from "@/lib/config/grid-limits";
import { lv95ToWgs84, wgs84ToLv95 } from "@/lib/geo/projection";
import { buildGridFromBbox } from "@/lib/geo/grid";
import {
  streamTilesForBbox,
} from "@/lib/precompute/sunlight-tile-service";
import {
  decodeBase64Bytes,
  isMaskBitSet,
  pointInBbox,
  setMaskBit,
} from "@/lib/precompute/sunlight-cache";
import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";
import { buildPointEvaluationContext, buildSharedPointEvaluationSources } from "@/lib/sun/evaluation-context";
import { normalizeShadowCalibration } from "@/lib/sun/shadow-calibration";
import { evaluateInstantSunlight } from "@/lib/sun/solar";
import { getZonedDayRangeUtc, zonedDateTimeToUtc } from "@/lib/time/zoned-date";

export const runtime = "nodejs";

const MAX_RAW_GRID_POINTS = 20_000_000;

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
    cacheOnly: z.coerce.boolean().default(false),
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

interface PreparedPoint {
  id: string;
  lat: number;
  lon: number;
  pointLv95: {
    easting: number;
    northing: number;
  };
  pointElevationMeters: number | null;
  horizonMask: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["horizonMask"];
  buildingShadowEvaluator: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["buildingShadowEvaluator"];
  vegetationShadowEvaluator: Awaited<
    ReturnType<typeof buildPointEvaluationContext>
  >["vegetationShadowEvaluator"];
}

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings));
}

function extractTerrainHorizonDebug(
  mask: Awaited<ReturnType<typeof buildDynamicHorizonMask>> | undefined,
) {
  if (!mask?.ridgePoints || mask.ridgePoints.length === 0) {
    return null;
  }

  return {
    center: mask.center,
    radiusKm: mask.radiusKm,
    ridgePoints: mask.ridgePoints,
  };
}

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

function buildCacheMissMetadata() {
  return {
    hit: false,
    layer: "MISS" as const,
    region: null,
    modelVersionHash: null,
    fullyCovered: false,
  };
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
    // In cache-only mode, skip the expensive grid computation — we only
    // read cached tiles from disk, so the grid is not needed.
    const grid = query.cacheOnly
      ? []
      : buildGridFromBbox(
          {
            minLon: query.minLon,
            minLat: query.minLat,
            maxLon: query.maxLon,
            maxLat: query.maxLat,
          },
          query.gridStepMeters,
        );

    if (!query.cacheOnly && grid.length > MAX_RAW_GRID_POINTS) {
      return NextResponse.json(
        {
          error: "Grid exceeds raw safety limit.",
          detail: `Computed ${grid.length} raw points, but hard limit is ${MAX_RAW_GRID_POINTS}. Increase gridStepMeters or reduce bbox.`,
        },
        { status: 400 },
      );
    }
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

          let sentStart = false;
          let totalPointCount = 0;
          let totalGridPointCount = 0;
          let totalIndoorExcluded = 0;
          let totalPointsWithElevation = 0;
          let tileStreamTotalEvaluations = 0;
          let tilesFromCache = 0;
          let tilesComputed = 0;
          let frameCount = 0;
          const allWarnings = new Set<string>();
          // Track global col/row extremes for precise overlay bounds
          let globalMinCol = Infinity, globalMaxCol = -Infinity;
          let globalMinRow = Infinity, globalMaxRow = -Infinity;

          let result = await tileStream.next();
          while (!result.done) {
            if (streamAborted) return;
            const { tileId, tileIndex, totalTiles, artifact, layer } = result.value;

            if (!sentStart) {
              sendEvent("start", {
                date: query.date,
                timezone: query.timezone,
                startLocalTime: query.startLocalTime,
                endLocalTime: query.endLocalTime,
                sampleEveryMinutes: query.sampleEveryMinutes,
                gridStepMeters: query.gridStepMeters,
                totalTiles,
                frameCount: artifact.frames.length,
                model: artifact.model,
              });
              await yieldToEventLoop();
              sentStart = true;
              frameCount = artifact.frames.length;
            }

            if (layer === "L1" || layer === "L2") {
              tilesFromCache += 1;
            } else {
              tilesComputed += 1;
            }

            // Filter outdoor points within bbox
            const outdoorPoints: Array<{ id: string; lat: number; lon: number; outdoorIndex: number; pointElevationMeters: number | null }> = [];
            let tileGridCount = 0;
            let tileIndoorExcluded = 0;
            for (const p of artifact.points) {
              if (!pointInBbox(p.lon, p.lat, bbox)) continue;
              tileGridCount += 1;
              if (p.insideBuilding || p.outdoorIndex === null) {
                tileIndoorExcluded += 1;
                continue;
              }
              outdoorPoints.push({ id: p.id, lat: p.lat, lon: p.lon, outdoorIndex: p.outdoorIndex, pointElevationMeters: p.pointElevationMeters });
            }

            totalPointCount += outdoorPoints.length;
            totalGridPointCount += tileGridCount;
            totalIndoorExcluded += tileIndoorExcluded;
            totalPointsWithElevation += outdoorPoints.filter(p => p.pointElevationMeters !== null).length;
            tileStreamTotalEvaluations += outdoorPoints.length * artifact.frames.length;
            for (const w of artifact.warnings) allWarnings.add(w);

            // In non-cache mode, limit the number of tiles that need computation
            if (!query.cacheOnly && layer === "MISS" && tilesComputed > query.maxComputeTiles) {
              sendEvent("error", {
                error: "Too many tiles to compute.",
                details: `Already computed ${tilesComputed} tiles (limit: ${query.maxComputeTiles}). Use cache-only mode or reduce the area.`,
              });
              return;
            }

            // Re-index frame masks to filtered outdoor points
            const tileFrames = artifact.frames.map((frame) => {
              const srcMask = decodeBase64Bytes(frame.sunMaskBase64);
              const dstMask = new Uint8Array(Math.ceil(outdoorPoints.length / 8));
              let sunnyCount = 0;
              for (let i = 0; i < outdoorPoints.length; i++) {
                if (isMaskBitSet(srcMask, outdoorPoints[i].outdoorIndex)) {
                  setMaskBit(dstMask, i);
                  sunnyCount += 1;
                }
              }
              const srcMaskNoVeg = decodeBase64Bytes(frame.sunMaskNoVegetationBase64);
              const dstMaskNoVeg = new Uint8Array(Math.ceil(outdoorPoints.length / 8));
              let sunnyCountNoVeg = 0;
              for (let i = 0; i < outdoorPoints.length; i++) {
                if (isMaskBitSet(srcMaskNoVeg, outdoorPoints[i].outdoorIndex)) {
                  setMaskBit(dstMaskNoVeg, i);
                  sunnyCountNoVeg += 1;
                }
              }
              return {
                index: frame.index,
                localTime: frame.localTime,
                sunnyCount,
                sunnyCountNoVegetation: sunnyCountNoVeg,
                sunMaskBase64: Buffer.from(dstMask).toString("base64"),
                sunMaskNoVegetationBase64: Buffer.from(dstMaskNoVeg).toString("base64"),
              };
            });

            // Send only point IDs (not lat/lon) for large tiles to reduce
            // payload size (~1.8 MB → ~400 KB per tile). The client extracts
            // row/col from the ID for canvas pixel mapping, and uses tile
            // bounds for geo-referencing.
            const compactPoints = outdoorPoints.length > 1000;
            // Track global col/row extremes across all tiles for overlay bounds
            for (const p of outdoorPoints) {
              const m = /^ix(-?\d+)-iy(-?\d+)$/.exec(p.id);
              if (!m) continue;
              const col = +m[1], row = +m[2];
              if (col < globalMinCol) globalMinCol = col;
              if (col > globalMaxCol) globalMaxCol = col;
              if (row < globalMinRow) globalMinRow = row;
              if (row > globalMaxRow) globalMaxRow = row;
            }
            sendEvent("tile", {
              tileId,
              tileIndex,
              totalTiles,
              pointCount: outdoorPoints.length,
              gridPointCount: tileGridCount,
              indoorPointsExcluded: tileIndoorExcluded,
              points: compactPoints
                ? outdoorPoints.map(p => ({ id: p.id }))
                : outdoorPoints.map(p => ({ id: p.id, lat: p.lat, lon: p.lon })),
              frames: tileFrames,
            });
            await yieldToEventLoop();

            result = await tileStream.next();
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
            const sw = lv95ToWgs84(globalMinCol * gs, globalMinRow * gs);
            const ne = lv95ToWgs84((globalMaxCol + 1) * gs, (globalMaxRow + 1) * gs);
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
          return;

          const points: PreparedPoint[] = [];
          const warnings: string[] = [];
          let indoorPointsExcluded = 0;
          let pointsWithElevation = 0;
          let terrainMethod = "none";
          let buildingsMethod = "none";
          let vegetationMethod = "none";
          const preparationStartedAt = performance.now();
          const preparationTotalSteps = grid.length + 1;
          const prepProgressInterval = Math.max(1, Math.floor(grid.length / 200));
          let terrainHorizonOverride:
            | Awaited<ReturnType<typeof buildDynamicHorizonMask>>
            | undefined;

          // Pre-load shared sources ONCE for all points in the grid.
          // Without this, each buildPointEvaluationContext call would
          // independently reload terrain, vegetation, and GPU backend.
          const sw = wgs84ToLv95(query.minLon, query.minLat);
          const ne = wgs84ToLv95(query.maxLon, query.maxLat);
          const lv95Bounds = { minX: sw.easting, minY: sw.northing, maxX: ne.easting, maxY: ne.northing };
          const sharedSources = await buildSharedPointEvaluationSources({
            lv95Bounds,
          });

          sendEvent("progress", {
            phase: "preparing",
            done: 0,
            total: preparationTotalSteps,
            percent: 0,
            etaSeconds: null,
          });
          await yieldToEventLoop();

          try {
            const dynamicMask = await buildDynamicHorizonMask({
              lat: (query.minLat + query.maxLat) / 2,
              lon: (query.minLon + query.maxLon) / 2,
            });
            if (dynamicMask) {
              terrainHorizonOverride = dynamicMask;
              terrainMethod = dynamicMask!.method;
            } else {
              warnings.push(
                "Dynamic terrain horizon unavailable for this area center. Falling back to preprocessed horizon mask when available.",
              );
            }
          } catch (_err) {
            const errMsg = _err instanceof Error ? (_err as Error).message : "unknown error";
            warnings.push(
              `Dynamic terrain horizon build failed (${errMsg}). Falling back to preprocessed horizon mask when available.`,
            );
          }
          const terrainHorizonDebug = extractTerrainHorizonDebug(
            terrainHorizonOverride,
          );
          sendEvent("progress", {
            phase: "preparing",
            done: 1,
            total: preparationTotalSteps,
            percent: Math.round(percent(1, preparationTotalSteps) * 10) / 10,
            etaSeconds: null,
          });
          await yieldToEventLoop();

          for (let gridIndex = 0; gridIndex < grid.length; gridIndex += 1) {
            if (streamAborted) {
              return;
            }

            const point = grid[gridIndex];
            const context = await buildPointEvaluationContext(point.lat, point.lon, {
              skipTerrainSamplingWhenIndoor: true,
              terrainHorizonOverride: terrainHorizonOverride ?? undefined,
              shadowCalibration,
              sharedSources,
            });
            terrainMethod = context.terrainHorizonMethod;
            buildingsMethod = context.buildingsShadowMethod;
            vegetationMethod = context.vegetationShadowMethod ?? "none";
            warnings.push(...context.warnings);

            if (context.insideBuilding) {
              indoorPointsExcluded += 1;
            } else {
              if (points.length >= query.maxPoints) {
                sendEvent("error", {
                  error: "Outdoor grid exceeds maxPoints limit.",
                  details: `Computed more than ${query.maxPoints} outdoor points (raw: ${grid.length}, indoor excluded: ${indoorPointsExcluded}).`,
                });
                return;
              }

              if (context.pointElevationMeters !== null) {
                pointsWithElevation += 1;
              }

              points.push({
                id: point.id,
                lat: point.lat,
                lon: point.lon,
                pointLv95: context.pointLv95,
                pointElevationMeters: context.pointElevationMeters,
                horizonMask: context.horizonMask,
                buildingShadowEvaluator: context.buildingShadowEvaluator,
                vegetationShadowEvaluator: context.vegetationShadowEvaluator,
              });
            }

            const prepDone = gridIndex + 1;
            if (
              prepDone === grid.length ||
              prepDone % prepProgressInterval === 0
            ) {
              const elapsedMs = performance.now() - preparationStartedAt;
              const preparationDoneSteps = prepDone + 1;
              const donePercent = percent(
                preparationDoneSteps,
                preparationTotalSteps,
              );
              const etaSeconds =
                preparationDoneSteps > 0
                  ? Math.max(0, Math.round(
                      ((elapsedMs / preparationDoneSteps) *
                        Math.max(preparationTotalSteps - preparationDoneSteps, 0)) / 1000,
                    ))
                  : null;
              sendEvent("progress", {
                phase: "preparing",
                done: preparationDoneSteps,
                total: preparationTotalSteps,
                percent: Math.round(donePercent * 10) / 10,
                etaSeconds,
              });
              await yieldToEventLoop();
            }
          }

          const samples = createUtcSamples(
            query.date,
            query.timezone,
            query.sampleEveryMinutes,
            query.startLocalTime,
            query.endLocalTime,
          );
          if (samples.length === 0) {
            sendEvent("error", {
              error: "Invalid daily time range.",
              details: `No samples in range ${query.startLocalTime}-${query.endLocalTime} for ${query.date}.`,
            });
            return;
          }
          const totalEvaluations = points.length * samples.length;
          const responseWarnings = dedupeWarnings(warnings);
          const evalStartedAt = performance.now();
          let evaluationsDone = 0;

          sendEvent("start", {
            date: query.date,
            timezone: query.timezone,
            startLocalTime: query.startLocalTime,
            endLocalTime: query.endLocalTime,
            sampleEveryMinutes: query.sampleEveryMinutes,
            gridStepMeters: query.gridStepMeters,
            gridPointCount: grid.length,
            pointCount: points.length,
            indoorPointsExcluded,
            frameCount: samples.length,
            // Skip individual point coordinates for large grids to save memory
            points: points.length <= 10_000
              ? points.map((point) => ({ id: point.id, lat: point.lat, lon: point.lon }))
              : [],
            pointsOmitted: points.length > 10_000,
            model: {
              terrainHorizonMethod: terrainMethod,
              buildingsShadowMethod: buildingsMethod,
              vegetationShadowMethod: vegetationMethod,
              terrainHorizonDebug,
              shadowCalibration,
            },
            cache: buildCacheMissMetadata(),
            warnings: responseWarnings,
          });
          await yieldToEventLoop();

          for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
            if (streamAborted) {
              break;
            }

            const sampleDate = samples[sampleIndex];
            const sunnyMask = new Uint8Array(Math.ceil(points.length / 8));
            const sunnyMaskNoVegetation = new Uint8Array(
              Math.ceil(points.length / 8),
            );
            let sunnyCount = 0;
            let sunnyCountNoVegetation = 0;
            let localTime = "";

            for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
              const point = points[pointIndex];
              const sample = evaluateInstantSunlight({
                lat: point.lat,
                lon: point.lon,
                utcDate: sampleDate,
                timeZone: query.timezone,
                horizonMask: point.horizonMask,
                buildingShadowEvaluator: point.buildingShadowEvaluator,
                vegetationShadowEvaluator: point.vegetationShadowEvaluator,
              });
              if (!localTime) {
                localTime = sample.localTime;
              }

              const isSunnyNoVegetation =
                sample.aboveAstronomicalHorizon &&
                !sample.terrainBlocked &&
                !sample.buildingsBlocked;
              if (isSunnyNoVegetation) {
                sunnyMaskNoVegetation[pointIndex >> 3] |= 1 << (pointIndex & 7);
                sunnyCountNoVegetation += 1;
              }

              if (sample.isSunny) {
                sunnyMask[pointIndex >> 3] |= 1 << (pointIndex & 7);
                sunnyCount += 1;
              }

              evaluationsDone += 1;
            }

            sendEvent("frame", {
              index: sampleIndex,
              localTime,
              sunnyCount,
              sunnyCountNoVegetation,
              sunMaskBase64: Buffer.from(sunnyMask).toString("base64"),
              sunMaskNoVegetationBase64: Buffer.from(
                sunnyMaskNoVegetation,
              ).toString("base64"),
            });

            const elapsedMs = performance.now() - evalStartedAt;
            const donePercent = percent(evaluationsDone, totalEvaluations);
            const evalEtaSeconds =
              evaluationsDone > 0
                ? Math.max(0, Math.round(
                    ((elapsedMs / evaluationsDone) *
                      Math.max(totalEvaluations - evaluationsDone, 0)) / 1000,
                  ))
                : null;

            sendEvent("progress", {
              phase: "evaluation",
              done: evaluationsDone,
              total: totalEvaluations,
              percent: Math.round(donePercent * 10) / 10,
              etaSeconds: evalEtaSeconds,
            });
            await yieldToEventLoop();
          }

          sendEvent("done", {
            stats: {
              elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
              evaluationElapsedMs:
                Math.round((performance.now() - evalStartedAt) * 1000) / 1000,
              pointsWithElevation,
              pointsWithoutElevation: points.length - pointsWithElevation,
              indoorPointsExcluded,
              frameCount: samples.length,
              totalEvaluations,
            },
            cache: buildCacheMissMetadata(),
            warnings: responseWarnings,
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
