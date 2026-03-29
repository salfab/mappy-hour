import { NextResponse } from "next/server";
import { z } from "zod";

import { getCacheRunDetail } from "@/lib/admin/cache-admin";

export const runtime = "nodejs";

const querySchema = z.object({
  region: z.enum(["lausanne", "nyon"]),
  modelVersionHash: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gridStepMeters: z.coerce.number().int().min(1).max(2000),
  sampleEveryMinutes: z.coerce.number().int().min(1).max(60),
  startLocalTime: z.string().regex(/^\d{2}:\d{2}$/),
  endLocalTime: z.string().regex(/^\d{2}:\d{2}$/),
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    region: searchParams.get("region") ?? undefined,
    modelVersionHash: searchParams.get("modelVersionHash") ?? undefined,
    date: searchParams.get("date") ?? undefined,
    gridStepMeters: searchParams.get("gridStepMeters") ?? undefined,
    sampleEveryMinutes: searchParams.get("sampleEveryMinutes") ?? undefined,
    startLocalTime: searchParams.get("startLocalTime") ?? undefined,
    endLocalTime: searchParams.get("endLocalTime") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid run detail query.",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  try {
    const detail = await getCacheRunDetail(parsed.data);
    if (!detail) {
      return NextResponse.json(
        {
          error: "Cache run not found.",
        },
        { status: 404 },
      );
    }
    return NextResponse.json(detail);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load cache run detail.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
