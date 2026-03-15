import { NextResponse } from "next/server";
import { z } from "zod";

import {
  purgeCacheRuns,
  verifyCacheRuns,
} from "@/lib/admin/cache-admin";
import {
  listCachePrecomputeJobs,
  startCachePrecomputeJob,
} from "@/lib/admin/cache-precompute-jobs";

export const runtime = "nodejs";

const bodySchema = z.object({
  action: z.enum(["verify", "purge", "precompute"]),
  filters: z
    .object({
      region: z.enum(["lausanne", "nyon"]).optional(),
      modelVersionHash: z.string().min(1).optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .default({}),
  dryRun: z.boolean().optional(),
  precompute: z
    .object({
      region: z.enum(["lausanne", "nyon"]),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      days: z.number().int().min(1).max(31).default(1),
      timezone: z.string().default("Europe/Zurich"),
      sampleEveryMinutes: z.number().int().min(1).max(60).default(15),
      gridStepMeters: z.number().int().min(1).max(2000).default(1),
      startLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("00:00"),
      endLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("23:59"),
      tileIds: z.array(z.string().min(1)).min(1).max(20_000).optional(),
      skipExisting: z.boolean().default(true),
      buildingHeightBiasMeters: z.number().min(-20).max(20).optional(),
    })
    .strict()
    .optional(),
});

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid admin cache action payload.",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  try {
    console.info("[cache-admin-api] action request received", {
      action: parsed.data.action,
      filters: parsed.data.filters,
    });

    if (parsed.data.action === "verify") {
      const result = await verifyCacheRuns(parsed.data.filters);
      console.info("[cache-admin-api] verify completed", {
        manifestsMatched: result.manifestsMatched,
        tilesVerified: result.tilesVerified,
        problems: result.problems.length,
      });
      return NextResponse.json(result);
    }
    if (parsed.data.action === "precompute") {
      if (!parsed.data.precompute) {
        return NextResponse.json(
          { error: "Missing precompute payload." },
          { status: 400 },
        );
      }
      const activeJobs = listCachePrecomputeJobs().filter(
        (job) => job.status === "queued" || job.status === "running",
      );
      if (activeJobs.length > 0) {
        const activeJobIds = activeJobs.map((job) => job.jobId);
        console.warn("[cache-admin-api] precompute rejected (active job exists)", {
          activeJobIds,
          count: activeJobs.length,
        });
        return NextResponse.json(
          {
            error: "A precompute job is already running.",
            details:
              "Un job precompute est déjà en cours. Annule ou attends la fin avant d'en lancer un nouveau.",
            activeJobIds,
          },
          { status: 409 },
        );
      }
      console.info("[cache-admin-api] precompute enqueue", {
        region: parsed.data.precompute.region,
        startDate: parsed.data.precompute.startDate,
        days: parsed.data.precompute.days,
        sampleEveryMinutes: parsed.data.precompute.sampleEveryMinutes,
        gridStepMeters: parsed.data.precompute.gridStepMeters,
        startLocalTime: parsed.data.precompute.startLocalTime,
        endLocalTime: parsed.data.precompute.endLocalTime,
        selectedTileCount: parsed.data.precompute.tileIds?.length ?? null,
        skipExisting: parsed.data.precompute.skipExisting,
      });
      const job = startCachePrecomputeJob(parsed.data.precompute);
      console.info("[cache-admin-api] precompute enqueued", {
        jobId: job.jobId,
        status: job.status,
      });
      return NextResponse.json(
        {
          jobId: job.jobId,
          status: job.status,
          createdAt: job.createdAt,
        },
        { status: 202 },
      );
    }

    const result = await purgeCacheRuns(parsed.data.filters, {
      dryRun: parsed.data.dryRun ?? false,
    });
    console.info("[cache-admin-api] purge completed", {
      dryRun: parsed.data.dryRun ?? false,
      runsMatched: result.runsMatched,
      removedRunDirs: result.removedRunDirs.length,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[cache-admin-api] action failed", {
      action: parsed.data.action,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      {
        error: "Failed to execute admin cache action.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

