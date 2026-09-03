import { describe, expect, it } from 'vitest';

import type { RegionFeature } from '../../src/renderer/model';
import {
  isPhotoExcludedRegion,
  photoGeometryForRegion,
  SOUTH_SEA_CUTOFF_LATITUDE,
} from '../../src/renderer/map-scene/photo-geometry';

const hubei: RegionFeature = {
  type: 'Feature',
  properties: { gb: '156420000', name: '湖北省' },
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [110, 30],
      [114, 30],
      [114, 34],
      [110, 34],
      [110, 30],
    ]],
  },
};

describe('photo-only map geometry', () => {
  it('keeps ordinary region geometry unchanged and excludes Sansha photos', () => {
    const sansha: RegionFeature = {
      ...hubei,
      properties: { gb: '156460300', name: '三沙市' },
    };

    expect(photoGeometryForRegion(hubei)).toBe(hubei);
    expect(isPhotoExcludedRegion(hubei)).toBe(false);
    expect(isPhotoExcludedRegion(sansha)).toBe(true);
    expect(photoGeometryForRegion(sansha)).toBeUndefined();
  });

  it('uses only the Hainan polygons that touch the main map without mutating display geometry', () => {
    const hainan: RegionFeature = {
      type: 'Feature',
      properties: { gb: '156460000', name: '海南省' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[
            [109, SOUTH_SEA_CUTOFF_LATITUDE],
            [111, 18.5],
            [110, 20],
            [109, SOUTH_SEA_CUTOFF_LATITUDE],
          ]],
          [[
            [112, 16],
            [113, 16],
            [112.5, 17],
            [112, 16],
          ]],
        ],
      },
    };

    const photoGeometry = photoGeometryForRegion(hainan);

    expect(photoGeometry).not.toBe(hainan);
    expect(photoGeometry?.geometry.coordinates).toHaveLength(1);
    expect(hainan.geometry.coordinates).toHaveLength(2);
  });
});
