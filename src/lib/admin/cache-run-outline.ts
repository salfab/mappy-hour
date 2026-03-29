import { lv95ToWgs84 } from "@/lib/geo/projection";

interface Lv95Point {
  easting: number;
  northing: number;
}

interface TileBounds {
  minEasting: number;
  minNorthing: number;
  sizeMeters: number;
}

interface DirectedEdge {
  start: Lv95Point;
  end: Lv95Point;
  direction: 0 | 1 | 2 | 3;
}

const TILE_ID_PATTERN = /^e(-?\d+)_n(-?\d+)_s(\d+)$/;
const TURN_PRIORITY: ReadonlyArray<number> = [1, 0, 3, 2];

function pointKey(point: Lv95Point): string {
  return `${point.easting},${point.northing}`;
}

function toUndirectedEdgeKey(start: Lv95Point, end: Lv95Point): string {
  const startKey = pointKey(start);
  const endKey = pointKey(end);
  return startKey < endKey
    ? `${startKey}|${endKey}`
    : `${endKey}|${startKey}`;
}

function detectDirection(start: Lv95Point, end: Lv95Point): 0 | 1 | 2 | 3 {
  const deltaE = end.easting - start.easting;
  const deltaN = end.northing - start.northing;
  if (deltaN === 0 && deltaE > 0) {
    return 0;
  }
  if (deltaE === 0 && deltaN > 0) {
    return 1;
  }
  if (deltaN === 0 && deltaE < 0) {
    return 2;
  }
  if (deltaE === 0 && deltaN < 0) {
    return 3;
  }
  throw new Error(
    `Unsupported boundary segment (${start.easting},${start.northing}) -> (${end.easting},${end.northing}).`,
  );
}

function parseTileId(tileId: string): TileBounds | null {
  const match = TILE_ID_PATTERN.exec(tileId);
  if (!match) {
    return null;
  }
  const minEasting = Number(match[1]);
  const minNorthing = Number(match[2]);
  const sizeMeters = Number(match[3]);
  if (
    !Number.isFinite(minEasting) ||
    !Number.isFinite(minNorthing) ||
    !Number.isFinite(sizeMeters) ||
    sizeMeters <= 0
  ) {
    return null;
  }
  return {
    minEasting,
    minNorthing,
    sizeMeters,
  };
}

function simplifyClosedRing(points: Lv95Point[]): Lv95Point[] {
  if (points.length < 3) {
    return [];
  }

  const closedPoints = (() => {
    const first = points[0];
    const last = points[points.length - 1];
    if (last && first && pointKey(first) === pointKey(last)) {
      return points;
    }
    return [...points, first];
  })();

  const openPoints = closedPoints.slice(0, -1);
  if (openPoints.length < 3) {
    return [];
  }

  const simplified = openPoints.filter((point, index) => {
    const previous = openPoints[(index - 1 + openPoints.length) % openPoints.length];
    const next = openPoints[(index + 1) % openPoints.length];
    const collinearVertical =
      previous.easting === point.easting && point.easting === next.easting;
    const collinearHorizontal =
      previous.northing === point.northing && point.northing === next.northing;
    return !(collinearVertical || collinearHorizontal);
  });

  if (simplified.length < 3) {
    return [];
  }

  return [...simplified, simplified[0]];
}

function chooseNextEdgeIndex(
  edges: DirectedEdge[],
  previousDirection: 0 | 1 | 2 | 3,
  candidates: number[],
): number {
  let winner = candidates[0]!;
  let winnerRank = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const direction = edges[candidate]!.direction;
    const delta = (direction - previousDirection + 4) % 4;
    const rank = TURN_PRIORITY.indexOf(delta);
    const normalizedRank = rank === -1 ? TURN_PRIORITY.length : rank;
    if (
      normalizedRank < winnerRank ||
      (normalizedRank === winnerRank && candidate < winner)
    ) {
      winner = candidate;
      winnerRank = normalizedRank;
    }
  }

  return winner;
}

