export const PHOTO_MAP_CHANNELS = {
  getLibrary: 'photo-map:get-library',
  chooseLibrary: 'photo-map:choose-library',
  refreshLibrary: 'photo-map:refresh-library',
  cancelScan: 'photo-map:cancel-scan',
  resolveScanLocations: 'photo-map:resolve-scan-locations',
  updateLocations: 'photo-map:update-locations',
  updateTypes: 'photo-map:update-types',
  updateNote: 'photo-map:update-note',
  updateCaptureTime: 'photo-map:update-capture-time',
  renamePhoto: 'photo-map:rename-photo',
  createType: 'photo-map:create-type',
  trashPhotos: 'photo-map:trash-photos',
  saveExport: 'photo-map:save-export',
  getAppInfo: 'photo-map:get-app-info',
  importMapData: 'photo-map:import-map-data',
  openMapDownload: 'photo-map:open-map-download',
  getSettings: 'photo-map:get-settings',
  updateSettings: 'photo-map:update-settings',
  windowAction: 'photo-map:window-action',
  scanProgress: 'photo-map:scan-progress',
  flushSettings: 'photo-map:flush-settings',
  settingsFlushed: 'photo-map:settings-flushed'
} as const;

export const PHOTO_MAP_ASSETS = {
  provinceMap: 'photomap-asset://data/china-provinces.geojson',
  cityMap: 'photomap-asset://data/china-city-view.geojson'
} as const;

export type DecodeState = 'unknown' | 'valid' | 'corrupt' | 'unreadable' | 'unsupported';
export type PhotoLifecycle = 'active' | 'missing' | 'trash_pending' | 'trashed' | 'replaced';
export const MEDIA_KINDS = ['photo', 'video', 'live'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type ImageFormat = 'png' | 'jpg' | 'heic' | 'avif';
export type VideoFormat = 'mp4' | 'mov' | 'm4v';
export type MediaFormat = ImageFormat | VideoFormat;
export type ScanStatus = 'idle' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export const MAX_PHOTO_NOTE_LENGTH = 60;
export const MAX_MEDIA_FILE_NAME_LENGTH = 255;

export type CaptureTimeSource = 'metadata' | 'user';

export interface CaptureTimeValue {
  localDateTime: string;
  offsetMinutes: number | null;
}

export interface CaptureTime extends CaptureTimeValue {
  source: CaptureTimeSource;
}

export function isImageFormat(format: MediaFormat): format is ImageFormat {
  return format === 'png' || format === 'jpg' || format === 'heic' || format === 'avif';
}

export type AppErrorCode =
  | 'INVALID_REQUEST'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_ACCESS_DENIED'
  | 'SCAN_PARTIAL'
  | 'SCAN_FAILED'
  | 'MEDIA_DECODE_FAILED'
  | 'MEDIA_NOT_FOUND'
  | 'INDEX_OPEN_FAILED'
  | 'INDEX_WRITE_FAILED'
  | 'MAP_CONTRACT_INVALID'
  | 'MAP_IMPORT_FAILED'
  | 'SETTINGS_READ_FAILED'
  | 'SETTINGS_WRITE_FAILED'
  | 'EXPORT_WRITE_FAILED'
  | 'RENAME_FAILED'
  | 'RECYCLE_PARTIAL'
  | 'RECYCLE_FAILED'
  | 'UNAUTHORIZED_IPC'
  | 'UNKNOWN_ERROR';

export interface AppError {
  code: AppErrorCode;
  userMessage: string;
  retryability: 'retry' | 'choose_other' | 'non_retryable';
  scope: 'global' | 'task' | 'item';
  affectedIds?: string[];
}

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };

export interface LocationAssignment {
  provinceGb: string;
  cityGb?: string;
}

export interface PhotoType {
  typeId: string;
  name: string;
  isBuiltin: boolean;
}

