import type { RegionFeature, ViewBox } from '../model';

export const MAP_WIDTH = 2000;
export const MAP_HEIGHT = 1710;
export const MAP_WEST = 69;
export const MAP_EAST = 141;
export const MAP_NORTH = 57;
export const MAP_LATITUDE_SCALE = 30;

export const MAIN_VIEW_BOX: ViewBox = { x: -500, y: -100, width: 3000, height: 1600 };
export const TERRAIN_BOUNDS: ViewBox = { x: -500, y: -243.9081, width: 3000, height: 2650.5501 };
export const PHOTO_GEOGRAPHY_BOUNDS: ViewBox = { x: 0, y: 0, width: 2000, height: 1170 };
export const MAIN_ASPECT = MAIN_VIEW_BOX.width / MAIN_VIEW_BOX.height;

export function atlasProject(longitude: number, latitude: number): [number, number] {
  return [
    ((longitude - MAP_WEST) / (MAP_EAST - MAP_WEST)) * MAP_WIDTH,
    (MAP_NORTH - latitude) * MAP_LATITUDE_SCALE,
  ];
}

function visitPositions(value: unknown, visitor: (longitude: number, latitude: number) => void): void {
  if (!Array.isArray(value)) return;
  if (
    value.length >= 2
    && typeof value[0] === 'number'
    && typeof value[1] === 'number'
  ) {
    visitor(value[0], value[1]);
    return;
  }
  value.forEach((item) => visitPositions(item, visitor));
}

export function featureBounds(feature: RegionFeature): ViewBox | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  visitPositions(feature.geometry.coordinates, (longitude, latitude) => {
    const [x, y] = atlasProject(longitude, latitude);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return undefined;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

export function collectionBounds(features: readonly RegionFeature[]): ViewBox | undefined {
  const boxes = features.map(featureBounds).filter((box): box is ViewBox => Boolean(box));
  if (boxes.length === 0) return undefined;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

export function expandViewBoxToAspect(
  source: ViewBox,
  targetAspect: number,
  bounds: ViewBox = TERRAIN_BOUNDS,
): ViewBox {
  let { x, y, width, height } = source;
  if (width / height < targetAspect) {
    const targetWidth = height * targetAspect;
    x -= (targetWidth - width) / 2;
    width = targetWidth;
  } else {
    const targetHeight = width / targetAspect;
    y -= (targetHeight - height) / 2;
    height = targetHeight;
  }
  x = Math.min(Math.max(x, bounds.x), bounds.x + bounds.width - width);
  y = Math.min(Math.max(y, bounds.y), bounds.y + bounds.height - height);
  return { x, y, width, height };
}

export function focusViewBox(features: readonly RegionFeature[]): ViewBox {
  const bounds = collectionBounds(features);
  if (!bounds) return MAIN_VIEW_BOX;
  const paddingX = Math.max(42, bounds.width * 0.14);
  const paddingY = Math.max(38, bounds.height * 0.18);
  return expandViewBoxToAspect({
    x: bounds.x - paddingX,
    y: bounds.y - paddingY,
    width: bounds.width + paddingX * 2,
    height: bounds.height + paddingY * 2,
  }, MAIN_ASPECT);
}