export function buildOutlineRingsFromTileIdsLv95(
  tileIds: string[],
): Lv95Point[][] {
  if (tileIds.length === 0) {
    return [];
  }

  const boundaryByUndirectedEdge = new Map<string, DirectedEdge>();
  for (const tileId of tileIds) {
    const parsed = parseTileId(tileId);
    if (!parsed) {
      continue;
    }

    const minE = parsed.minEasting;
    const minN = parsed.minNorthing;
    const maxE = parsed.minEasting + parsed.sizeMeters;
    const maxN = parsed.minNorthing + parsed.sizeMeters;

    const southWest = { easting: minE, northing: minN };
    const southEast = { easting: maxE, northing: minN };
    const northEast = { easting: maxE, northing: maxN };
    const northWest = { easting: minE, northing: maxN };

    const segments: Array<{ start: Lv95Point; end: Lv95Point }> = [
      { start: southWest, end: southEast },
      { start: southEast, end: northEast },
      { start: northEast, end: northWest },
      { start: northWest, end: southWest },
    ];

    for (const segment of segments) {
      const edgeKey = toUndirectedEdgeKey(segment.start, segment.end);
      if (boundaryByUndirectedEdge.has(edgeKey)) {
        boundaryByUndirectedEdge.delete(edgeKey);
      } else {
        boundaryByUndirectedEdge.set(edgeKey, {
          start: segment.start,
          end: segment.end,
          direction: detectDirection(segment.start, segment.end),
        });
      }
    }
  }

  const edges = Array.from(boundaryByUndirectedEdge.values());
  if (edges.length === 0) {
    return [];
  }

  const outgoingByPoint = new Map<string, number[]>();
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]!;
    const startKey = pointKey(edge.start);
    const bucket = outgoingByPoint.get(startKey);
    if (bucket) {
      bucket.push(index);
    } else {
      outgoingByPoint.set(startKey, [index]);
    }
  }

  const usedEdges = new Set<number>();
  const rings: Lv95Point[][] = [];
  const maxSteps = edges.length * 6;

  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    if (usedEdges.has(edgeIndex)) {
      continue;
    }

    const firstEdge = edges[edgeIndex]!;
    const startKey = pointKey(firstEdge.start);
    const ring: Lv95Point[] = [];
    let currentEdgeIndex = edgeIndex;
    let steps = 0;

    while (steps < maxSteps) {
      steps += 1;
      if (usedEdges.has(currentEdgeIndex)) {
        break;
      }

      const edge = edges[currentEdgeIndex]!;
      usedEdges.add(currentEdgeIndex);

      if (ring.length === 0) {
        ring.push(edge.start);
      }
      ring.push(edge.end);

      const endKey = pointKey(edge.end);
      if (endKey === startKey) {
        break;
      }

      const candidateIndexes =
        outgoingByPoint
          .get(endKey)
          ?.filter((candidateIndex) => !usedEdges.has(candidateIndex)) ?? [];

      if (candidateIndexes.length === 0) {
        break;
      }

      currentEdgeIndex = chooseNextEdgeIndex(
        edges,
        edge.direction,
        candidateIndexes,
      );
    }

    const simplified = simplifyClosedRing(ring);
    if (simplified.length >= 4) {
      rings.push(simplified);
    }
  }

  rings.sort((left, right) => {
    const leftAnchor = left[0]!;
    const rightAnchor = right[0]!;
    if (leftAnchor.northing !== rightAnchor.northing) {
      return leftAnchor.northing - rightAnchor.northing;
    }
    return leftAnchor.easting - rightAnchor.easting;
  });

  return rings;
}

export function buildOutlineRingsFromTileIds(
  tileIds: string[],
): Array<Array<[number, number]>> {
  return buildOutlineRingsFromTileIdsLv95(tileIds).map((ring) =>
    ring.map((point) => {
      const wgs84 = lv95ToWgs84(point.easting, point.northing);
      return [
        Math.round(wgs84.lat * 1_000_000) / 1_000_000,
        Math.round(wgs84.lon * 1_000_000) / 1_000_000,
      ];
    }),
  );
}