export interface PhotoSummary {
  photoId: string;
  fileName: string;
  folderPath: string | null;
  mediaUrl: `photomap-media://photo/${string}`;
  thumbnailUrl: `photomap-media://photo/${string}?size=thumb`;
  fileCreatedAtMs: number | null;
  captureTime: CaptureTime | null;
  mediaKind: MediaKind;
  mediaFormat: MediaFormat;
  pixelWidth: number | null;
  pixelHeight: number | null;
  decodeState: DecodeState;
  lifecycleState: PhotoLifecycle;
  location: LocationAssignment | null;
  typeIds: string[];
  note: string;
}

export interface LibrarySourceSummary {
  sourceId: string;
  displayName: string;
  availability: 'available' | 'unavailable' | 'unknown';
}

export interface ScanCounts {
  discovered: number;
  indexed: number;
  unchanged: number;
  errors: number;
}

export interface ScanProgress {
  runId: string | null;
  sourceId: string | null;
  status: ScanStatus;
  counts: ScanCounts;
  metadata?: ScanMetadataSummary;
  catalogCommitCount?: number;
  currentFileName?: string;
}

export interface ScanMetadataSummary {
  examined: number;
  exifCount: number;
  gpsCount: number;
  resolvedLocationCount: number;
  captureTimeCount: number;
  metadataErrorCount: number;
}

export interface LibrarySnapshot {
  source: LibrarySourceSummary | null;
  photos: PhotoSummary[];
  photoTypes: PhotoType[];
  scan: ScanProgress;
  catalogRevision: number;
}

export interface ChooseLibraryResult {
  cancelled: boolean;
  library: LibrarySnapshot;
}

export interface RefreshLibraryResult {
  library: LibrarySnapshot;
}

export interface CancelScanResult {
  cancelled: boolean;
  library: LibrarySnapshot;
}

export interface UpdateLocationsRequest {
  photoIds: string[];
  location: LocationAssignment | null;
}

export interface UpdateTypesRequest {
  photoIds: string[];
  addTypeIds: string[];
  removeTypeIds: string[];
}

export interface UpdateNoteRequest {
  photoId: string;
  note: string;
}

export interface UpdateCaptureTimeRequest {
  photoId: string;
  localDateTime: string;
}

export interface RenamePhotoRequest {
  photoId: string;
  newFileName: string;
}

export interface CreateTypeRequest {
  name: string;
}

export interface BulkUpdateResult {
  succeeded: number;
  skipped: number;
  failed: number;
  library: LibrarySnapshot;
}

export interface RenamePhotoResult {
  renamed: boolean;
  fileName: string;
  library: LibrarySnapshot;
}

export type ScanLocationDecision =
  | 'ignore'
  | 'overwrite-all-resolved'
  | 'fill-unlabeled-only';

export interface ResolveScanLocationsRequest {
  runId: string;
  decision: ScanLocationDecision;
}

export interface ResolveScanLocationsResult extends BulkUpdateResult {
  applied: boolean;
  decision: ScanLocationDecision;
  locations: Omit<BulkUpdateResult, 'library'>;
  captureTimes: Omit<BulkUpdateResult, 'library'>;
}

export interface TrashPhotosRequest {
  photoIds: string[];
  confirmed: boolean;
}

export type TrashFailureReason = 'not_found' | 'access_denied' | 'changed' | 'index_failed' | 'failed';
export type TrashItemStatus = 'moved' | 'partial' | 'cancelled' | TrashFailureReason;

export interface TrashItemResult {
  photoId: string;
  status: TrashItemStatus;
  /** Files confirmed moved by the recycle-bin API during this attempt. */
  movedFileNames?: string[];
  /** Why an item was only partially processed. */
  failureReason?: TrashFailureReason;
}

export interface TrashPhotosResult {
  items: TrashItemResult[];
  library: LibrarySnapshot;
}

export interface SaveExportRequest {
  dataUrl: string;
  format: 'png';
  suggestedName: string;
}

export interface SaveExportResult {
  cancelled: boolean;
  savedPath?: string;
}

export type MapDataKind = 'province' | 'city';

