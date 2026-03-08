import { performance } from "node:perf_hooks";

import { NextResponse } from "next/server";
import { z } from "zod";

import { buildGridFromBbox } from "@/lib/geo/grid";
import { buildDynamicHorizonMask } from "@/lib/sun/dynamic-horizon-mask";
import { buildPointEvaluationContext } from "@/lib/sun/evaluation-context";
import { evaluateInstantSunlight } from "@/lib/sun/solar";
import { getZonedDayRangeUtc } from "@/lib/time/zoned-date";

export const runtime = "nodejs";

const MAX_RAW_GRID_POINTS = 20_000;

const querySchema = z
  .object({
    minLon: z.coerce.number(),
    minLat: z.coerce.number(),
    maxLon: z.coerce.number(),
    maxLat: z.coerce.number(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().default("Europe/Zurich"),
    sampleEveryMinutes: z.coerce.number().int().min(1).max(60).default(15),
    gridStepMeters: z.coerce.number().int().min(1).max(2000).default(250),
    maxPoints: z.coerce.number().int().min(1).max(5000).default(3000),
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
): Date[] {
  const { startUtc, endUtc } = getZonedDayRangeUtc(date, timeZone);
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
          const points: PreparedPoint[] = [];
          const warnings: string[] = [];
          let indoorPointsExcluded = 0;
          let pointsWithElevation = 0;
          let terrainMethod = "none";
          let buildingsMethod = "none";
          const preparationStartedAt = performance.now();
          const preparationTotalSteps = grid.length + 1;
          const prepProgressInterval = Math.max(1, Math.floor(grid.length / 200));
          let terrainHorizonOverride:
            | Awaited<ReturnType<typeof buildDynamicHorizonMask>>
            | undefined;

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
              terrainMethod = dynamicMask.method;
            } else {
              warnings.push(
                "Dynamic terrain horizon unavailable for this area center. Falling back to preprocessed Lausanne horizon mask when available.",
              );
            }
          } catch (error) {
            warnings.push(
              `Dynamic terrain horizon build failed (${error instanceof Error ? error.message : "unknown error"}). Falling back to preprocessed Lausanne horizon mask when available.`,
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
            });
            terrainMethod = context.terrainHorizonMethod;
            buildingsMethod = context.buildingsShadowMethod;
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
              const etaMs =
                preparationDoneSteps > 0
                  ? (elapsedMs / preparationDoneSteps) *
                    Math.max(preparationTotalSteps - preparationDoneSteps, 0)
                  : null;
              sendEvent("progress", {
                phase: "preparing",
                done: preparationDoneSteps,
                total: preparationTotalSteps,
                percent: Math.round(donePercent * 10) / 10,
                etaSeconds:
                  etaMs === null ? null : Math.max(0, Math.round(etaMs / 1000)),
              });
              await yieldToEventLoop();
            }
          }

          const samples = createUtcSamples(
            query.date,
            query.timezone,
            query.sampleEveryMinutes,
          );
          const totalEvaluations = points.length * samples.length;
          const responseWarnings = dedupeWarnings(warnings);
          const evalStartedAt = performance.now();
          let evaluationsDone = 0;

          sendEvent("start", {
            date: query.date,
            timezone: query.timezone,
            sampleEveryMinutes: query.sampleEveryMinutes,
            gridStepMeters: query.gridStepMeters,
            gridPointCount: grid.length,
            pointCount: points.length,
            indoorPointsExcluded,
            frameCount: samples.length,
            points: points.map((point) => ({
              id: point.id,
              lat: point.lat,
              lon: point.lon,
            })),
            model: {
              terrainHorizonMethod: terrainMethod,
              buildingsShadowMethod: buildingsMethod,
              terrainHorizonDebug,
            },
            warnings: responseWarnings,
          });
          await yieldToEventLoop();

          for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
            if (streamAborted) {
              break;
            }

            const sampleDate = samples[sampleIndex];
            const sunnyMask = new Uint8Array(Math.ceil(points.length / 8));
            let sunnyCount = 0;
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
              });
              if (!localTime) {
                localTime = sample.localTime;
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
              sunMaskBase64: Buffer.from(sunnyMask).toString("base64"),
            });

            const elapsedMs = performance.now() - evalStartedAt;
            const donePercent = percent(evaluationsDone, totalEvaluations);
            const etaMs =
              evaluationsDone > 0
                ? (elapsedMs / evaluationsDone) *
                    Math.max(totalEvaluations - evaluationsDone, 0)
                : null;

            sendEvent("progress", {
              phase: "evaluation",
              done: evaluationsDone,
              total: totalEvaluations,
              percent: Math.round(donePercent * 10) / 10,
              etaSeconds:
                etaMs === null ? null : Math.max(0, Math.round(etaMs / 1000)),
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
        error: "Daily timeline calculation failed.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
