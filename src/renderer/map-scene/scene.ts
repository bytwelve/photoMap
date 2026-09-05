import { shortRegionName, stableHash, stablePhotoOrder } from '../domain';
import { MAX_MAP_DENSITY, MIN_MAP_DENSITY } from '../../shared/contracts';
import type {
  MapSnapshot,
  PhotoRecord,
  PolygonCoordinates,
  MultiPolygonCoordinates,
  RegionCollection,
  RegionFeature,
} from '../model';
import {
  atlasProject,
  featureBounds,
  MAP_HEIGHT,
  MAP_WIDTH,
  PHOTO_GEOGRAPHY_BOUNDS,
  TERRAIN_BOUNDS,
} from './projection';
import {
  createDefaultShareDocument,
  updateShareText,
  type ShareDocument,
  type ShareTextElement,
} from '../share-document';
import {
  createCollageLayout,
  type CollagePoint,
} from './collage-layout';
import { photoGeometryForRegion } from './photo-geometry';

export const MAP_ASSET_URLS = {
  terrain: 'photomap-asset://map/terrain-expanded-uniform-r16.png',
  coastRepair: 'photomap-asset://map/terrain-coast-repair-uniform-r16.png',
  provinceLines: 'photomap-asset://map/province-lines-uniform-r16.png',
  nationalOutline: 'photomap-asset://map/national-outline-uniform-r16.png',
} as const;

export interface LayoutTile {
  photo: PhotoRecord;
  x: number;
  y: number;
  width: number;
  height: number;
  polygon: readonly CollagePoint[];
}

export interface MapAssetImages {
  terrain?: CanvasImageSource;
  coastRepair?: CanvasImageSource;
  provinceLines?: CanvasImageSource;
  nationalOutline?: CanvasImageSource;
}

export interface SceneImages extends MapAssetImages {
  photos: ReadonlyMap<string, CanvasImageSource>;
}

export interface DrawSceneOptions {
  width: number;
  height: number;
  snapshot: MapSnapshot;
  images: SceneImages;
  selectedRegionCode?: string;
  drawLabels?: boolean;
  originX?: number;
  originY?: number;
  clear?: boolean;
}

export interface ExportSpec {
  currentWidth: number;
  currentHeight: number;
  document?: ShareDocument;
  title?: string;
}

const imagePromises = new Map<string, Promise<HTMLImageElement>>();

function asCoordinates(feature: RegionFeature): PolygonCoordinates[] {
  return feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates as PolygonCoordinates]
    : feature.geometry.coordinates as MultiPolygonCoordinates;
}

