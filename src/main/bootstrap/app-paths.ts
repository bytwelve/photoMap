import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

export const PORTABLE_MARKER_FILENAME = 'photomap.portable';
export const PORTABLE_DATA_DIRECTORY_NAME = 'PhotoMapData';

export type PortableMarkerKind = 'missing' | 'file' | 'other';
export type PortableMarkerProbe = (markerPath: string) => PortableMarkerKind;

export interface PhotoMapPaths {
  dataRoot: string;
  dataDirectory: string;
  mapDataDirectory: string;
  backupsDirectory: string;
  cacheDirectory: string;
  logsDirectory: string;
  tempDirectory: string;
  crashDumpsDirectory: string;
  settingsPath: string;
  sessionDataDirectory: string;
  databasePath: string;
  thumbnailRoot: string;
  assetRoot: string;
}

export interface ConfigureAppPathsOptions {
  executablePath?: string;
  portableMarkerProbe?: PortableMarkerProbe;
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function inspectPortableMarker(markerPath: string): PortableMarkerKind {
  try {
    return lstatSync(markerPath).isFile() ? 'file' : 'other';
  } catch (error) {
    if (isMissingPathError(error)) {
      return 'missing';
    }
    throw new Error(`无法读取便携版标记：${markerPath}`, { cause: error });
  }
}

export function resolvePortableDataRoot(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  executablePath: string,
  markerProbe: PortableMarkerProbe = inspectPortableMarker
): string | undefined {
  if (platform !== 'win32' || !isPackaged) {
    return undefined;
  }
  const executableDirectory = path.dirname(path.resolve(executablePath));
  const markerPath = path.join(executableDirectory, PORTABLE_MARKER_FILENAME);
  const markerKind = markerProbe(markerPath);
  if (markerKind === 'missing') {
    return undefined;
  }
  if (markerKind !== 'file') {
    throw new Error(`便携版标记无效：${markerPath} 必须是普通文件。`);
  }
  return path.join(executableDirectory, PORTABLE_DATA_DIRECTORY_NAME);
}

export function resolvePhotoMapDataRoot(
  platform: NodeJS.Platform,
  localAppData: string | undefined,
  nonWindowsAppData: string,
  portableDataRoot?: string
): string {
  if (portableDataRoot !== undefined) {
    return portableDataRoot;
  }
  const normalizedLocalAppData = localAppData?.trim();
  if (platform === 'win32') {
    if (normalizedLocalAppData === undefined || normalizedLocalAppData.length === 0) {
      throw new Error('LOCALAPPDATA is unavailable; refusing to place PhotoMap data in roaming storage.');
    }
    return path.join(normalizedLocalAppData, 'PhotoMap');
  }
  return path.join(nonWindowsAppData, 'PhotoMap');
}

function preparePortableElectronDirectories(dataRoot: string, directories: string[]): void {
  let probePath: string | undefined;
  let committedProbePath: string | undefined;
  let descriptor: number | undefined;
  try {
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true });
    }
    probePath = path.join(dataRoot, `.photomap-write-probe-${process.pid}-${randomUUID()}.tmp`);
    committedProbePath = `${probePath}.committed`;
    descriptor = openSync(probePath, 'wx');
    writeFileSync(descriptor, 'PhotoMap portable storage write probe\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(probePath, committedProbePath);
    probePath = undefined;
    rmSync(committedProbePath, { force: true });
    committedProbePath = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original storage failure below.
      }
    }
    for (const candidate of [probePath, committedProbePath]) {
      if (candidate !== undefined) {
        try {
          rmSync(candidate, { force: true });
        } catch {
          // Preserve the original storage failure below.
        }
      }
    }
    throw new Error(
      `便携版数据目录不可写：${dataRoot}。请将完整应用文件夹移到可写位置后重试。`,
      { cause: error }
    );
  }
}

export function configureAppPaths(options: ConfigureAppPathsOptions = {}): PhotoMapPaths {
  const portableDataRoot = resolvePortableDataRoot(
    process.platform,
    app.isPackaged,
    options.executablePath ?? process.execPath,
    options.portableMarkerProbe ?? inspectPortableMarker
  );
  const dataRoot = resolvePhotoMapDataRoot(
    process.platform,
    process.env.LOCALAPPDATA,
    app.getPath('appData'),
    portableDataRoot
  );
  const dataDirectory = path.join(dataRoot, 'data');
  const mapDataRoot = portableDataRoot ?? (
    process.platform === 'win32'
      ? path.join(path.dirname(dataRoot), PORTABLE_DATA_DIRECTORY_NAME)
      : dataRoot
  );
  const cacheDirectory = path.join(dataRoot, 'cache');
  const sessionDataDirectory = path.join(dataRoot, 'chromium');
  const logsDirectory = path.join(dataRoot, 'logs');
  const tempDirectory = path.join(dataRoot, 'temp');
  const crashDumpsDirectory = path.join(dataRoot, 'crash-dumps');
  if (portableDataRoot !== undefined) {
    preparePortableElectronDirectories(dataRoot, [
      dataRoot,
      sessionDataDirectory,
      logsDirectory,
      tempDirectory,
      crashDumpsDirectory
    ]);
  }
  app.setPath('userData', dataRoot);
  app.setPath('sessionData', sessionDataDirectory);
  if (portableDataRoot !== undefined) {
    app.setPath('temp', tempDirectory);
    app.setPath('logs', logsDirectory);
    app.setPath('crashDumps', crashDumpsDirectory);
  }
  return {
    dataRoot,
    dataDirectory,
    mapDataDirectory: path.join(mapDataRoot, 'data', 'map-data', 'v1'),
    backupsDirectory: path.join(dataDirectory, 'backups'),
    cacheDirectory,
    logsDirectory,
    tempDirectory,
    crashDumpsDirectory,
    settingsPath: path.join(dataRoot, 'settings.json'),
    sessionDataDirectory,
    databasePath: path.join(dataDirectory, 'index.sqlite3'),
    thumbnailRoot: path.join(cacheDirectory, 'thumbnails', 'v1'),
    assetRoot: app.isPackaged
      ? process.resourcesPath
      : path.resolve(app.getAppPath(), 'resources')
  };
}

export async function initializeAppDirectories(paths: PhotoMapPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.dataDirectory, { recursive: true }),
    mkdir(paths.mapDataDirectory, { recursive: true }),
    mkdir(paths.backupsDirectory, { recursive: true }),
    mkdir(paths.cacheDirectory, { recursive: true }),
    mkdir(paths.logsDirectory, { recursive: true }),
    mkdir(paths.tempDirectory, { recursive: true }),
    mkdir(paths.crashDumpsDirectory, { recursive: true }),
    mkdir(paths.sessionDataDirectory, { recursive: true }),
    mkdir(paths.thumbnailRoot, { recursive: true })
  ]);
}
