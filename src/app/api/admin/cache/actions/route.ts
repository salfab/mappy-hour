import { NextResponse } from "next/server";
import { z } from "zod";

import {
  purgeCacheRuns,
  verifyCacheRuns,
} from "@/lib/admin/cache-admin";
import { startCachePrecomputeJob } from "@/lib/admin/cache-precompute-jobs";

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
      gridStepMeters: z.number().int().min(1).max(2000).default(5),
      startLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("00:00"),
      endLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("23:59"),
      skipExisting: z.boolean().default(true),
      observerHeightMeters: z.number().min(-5).max(20).optional(),
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
    if (parsed.data.action === "verify") {
      const result = await verifyCacheRuns(parsed.data.filters);
      return NextResponse.json(result);
    }
    if (parsed.data.action === "precompute") {
      if (!parsed.data.precompute) {
        return NextResponse.json(
          { error: "Missing precompute payload." },
          { status: 400 },
        );
      }
      const job = startCachePrecomputeJob(parsed.data.precompute);
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
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to execute admin cache action.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
