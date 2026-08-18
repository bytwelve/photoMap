import type { MultiPolygonCoordinates, PolygonCoordinates, RegionFeature } from '../model';

export const SOUTH_SEA_CUTOFF_LATITUDE = 18;
export const SOUTH_SEA_NO_PHOTO_CITY_CODE = '156460300';
const HAINAN_PROVINCE_CODE = '156460000';

export function isPhotoExcludedRegion(feature: RegionFeature): boolean {
  return feature.properties.gb === SOUTH_SEA_NO_PHOTO_CITY_CODE;
}

function polygonTouchesMainMap(polygon: PolygonCoordinates): boolean {
  return polygon.some((ring) => ring.some(([, latitude]) => (
    latitude >= SOUTH_SEA_CUTOFF_LATITUDE
  )));
}

export function photoGeometryForRegion(feature: RegionFeature): RegionFeature | undefined {
  if (isPhotoExcludedRegion(feature)) return undefined;
  if (feature.properties.gb !== HAINAN_PROVINCE_CODE || feature.geometry.type !== 'MultiPolygon') {
    return feature;
  }
  return {
    ...feature,
    geometry: {
      ...feature.geometry,
      coordinates: (feature.geometry.coordinates as MultiPolygonCoordinates)
        .filter(polygonTouchesMainMap),
    },
  };
}
