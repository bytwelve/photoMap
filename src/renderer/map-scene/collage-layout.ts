export interface CollagePoint {
  readonly x: number;
  readonly y: number;
}

export interface CollageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CollageLayoutTile {
  readonly polygon: readonly CollagePoint[];
  readonly bounds: CollageRect;
}

interface UnitPoint {
  x: number;
  y: number;
}

interface CutDirection {
  x: number;
  y: number;
}

const BISECTION_STEPS = 60;
const POINT_EPSILON = 1e-13;

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function area(polygon: readonly UnitPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const point = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    if (!point || !next) continue;
    twiceArea += point.x * next.y - point.y * next.x;
  }
  return Math.abs(twiceArea) / 2;
}

function unitBounds(polygon: readonly UnitPoint[]): CollageRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function project(point: UnitPoint, direction: CutDirection): number {
  return point.x * direction.x + point.y * direction.y;
}

function samePoint(left: UnitPoint, right: UnitPoint): boolean {
  return Math.abs(left.x - right.x) <= POINT_EPSILON
    && Math.abs(left.y - right.y) <= POINT_EPSILON;
}

function withoutAdjacentDuplicates(polygon: readonly UnitPoint[]): UnitPoint[] {
  const result: UnitPoint[] = [];
  for (const point of polygon) {
    const previous = result[result.length - 1];
    if (!previous || !samePoint(previous, point)) result.push(point);
  }
  if (result.length > 1) {
    const first = result[0];
    const last = result[result.length - 1];
    if (first && last && samePoint(first, last)) result.pop();
  }
  return result;
}

function clipHalfPlane(
  polygon: readonly UnitPoint[],
  direction: CutDirection,
  offset: number,
  keepLower: boolean,
): UnitPoint[] {
  const output: UnitPoint[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    if (!current || !previous) continue;
    const currentProjection = project(current, direction);
    const previousProjection = project(previous, direction);
    const currentInside = keepLower
      ? currentProjection <= offset
      : currentProjection >= offset;
    const previousInside = keepLower
      ? previousProjection <= offset
      : previousProjection >= offset;

    if (currentInside !== previousInside) {
      const denominator = currentProjection - previousProjection;
      const ratio = denominator === 0 ? 0 : (offset - previousProjection) / denominator;
      output.push({
        x: previous.x + (current.x - previous.x) * ratio,
        y: previous.y + (current.y - previous.y) * ratio,
      });
    }
    if (currentInside) output.push({ ...current });
  }
  return withoutAdjacentDuplicates(output);
}

function cutDirection(
  polygon: readonly UnitPoint[],
  rootRect: CollageRect,
  seed: string,
  branch: string,
): CutDirection {
  const bounds = unitBounds(polygon);
  const physicalWidth = bounds.width * rootRect.width;
  const physicalHeight = bounds.height * rootRect.height;
  const hash = stableHash(`${seed}:${branch}`);
  const magnitude = 0.08 + ((hash & 0xffff) / 0xffff) * 0.12;
  const slant = (hash & 0x10000) === 0 ? -magnitude : magnitude;
  const angle = physicalWidth >= physicalHeight
    ? slant
    : Math.PI / 2 + slant;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function splitByArea(
  polygon: readonly UnitPoint[],
  direction: CutDirection,
  lowerRatio: number,
): readonly [UnitPoint[], UnitPoint[]] {
  const projections = polygon.map((point) => project(point, direction));
  let low = Math.min(...projections);
  let high = Math.max(...projections);
  const targetArea = area(polygon) * lowerRatio;

  for (let iteration = 0; iteration < BISECTION_STEPS; iteration += 1) {
    const offset = (low + high) / 2;
    const lower = clipHalfPlane(polygon, direction, offset, true);
    if (area(lower) < targetArea) low = offset;
    else high = offset;
  }

  const offset = (low + high) / 2;
  return [
    clipHalfPlane(polygon, direction, offset, true),
    clipHalfPlane(polygon, direction, offset, false),
  ];
}

function partition(
  polygon: readonly UnitPoint[],
  count: number,
  rootRect: CollageRect,
  seed: string,
  branch: string,
): UnitPoint[][] {
  if (count === 1) return [[...polygon]];
  const lowerCount = Math.floor(count / 2);
  const upperCount = count - lowerCount;
  const direction = cutDirection(polygon, rootRect, seed, branch);
  const [lower, upper] = splitByArea(polygon, direction, lowerCount / count);
  return [
    ...partition(lower, lowerCount, rootRect, seed, `${branch}L`),
    ...partition(upper, upperCount, rootRect, seed, `${branch}R`),
  ];
}

function toOutputPoint(point: UnitPoint, rect: CollageRect): CollagePoint {
  return {
    x: rect.x + point.x * rect.width,
    y: rect.y + point.y * rect.height,
  };
}

function outputBounds(polygon: readonly CollagePoint[]): CollageRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function validRect(rect: CollageRect): boolean {
  return Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}

/**
 * Partitions a rectangle into deterministic, equal-area convex polygons.
 * The polygons cover the rectangle without area gaps or overlaps. A renderer can
 * object-cover an image into each tile's bounds, then clip it to tile.polygon.
 */
export function createCollageLayout(
  rect: CollageRect,
  tileCount: number,
  seed = '',
): CollageLayoutTile[] {
  if (!validRect(rect) || !Number.isFinite(tileCount) || tileCount < 1) return [];
  const count = Math.floor(tileCount);
  if (count === 1) {
    return [{
      polygon: [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.width, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height },
        { x: rect.x, y: rect.y + rect.height },
      ],
      bounds: { ...rect },
    }];
  }

  const unitRectangle: UnitPoint[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  return partition(unitRectangle, count, rect, seed, 'root').map((unitPolygon) => {
    const polygon = unitPolygon.map((point) => toOutputPoint(point, rect));
    return { polygon, bounds: outputBounds(polygon) };
  });
}
