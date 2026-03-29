export interface FootprintPoint {
  x: number;
  y: number;
}

const DEFAULT_SPIKE_MIN_INTERIOR_ANGLE_DEG = 16;
const DEFAULT_SPIKE_MIN_ACUTE_COUNT = 3;
const DEFAULT_SPIKE_MIN_VERTICES = 10;
const DEFAULT_SPIKE_AREA_RATIO_THRESHOLD = 0.72;
const EPSILON = 1e-9;

function cross(origin: FootprintPoint, a: FootprintPoint, b: FootprintPoint): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function pointsAreEqual(a: FootprintPoint, b: FootprintPoint, epsilon = 1e-6): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

export function simplifyRingPoints(points: FootprintPoint[]): FootprintPoint[] {
  const simplified: FootprintPoint[] = [];
  for (const point of points) {
    const previous = simplified.at(-1);
    if (!previous || !pointsAreEqual(previous, point)) {
      simplified.push(point);
    }
  }

  if (simplified.length > 1 && pointsAreEqual(simplified[0]!, simplified.at(-1)!)) {
    simplified.pop();
  }

  return simplified;
}

export function dedupePoints(points: FootprintPoint[]): FootprintPoint[] {
  const unique = new Map<string, FootprintPoint>();
  for (const point of points) {
    const key = `${Math.round(point.x * 1000)}:${Math.round(point.y * 1000)}`;
    if (!unique.has(key)) {
      unique.set(key, point);
    }
  }
  return Array.from(unique.values());
}

export function polygonArea(points: FootprintPoint[]): number {
  if (points.length < 3) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function convexHull(points: FootprintPoint[]): FootprintPoint[] {
  if (points.length <= 1) {
    return points;
  }

  const sorted = [...points].sort((a, b) => {
    if (a.x !== b.x) {
      return a.x - b.x;
    }
    return a.y - b.y;
  });

  const lower: FootprintPoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: FootprintPoint[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i]!;
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function orientation(a: FootprintPoint, b: FootprintPoint, c: FootprintPoint): number {
  const value = cross(a, b, c);
  if (Math.abs(value) < EPSILON) {
    return 0;
  }

  return value > 0 ? 1 : -1;
}

function onSegment(a: FootprintPoint, b: FootprintPoint, c: FootprintPoint): boolean {
  return (
    Math.min(a.x, c.x) - EPSILON <= b.x &&
    b.x <= Math.max(a.x, c.x) + EPSILON &&
    Math.min(a.y, c.y) - EPSILON <= b.y &&
    b.y <= Math.max(a.y, c.y) + EPSILON
  );
}

function segmentsIntersect(
  a: FootprintPoint,
  b: FootprintPoint,
  c: FootprintPoint,
  d: FootprintPoint,
): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }

  if (o1 === 0 && onSegment(a, c, b)) {
    return true;
  }
  if (o2 === 0 && onSegment(a, d, b)) {
    return true;
  }
  if (o3 === 0 && onSegment(c, a, d)) {
    return true;
  }
  if (o4 === 0 && onSegment(c, b, d)) {
    return true;
  }

  return false;
}

export function isSimplePolygon(points: FootprintPoint[]): boolean {
  if (points.length < 3) {
    return false;
  }

  for (let i = 0; i < points.length; i += 1) {
    const a1 = points[i]!;
    const a2 = points[(i + 1) % points.length]!;
    for (let j = i + 1; j < points.length; j += 1) {
      const b1 = points[j]!;
      const b2 = points[(j + 1) % points.length]!;

      const sharesEndpoint =
        i === j ||
        (i + 1) % points.length === j ||
        i === (j + 1) % points.length;
      if (sharesEndpoint) {
        continue;
      }

      if (segmentsIntersect(a1, a2, b1, b2)) {
        return false;
      }
    }
  }

  return true;
}

function interiorAngleDeg(
  previous: FootprintPoint,
  current: FootprintPoint,
  next: FootprintPoint,
): number {
  const v1x = previous.x - current.x;
  const v1y = previous.y - current.y;
  const v2x = next.x - current.x;
  const v2y = next.y - current.y;
  const norm1 = Math.hypot(v1x, v1y);
  const norm2 = Math.hypot(v2x, v2y);
  if (norm1 < EPSILON || norm2 < EPSILON) {
    return 180;
  }

  const dot = v1x * v2x + v1y * v2y;
  const ratio = Math.max(-1, Math.min(1, dot / (norm1 * norm2)));
  return (Math.acos(ratio) * 180) / Math.PI;
}

function acuteInteriorAnglesCount(points: FootprintPoint[], thresholdDeg: number): number {
  if (points.length < 3) {
    return 0;
  }

  let count = 0;
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[(i - 1 + points.length) % points.length]!;
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    if (interiorAngleDeg(previous, current, next) <= thresholdDeg) {
      count += 1;
    }
  }

  return count;
}

export function normalizeBuildingFootprint(points: FootprintPoint[]): {
  footprint: FootprintPoint[] | null;
  usedConvexHullFallback: boolean;
} {
  const deduped = dedupePoints(points);
  let ring = simplifyRingPoints(deduped);
  if (ring.length < 3) {
    return {
      footprint: null,
      usedConvexHullFallback: false,
    };
  }

  let usedConvexHullFallback = false;
  if (!isSimplePolygon(ring)) {
    ring = convexHull(ring);
    usedConvexHullFallback = true;
  }

  if (ring.length < 3) {
    return {
      footprint: null,
      usedConvexHullFallback,
    };
  }

  const hull = convexHull(ring);
  const hullArea = polygonArea(hull);
  const area = polygonArea(ring);
  const areaRatio = hullArea > 0 ? area / hullArea : 1;
  const acuteAngles = acuteInteriorAnglesCount(
    ring,
    DEFAULT_SPIKE_MIN_INTERIOR_ANGLE_DEG,
  );

  const looksSpiky =
    ring.length >= DEFAULT_SPIKE_MIN_VERTICES &&
    areaRatio <= DEFAULT_SPIKE_AREA_RATIO_THRESHOLD &&
    acuteAngles >= DEFAULT_SPIKE_MIN_ACUTE_COUNT;

  if (looksSpiky && hull.length >= 3) {
    return {
      footprint: hull,
      usedConvexHullFallback: true,
    };
  }

  return {
    footprint: ring,
    usedConvexHullFallback,
  };
}
