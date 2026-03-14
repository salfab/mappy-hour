import { NextResponse } from "next/server";
import { z } from "zod";

import { listCacheRuns } from "@/lib/admin/cache-admin";

export const runtime = "nodejs";

const querySchema = z.object({
  region: z.enum(["lausanne", "nyon"]).optional(),
  modelVersionHash: z.string().min(1).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sortBy: z
    .enum([
      "date",
      "generatedAt",
      "sizeBytes",
      "tileCount",
      "failedTileCount",
      "gridStepMeters",
      "sampleEveryMinutes",
    ])
    .optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      region: url.searchParams.get("region") ?? undefined,
      modelVersionHash: url.searchParams.get("modelVersionHash") ?? undefined,
      startDate: url.searchParams.get("startDate") ?? undefined,
      endDate: url.searchParams.get("endDate") ?? undefined,
      sortBy: url.searchParams.get("sortBy") ?? undefined,
      sortOrder: url.searchParams.get("sortOrder") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid admin cache query.",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const result = await listCacheRuns(
      {
        region: parsed.data.region,
        modelVersionHash: parsed.data.modelVersionHash,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
      },
      {
        sortBy: parsed.data.sortBy,
        sortOrder: parsed.data.sortOrder,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to list cache runs.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
