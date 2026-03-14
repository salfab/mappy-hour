import { NextResponse } from "next/server";

import { getCachePrecomputeJob } from "@/lib/admin/cache-precompute-jobs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const job = getCachePrecomputeJob(jobId);
  if (!job) {
    return NextResponse.json(
      { error: `Unknown precompute job '${jobId}'.` },
      { status: 404 },
    );
  }
  return NextResponse.json(job);
}
