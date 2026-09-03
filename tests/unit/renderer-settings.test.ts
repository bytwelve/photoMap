import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../../src/shared/contracts';
import {
  appSettingsFromRenderer,
  normalizeAppSettings,
  rendererPreferencesFromSettings,
} from '../../src/renderer/settings';

describe('renderer app settings', () => {
  it('falls back safely for unknown schema and invalid values', () => {
    expect(normalizeAppSettings({ schemaVersion: 99, mode: 'broken' })).toEqual(DEFAULT_APP_SETTINGS);
    const normalized = normalizeAppSettings({
      schemaVersion: 2,
      mode: 'memory',
      filters: { search: 42, locationCodes: ['a', 'a', 3], typeIds: ['type-1'] },
      map: { level: 'city', showPhotos: false, density: 99, camera: { zoom: Number.NaN, panX: 4, panY: Infinity } },
    });
    expect(normalized.mode).toBe('memory');
    expect(normalized.filters.locationCodes).toEqual(['a']);
    expect(normalized.filters.mediaKinds).toEqual(['photo', 'video', 'live']);
    expect(normalized.filters.folderPaths).toEqual([]);
    expect(normalized.map.density).toBe(9);
    expect(normalized.map.showPlaceNames).toBe(true);
    expect(normalized.map.camera).toEqual({ zoom: 1.18, panX: 4, panY: 0 });
    expect(normalized).not.toHaveProperty('export');
  });

  it('uses density five as the best midpoint and preserves the new dense end of the range', () => {
    expect(DEFAULT_APP_SETTINGS.map.density).toBe(5);
    const preferences = rendererPreferencesFromSettings({
      ...DEFAULT_APP_SETTINGS,
      map: { ...DEFAULT_APP_SETTINGS.map, density: 9 },
    });

    expect(preferences.map.density).toBe(9);
    expect(appSettingsFromRenderer(preferences).map.density).toBe(9);
  });

  it('round-trips renderer sets as stable sorted arrays', () => {
    const preferences = rendererPreferencesFromSettings({
      ...DEFAULT_APP_SETTINGS,
      mode: 'batch',
      filters: { search: '武汉', locationCodes: ['b', 'a'], includeUnlocated: true, mediaKinds: ['live', 'photo'], folderPaths: ['旅行/武汉', '工作'], typeIds: ['z', 'x'] },
      map: { ...DEFAULT_APP_SETTINGS.map, showPlaceNames: false },
    });
    expect(appSettingsFromRenderer(preferences).filters).toEqual({
      search: '武汉',
      locationCodes: ['a', 'b'],
      includeUnlocated: true,
      mediaKinds: ['photo', 'live'],
      folderPaths: ['工作', '旅行/武汉'],
      typeIds: ['x', 'z'],
    });
    expect(appSettingsFromRenderer(preferences).map.showPlaceNames).toBe(false);
  });

  it('migrates the former 1.0 maximum-extent camera to the new 1.18 base without dropping settings', () => {
    const preferences = rendererPreferencesFromSettings({
      ...DEFAULT_APP_SETTINGS,
      mode: 'memory',
      map: {
        ...DEFAULT_APP_SETTINGS.map,
        density: 5,
        camera: { zoom: 1, panX: 120, panY: -80 },
      },
    });

    expect(preferences.mode).toBe('memory');
    expect(preferences.map.density).toBe(5);
    expect(preferences.map.camera).toEqual({ zoom: 1.18, panX: 120, panY: -80 });
  });

  it('keeps export options out of renderer settings', () => {
    const preferences = rendererPreferencesFromSettings(DEFAULT_APP_SETTINGS);
    expect(preferences).not.toHaveProperty('export');
    expect(appSettingsFromRenderer(preferences)).not.toHaveProperty('export');
  });
});
