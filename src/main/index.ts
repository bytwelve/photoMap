import { app, dialog } from 'electron';
import started from 'electron-squirrel-startup';
import { PhotoMapController } from './app-controller';
import { configureAppPaths, initializeAppDirectories } from './bootstrap/app-paths';
import { createMainWindow } from './bootstrap/create-window';
import { flushRendererSettings } from './bootstrap/flush-renderer-settings';
import { registerPhotoMapHandlers, removePhotoMapHandlers } from './ipc/register-handlers';
import { registerControlledProtocols } from './infrastructure/media-protocol/register-protocols';
import {
  CATALOG_SCHEMA_VERSION,
  NodeSqliteCatalogRepository
} from './infrastructure/sqlite/catalog-repository';
import { JsonlDiagnostics } from './infrastructure/diagnostics/diagnostics';
import { AtomicSettingsStore } from './infrastructure/settings/settings-store';
import { AtomicExportService } from './services/export/atomic-export';
import { ElectronExportEncoder } from './services/export/electron-export-encoder';
import { ElectronRecycleBin } from './services/file-trash/electron-recycle-bin';
import { TrashService } from './services/file-trash/trash-service';
import { ElectronMediaProbe } from './services/library-scan/electron-media-probe';
import { ExifGpsProbe } from './services/library-scan/exif-gps-reader';
import { LibraryScanner } from './services/library-scan/library-scanner';
import { MapDataService } from './services/map-data/map-data-service';
import { RegionCatalog } from './services/regions/region-catalog';
import { ThumbnailCache } from './services/thumbnails/thumbnail-cache';
import { PhotoMapError } from '../shared/errors';

if (started) {
  app.quit();
}

app.setName('PhotoMap');
const paths = configureAppPaths();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let repository: NodeSqliteCatalogRepository | null = null;
let controller: PhotoMapController | null = null;
let diagnostics: JsonlDiagnostics | null = null;
let mainWindow: Electron.BrowserWindow | null = null;
let shuttingDown = false;
let allowImmediateExit = false;

async function startApplication(): Promise<void> {
  await initializeAppDirectories(paths);
  diagnostics = new JsonlDiagnostics(paths.logsDirectory, app.getVersion(), CATALOG_SCHEMA_VERSION);
  const settingsStore = new AtomicSettingsStore(paths.settingsPath);
  const settingsLoad = await settingsStore.initialize();
  if (settingsLoad.recoveredFromInvalid) {
    await diagnostics
      .record({ stage: 'settings', errorCode: 'SETTINGS_READ_FAILED', counts: { failed: 1 } })
      .catch(() => undefined);
  }
  repository = await NodeSqliteCatalogRepository.open(paths.databasePath, {
    backupsDirectory: paths.backupsDirectory,
  });
  const regions = new RegionCatalog();
  const mapData = new MapDataService(paths.mapDataDirectory, regions);
  await mapData.initialize();
  const scanner = new LibraryScanner(repository, new ElectronMediaProbe(), new ExifGpsProbe(), regions);
  const trashService = new TrashService(repository, new ElectronRecycleBin());
  const exportService = new AtomicExportService(new ElectronExportEncoder());
  const thumbnailCache = new ThumbnailCache(paths.thumbnailRoot);
  const window = createMainWindow(MAIN_WINDOW_WEBPACK_ENTRY, MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY);
  mainWindow = window;
  window.on('close', (event) => {
    if (allowImmediateExit) return;
    event.preventDefault();
    app.quit();
  });
  controller = new PhotoMapController(
    window,
    repository,
    scanner,
    regions,
    trashService,
    exportService,
    settingsStore,
    diagnostics,
    mapData
  );

  registerControlledProtocols(
    repository,
    paths.assetRoot,
    paths.mapDataDirectory,
    thumbnailCache,
    () => regions.isAvailable()
  );
  registerPhotoMapHandlers(controller, window);
  window.on('closed', removePhotoMapHandlers);
  app.on('second-instance', () => {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  });

  await window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  await diagnostics.record({ stage: 'startup', counts: { succeeded: 1 } }).catch(() => undefined);
  controller.resumeActiveLibrary();
}

app.whenReady().then(startApplication).catch(async (error: unknown) => {
  await diagnostics
    ?.record({
      stage: 'startup',
      errorCode: error instanceof PhotoMapError ? error.code : 'UNKNOWN_ERROR',
      counts: { failed: 1 }
    })
    .catch(() => undefined);
  await diagnostics?.flush().catch(() => undefined);
  const detail = error instanceof Error ? error.message : '未知错误';
  dialog.showErrorBox('用照片拼地图无法启动', detail);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (allowImmediateExit) {
    return;
  }
  event.preventDefault();
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  void (async () => {
    let shutdownFailed = false;
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.setEnabled(false);
      await flushRendererSettings(mainWindow).catch(() => { shutdownFailed = true; });
    }
    await controller?.shutdown().catch(() => {
      shutdownFailed = true;
    });
    controller = null;
    try {
      repository?.close();
    } catch {
      shutdownFailed = true;
    }
    repository = null;
    await diagnostics
      ?.record({
        stage: 'shutdown',
        ...(shutdownFailed ? { errorCode: 'UNKNOWN_ERROR' as const } : {}),
        counts: shutdownFailed ? { failed: 1 } : { succeeded: 1 }
      })
      .catch(() => undefined);
    await diagnostics?.flush().catch(() => undefined);
    diagnostics = null;
    allowImmediateExit = true;
    app.exit(0);
  })();
});
