import type {
  AppMode,
  FilterState,
  MapLevel,
  PhotoRecord,
  RegionFeature,
  WallPhotoSelections,
} from './model';
import { folderFilterPathKey, folderPathMatches } from '../shared/folder-filter';

export interface SelectionPoint {
  x: number;
  y: number;
}

export interface SelectionBounds extends SelectionPoint {
  width: number;
  height: number;
}

export interface PostcardEntryOrigin {
  left: number;
  top: number;
  width: number;
  height: number;
  viewTransition?: boolean;
}

export const BATCH_DRAG_THRESHOLD = 4;
export const MIN_BATCH_COLUMN_COUNT = 2;
export const MAX_BATCH_COLUMN_COUNT = 10;
export const DEFAULT_BATCH_COLUMN_COUNT = 4;

export function mediaKindLabel(mediaKind: PhotoRecord['mediaKind']): string {
  switch (mediaKind) {
    case 'video': return '【视频】';
    case 'live': return '【实况】';
    default: return '【照片】';
  }
}

export function isWallEligiblePhoto(photo: PhotoRecord): boolean {
  return photo.mediaKind === 'photo'
    && photo.decodeState === 'valid'
    && Boolean(photo.location?.provinceCode);
}

export function annotationPreviewUrl(photo: PhotoRecord): string {
  return photo.mediaKind === 'video' || photo.mediaFormat === 'heic' || photo.mediaFormat === 'avif'
    ? photo.thumbnailUrl
    : photo.mediaUrl;
}

export function annotationPlaybackUrl(photo: PhotoRecord): string {
  return photo.mediaKind === 'live' ? `${photo.mediaUrl}?content=motion` : photo.mediaUrl;
}

export function normalizeBatchColumnCount(
  value: string | number,
  fallback = DEFAULT_BATCH_COLUMN_COUNT,
): number {
  const normalizedFallback = Math.min(
    MAX_BATCH_COLUMN_COUNT,
    Math.max(MIN_BATCH_COLUMN_COUNT, Math.round(Number.isFinite(fallback) ? fallback : DEFAULT_BATCH_COLUMN_COUNT)),
  );
  if (typeof value === 'string' && value.trim() === '') return normalizedFallback;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return normalizedFallback;
  return Math.min(MAX_BATCH_COLUMN_COUNT, Math.max(MIN_BATCH_COLUMN_COUNT, Math.round(numericValue)));
}

export function hasReachedBatchDragThreshold(start: SelectionPoint, current: SelectionPoint): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= BATCH_DRAG_THRESHOLD;
}

export function selectionBoundsFromPoints(start: SelectionPoint, current: SelectionPoint): SelectionBounds {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

export function selectionBoundsIntersect(left: SelectionBounds, right: SelectionBounds): boolean {
  return (
    left.x + left.width >= right.x
    && left.x <= right.x + right.width
    && left.y + left.height >= right.y
    && left.y <= right.y + right.height
  );
}

export function parentProvinceCode(code = ''): string {
  return code.length >= 5 ? `${code.slice(0, 5)}0000` : '';
}

export interface FilterItemSortKey {
  pinned: boolean;
  photoCount: number;
  sourceOrder: number;
}

export function compareFilterItems(left: FilterItemSortKey, right: FilterItemSortKey): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  if (!left.pinned && left.photoCount !== right.photoCount) return right.photoCount - left.photoCount;
  return left.sourceOrder - right.sourceOrder;
}

export interface FolderFilterNode {
  path: string;
  name: string;
  photoCount: number;
  children: FolderFilterNode[];
}

export function buildFolderFilterTree(photos: readonly PhotoRecord[]): FolderFilterNode[] {
  const roots = new Map<string, FolderFilterNode>();
  const childrenByRoot = new Map<string, Map<string, FolderFilterNode>>();
  for (const photo of photos) {
    const folderPath = photo.folderPath;
    if (!folderPath) continue;
    const [rootName, childName] = folderPath.split('/');
    if (!rootName) continue;
    const rootKey = folderFilterPathKey(rootName);
    if (!rootKey) continue;
    const root = roots.get(rootKey) ?? {
      path: rootName,
      name: rootName,
      photoCount: 0,
      children: [],
    };
    root.photoCount += 1;
    roots.set(rootKey, root);
    if (!childName) continue;
    const childKey = folderFilterPathKey(folderPath);
    if (!childKey) continue;
    const children = childrenByRoot.get(rootKey) ?? new Map<string, FolderFilterNode>();
    let child = children.get(childKey);
    if (!child) {
      child = { path: `${root.path}/${childName}`, name: childName, photoCount: 0, children: [] };
      children.set(childKey, child);
      childrenByRoot.set(rootKey, children);
      root.children.push(child);
    }
    child.photoCount += 1;
  }
  const compareNames = (left: FolderFilterNode, right: FolderFilterNode): number => (
    left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
  );
  const result = [...roots.values()].sort(compareNames);
  for (const root of result) root.children.sort(compareNames);
  return result;
}

