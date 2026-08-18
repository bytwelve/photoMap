import type { MapCamera, ViewBox } from '../model';

export const MIN_MAP_ZOOM = 1.18;
export const MAX_MAP_ZOOM = 3.2;
export const MAP_WHEEL_ZOOM_FACTOR = 1.18;

type Viewport = { width: number; height: number };

export function clampZoom(zoom: number): number {
  return Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, zoom));
}

export function zoomFromWheel(currentZoom: number, deltaY: number): number {
  if (deltaY === 0) return clampZoom(currentZoom);
  const factor = deltaY < 0 ? MAP_WHEEL_ZOOM_FACTOR : 1 / MAP_WHEEL_ZOOM_FACTOR;
  return clampZoom(Math.round(currentZoom * factor * 1000) / 1000);
}

export function visibleViewBox(viewBox: ViewBox, viewport?: Viewport): ViewBox {
  if (!viewport) return viewBox;
  const scale = Math.min(viewport.width / viewBox.width, viewport.height / viewBox.height);
  if (!Number.isFinite(scale) || scale <= 0) return viewBox;
  const centerX = viewBox.x + viewBox.width / 2;
  const centerY = viewBox.y + viewBox.height / 2;
  const width = viewport.width / scale;
  const height = viewport.height / scale;
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  };
}

function clampAxis(value: number, minimum: number, maximum: number): number {
  if (minimum > maximum) return (minimum + maximum) / 2;
  return Math.max(minimum, Math.min(maximum, value));
}

export function clampCamera(
  camera: MapCamera,
  viewBox: ViewBox,
  content: ViewBox,
  viewport?: Viewport,
): MapCamera {
  const zoom = clampZoom(camera.zoom);
  if (zoom <= MIN_MAP_ZOOM) return { zoom, panX: 0, panY: 0 };
  const visible = visibleViewBox(viewBox, viewport);
  const centerX = viewBox.x + viewBox.width / 2;
  const centerY = viewBox.y + viewBox.height / 2;
  const transformedLeft = zoom * content.x + (1 - zoom) * centerX;
  const transformedTop = zoom * content.y + (1 - zoom) * centerY;
  const transformedRight = transformedLeft + zoom * content.width;
  const transformedBottom = transformedTop + zoom * content.height;
  const minX = visible.x + visible.width - transformedRight;
  const maxX = visible.x - transformedLeft;
  const minY = visible.y + visible.height - transformedBottom;
  const maxY = visible.y - transformedTop;
  return {
    zoom,
    panX: clampAxis(camera.panX, minX, maxX),
    panY: clampAxis(camera.panY, minY, maxY),
  };
}

export function panFromScreenDelta(
  camera: MapCamera,
  delta: { x: number; y: number },
  viewBox: ViewBox,
  viewport: { width: number; height: number },
  content: ViewBox,
): MapCamera {
  const scale = Math.min(viewport.width / viewBox.width, viewport.height / viewBox.height);
  if (!Number.isFinite(scale) || scale <= 0) return camera;
  return clampCamera({
    ...camera,
    panX: camera.panX + delta.x / scale,
    panY: camera.panY + delta.y / scale,
  }, viewBox, content, viewport);
}

export function mapPointFromScreen(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
  viewBox: ViewBox,
  camera: MapCamera,
): { x: number; y: number } {
  const scale = Math.min(viewport.width / viewBox.width, viewport.height / viewBox.height);
  const drawWidth = viewBox.width * scale;
  const drawHeight = viewBox.height * scale;
  const offsetX = (viewport.width - drawWidth) / 2;
  const offsetY = (viewport.height - drawHeight) / 2;
  const transformedX = viewBox.x + (point.x - offsetX) / scale;
  const transformedY = viewBox.y + (point.y - offsetY) / scale;
  const centerX = viewBox.x + viewBox.width / 2;
  const centerY = viewBox.y + viewBox.height / 2;
  return {
    x: (transformedX - (1 - camera.zoom) * centerX - camera.panX) / camera.zoom,
    y: (transformedY - (1 - camera.zoom) * centerY - camera.panY) / camera.zoom,
  };
}
