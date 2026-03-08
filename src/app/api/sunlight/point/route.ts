import { NextResponse } from "next/server";
import { z } from "zod";

import { loadLausanneHorizonMask } from "@/lib/sun/horizon-mask";
import { evaluatePointSunlight } from "@/lib/sun/solar";

export const runtime = "nodejs";

const requestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().default("Europe/Zurich"),
  sampleEveryMinutes: z.number().int().min(1).max(60).default(15),
});

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request payload.",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  try {
    const horizonMask = await loadLausanneHorizonMask();
    const result = evaluatePointSunlight({
      lat: parsed.data.lat,
      lon: parsed.data.lon,
      date: parsed.data.date,
      timeZone: parsed.data.timezone,
      sampleEveryMinutes: parsed.data.sampleEveryMinutes,
      horizonMask,
    });

    return NextResponse.json({
      ...result,
      model: {
        terrainHorizonMethod: horizonMask?.method ?? "none",
        buildingsShadowMethod: "pending",
      },
      warnings: horizonMask
        ? []
        : [
            "No horizon mask found. Run preprocess:lausanne:horizon to enable terrain blocking.",
          ],
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Sunlight calculation failed.",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
