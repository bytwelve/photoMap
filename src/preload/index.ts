import { contextBridge, ipcRenderer } from 'electron';
import type {
  ApiResult,
  AppInfo,
  AppSettings,
  BulkUpdateResult,
  CancelScanResult,
  ChooseLibraryResult,
  CreateTypeRequest,
  ImportMapDataResult,
  LibrarySnapshot,
  OpenMapDownloadResult,
  PhotoMapApi,
  PhotoType,
  RenamePhotoRequest,
  RenamePhotoResult,
  RefreshLibraryResult,
  ResolveScanLocationsRequest,
  ResolveScanLocationsResult,
  SaveExportRequest,
  SaveExportResult,
  ScanProgress,
  TrashPhotosRequest,
  TrashPhotosResult,
  UpdateCaptureTimeRequest,
  UpdateLocationsRequest,
  UpdateNoteRequest,
  UpdateTypesRequest,
  WindowAction,
  WindowActionResult
} from '../shared/contracts';
import { PHOTO_MAP_CHANNELS } from '../shared/contracts';

const invoke = <T>(channel: string, value?: unknown): Promise<ApiResult<T>> =>
  value === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, value);

let settingsFlushListener: (() => Promise<void>) | undefined;
ipcRenderer.on(PHOTO_MAP_CHANNELS.flushSettings, (_event, requestId: unknown) => {
  if (typeof requestId !== 'string') return;
  void Promise.resolve()
    .then(() => settingsFlushListener?.())
    .then(
      () => ipcRenderer.send(PHOTO_MAP_CHANNELS.settingsFlushed, requestId, true),
      () => ipcRenderer.send(PHOTO_MAP_CHANNELS.settingsFlushed, requestId, false),
    );
});

const photoMap: PhotoMapApi = Object.freeze({
  getLibrary: () => invoke<LibrarySnapshot>(PHOTO_MAP_CHANNELS.getLibrary),
  chooseLibrary: () => invoke<ChooseLibraryResult>(PHOTO_MAP_CHANNELS.chooseLibrary),
  refreshLibrary: () => invoke<RefreshLibraryResult>(PHOTO_MAP_CHANNELS.refreshLibrary),
  cancelScan: () => invoke<CancelScanResult>(PHOTO_MAP_CHANNELS.cancelScan),
  resolveScanLocations: (request: ResolveScanLocationsRequest) =>
    invoke<ResolveScanLocationsResult>(PHOTO_MAP_CHANNELS.resolveScanLocations, request),
  updateLocations: (request: UpdateLocationsRequest) =>
    invoke<BulkUpdateResult>(PHOTO_MAP_CHANNELS.updateLocations, request),
  updateTypes: (request: UpdateTypesRequest) =>
    invoke<BulkUpdateResult>(PHOTO_MAP_CHANNELS.updateTypes, request),
  updateNote: (request: UpdateNoteRequest) =>
    invoke<BulkUpdateResult>(PHOTO_MAP_CHANNELS.updateNote, request),
  updateCaptureTime: (request: UpdateCaptureTimeRequest) =>
    invoke<BulkUpdateResult>(PHOTO_MAP_CHANNELS.updateCaptureTime, request),
  renamePhoto: (request: RenamePhotoRequest) =>
    invoke<RenamePhotoResult>(PHOTO_MAP_CHANNELS.renamePhoto, request),
  createType: (request: CreateTypeRequest) => invoke<PhotoType>(PHOTO_MAP_CHANNELS.createType, request),
  trashPhotos: (request: TrashPhotosRequest) =>
    invoke<TrashPhotosResult>(PHOTO_MAP_CHANNELS.trashPhotos, request),
  saveExport: (request: SaveExportRequest) => invoke<SaveExportResult>(PHOTO_MAP_CHANNELS.saveExport, request),
  getAppInfo: () => invoke<AppInfo>(PHOTO_MAP_CHANNELS.getAppInfo),
  importMapData: () => invoke<ImportMapDataResult>(PHOTO_MAP_CHANNELS.importMapData),
  openMapDownload: () => invoke<OpenMapDownloadResult>(PHOTO_MAP_CHANNELS.openMapDownload),
  getSettings: () => invoke<AppSettings>(PHOTO_MAP_CHANNELS.getSettings),
  updateSettings: (settings: AppSettings) => invoke<AppSettings>(PHOTO_MAP_CHANNELS.updateSettings, settings),
  windowAction: (action: WindowAction) => invoke<WindowActionResult>(PHOTO_MAP_CHANNELS.windowAction, action),
  subscribeSettingsFlush: (listener: () => Promise<void>) => {
    settingsFlushListener = listener;
    return () => {
      if (settingsFlushListener === listener) settingsFlushListener = undefined;
    };
  },
  subscribeScanProgress: (listener: (progress: ScanProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ScanProgress): void => listener(progress);
    ipcRenderer.on(PHOTO_MAP_CHANNELS.scanProgress, handler);
    return () => ipcRenderer.removeListener(PHOTO_MAP_CHANNELS.scanProgress, handler);
  }
});

contextBridge.exposeInMainWorld('photoMap', photoMap);