export function pathForFeature(feature: RegionFeature): Path2D {
  const path = new Path2D();
  for (const polygon of asCoordinates(feature)) {
    for (const ring of polygon) {
      ring.forEach(([longitude, latitude], index) => {
        const [x, y] = atlasProject(longitude, latitude);
        if (index === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      path.closePath();
    }
  }
  return path;
}

function pathForCollagePolygon(polygon: readonly CollagePoint[]): Path2D {
  const path = new Path2D();
  polygon.forEach((point, index) => {
    if (index === 0) path.moveTo(point.x, point.y);
    else path.lineTo(point.x, point.y);
  });
  path.closePath();
  return path;
}

export function layoutPhotosForRegion(
  feature: RegionFeature,
  candidates: readonly PhotoRecord[],
  density: number,
  snapshotSeed: string,
  selectionMode: 'automatic' | 'fixed' = 'automatic',
): LayoutTile[] {
  const photoFeature = photoGeometryForRegion(feature);
  if (!photoFeature) return [];
  const bounds = featureBounds(photoFeature);
  if (!bounds || candidates.length === 0) return [];
  const uniqueCandidates = [...new Map(candidates.map((photo) => [photo.id, photo])).values()];
  const normalizedDensity = Math.max(
    MIN_MAP_DENSITY,
    Math.min(MAX_MAP_DENSITY, Math.round(density)),
  );
  const screenArea = Math.max(1, bounds.width * bounds.height);
  const targetByArea = Math.max(1, Math.round(screenArea / (26_000 / normalizedDensity)));
  const targetCount = Math.min(uniqueCandidates.length, Math.max(normalizedDensity, targetByArea));
  const ordered = selectionMode === 'fixed'
    ? uniqueCandidates
    : stablePhotoOrder(uniqueCandidates, `${snapshotSeed}:${String(feature.properties.gb ?? '')}`)
      .slice(0, targetCount);
  const layout = createCollageLayout(
    bounds,
    ordered.length,
    `${snapshotSeed}:${String(feature.properties.gb ?? '')}:partition-v2`,
  );
  return ordered.map((photo, index) => {
    const tile = layout[index]!;
    return {
      photo,
      x: tile.bounds.x,
      y: tile.bounds.y,
      width: tile.bounds.width,
      height: tile.bounds.height,
      polygon: tile.polygon,
    };
  });
}

function drawImageCover(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const source = image as unknown as Record<string, unknown>;
  const numeric = (value: unknown): number => typeof value === 'number' ? value : 0;
  const imageWidth = numeric(source.naturalWidth)
    || numeric(source.videoWidth)
    || numeric(source.displayWidth)
    || numeric(source.width);
  const imageHeight = numeric(source.naturalHeight)
    || numeric(source.videoHeight)
    || numeric(source.displayHeight)
    || numeric(source.height);
  if (!imageWidth || !imageHeight) return;
  const sourceAspect = imageWidth / imageHeight;
  const targetAspect = width / height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = imageWidth;
  let sourceHeight = imageHeight;
  if (sourceAspect > targetAspect) {
    sourceWidth = imageHeight * targetAspect;
    sourceX = (imageWidth - sourceWidth) / 2;
  } else {
    sourceHeight = imageWidth / targetAspect;
    sourceY = (imageHeight - sourceHeight) / 2;
  }
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function setMapTransform(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  snapshot: MapSnapshot,
  originX = 0,
  originY = 0,
): void {
  const { viewBox, camera } = snapshot;
  const scale = Math.min(width / viewBox.width, height / viewBox.height);
  const offsetX = (width - viewBox.width * scale) / 2;
  const offsetY = (height - viewBox.height * scale) / 2;
  const centerX = viewBox.x + viewBox.width / 2;
  const centerY = viewBox.y + viewBox.height / 2;
  context.setTransform(
    scale,
    0,
    0,
    scale,
    originX + offsetX - viewBox.x * scale,
    originY + offsetY - viewBox.y * scale,
  );
  context.translate((1 - camera.zoom) * centerX + camera.panX, (1 - camera.zoom) * centerY + camera.panY);
  context.scale(camera.zoom, camera.zoom);
}

function drawBaseMap(context: CanvasRenderingContext2D, images: SceneImages): void {
  context.fillStyle = '#dfe9e8';
  context.fillRect(TERRAIN_BOUNDS.x, TERRAIN_BOUNDS.y, TERRAIN_BOUNDS.width, TERRAIN_BOUNDS.height);
  if (images.terrain) {
    context.drawImage(images.terrain, TERRAIN_BOUNDS.x, TERRAIN_BOUNDS.y, TERRAIN_BOUNDS.width, TERRAIN_BOUNDS.height);
  }
  if (images.coastRepair) {
    context.drawImage(images.coastRepair, TERRAIN_BOUNDS.x, TERRAIN_BOUNDS.y, TERRAIN_BOUNDS.width, TERRAIN_BOUNDS.height);
  }
}

function drawRegionBase(context: CanvasRenderingContext2D, regions: readonly RegionFeature[]): void {
  context.fillStyle = 'rgba(245, 232, 208, 0.24)';
  context.strokeStyle = 'rgba(132, 91, 62, 0.52)';
  context.lineWidth = 0.9;
  for (const feature of regions) {
    const path = pathForFeature(feature);
    context.fill(path, 'evenodd');
    context.stroke(path);
  }
}

function drawRegionPhotos(context: CanvasRenderingContext2D, snapshot: MapSnapshot, images: SceneImages): void {
  if (!snapshot.showPhotos) return;
  context.save();
  context.beginPath();
  context.rect(
    PHOTO_GEOGRAPHY_BOUNDS.x,
    PHOTO_GEOGRAPHY_BOUNDS.y,
    PHOTO_GEOGRAPHY_BOUNDS.width,
    PHOTO_GEOGRAPHY_BOUNDS.height,
  );
  context.clip();
  for (const feature of snapshot.regions) {
    const code = String(feature.properties.gb ?? '');
    const photoFeature = photoGeometryForRegion(feature);
    if (!photoFeature) continue;
    const candidates = snapshot.photosByRegion.get(code) ?? [];
    const plannedTiles = layoutPhotosForRegion(
      photoFeature,
      candidates,
      snapshot.density,
      snapshot.id,
      snapshot.fixedPhotoRegionCodes?.has(code) ? 'fixed' : 'automatic',
    );
    const loadedPhotos = plannedTiles
      .filter((tile) => images.photos.has(tile.photo.id))
      .map((tile) => tile.photo);
    const tiles = loadedPhotos.length === plannedTiles.length
      ? plannedTiles
      : layoutPhotosForRegion(
        photoFeature,
        loadedPhotos,
        snapshot.density,
        snapshot.id,
        'fixed',
      );
    if (tiles.length === 0) continue;
    context.save();
    const photoPath = pathForFeature(photoFeature);
    context.clip(photoPath, 'evenodd');
    for (const tile of tiles) {
      const image = images.photos.get(tile.photo.id);
      if (!image) continue;
      context.save();
      context.clip(pathForCollagePolygon(tile.polygon));
      drawImageCover(context, image, tile.x, tile.y, tile.width, tile.height);
      context.restore();
    }
    context.fillStyle = 'rgba(63, 48, 33, 0.055)';
    context.fill(photoPath, 'evenodd');
    context.restore();
  }
  context.restore();
}

function drawBoundaries(context: CanvasRenderingContext2D, snapshot: MapSnapshot, images: SceneImages): void {
  if (snapshot.level === 'province' && images.provinceLines) {
    context.drawImage(images.provinceLines, 0, 0, MAP_WIDTH, MAP_HEIGHT);
  } else {
    context.strokeStyle = 'rgba(76, 85, 82, 0.58)';
    context.lineWidth = 0.55;
    for (const feature of snapshot.regions) context.stroke(pathForFeature(feature));
  }
  if (images.nationalOutline) {
    context.drawImage(images.nationalOutline, 0, 0, MAP_WIDTH, MAP_HEIGHT);
  }
}

function drawRegionLabels(context: CanvasRenderingContext2D, snapshot: MapSnapshot): void {
  context.save();
  context.fillStyle = '#4c4034';
  context.strokeStyle = 'rgba(250, 244, 233, 0.88)';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.font = snapshot.level === 'province'
    ? '650 18px "Microsoft YaHei UI", sans-serif'
    : '650 5.4px "Microsoft YaHei UI", sans-serif';
  context.lineWidth = snapshot.level === 'province' ? 3 : 1.2;
  for (const feature of snapshot.regions) {
    const bounds = featureBounds(feature);
    const label = shortRegionName(String(feature.properties.name ?? ''));
    if (!bounds || !label || bounds.width < (snapshot.level === 'province' ? 18 : 3)) continue;
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    context.strokeText(label, x, y);
    context.fillText(label, x, y);
  }
  context.restore();
}

function drawSelectedRegion(context: CanvasRenderingContext2D, snapshot: MapSnapshot, code: string): void {
  const selected = snapshot.regions.find((feature) => feature.properties.gb === code);
  if (!selected) return;
  const path = pathForFeature(selected);
  context.save();
  context.strokeStyle = 'rgba(255, 248, 235, 0.96)';
  context.lineWidth = 5.4 / snapshot.camera.zoom;
  context.stroke(path);
  context.fillStyle = 'rgba(183, 113, 38, 0.12)';
  context.strokeStyle = '#a95f1d';
  context.lineWidth = 2.7 / snapshot.camera.zoom;
  context.fill(path, 'evenodd');
  context.stroke(path);
  context.restore();
}

export function drawMapScene(context: CanvasRenderingContext2D, options: DrawSceneOptions): void {
  const { width, height, snapshot, images } = options;
  const originX = options.originX ?? 0;
  const originY = options.originY ?? 0;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  if (options.clear !== false) context.clearRect(originX, originY, width, height);
  context.fillStyle = '#f4efe6';
  context.fillRect(originX, originY, width, height);
  context.beginPath();
  context.rect(originX, originY, width, height);
  context.clip();
  setMapTransform(context, width, height, snapshot, originX, originY);
  drawBaseMap(context, images);
  drawRegionBase(context, snapshot.regions);
  drawRegionPhotos(context, snapshot, images);
  drawBoundaries(context, snapshot, images);
  if (snapshot.showPlaceNames && options.drawLabels !== false) drawRegionLabels(context, snapshot);
  if (options.selectedRegionCode) drawSelectedRegion(context, snapshot, options.selectedRegionCode);
  context.restore();
}

export function createSnapshot(input: Omit<MapSnapshot, 'id' | 'createdAt'>): MapSnapshot {
  const groups = [...input.photosByRegion.entries()]
    .map(([code, photos]) => `${code}:${photos.map((photo) => photo.id).sort().join(',')}`)
    .sort()
    .join('|');
  const fixedRegions = [...(input.fixedPhotoRegionCodes ?? [])].sort().join(',');
  // Camera changes only transform the viewport; they must not select new photos or reload scene images.
  const seed = [
    'layout-v2',
    input.level,
    input.density,
    input.showPhotos,
    input.viewBox.x,
    input.viewBox.y,
    input.viewBox.width,
    input.viewBox.height,
    groups,
    fixedRegions,
  ].join(':');
  return { ...input, id: `snapshot-${stableHash(seed).toString(16)}`, createdAt: Date.now() };
}

export function isRegionCollection(value: unknown): value is RegionCollection {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; features?: unknown };
  return candidate.type === 'FeatureCollection' && Array.isArray(candidate.features);
}

export async function loadRegionCollection(url: string): Promise<RegionCollection> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`离线地图载入失败（${response.status}）`);
  const data: unknown = await response.json();
  if (!isRegionCollection(data)) throw new Error('本地地图数据格式无效');
  return data;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  const existing = imagePromises.get(url);
  if (existing) return existing;
  const promise: Promise<HTMLImageElement> = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`图片载入失败：${url}`));
    image.src = url;
  }).catch((error: unknown) => {
    // A refreshed library must be able to retry a temporarily unavailable file.
    if (imagePromises.get(url) === promise) imagePromises.delete(url);
    throw error;
  });
  imagePromises.set(url, promise);
  return promise;
}

