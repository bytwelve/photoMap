import { describe, expect, it } from 'vitest';

import {
  clampCamera,
  MAP_WHEEL_ZOOM_FACTOR,
  MIN_MAP_ZOOM,
  visibleViewBox,
  zoomFromWheel,
} from '../../src/renderer/map-scene/interaction';
import { TERRAIN_BOUNDS } from '../../src/renderer/map-scene/projection';

describe('photo-wall map base zoom', () => {
  it('uses the former one-wheel-step view as the new maximum extent', () => {
    expect(MIN_MAP_ZOOM).toBe(1.18);
    expect(MAP_WHEEL_ZOOM_FACTOR).toBe(1.18);
    expect(zoomFromWheel(1, -100)).toBe(MIN_MAP_ZOOM);
    expect(zoomFromWheel(MIN_MAP_ZOOM, 100)).toBe(MIN_MAP_ZOOM);
    expect(zoomFromWheel(MIN_MAP_ZOOM, -100)).toBe(1.392);
  });

  it('centers legacy cameras when clamping them to the new base zoom', () => {
    const viewBox = { x: -500, y: -100, width: 3000, height: 1600 };

    expect(clampCamera(
      { zoom: 1, panX: 120, panY: -80 },
      viewBox,
      viewBox,
    )).toEqual({ zoom: MIN_MAP_ZOOM, panX: 0, panY: 0 });
  });

  it('uses the actual tall viewport when limiting downward drag so the terrain top never reveals a gap', () => {
    const viewBox = { x: -500, y: -100, width: 3000, height: 1600 };
    const viewport = { width: 1200, height: 830 };
    const visible = visibleViewBox(viewBox, viewport);
    const northCamera = clampCamera(
      { zoom: 1.392, panX: 0, panY: Number.POSITIVE_INFINITY },
      viewBox,
      TERRAIN_BOUNDS,
      viewport,
    );
    const southCamera = clampCamera(
      { zoom: 1.392, panX: 0, panY: Number.NEGATIVE_INFINITY },
      viewBox,
      TERRAIN_BOUNDS,
      viewport,
    );
    const westCamera = clampCamera(
      { zoom: 1.392, panX: Number.POSITIVE_INFINITY, panY: 0 },
      viewBox,
      TERRAIN_BOUNDS,
      viewport,
    );
    const eastCamera = clampCamera(
      { zoom: 1.392, panX: Number.NEGATIVE_INFINITY, panY: 0 },
      viewBox,
      TERRAIN_BOUNDS,
      viewport,
    );
    const centerX = viewBox.x + viewBox.width / 2;
    const centerY = viewBox.y + viewBox.height / 2;
    const transformedLeft = northCamera.zoom * TERRAIN_BOUNDS.x
      + (1 - northCamera.zoom) * centerX;
    const transformedTop = northCamera.zoom * TERRAIN_BOUNDS.y
      + (1 - northCamera.zoom) * centerY;
    const transformedRight = transformedLeft + northCamera.zoom * TERRAIN_BOUNDS.width;
    const transformedBottom = transformedTop + northCamera.zoom * TERRAIN_BOUNDS.height;

    expect(visible.y).toBeCloseTo(-337.5);
    expect(northCamera.panY).toBeCloseTo(276.4200752);
    expect(transformedTop + northCamera.panY).toBeCloseTo(visible.y);
    expect(transformedBottom + southCamera.panY).toBeCloseTo(visible.y + visible.height);
    expect(transformedLeft + westCamera.panX).toBeCloseTo(visible.x);
    expect(transformedRight + eastCamera.panX).toBeCloseTo(visible.x + visible.width);
  });
});
