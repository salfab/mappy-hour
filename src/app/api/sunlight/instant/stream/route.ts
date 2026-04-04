import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import { z } from "zod";

import { buildGridFromBbox } from "@/lib/geo/grid";
import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import { normalizeShadowCalibration } from "@/lib/sun/shadow-calibration";
import { evaluateInstantSunlight } from "@/lib/sun/solar";
import { zonedDateTimeToUtc } from "@/lib/time/zoned-date";

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
    localTime: z.string().regex(/^\d{2}:\d{2}$/).default("12:00"),
    gridStepMeters: z.coerce.number().int().min(1).max(2000).default(250),
    maxPoints: z.coerce.number().int().min(1).max(12000).default(6000),
    buildingHeightBiasMeters: z.coerce.number().min(-20).max(20).default(0),
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

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings));
}

function percent(done: number, total: number): number {
  if (total <= 0) {
    return 100;
  }
  return Math.max(0, Math.min(100, (done / total) * 100));
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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
    const grid = buildGridFromBbox(
      {
        minLon: query.minLon,
        minLat: query.minLat,
        maxLon: query.maxLon,
        maxLat: query.maxLat,
      },
      query.gridStepMeters,
    );

    if (grid.length > MAX_RAW_GRID_POINTS) {
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

        const sendEvent = (event: string, payload: unknown) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
          );
        };

        const run = async () => {
          const warnings: string[] = [];
          const utcDate = zonedDateTimeToUtc(query.date, query.localTime, query.timezone);
          const totalSteps = grid.length + 1;
          const startedAt = performance.now();
          const partialBatchSize = 120;
          const progressInterval = Math.max(1, Math.floor(grid.length / 200));

          let terrainMethod = "none";
          let buildingsMethod = "none";
          let vegetationMethod = "none";
          let pointsWithElevation = 0;
          let indoorPointsExcluded = 0;
          let outdoorPointCount = 0;
          let processedRawPoints = 0;
          let terrainHorizonOverride:
            | Awaited<ReturnType<typeof buildDynamicHorizonMask>>
            | undefined;

          sendEvent("progress", {
            phase: "preparing",
            done: 0,
            total: totalSteps,
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
              terrainMethod = dynamicMask.method;
            } else {
              warnings.push(
                "Dynamic terrain horizon unavailable for this area center. Falling back to preprocessed horizon mask when available.",
              );
            }
          } catch (error) {
            warnings.push(
              `Dynamic terrain horizon build failed (${error instanceof Error ? error.message : "unknown error"}). Falling back to preprocessed horizon mask when available.`,
            );
          }

          const terrainHorizonDebug = extractTerrainHorizonDebug(terrainHorizonOverride);
          sendEvent("start", {
            mode: "instant",
            date: query.date,
            timezone: query.timezone,
            localTime: query.localTime,
            utcTime: utcDate.toISOString(),
            bbox: {
              minLon: query.minLon,
              minLat: query.minLat,
              maxLon: query.maxLon,
              maxLat: query.maxLat,
            },
            gridStepMeters: query.gridStepMeters,
            gridPointCount: grid.length,
            model: {
              terrainHorizonMethod: terrainMethod,
              buildingsShadowMethod: buildingsMethod,
              vegetationShadowMethod: vegetationMethod,
              terrainHorizonDebug,
              shadowCalibration,
            },
            warnings: dedupeWarnings(warnings),
          });
          sendEvent("progress", {
            phase: "evaluation",
            done: 1,
            total: totalSteps,
            percent: Math.round(percent(1, totalSteps) * 10) / 10,
            etaSeconds: null,
          });
          await yieldToEventLoop();

          const pointsBatch: Array<{
            id: string;
            lat: number;
            lon: number;
            lv95Easting: number;
            lv95Northing: number;
            pointElevationMeters: number | null;
            isSunny: boolean;
            terrainBlocked: boolean;
            buildingsBlocked: boolean;
            vegetationBlocked: boolean;
            altitudeDeg: number;
            azimuthDeg: number;
            horizonAngleDeg: number | null;
            buildingBlockerId: string | null;
            insideBuilding: boolean;
            indoorBuildingId: string | null;
          }> = [];

          for (const point of grid) {
            if (streamAborted) {
              return;
            }

            const context = await buildPointEvaluationContext(point.lat, point.lon, {
              skipTerrainSamplingWhenIndoor: true,
              terrainHorizonOverride: terrainHorizonOverride ?? undefined,
              shadowCalibration,
            });
            terrainMethod = context.terrainHorizonMethod;
            buildingsMethod = context.buildingsShadowMethod;
            vegetationMethod = context.vegetationShadowMethod ?? "none";
            warnings.push(...context.warnings);
            processedRawPoints += 1;

            if (context.insideBuilding) {
              indoorPointsExcluded += 1;
            } else {
              outdoorPointCount += 1;
              if (outdoorPointCount > query.maxPoints) {
                sendEvent("error", {
                  error: "Outdoor grid exceeds maxPoints limit.",
                  details: `Computed more than ${query.maxPoints} outdoor points (raw: ${grid.length}, indoor excluded: ${indoorPointsExcluded}).`,
                });
                return;
              }

              if (context.pointElevationMeters !== null) {
                pointsWithElevation += 1;
              }

              const sample = evaluateInstantSunlight({
                lat: point.lat,
                lon: point.lon,
                utcDate,
                timeZone: query.timezone,
                horizonMask: context.horizonMask,
                buildingShadowEvaluator: context.buildingShadowEvaluator,
                vegetationShadowEvaluator: context.vegetationShadowEvaluator,
              });

              pointsBatch.push({
                id: point.id,
                lat: point.lat,
                lon: point.lon,
                lv95Easting: Math.round(context.pointLv95.easting * 1000) / 1000,
                lv95Northing: Math.round(context.pointLv95.northing * 1000) / 1000,
                pointElevationMeters: context.pointElevationMeters,
                isSunny: sample.isSunny,
                terrainBlocked: sample.terrainBlocked,
                buildingsBlocked: sample.buildingsBlocked,
                vegetationBlocked: sample.vegetationBlocked,
                altitudeDeg: Math.round(sample.altitudeDeg * 1000) / 1000,
                azimuthDeg: Math.round(sample.azimuthDeg * 1000) / 1000,
                horizonAngleDeg:
                  sample.horizonAngleDeg === null
                    ? null
                    : Math.round(sample.horizonAngleDeg * 1000) / 1000,
                buildingBlockerId: sample.buildingBlockerId,
                insideBuilding: false,
                indoorBuildingId: null,
              });
            }

            if (pointsBatch.length >= partialBatchSize) {
              sendEvent("partial", {
                points: pointsBatch.splice(0, pointsBatch.length),
                pointCount: outdoorPointCount,
                indoorPointsExcluded,
              });
              await yieldToEventLoop();
            }

            if (
              processedRawPoints === grid.length ||
              processedRawPoints % progressInterval === 0
            ) {
              const elapsedMs = performance.now() - startedAt;
              const doneSteps = processedRawPoints + 1;
              const donePercent = percent(doneSteps, totalSteps);
              const etaMs =
                doneSteps > 0
                  ? (elapsedMs / doneSteps) * Math.max(totalSteps - doneSteps, 0)
                  : null;
              sendEvent("progress", {
                phase: "evaluation",
                done: doneSteps,
                total: totalSteps,
                percent: Math.round(donePercent * 10) / 10,
                etaSeconds:
                  etaMs === null ? null : Math.max(0, Math.round(etaMs / 1000)),
              });
              await yieldToEventLoop();
            }
          }

          if (pointsBatch.length > 0) {
            sendEvent("partial", {
              points: pointsBatch,
              pointCount: outdoorPointCount,
              indoorPointsExcluded,
            });
            await yieldToEventLoop();
          }

          sendEvent("done", {
            mode: "instant",
            date: query.date,
            timezone: query.timezone,
            localTime: query.localTime,
            utcTime: utcDate.toISOString(),
            bbox: {
              minLon: query.minLon,
              minLat: query.minLat,
              maxLon: query.maxLon,
              maxLat: query.maxLat,
            },
            gridStepMeters: query.gridStepMeters,
            pointCount: outdoorPointCount,
            gridPointCount: grid.length,
            model: {
              terrainHorizonMethod: terrainMethod,
              buildingsShadowMethod: buildingsMethod,
              vegetationShadowMethod: vegetationMethod,
              terrainHorizonDebug,
              shadowCalibration,
            },
            warnings: dedupeWarnings(warnings),
            stats: {
              elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
              pointsWithElevation,
              pointsWithoutElevation: outdoorPointCount - pointsWithElevation,
              indoorPointsExcluded,
            },
          });
        };

        void run()
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : "Unknown streaming error";
            sendEvent("error", {
              error: "Instant streaming failed.",
              details: message,
            });
          })
          .finally(() => {
            controller.close();
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
        error: "Instant area streaming failed.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
