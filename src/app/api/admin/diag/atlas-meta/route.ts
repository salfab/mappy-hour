import { NextResponse } from "next/server";

import { loadPrecomputedTileAtlasesInPrecisionOrder } from "@/lib/precompute/sunlight-cache-atlas";
import type { PrecomputedRegionName } from "@/lib/precompute/sunlight-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const region = (url.searchParams.get("region") ?? "lausanne") as PrecomputedRegionName;
  const modelVersionHash = url.searchParams.get("modelVersionHash") ?? "f0dc41e3ff51095d";
  const gridStepMeters = Number(url.searchParams.get("gridStepMeters") ?? "1");
  const tileId = url.searchParams.get("tileId") ?? "e2538250_n1152250_s250";

  try {
    const atlases = await loadPrecomputedTileAtlasesInPrecisionOrder({
      region,
      modelVersionHash,
      gridStepMeters,
      tileId,
    });
    return NextResponse.json({
      params: { region, modelVersionHash, gridStepMeters, tileId },
      atlasCount: atlases.length,
      atlases: atlases.map((a) => ({
        atlasFormatVersion: a.meta.atlasFormatVersion,
        modelVersionHash: a.meta.modelVersionHash,
        resolutionDegAz: a.meta.resolutionDegAz,
        resolutionDegAlt: a.meta.resolutionDegAlt,
        bucketCount: a.bucketCount,
        outdoorPointCount: a.outdoorPointCount,
        warnings: a.meta.warnings,
        model: a.meta.model,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "load failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