export function folderPathSetHas(paths: ReadonlySet<string>, targetPath: string): boolean {
  const targetKey = folderFilterPathKey(targetPath);
  return targetKey !== undefined && [...paths].some((path) => folderFilterPathKey(path) === targetKey);
}

function deleteFolderPath(paths: Set<string>, targetPath: string): void {
  const targetKey = folderFilterPathKey(targetPath);
  if (!targetKey) return;
  for (const path of paths) {
    if (folderFilterPathKey(path) === targetKey) paths.delete(path);
  }
}

export function toggleParentFolderFilter(
  selectedPaths: ReadonlySet<string>,
  parentPath: string,
): Set<string> {
  const next = new Set(selectedPaths);
  const parentKey = folderFilterPathKey(parentPath);
  if (!parentKey) return next;
  const removingParent = folderPathSetHas(next, parentPath);
  for (const selectedPath of next) {
    const selectedKey = folderFilterPathKey(selectedPath);
    if (selectedKey && (selectedKey === parentKey || selectedKey.startsWith(`${parentKey}/`))) {
      next.delete(selectedPath);
    }
  }
  if (!removingParent) next.add(parentPath);
  return next;
}

export function toggleChildFolderFilter(
  selectedPaths: ReadonlySet<string>,
  parentPath: string,
  childPath: string,
): Set<string> {
  const next = new Set(selectedPaths);
  if (folderPathSetHas(next, childPath)) {
    deleteFolderPath(next, childPath);
    return next;
  }
  deleteFolderPath(next, parentPath);
  next.add(childPath);
  return next;
}

export function toggleProvinceLocationFilter(
  selectedCodes: ReadonlySet<string>,
  provinceCode: string,
  childCityCodes: readonly string[],
): Set<string> {
  const next = new Set(selectedCodes);
  const removingProvince = next.has(provinceCode);
  next.delete(provinceCode);
  for (const cityCode of childCityCodes) next.delete(cityCode);
  if (!removingProvince) next.add(provinceCode);
  return next;
}

export function toggleCityLocationFilter(
  selectedCodes: ReadonlySet<string>,
  provinceCode: string,
  cityCode: string,
): Set<string> {
  const next = new Set(selectedCodes);
  if (next.has(cityCode)) {
    next.delete(cityCode);
    return next;
  }
  next.delete(provinceCode);
  next.add(cityCode);
  return next;
}

export function shortRegionName(name = ''): string {
  return name
    .replace('特别行政区', '')
    .replace('壮族自治区', '')
    .replace('回族自治区', '')
    .replace('维吾尔自治区', '')
    .replace('自治区', '')
    .replace('省', '')
    .replace('市', '');
}

export function isAdministrativeRegion(feature: RegionFeature): boolean {
  return /^156\d{6}$/u.test(String(feature.properties.gb ?? ''));
}

export function filterPhotos(photos: readonly PhotoRecord[], filters: FilterState): PhotoRecord[] {
  const query = filters.search.trim().toLocaleLowerCase('zh-CN');
  return photos.filter((photo) => {
    const hasLocationFilter = filters.includeUnlocated || filters.locationCodes.size > 0;
    const unlocated = !photo.location?.provinceCode;
    const locationMatch = !hasLocationFilter
      || (filters.includeUnlocated && unlocated)
      || (photo.location?.provinceCode ? filters.locationCodes.has(photo.location.provinceCode) : false)
      || (photo.location?.cityCode ? filters.locationCodes.has(photo.location.cityCode) : false);
    const typeMatch = filters.typeIds.size === 0
      || photo.types.some((type) => filters.typeIds.has(type.id));
    const mediaKindMatch = filters.mediaKinds.has(photo.mediaKind);
    const folderPath = photo.folderPath;
    const folderMatch = folderPathMatches(folderPath, filters.folderPaths);
    const searchMatch = query.length === 0
      || [
        photo.name,
        photo.folderPath,
        photo.location?.provinceName,
        photo.location?.cityName,
        unlocated ? '未标记地点' : undefined,
        ...photo.types.map((type) => type.name),
      ].some((value) => value?.toLocaleLowerCase('zh-CN').includes(query));
    return locationMatch && typeMatch && mediaKindMatch && folderMatch && searchMatch;
  });
}