async function optionalImage(url: string): Promise<HTMLImageElement | undefined> {
  try {
    return await loadImage(url);
  } catch {
    return undefined;
  }
}

export async function loadSceneImages(snapshot: MapSnapshot): Promise<SceneImages> {
  const [terrain, coastRepair, provinceLines, nationalOutline] = await Promise.all([
    optionalImage(MAP_ASSET_URLS.terrain),
    optionalImage(MAP_ASSET_URLS.coastRepair),
    optionalImage(MAP_ASSET_URLS.provinceLines),
    optionalImage(MAP_ASSET_URLS.nationalOutline),
  ]);
  const uniquePhotos = new Map<string, PhotoRecord>();
  for (const feature of snapshot.regions) {
    const code = String(feature.properties.gb ?? '');
    const candidates = snapshot.photosByRegion.get(code) ?? [];
    for (const tile of layoutPhotosForRegion(
      feature,
      candidates,
      snapshot.density,
      snapshot.id,
      snapshot.fixedPhotoRegionCodes?.has(code) ? 'fixed' : 'automatic',
    )) {
      uniquePhotos.set(tile.photo.id, tile.photo);
    }
  }
  const loadedPhotos = await Promise.all([...uniquePhotos.values()].map(async (photo) => {
    try {
      return [photo.id, await loadImage(photo.thumbnailUrl)] as const;
    } catch {
      return undefined;
    }
  }));
  return {
    terrain,
    coastRepair,
    provinceLines,
    nationalOutline,
    photos: new Map(loadedPhotos.filter((entry): entry is readonly [string, HTMLImageElement] => Boolean(entry))),
  };
}

