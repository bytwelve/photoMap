import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  getPath: vi.fn(() => 'C:\\Users\\fixture\\AppData\\Roaming'),
  setPath: vi.fn(),
  getAppPath: vi.fn(() => 'D:\\photo-map\\app'),
  isPackaged: false,
}));

vi.mock('electron', () => ({
  app: {
    getPath: electronMocks.getPath,
    setPath: electronMocks.setPath,
    getAppPath: electronMocks.getAppPath,
    get isPackaged() {
      return electronMocks.isPackaged;
    },
  },
}));

import {
  PORTABLE_DATA_DIRECTORY_NAME,
  PORTABLE_MARKER_FILENAME,
  configureAppPaths,
  initializeAppDirectories,
  resolvePortableDataRoot,
  resolvePhotoMapDataRoot,
} from '../../src/main/bootstrap/app-paths';

const originalLocalAppData = process.env.LOCALAPPDATA;

afterEach(() => {
  vi.clearAllMocks();
  electronMocks.isPackaged = false;
  if (originalLocalAppData === undefined) {
    delete process.env.LOCALAPPDATA;
  } else {
    process.env.LOCALAPPDATA = originalLocalAppData;
  }
});

describe('SDD application data directory contract', () => {
  it('uses LOCALAPPDATA on Windows and refuses a roaming-storage fallback', () => {
    const local = path.join('C:', 'Users', 'fixture', 'AppData', 'Local');
    expect(resolvePhotoMapDataRoot('win32', `  ${local}  `, 'ignored')).toBe(
      path.join(local, 'PhotoMap'),
    );
    expect(() => resolvePhotoMapDataRoot('win32', undefined, 'roaming')).toThrow(
      'LOCALAPPDATA is unavailable',
    );
    expect(() => resolvePhotoMapDataRoot('win32', '   ', 'roaming')).toThrow(
      'LOCALAPPDATA is unavailable',
    );
  });

  it('uses the platform application-data directory outside Windows', () => {
    const appData = path.join('home', 'fixture', '.local', 'share');
    expect(resolvePhotoMapDataRoot('linux', undefined, appData)).toBe(
      path.join(appData, 'PhotoMap'),
    );
  });

  it('uses an explicit portable root without requiring LOCALAPPDATA', () => {
    const portableRoot = path.join('E:', '照片地图 便携版', PORTABLE_DATA_DIRECTORY_NAME);
    expect(resolvePhotoMapDataRoot('win32', undefined, 'ignored', portableRoot)).toBe(portableRoot);
  });

  it('enables portable storage only for a packaged Windows build with a regular marker file', () => {
    const executablePath = path.join('D:', '便携 应用', 'PhotoMap.exe');
    const markerProbe = vi.fn(() => 'file' as const);

    expect(resolvePortableDataRoot('win32', true, executablePath, markerProbe)).toBe(
      path.join(path.dirname(executablePath), PORTABLE_DATA_DIRECTORY_NAME),
    );
    expect(markerProbe).toHaveBeenCalledOnce();
    expect(markerProbe).toHaveBeenCalledWith(
      path.join(path.dirname(executablePath), PORTABLE_MARKER_FILENAME),
    );
  });

  it('does not infer portable mode for development, non-Windows, or a missing marker', () => {
    const executablePath = path.join('D:', 'PhotoMap', 'PhotoMap.exe');
    const presentMarker = vi.fn(() => 'file' as const);

    expect(resolvePortableDataRoot('win32', false, executablePath, presentMarker)).toBeUndefined();
    expect(resolvePortableDataRoot('linux', true, executablePath, presentMarker)).toBeUndefined();
    expect(presentMarker).not.toHaveBeenCalled();
    expect(resolvePortableDataRoot('win32', true, executablePath, () => 'missing')).toBeUndefined();
  });

  it('refuses an invalid or unreadable portable marker instead of silently writing to LOCALAPPDATA', () => {
    const executablePath = path.join('D:', 'PhotoMap', 'PhotoMap.exe');

    expect(() => resolvePortableDataRoot('win32', true, executablePath, () => 'other')).toThrow(
      '便携版标记无效',
    );
    expect(() => resolvePortableDataRoot('win32', true, executablePath, () => {
      throw new Error('EACCES');
    })).toThrow('EACCES');
  });

  it('keeps installed application state compatible while isolating imported map data from the Squirrel root', async () => {
    const local = await mkdtemp(path.join(os.tmpdir(), 'photo-map-installed-paths-'));
    process.env.LOCALAPPDATA = local;
    try {
      const resolved = configureAppPaths();
      const dataRoot = path.join(local, 'PhotoMap');
      const mapDataDirectory = path.join(local, 'PhotoMapData', 'data', 'map-data', 'v1');

      expect(resolved).toEqual({
        dataRoot,
        dataDirectory: path.join(dataRoot, 'data'),
        mapDataDirectory,
        backupsDirectory: path.join(dataRoot, 'data', 'backups'),
        cacheDirectory: path.join(dataRoot, 'cache'),
        logsDirectory: path.join(dataRoot, 'logs'),
        tempDirectory: path.join(dataRoot, 'temp'),
        crashDumpsDirectory: path.join(dataRoot, 'crash-dumps'),
        settingsPath: path.join(dataRoot, 'settings.json'),
        sessionDataDirectory: path.join(dataRoot, 'chromium'),
        databasePath: path.join(dataRoot, 'data', 'index.sqlite3'),
        thumbnailRoot: path.join(dataRoot, 'cache', 'thumbnails', 'v1'),
        assetRoot: path.resolve(electronMocks.getAppPath(), 'resources'),
      });
      expect(electronMocks.setPath).toHaveBeenCalledTimes(2);
      expect(electronMocks.setPath).toHaveBeenNthCalledWith(1, 'userData', dataRoot);
      expect(electronMocks.setPath).toHaveBeenNthCalledWith(
        2,
        'sessionData',
        path.join(dataRoot, 'chromium'),
      );

      await initializeAppDirectories(resolved);

      expect((await stat(mapDataDirectory)).isDirectory()).toBe(true);
      await expect(access(path.join(dataRoot, 'data', 'map-data'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  });

  it('keeps portable business and Electron state beside the executable without touching LOCALAPPDATA', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), '照片地图 portable paths-'));
    const executableDirectory = path.join(root, '应用 目录');
    const executablePath = path.join(executableDirectory, 'PhotoMap.exe');
    const localAppDataSentinel = path.join(root, 'localappdata-sentinel');
    await mkdir(executableDirectory, { recursive: true });
    await writeFile(path.join(executableDirectory, PORTABLE_MARKER_FILENAME), 'portable\n', 'utf8');
    process.env.LOCALAPPDATA = localAppDataSentinel;
    electronMocks.isPackaged = true;

    try {
      const resolved = configureAppPaths({ executablePath });
      const dataRoot = path.join(executableDirectory, PORTABLE_DATA_DIRECTORY_NAME);

      expect(resolved.dataRoot).toBe(dataRoot);
      expect(resolved.mapDataDirectory).toBe(path.join(dataRoot, 'data', 'map-data', 'v1'));
      expect(electronMocks.setPath.mock.calls).toEqual([
        ['userData', dataRoot],
        ['sessionData', path.join(dataRoot, 'chromium')],
        ['temp', path.join(dataRoot, 'temp')],
        ['logs', path.join(dataRoot, 'logs')],
        ['crashDumps', path.join(dataRoot, 'crash-dumps')],
      ]);
      for (const directory of [
        dataRoot,
        resolved.sessionDataDirectory,
        resolved.logsDirectory,
        resolved.tempDirectory,
        resolved.crashDumpsDirectory,
      ]) {
        expect((await stat(directory)).isDirectory()).toBe(true);
      }
      expect((await readdir(dataRoot)).some((name) => name.startsWith('.photomap-write-probe-'))).toBe(false);
      await expect(access(path.join(localAppDataSentinel, 'PhotoMap'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('initializes every writable application directory without touching a photo source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-paths-'));
    try {
      const dataRoot = path.join(root, 'PhotoMap');
      const paths = {
        dataRoot,
        dataDirectory: path.join(dataRoot, 'data'),
        mapDataDirectory: path.join(root, 'PhotoMapData', 'data', 'map-data', 'v1'),
        backupsDirectory: path.join(dataRoot, 'data', 'backups'),
        cacheDirectory: path.join(dataRoot, 'cache'),
        logsDirectory: path.join(dataRoot, 'logs'),
        tempDirectory: path.join(dataRoot, 'temp'),
        crashDumpsDirectory: path.join(dataRoot, 'crash-dumps'),
        settingsPath: path.join(dataRoot, 'settings.json'),
        sessionDataDirectory: path.join(dataRoot, 'chromium'),
        databasePath: path.join(dataRoot, 'data', 'index.sqlite3'),
        thumbnailRoot: path.join(dataRoot, 'cache', 'thumbnails', 'v1'),
        assetRoot: path.join(root, 'packaged-assets'),
      };

      await initializeAppDirectories(paths);

      for (const directory of [
        paths.dataDirectory,
        paths.mapDataDirectory,
        paths.backupsDirectory,
        paths.cacheDirectory,
        paths.logsDirectory,
        paths.tempDirectory,
        paths.crashDumpsDirectory,
        paths.sessionDataDirectory,
        paths.thumbnailRoot,
      ]) {
        expect((await stat(directory)).isDirectory()).toBe(true);
      }
      await expect(access(path.join(dataRoot, 'data', 'map-data'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root).startsWith('photo-map-paths-')).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  });
});
