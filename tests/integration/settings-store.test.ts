import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AtomicSettingsStore } from '../../src/main/infrastructure/settings/settings-store';
import type { AppSettings } from '../../src/shared/contracts';
import { defaultAppSettings, parseAppSettings, parseStoredAppSettings } from '../../src/shared/settings';

const temporaryRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-settings-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop()!;
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(target).startsWith('photo-map-settings-')).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

function changedSettings(): AppSettings {
  return {
    schemaVersion: 2,
    mode: 'memory',
    filters: {
      locationCodes: ['156420000'],
      includeUnlocated: false,
      mediaKinds: ['photo', 'live'],
      folderPaths: ['旅行/武汉'],
      typeIds: ['builtin-landscape'],
      search: '武汉',
    },
    map: {
      level: 'city',
      showPhotos: false,
      showPlaceNames: false,
      density: 9,
      camera: { zoom: 2.5, panX: 120, panY: -80 },
    },
  };
}

describe('SDD atomic settings persistence', () => {
  it('loads schema 1 without losing user preferences and writes schema 2 on the next update', async () => {
    const root = await fixtureRoot();
    const settingsPath = path.join(root, 'settings.json');
    const legacy = { ...changedSettings(), schemaVersion: 1, export: { format: 'jpeg', preset: '4:5' } };
    const original = JSON.stringify(legacy);
    await writeFile(settingsPath, original, 'utf8');
    const store = new AtomicSettingsStore(settingsPath);
    expect(await store.initialize()).toEqual({ settings: changedSettings(), created: false, recoveredFromInvalid: false });
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
    await store.update(store.get());
    const reopened = new AtomicSettingsStore(settingsPath);
    expect((await reopened.initialize()).settings).toEqual(changedSettings());
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).not.toHaveProperty('export');
    expect(() => parseAppSettings(legacy)).toThrow('设置数据格式无效');
  });

  it('persists one strict JSON document and returns defensive copies', async () => {
    const root = await fixtureRoot();
    const settingsPath = path.join(root, 'settings.json');
    const store = new AtomicSettingsStore(settingsPath, () => 'stable-id');

    const initialized = await store.initialize();
    expect(initialized).toEqual({
      settings: defaultAppSettings(),
      created: true,
      recoveredFromInvalid: false,
    });

    const updated = await store.update(changedSettings());
    const diskValue = JSON.parse(await readFile(settingsPath, 'utf8')) as unknown;
    expect(diskValue).toEqual(updated);
    expect(parseAppSettings(diskValue)).toEqual(changedSettings());
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    updated.filters.locationCodes.push('156110000');
    expect(store.get()).toEqual(changedSettings());
  });

  it('keeps the last committed settings and in-memory value when a temporary write cannot start', async () => {
    const root = await fixtureRoot();
    const settingsPath = path.join(root, 'settings.json');
    const ids = ['initial', 'blocked'];
    const store = new AtomicSettingsStore(settingsPath, () => ids.shift() ?? 'exhausted');
    await store.initialize();
    const committedText = await readFile(settingsPath, 'utf8');
    await mkdir(path.join(root, '.settings-blocked.tmp'));

    await expect(store.update(changedSettings())).rejects.toMatchObject({
      code: 'SETTINGS_WRITE_FAILED',
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(committedText);
    expect(store.get()).toEqual(defaultAppSettings());
  });

  it('maximum_valid_folder_selection__persists_and_loads_within_the_shared_size_bound', async () => {
    const root = await fixtureRoot();
    const settingsPath = path.join(root, 'settings.json');
    const folderPaths = Array.from({ length: 500 }, (_, index) => (
      `目录${index}/${'照片'.repeat(120)}${index}`
    ));
    const settings: AppSettings = {
      ...changedSettings(),
      filters: { ...changedSettings().filters, folderPaths },
    };
    const store = new AtomicSettingsStore(settingsPath, () => 'large-settings');
    await store.initialize();
    await store.update(settings);

    const reopened = new AtomicSettingsStore(settingsPath);
    const loaded = await reopened.initialize();

    expect((await stat(settingsPath)).size).toBeGreaterThan(64 * 1024);
    expect(loaded).toEqual({ settings, created: false, recoveredFromInvalid: false });
  });
});

describe('SDD settings recovery and strict schema', () => {
  it('loads legacy filters with unlocated disabled and accepts the current unlocated preference', () => {
    const settings = changedSettings();
    const {
      includeUnlocated: _removedUnlocated,
      mediaKinds: _removedMediaKinds,
      folderPaths: _removedFolderPaths,
      ...legacyFilters
    } = settings.filters;

    expect(parseStoredAppSettings({ ...settings, schemaVersion: 1, export: { format: 'jpeg', preset: '4:5' }, filters: legacyFilters })).toEqual({
      ...settings,
      filters: {
        ...settings.filters,
        includeUnlocated: false,
        mediaKinds: ['photo', 'video', 'live'],
        folderPaths: [],
      },
    });
    expect(parseAppSettings({
      ...settings,
      filters: { ...settings.filters, includeUnlocated: true },
    }).filters.includeUnlocated).toBe(true);
  });

  it('loads pre-media-filter settings with every media kind selected', () => {
    const settings = changedSettings();
    const { mediaKinds: _removedMediaKinds, folderPaths: _removedFolderPaths, ...previousFilters } = settings.filters;

    expect(parseStoredAppSettings({ ...settings, schemaVersion: 1, export: { format: 'jpeg', preset: '4:5' }, filters: previousFilters }).filters).toEqual({
      ...settings.filters,
      mediaKinds: ['photo', 'video', 'live'],
      folderPaths: [],
    });
  });

  it('loads pre-folder-filter settings with no folder selected', () => {
    const settings = changedSettings();
    const { folderPaths: _removed, ...previousFilters } = settings.filters;

    expect(parseStoredAppSettings({ ...settings, schemaVersion: 1, export: { format: 'jpeg', preset: '4:5' }, filters: previousFilters }).filters).toEqual({
      ...settings.filters,
      folderPaths: [],
    });
  });

  it('loads legacy schema-1 map settings with place names enabled by default', () => {
    const settings = changedSettings();
    const { showPlaceNames: _removed, ...legacyMap } = settings.map;

    expect(parseStoredAppSettings({ ...settings, schemaVersion: 1, export: { format: 'jpeg', preset: '4:5' }, map: legacyMap })).toEqual({
      ...settings,
      map: { ...settings.map, showPlaceNames: true },
    });
  });

  it('loads defaults without overwriting a malformed settings file', async () => {
    const root = await fixtureRoot();
    const settingsPath = path.join(root, 'settings.json');
    const malformed = '{"schemaVersion":1,"mode":';
    await writeFile(settingsPath, malformed, 'utf8');
    const store = new AtomicSettingsStore(settingsPath);

    const loaded = await store.initialize();

    expect(loaded).toEqual({
      settings: defaultAppSettings(),
      created: false,
      recoveredFromInvalid: true,
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(malformed);
  });

  it.each([
    ['unknown root key', { ...changedSettings(), unexpected: true }],
    ['unsupported schema', { ...changedSettings(), schemaVersion: 99 }],
    ['unknown nested key', {
      ...changedSettings(),
      filters: { ...changedSettings().filters, path: 'D:\\private\\photo.jpg' },
    }],
    ['out-of-range camera', {
      ...changedSettings(),
      map: { ...changedSettings().map, camera: { zoom: 99, panX: 0, panY: 0 } },
    }],
    ['out-of-range density', {
      ...changedSettings(),
      map: { ...changedSettings().map, density: 10 },
    }],
    ['duplicate identifiers', {
      ...changedSettings(),
      filters: { ...changedSettings().filters, typeIds: ['same', 'same'] },
    }],
    ['unknown media kind', {
      ...changedSettings(),
      filters: { ...changedSettings().filters, mediaKinds: ['photo', 'audio'] },
    }],
    ['absolute folder path', {
      ...changedSettings(),
      filters: { ...changedSettings().filters, folderPaths: ['D:\\private'] },
    }],
    ['folder path deeper than two levels', {
      ...changedSettings(),
      filters: { ...changedSettings().filters, folderPaths: ['旅行/武汉/东湖'] },
    }],
    ['case-insensitive duplicate folder paths', {
      ...changedSettings(),
      filters: { ...changedSettings().filters, folderPaths: ['Travel/Wuhan', 'travel/wuhan'] },
    }],
  ])('rejects %s instead of permissively merging it', (_label, invalid) => {
    expect(() => parseAppSettings(invalid)).toThrow('设置数据格式无效');
  });
});
