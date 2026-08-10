import type { AppSettings, MediaKind } from './contracts';
import {
  DEFAULT_APP_SETTINGS,
  MAX_MAP_DENSITY,
  MEDIA_KINDS,
  MIN_MAP_DENSITY,
} from './contracts';
import { folderFilterPathKey, normalizeFolderFilterPath } from './folder-filter';
import { PhotoMapError } from './errors';

const GB_PATTERN = /^156\d{6}$/;
const TYPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function invalidSettings(): never {
  throw new PhotoMapError('INVALID_REQUEST', '设置数据格式无效。');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseUniqueStrings(
  value: unknown,
  pattern: RegExp,
  maximumItems: number
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return invalidSettings();
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item) || seen.has(item)) {
      return invalidSettings();
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    return invalidSettings();
  }
  return value;
}

function parseMediaKinds(value: unknown): MediaKind[] {
  if (!Array.isArray(value) || value.length > MEDIA_KINDS.length) return invalidSettings();
  const result: MediaKind[] = [];
  const seen = new Set<MediaKind>();
  for (const item of value) {
    if (typeof item !== 'string' || !MEDIA_KINDS.includes(item as MediaKind) || seen.has(item as MediaKind)) {
      return invalidSettings();
    }
    const mediaKind = item as MediaKind;
    seen.add(mediaKind);
    result.push(mediaKind);
  }
  return result;
}

function parseFolderPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500) return invalidSettings();
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return invalidSettings();
    const normalized = normalizeFolderFilterPath(item);
    const key = normalized ? folderFilterPathKey(normalized) : undefined;
    if (!normalized || !key || seen.has(key)) return invalidSettings();
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function cloneAppSettings(settings: AppSettings): AppSettings {
  return {
    schemaVersion: 2,
    mode: settings.mode,
    filters: {
      locationCodes: [...settings.filters.locationCodes],
      includeUnlocated: settings.filters.includeUnlocated,
      mediaKinds: [...settings.filters.mediaKinds],
      folderPaths: [...settings.filters.folderPaths],
      typeIds: [...settings.filters.typeIds],
      search: settings.filters.search
    },
    map: {
      level: settings.map.level,
      showPhotos: settings.map.showPhotos,
      showPlaceNames: settings.map.showPlaceNames,
      density: settings.map.density,
      camera: { ...settings.map.camera }
    }
  };
}

export function defaultAppSettings(): AppSettings {
  return cloneAppSettings(DEFAULT_APP_SETTINGS);
}

export function parseAppSettings(value: unknown): AppSettings {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'mode', 'filters', 'map'])) {
    return invalidSettings();
  }
  if (value.schemaVersion !== 2 || (value.mode !== 'wall' && value.mode !== 'memory' && value.mode !== 'batch')) {
    return invalidSettings();
  }

  if (!isRecord(value.filters)) {
    return invalidSettings();
  }
  const hasCurrentFilterKeys = hasExactKeys(value.filters, ['locationCodes', 'includeUnlocated', 'mediaKinds', 'folderPaths', 'typeIds', 'search']);
  if (!hasCurrentFilterKeys) return invalidSettings();
  const locationCodes = parseUniqueStrings(value.filters.locationCodes, GB_PATTERN, 500);
  const typeIds = parseUniqueStrings(value.filters.typeIds, TYPE_ID_PATTERN, 500);
  const mediaKinds = parseMediaKinds(value.filters.mediaKinds);
  const folderPaths = parseFolderPaths(value.filters.folderPaths);
  if (
    typeof value.filters.includeUnlocated !== 'boolean'
    || typeof value.filters.search !== 'string'
    || value.filters.search.length > 200
  ) {
    return invalidSettings();
  }

  if (!isRecord(value.map)) {
    return invalidSettings();
  }
  const hasCurrentMapKeys = hasExactKeys(value.map, ['level', 'showPhotos', 'showPlaceNames', 'density', 'camera']);
  if (!hasCurrentMapKeys) return invalidSettings();
  if (
    (value.map.level !== 'province' && value.map.level !== 'city') ||
    typeof value.map.showPhotos !== 'boolean' ||
    typeof value.map.showPlaceNames !== 'boolean' ||
    !Number.isInteger(value.map.density) ||
    typeof value.map.density !== 'number' ||
    value.map.density < MIN_MAP_DENSITY ||
    value.map.density > MAX_MAP_DENSITY ||
    !isRecord(value.map.camera) ||
    !hasExactKeys(value.map.camera, ['zoom', 'panX', 'panY'])
  ) {
    return invalidSettings();
  }
  const zoom = finiteNumber(value.map.camera.zoom, 1, 3.2);
  const panX = finiteNumber(value.map.camera.panX, -1_000_000, 1_000_000);
  const panY = finiteNumber(value.map.camera.panY, -1_000_000, 1_000_000);

  return {
    schemaVersion: 2,
    mode: value.mode,
    filters: {
      locationCodes,
      includeUnlocated: value.filters.includeUnlocated,
      mediaKinds,
      folderPaths,
      typeIds,
      search: value.filters.search,
    },
    map: {
      level: value.map.level,
      showPhotos: value.map.showPhotos,
      showPlaceNames: value.map.showPlaceNames,
      density: value.map.density as AppSettings['map']['density'],
      camera: { zoom, panX, panY }
    }
  };
}

/** Convert on-disk schema 1 at the persistence boundary; IPC only accepts schema 2. */
export function parseStoredAppSettings(value: unknown): AppSettings {
  if (!isRecord(value) || value.schemaVersion !== 1) return parseAppSettings(value);
  if (!hasExactKeys(value, ['schemaVersion', 'mode', 'filters', 'map', 'export'])
    || !isRecord(value.filters) || !isRecord(value.map)
    || !isRecord(value.export) || !hasExactKeys(value.export, ['format', 'preset'])
    || (value.export.format !== 'png' && value.export.format !== 'jpeg')
    || typeof value.export.preset !== 'string'
    || !['viewport', '1:1', '4:5'].includes(value.export.preset)) {
    return invalidSettings();
  }
  return parseAppSettings({
    schemaVersion: 2,
    mode: value.mode,
    filters: { includeUnlocated: false, mediaKinds: [...MEDIA_KINDS], folderPaths: [], ...value.filters },
    map: { showPlaceNames: true, ...value.map },
  });
}
