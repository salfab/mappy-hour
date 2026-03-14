import { NextResponse } from "next/server";
import { z } from "zod";

import {
  cancelCachePrecomputeJob,
  getCachePrecomputeJob,
  isCachePrecomputeJobExecuting,
  rejectCachePrecomputeJob,
  resumeCachePrecomputeJob,
} from "@/lib/admin/cache-precompute-jobs";

export const runtime = "nodejs";

const actionSchema = z.object({
  action: z.enum(["cancel", "resume", "reject"]),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const job = getCachePrecomputeJob(jobId);
  if (!job) {
    console.warn("[cache-admin-api] job lookup miss", { jobId });
    return NextResponse.json(
      { error: `Unknown precompute job '${jobId}'.` },
      { status: 404 },
    );
  }
  return NextResponse.json(job);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = actionSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid job action payload.",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  if (parsed.data.action === "cancel") {
    const job = cancelCachePrecomputeJob(jobId);
    if (!job) {
      return NextResponse.json(
        { error: `Unknown precompute job '${jobId}'.` },
        { status: 404 },
      );
    }
    if (job.status === "completed") {
      return NextResponse.json(
        {
          error: "Cannot cancel completed precompute job.",
          details: "Le job est déjà terminé. Utilise l'action reject si tu veux nettoyer ce run.",
        },
        { status: 409 },
      );
    }

    const deadline = Date.now() + 20_000;
    while (isCachePrecomputeJobExecuting(jobId) && Date.now() < deadline) {
      await sleep(200);
    }
    if (isCachePrecomputeJobExecuting(jobId)) {
      return NextResponse.json(
        {
          error: "Cancel timed out before job stopped.",
          details:
            "L'arrêt du job prend plus de temps que prévu. Réessaie dans quelques secondes.",
        },
        { status: 409 },
      );
    }

    try {
      const rejected = await rejectCachePrecomputeJob(jobId);
      return NextResponse.json({
        jobId,
        status: "cancelled",
        rejected: rejected !== null,
        removedRunDirs: rejected?.removedRunDirs.length ?? 0,
        removedSnapshot: rejected?.removedSnapshot ?? false,
      });
    } catch (error) {
      return NextResponse.json(
        {
          error: "Failed to cancel/reject precompute job.",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 409 },
      );
    }
  }

  if (parsed.data.action === "reject") {
    try {
      const rejected = await rejectCachePrecomputeJob(jobId);
      if (!rejected) {
        return NextResponse.json(
          { error: `Unknown precompute job '${jobId}'.` },
          { status: 404 },
        );
      }
      return NextResponse.json(rejected);
    } catch (error) {
      return NextResponse.json(
        {
          error: "Failed to reject precompute job.",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 409 },
      );
    }
  }

  try {
    const resumed = resumeCachePrecomputeJob(jobId);
    if (!resumed) {
      return NextResponse.json(
        { error: `Unknown precompute job '${jobId}'.` },
        { status: 404 },
      );
    }
    return NextResponse.json(resumed, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to resume precompute job.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 409 },
    );
  }
}