function drawShareText(context: CanvasRenderingContext2D, text: ShareTextElement): void {
  const content = text.text.trim();
  if (!content) return;
  const { rect } = text;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.beginPath();
  context.rect(rect.x, rect.y, rect.width, rect.height);
  context.clip();
  context.fillStyle = text.color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `${text.weight} ${text.fontSize}px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`;
  const measuredWidth = Math.max(1, context.measureText(content).width);
  const requestedScale = Math.max(0.55, Math.min(1.65, text.compactness));
  const fittedScale = Math.min(requestedScale, Math.max(0.2, (rect.width - 24) / measuredWidth));
  context.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
  context.scale(fittedScale, 1);
  context.fillText(content, 0, 0);
  context.restore();
}

export function drawShareCard(
  context: CanvasRenderingContext2D,
  options: {
    snapshot: MapSnapshot;
    images: SceneImages;
    document: ShareDocument;
  },
): ShareDocument {
  const document = options.document;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, document.width, document.height);
  context.fillStyle = '#fffdf9';
  context.fillRect(0, 0, document.width, document.height);
  context.strokeStyle = '#e1d7cb';
  context.lineWidth = 2;
  context.strokeRect(1, 1, document.width - 2, document.height - 2);
  context.restore();

  drawMapScene(context, {
    width: document.photo.rect.width,
    height: document.photo.rect.height,
    originX: document.photo.rect.x,
    originY: document.photo.rect.y,
    clear: false,
    snapshot: options.snapshot,
    images: options.images,
  });

  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.strokeStyle = '#cfc2b3';
  context.lineWidth = 3;
  context.strokeRect(
    document.photo.rect.x + 1.5,
    document.photo.rect.y + 1.5,
    document.photo.rect.width - 3,
    document.photo.rect.height - 3,
  );
  context.restore();

  for (const text of document.texts) drawShareText(context, text);
  return document;
}

export async function renderSnapshotToDataUrl(snapshot: MapSnapshot, spec: ExportSpec): Promise<string> {
  const defaultDocument = createDefaultShareDocument({
    width: spec.currentWidth,
    height: spec.currentHeight,
  });
  const shareDocument = spec.document
    ?? (spec.title === undefined
      ? defaultDocument
      : updateShareText(defaultDocument, 'text-1', { text: spec.title }));
  const dimensions = { width: shareDocument.width, height: shareDocument.height };
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前设备无法创建导出画布');
  const images = await loadSceneImages(snapshot);
  drawShareCard(context, {
    snapshot,
    images,
    document: shareDocument,
  });
  return canvas.toDataURL('image/png');
}
