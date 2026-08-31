import type { MapLevel, PhotoRecord, RegionFeature, WallPhotoSelections } from './model';


export function parentProvinceCode(code = ''): string {
  return code.length >= 5 ? `${code.slice(0, 5)}0000` : '';
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

export function isWallEligiblePhoto(photo: PhotoRecord): boolean {
  return photo.mediaKind === 'photo'
    && photo.decodeState === 'valid'
    && Boolean(photo.location?.provinceCode);
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

export function annotationPlaybackUrl(photo: PhotoRecord): string {
  return photo.mediaKind === 'live' ? `${photo.mediaUrl}?content=motion` : photo.mediaUrl;
}
