import { NextResponse } from "next/server";
import { z } from "zod";

import { purgeCacheRuns, verifyCacheRuns } from "@/lib/admin/cache-admin";

export const runtime = "nodejs";

const bodySchema = z.object({
  action: z.enum(["verify", "purge"]),
  filters: z
    .object({
      region: z.enum(["lausanne", "nyon"]).optional(),
      modelVersionHash: z.string().min(1).optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .default({}),
  dryRun: z.boolean().optional(),
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
