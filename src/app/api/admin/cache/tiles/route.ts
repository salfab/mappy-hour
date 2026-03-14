import { NextResponse } from "next/server";
import { z } from "zod";

import { CANONICAL_PRECOMPUTE_TILE_SIZE_METERS } from "@/lib/precompute/constants";
import {
  buildRegionTiles,
  getPrecomputedRegionBbox,
} from "@/lib/precompute/sunlight-cache";

export const runtime = "nodejs";

const querySchema = z.object({
  region: z.enum(["lausanne", "nyon"]),
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    region: searchParams.get("region") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid cache tiles query.",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const region = parsed.data.region;
  const tileSizeMeters = CANONICAL_PRECOMPUTE_TILE_SIZE_METERS;
  const tiles = buildRegionTiles(region, tileSizeMeters);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    region,
    tileSizeMeters,
    bbox: getPrecomputedRegionBbox(region),
    tileCount: tiles.length,
    tiles: tiles.map((tile) => ({
      tileId: tile.tileId,
      bbox: tile.bbox,
      minEasting: tile.minEasting,
      minNorthing: tile.minNorthing,
      maxEasting: tile.maxEasting,
      maxNorthing: tile.maxNorthing,
    })),
  });
}