export interface MapDataItemStatus {
  kind: MapDataKind;
  label: string;
  imported: boolean;
}

export interface MapDataStatus {
  items: MapDataItemStatus[];
  completed: number;
  total: number;
  ready: boolean;
  error?: string;
}

export interface MapDataImportRejection {
  fileName: string;
  reason: 'unrecognized' | 'source_unreadable';
}

export interface ImportMapDataResult {
  cancelled: boolean;
  accepted: MapDataKind[];
  rejected: MapDataImportRejection[];
  status: MapDataStatus;
}

export interface OpenMapDownloadResult {
  opened: true;
}

export interface AppInfo {
  name: string;
  version: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  mapData: MapDataStatus;
}

export const MIN_MAP_DENSITY = 1;
export const BEST_MAP_DENSITY = 5;
export const MAX_MAP_DENSITY = 9;

export type MapDensity = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface AppSettings {
  schemaVersion: 2;
  mode: 'wall' | 'memory' | 'batch';
  filters: {
    locationCodes: string[];
    includeUnlocated: boolean;
    mediaKinds: MediaKind[];
    folderPaths: string[];
    typeIds: string[];
    search: string;
  };
  map: {
    level: 'province' | 'city';
    showPhotos: boolean;
    showPlaceNames: boolean;
    density: MapDensity;
    camera: {
      zoom: number;
      panX: number;
      panY: number;
    };
  };
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  schemaVersion: 2,
  mode: 'wall',
  filters: {
    locationCodes: [],
    includeUnlocated: false,
    mediaKinds: [...MEDIA_KINDS],
    folderPaths: [],
    typeIds: [],
    search: ''
  },
  map: {
    level: 'province',
    showPhotos: true,
    showPlaceNames: true,
    density: BEST_MAP_DENSITY,
    camera: { zoom: 1.18, panX: 0, panY: 0 }
  }
};

export type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

export interface WindowActionResult {
  maximized: boolean;
}

export interface PhotoMapApi {
  getLibrary(): Promise<ApiResult<LibrarySnapshot>>;
  chooseLibrary(): Promise<ApiResult<ChooseLibraryResult>>;
  refreshLibrary(): Promise<ApiResult<RefreshLibraryResult>>;
  cancelScan(): Promise<ApiResult<CancelScanResult>>;
  resolveScanLocations(request: ResolveScanLocationsRequest): Promise<ApiResult<ResolveScanLocationsResult>>;
  updateLocations(request: UpdateLocationsRequest): Promise<ApiResult<BulkUpdateResult>>;
  updateTypes(request: UpdateTypesRequest): Promise<ApiResult<BulkUpdateResult>>;
  updateNote(request: UpdateNoteRequest): Promise<ApiResult<BulkUpdateResult>>;
  updateCaptureTime(request: UpdateCaptureTimeRequest): Promise<ApiResult<BulkUpdateResult>>;
  renamePhoto(request: RenamePhotoRequest): Promise<ApiResult<RenamePhotoResult>>;
  createType(request: CreateTypeRequest): Promise<ApiResult<PhotoType>>;
  trashPhotos(request: TrashPhotosRequest): Promise<ApiResult<TrashPhotosResult>>;
  saveExport(request: SaveExportRequest): Promise<ApiResult<SaveExportResult>>;
  getAppInfo(): Promise<ApiResult<AppInfo>>;
  importMapData(): Promise<ApiResult<ImportMapDataResult>>;
  openMapDownload(): Promise<ApiResult<OpenMapDownloadResult>>;
  getSettings(): Promise<ApiResult<AppSettings>>;
  updateSettings(settings: AppSettings): Promise<ApiResult<AppSettings>>;
  windowAction(action: WindowAction): Promise<ApiResult<WindowActionResult>>;
  subscribeScanProgress(listener: (progress: ScanProgress) => void): () => void;
  subscribeSettingsFlush(listener: () => Promise<void>): () => void;
}

declare global {
  interface Window {
    photoMap: PhotoMapApi;
  }
}
