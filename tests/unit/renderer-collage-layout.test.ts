import { describe, expect, it } from 'vitest';

import {
  createCollageLayout,
  type CollagePoint,
  type CollageRect,
} from '../../src/renderer/map-scene/collage-layout';

function signedArea(polygon: readonly CollagePoint[]): number {
  return polygon.reduce((sum, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    if (!next) return sum;
    return sum + point.x * next.y - point.y * next.x;
  }, 0) / 2;
}

function polygonArea(polygon: readonly CollagePoint[]): number {
  return Math.abs(signedArea(polygon));
}

function cross(origin: CollagePoint, a: CollagePoint, b: CollagePoint): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function expectConvex(polygon: readonly CollagePoint[]): void {
  expect(polygon.length).toBeGreaterThanOrEqual(3);
  const direction = Math.sign(signedArea(polygon));
  expect(direction).not.toBe(0);
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const c = polygon[(index + 2) % polygon.length];
    if (!a || !b || !c) continue;
    expect(direction * cross(a, b, c)).toBeGreaterThanOrEqual(-1e-10);
  }
}

function intersectConvex(
  subject: readonly CollagePoint[],
  clip: readonly CollagePoint[],
): CollagePoint[] {
  const clipDirection = Math.sign(signedArea(clip));
  let output = [...subject];
  for (let edgeIndex = 0; edgeIndex < clip.length; edgeIndex += 1) {
    const edgeStart = clip[edgeIndex];
    const edgeEnd = clip[(edgeIndex + 1) % clip.length];
    if (!edgeStart || !edgeEnd || output.length === 0) continue;
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index];
      const previous = input[(index + input.length - 1) % input.length];
      if (!current || !previous) continue;
      const currentSide = clipDirection * cross(edgeStart, edgeEnd, current);
      const previousSide = clipDirection * cross(edgeStart, edgeEnd, previous);
      const currentInside = currentSide >= -1e-12;
      const previousInside = previousSide >= -1e-12;
      if (currentInside !== previousInside) {
        const denominator = previousSide - currentSide;
        const ratio = denominator === 0 ? 0 : previousSide / denominator;
        output.push({
          x: previous.x + (current.x - previous.x) * ratio,
          y: previous.y + (current.y - previous.y) * ratio,
        });
      }
      if (currentInside) output.push(current);
    }
  }
  return output;
}

function expectExactPartition(rect: CollageRect, count: number, seed: string): void {
  const tiles = createCollageLayout(rect, count, seed);
  const expectedArea = rect.width * rect.height;
  expect(tiles).toHaveLength(count);
  expect(tiles.reduce((sum, tile) => sum + polygonArea(tile.polygon), 0)).toBeCloseTo(expectedArea, 8);

  for (const tile of tiles) {
    expectConvex(tile.polygon);
    expect(polygonArea(tile.polygon)).toBeCloseTo(expectedArea / count, 8);
    expect(tile.bounds.width).toBeGreaterThan(0);
    expect(tile.bounds.height).toBeGreaterThan(0);
    for (const point of tile.polygon) {
      expect(point.x).toBeGreaterThanOrEqual(rect.x - 1e-10);
      expect(point.x).toBeLessThanOrEqual(rect.x + rect.width + 1e-10);
      expect(point.y).toBeGreaterThanOrEqual(rect.y - 1e-10);
      expect(point.y).toBeLessThanOrEqual(rect.y + rect.height + 1e-10);
    }
  }

  for (let left = 0; left < tiles.length; left += 1) {
    for (let right = left + 1; right < tiles.length; right += 1) {
      const first = tiles[left];
      const second = tiles[right];
      if (!first || !second) continue;
      const overlap = intersectConvex(first.polygon, second.polygon);
      expect(polygonArea(overlap)).toBeLessThanOrEqual(expectedArea * 1e-9);
    }
  }
}

describe('collage bounding-box partition', () => {
  it('one_photo__fills_the_entire_rectangle', () => {
    const rect = { x: 12, y: -8, width: 160, height: 90 };

    expect(createCollageLayout(rect, 1, 'hubei')).toEqual([{
      polygon: [
        { x: 12, y: -8 },
        { x: 172, y: -8 },
        { x: 172, y: 82 },
        { x: 12, y: 82 },
      ],
      bounds: rect,
    }]);
  });

  it.each([2, 3, 5, 8, 13, 24])(
    '%i_photos__forms_equal_area_convex_tiles_without_gaps_or_area_overlap',
    (count) => {
      expectExactPartition({ x: -30, y: 45, width: 417, height: 193 }, count, 'region-156420000');
    },
  );

  it('extreme_aspect_ratios__keeps_every_tile_non_degenerate', () => {
    expectExactPartition({ x: 0, y: 0, width: 8_000, height: 0.0002 }, 31, 'wide');
    expectExactPartition({ x: 0, y: 0, width: 0.0002, height: 8_000 }, 31, 'tall');
  });

  it('same_inputs__returns_the_same_layout__different_seed_changes_the_cut_geometry', () => {
    const rect = { x: 4, y: 9, width: 320, height: 180 };
    const first = createCollageLayout(rect, 7, 'stable-seed');

    expect(createCollageLayout(rect, 7, 'stable-seed')).toEqual(first);
    expect(createCollageLayout(rect, 7, 'another-seed')).not.toEqual(first);
  });

  it('multi_photo_layout__uses_non_axis_aligned_edges', () => {
    const tiles = createCollageLayout({ x: 0, y: 0, width: 300, height: 180 }, 6, 'irregular');
    const hasDiagonalEdge = tiles.some(({ polygon }) => polygon.some((point, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return Boolean(next && Math.abs(next.x - point.x) > 1e-7 && Math.abs(next.y - point.y) > 1e-7);
    }));

    expect(hasDiagonalEdge).toBe(true);
  });

  it('empty_or_invalid_request__returns_no_tiles', () => {
    expect(createCollageLayout({ x: 0, y: 0, width: 100, height: 80 }, 0, 'empty')).toEqual([]);
    expect(createCollageLayout({ x: 0, y: 0, width: 0, height: 80 }, 3, 'invalid')).toEqual([]);
    expect(createCollageLayout({ x: 0, y: 0, width: 100, height: Number.NaN }, 3, 'invalid')).toEqual([]);
  });
});
