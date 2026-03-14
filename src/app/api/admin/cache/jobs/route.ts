import { NextResponse } from "next/server";

import { listCachePrecomputeJobs } from "@/lib/admin/cache-precompute-jobs";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      jobs: listCachePrecomputeJobs(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to list precompute jobs.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