export function activeFiltersForMode(filters: FilterState, mode: AppMode): FilterState {
  if (mode !== 'wall' || !filters.includeUnlocated) return filters;
  return { ...filters, includeUnlocated: false };
}

export function sortAnnotationPhotosByCreationTime(photos: readonly PhotoRecord[]): PhotoRecord[] {
  return [...photos].sort((left, right) => {
    const leftCreatedAt = typeof left.fileCreatedAtMs === 'number' && Number.isFinite(left.fileCreatedAtMs)
      ? left.fileCreatedAtMs
      : undefined;
    const rightCreatedAt = typeof right.fileCreatedAtMs === 'number' && Number.isFinite(right.fileCreatedAtMs)
      ? right.fileCreatedAtMs
      : undefined;

    if (leftCreatedAt === undefined && rightCreatedAt !== undefined) return 1;
    if (leftCreatedAt !== undefined && rightCreatedAt === undefined) return -1;
    if (leftCreatedAt !== undefined && rightCreatedAt !== undefined && leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function groupPhotosByRegion(
  photos: readonly PhotoRecord[],
  level: 'province' | 'city',
): ReadonlyMap<string, readonly PhotoRecord[]> {
  const groups = new Map<string, PhotoRecord[]>();
  for (const photo of photos) {
    if (!isWallEligiblePhoto(photo)) continue;
    const key = level === 'province' ? photo.location?.provinceCode : photo.location?.cityCode;
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(photo);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.id.localeCompare(right.id));
  }
  return groups;
}

export function wallPhotoSelectionKey(level: MapLevel, regionCode: string): string {
  return `${level}:${regionCode}`;
}

export function applyWallPhotoSelections(
  photosByRegion: ReadonlyMap<string, readonly PhotoRecord[]>,
  level: MapLevel,
  selections: WallPhotoSelections,
): {
  photosByRegion: ReadonlyMap<string, readonly PhotoRecord[]>;
  fixedRegionCodes: ReadonlySet<string>;
} {
  const result = new Map(photosByRegion);
  const fixedRegionCodes = new Set<string>();
  const keyPrefix = `${level}:`;

  for (const [key, selectedIds] of selections) {
    if (!key.startsWith(keyPrefix) || selectedIds.length === 0) continue;
    const regionCode = key.slice(keyPrefix.length);
    if (!regionCode) continue;

    const candidatesById = new Map(
      (photosByRegion.get(regionCode) ?? []).map((photo) => [photo.id, photo]),
    );
    const selectedPhotos: PhotoRecord[] = [];
    const seen = new Set<string>();
    for (const photoId of selectedIds) {
      if (seen.has(photoId)) continue;
      seen.add(photoId);
      const photo = candidatesById.get(photoId);
      if (photo) selectedPhotos.push(photo);
    }

    // Keep an unavailable fixed selection empty instead of silently falling
    // back to random candidates. The user can explicitly restore randomness.
    result.set(regionCode, selectedPhotos);
    fixedRegionCodes.add(regionCode);
  }

  return { photosByRegion: result, fixedRegionCodes };
}

export function intersectSelection(selection: ReadonlySet<string>, photos: readonly PhotoRecord[]): Set<string> {
  const visibleIds = new Set(photos.map((photo) => photo.id));
  return new Set([...selection].filter((id) => visibleIds.has(id)));
}

export function stableHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function stablePhotoOrder(photos: readonly PhotoRecord[], seed: string): PhotoRecord[] {
  return [...photos].sort((left, right) => {
    const leftHash = stableHash(`${seed}:${left.id}`);
    const rightHash = stableHash(`${seed}:${right.id}`);
    return leftHash === rightHash ? left.id.localeCompare(right.id) : leftHash - rightHash;
  });
}
