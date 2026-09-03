import {
  DEFAULT_APP_SETTINGS,
  MAX_MAP_DENSITY,
  MEDIA_KINDS,
  MIN_MAP_DENSITY,
  type AppSettings,
  type MapDensity,
  type MediaKind,
} from '../shared/contracts';
import { folderFilterPathKey, normalizeFolderFilterPath } from '../shared/folder-filter';
import type { AppMode, FilterState, MapCamera, MapLevel } from './model';
import { MAX_MAP_ZOOM, MIN_MAP_ZOOM } from './map-scene/interaction';

export interface RendererMapPreference {
  level: MapLevel;
  showPhotos: boolean;
  showPlaceNames: boolean;
  density: MapDensity;
  camera: MapCamera;
}

export interface RendererPreferences {
  mode: AppMode;
  filters: FilterState;
  map: RendererMapPreference;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

function mediaKindArray(value: unknown, fallback: readonly MediaKind[]): MediaKind[] {
  if (!Array.isArray(value)) return [...fallback];
  const selected = new Set(value.filter(
    (item): item is MediaKind => typeof item === 'string' && MEDIA_KINDS.includes(item as MediaKind),
  ));
  return MEDIA_KINDS.filter((mediaKind) => selected.has(mediaKind));
}

function folderPathArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = normalizeFolderFilterPath(item);
    const key = normalized ? folderFilterPathKey(normalized) : undefined;
    if (normalized && key && !result.has(key)) result.set(key, normalized);
  }
  return [...result.values()];
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function safeDefaultSettings(): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    filters: {
      ...DEFAULT_APP_SETTINGS.filters,
      locationCodes: [...DEFAULT_APP_SETTINGS.filters.locationCodes],
      mediaKinds: [...DEFAULT_APP_SETTINGS.filters.mediaKinds],
      folderPaths: [...DEFAULT_APP_SETTINGS.filters.folderPaths],
      typeIds: [...DEFAULT_APP_SETTINGS.filters.typeIds],
    },
    map: {
      ...DEFAULT_APP_SETTINGS.map,
      camera: { ...DEFAULT_APP_SETTINGS.map.camera },
    },
  };
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const fallback = safeDefaultSettings();
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 2) return fallback;
  const filters = candidate.filters && typeof candidate.filters === 'object'
    ? candidate.filters as Record<string, unknown>
    : {};
  const map = candidate.map && typeof candidate.map === 'object'
    ? candidate.map as Record<string, unknown>
    : {};
  const camera = map.camera && typeof map.camera === 'object'
    ? map.camera as Record<string, unknown>
    : {};
  const density = finiteNumber(map.density, fallback.map.density);
  return {
    schemaVersion: 2,
    mode: candidate.mode === 'memory' || candidate.mode === 'batch' || candidate.mode === 'wall'
      ? candidate.mode
      : fallback.mode,
    filters: {
      locationCodes: stringArray(filters.locationCodes),
      includeUnlocated: typeof filters.includeUnlocated === 'boolean'
        ? filters.includeUnlocated
        : fallback.filters.includeUnlocated,
      mediaKinds: mediaKindArray(filters.mediaKinds, fallback.filters.mediaKinds),
      folderPaths: folderPathArray(filters.folderPaths),
      typeIds: stringArray(filters.typeIds),
      search: typeof filters.search === 'string' ? filters.search : fallback.filters.search,
    },
    map: {
      level: map.level === 'city' || map.level === 'province' ? map.level : fallback.map.level,
      showPhotos: typeof map.showPhotos === 'boolean' ? map.showPhotos : fallback.map.showPhotos,
      showPlaceNames: typeof map.showPlaceNames === 'boolean' ? map.showPlaceNames : fallback.map.showPlaceNames,
      density: Math.max(MIN_MAP_DENSITY, Math.min(MAX_MAP_DENSITY, Math.round(density))) as MapDensity,
      camera: {
        zoom: Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, finiteNumber(camera.zoom, fallback.map.camera.zoom))),
        panX: finiteNumber(camera.panX, fallback.map.camera.panX),
        panY: finiteNumber(camera.panY, fallback.map.camera.panY),
      },
    },
  };
}

export function rendererPreferencesFromSettings(settings: AppSettings): RendererPreferences {
  const normalized = normalizeAppSettings(settings);
  return {
    mode: normalized.mode,
    filters: {
      search: normalized.filters.search,
      locationCodes: new Set(normalized.filters.locationCodes),
      includeUnlocated: normalized.filters.includeUnlocated,
      mediaKinds: new Set(normalized.filters.mediaKinds),
      folderPaths: new Set(normalized.filters.folderPaths),
      typeIds: new Set(normalized.filters.typeIds),
    },
    map: {
      ...normalized.map,
      camera: { ...normalized.map.camera },
    },
  };
}

export function appSettingsFromRenderer(preferences: RendererPreferences): AppSettings {
  return normalizeAppSettings({
    schemaVersion: 2,
    mode: preferences.mode,
    filters: {
      search: preferences.filters.search,
      locationCodes: [...preferences.filters.locationCodes].sort(),
      includeUnlocated: preferences.filters.includeUnlocated,
      mediaKinds: MEDIA_KINDS.filter((mediaKind) => preferences.filters.mediaKinds.has(mediaKind)),
      folderPaths: [...preferences.filters.folderPaths].sort(),
      typeIds: [...preferences.filters.typeIds].sort(),
    },
    map: {
      ...preferences.map,
      camera: { ...preferences.map.camera },
    },
  });
}
