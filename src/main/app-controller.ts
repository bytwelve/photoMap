import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import type {
  AppErrorCode,
  AppInfo,
  AppSettings,
  BulkUpdateResult,
  CancelScanResult,
  ChooseLibraryResult,
  CreateTypeRequest,
  ImportMapDataResult,
  LibrarySnapshot,
  OpenMapDownloadResult,
  RenamePhotoRequest,
  RenamePhotoResult,
  RefreshLibraryResult,
  ResolveScanLocationsRequest,
  ResolveScanLocationsResult,
  SaveExportRequest,
  SaveExportResult,
  ScanProgress,
  TrashPhotosResult,
  UpdateCaptureTimeRequest,
  UpdateLocationsRequest,
  UpdateNoteRequest,
  UpdateTypesRequest,
  WindowAction,
  WindowActionResult
} from '../shared/contracts';
import { PHOTO_MAP_CHANNELS } from '../shared/contracts';
import { PhotoMapError } from '../shared/errors';
import mapDataManifest from '../shared/map-data-manifest.json';
import { validateLibraryRoot } from './infrastructure/filesystem/path-policy';
import type { NodeSqliteCatalogRepository } from './infrastructure/sqlite/catalog-repository';
import type { LibraryScanner } from './services/library-scan/library-scanner';
import type { ScanLocationProposal } from './services/library-scan/models';
import type { RegionCatalog } from './services/regions/region-catalog';
import type { MapDataManagerPort } from './services/map-data/map-data-service';
import type { TrashService } from './services/file-trash/trash-service';
import type { AtomicExportService } from './services/export/atomic-export';
import type { DiagnosticsPort, DiagnosticInput } from './infrastructure/diagnostics/diagnostics';
import type { SettingsStorePort } from './infrastructure/settings/settings-store';
import { FileRenameService, type FileRenamePort } from './services/file-rename/file-rename-service';
import { AppOperationCoordinator } from './operation-coordinator';

export class PhotoMapController {
  private readonly operations = new AppOperationCoordinator(() => this.scheduleMapReadySupplementalScanDrain());
  private currentProgress: ScanProgress | undefined;
  private pendingLocationProposal: ScanLocationProposal | null = null;
  private pendingMapReadySupplementalSourceId: string | null = null;
  private mapReadySupplementalDrainScheduled = false;

  public constructor(
    private readonly window: BrowserWindow,
    private readonly repository: NodeSqliteCatalogRepository,
    private readonly scanner: LibraryScanner,
    private readonly regions: RegionCatalog,
    private readonly trashService: TrashService,
    private readonly exportService: AtomicExportService,
    private readonly settingsStore: SettingsStorePort,
    private readonly diagnostics: DiagnosticsPort,
    private readonly mapData: MapDataManagerPort,
    private readonly fileRenameService: FileRenamePort = new FileRenameService(repository)
  ) {}

  public getLibrary(): LibrarySnapshot {
    return this.repository.getLibrarySnapshot(this.currentProgress);
  }

  public async chooseLibrary(): Promise<ChooseLibraryResult> {
    const finishOperation = this.operations.beginOperation('SCAN_FAILED');
    try {
      const releaseScanStart = this.operations.reserveScanStart();
      try {
        const result = await dialog.showOpenDialog(this.window, {
          title: '选择照片文件夹',
          buttonLabel: '选择此文件夹',
          properties: ['openDirectory']
        });
        if (result.canceled || result.filePaths[0] === undefined) {
          return { cancelled: true, library: this.getLibrary() };
        }

        const rootPath = await validateLibraryRoot(result.filePaths[0]);
        this.operations.assertAcceptingOperations('SCAN_FAILED');
        await this.operations.cancelActiveScan();
        this.operations.assertAcceptingOperations('SCAN_FAILED');
        this.pendingLocationProposal = null;
        const source = this.repository.activateSource(rootPath);
        void this.runScan(source.sourceId, source.rootPath).catch((error: unknown) => {
          if (!this.operations.isClosing) {
            this.publishFailedScan(source.sourceId, error, true);
          }
        });
        return { cancelled: false, library: this.getLibrary() };
      } finally {
        releaseScanStart();
      }
    } finally {
      finishOperation();
    }
  }

  public async refreshLibrary(): Promise<RefreshLibraryResult> {
    const finishOperation = this.operations.beginOperation('SCAN_FAILED');
    try {
      if (this.operations.isScanning) {
        throw new PhotoMapError('SCAN_FAILED', '照片扫描正在进行，请等待完成后再刷新。', {
          retryability: 'retry'
        });
      }
      const releaseScanStart = this.operations.reserveScanStart();
      try {
        const source = this.repository.getActiveSource();
        if (source === null) {
          throw new PhotoMapError('SOURCE_NOT_FOUND', '请先选择照片文件夹。', {
            retryability: 'choose_other',
            scope: 'global'
          });
        }
        let rootPath: string;
        try {
          rootPath = await validateLibraryRoot(source.rootPath);
        } catch (error) {
          try {
            this.repository.markActiveSourceUnavailable();
          } catch {
            // The root validation failure remains the primary user-visible error.
          }
          this.publishFailedScan(source.sourceId, error, false);
          throw error;
        }
        this.operations.assertAcceptingOperations('SCAN_FAILED');
        let scanStarted = false;
        try {
          this.restoreAvailableSourceAfterValidation(source.sourceId, source.availability);
          scanStarted = true;
          await this.runScan(source.sourceId, rootPath);
          return { library: this.getLibrary() };
        } catch (error) {
          if (!this.operations.isClosing) {
            this.publishFailedScan(source.sourceId, error, scanStarted);
          }
          throw error;
        }
      } finally {
        releaseScanStart();
      }
    } finally {
      finishOperation();
    }
  }

  public async cancelScan(): Promise<CancelScanResult> {
    const finishOperation = this.operations.beginOperation('SCAN_FAILED');
    try {
      const cancelled = this.operations.isScanning;
      await this.operations.cancelActiveScan();
      return { cancelled, library: this.getLibrary() };
    } finally {
      finishOperation();
    }
  }

  public resolveScanLocations(request: ResolveScanLocationsRequest): ResolveScanLocationsResult {
    const proposal = this.pendingLocationProposal;
    const activeSource = this.repository.getActiveSource();
    if (
      proposal === null
      || proposal.runId !== request.runId
      || activeSource === null
      || activeSource.sourceId !== proposal.sourceId
    ) {
      throw new PhotoMapError('INVALID_REQUEST', '这次扫描的照片信息建议已失效，请重新扫描。');
    }

    if (request.decision === 'ignore') {
      this.consumeLocationProposal(proposal);
      return {
        applied: false,
        decision: request.decision,
        succeeded: 0,
        skipped: 0,
        failed: 0,
        locations: { succeeded: 0, skipped: 0, failed: 0 },
        captureTimes: { succeeded: 0, skipped: 0, failed: 0 },
        library: this.getLibrary()
      };
    }

    for (const assignment of proposal.assignments) {
      this.regions.assertLocation(assignment.location);
    }
    const result = this.repository.applySuggestedMetadata(
      proposal.sourceId,
      proposal.assignments,
      proposal.captureTimes,
      request.decision
    );
    this.consumeLocationProposal(proposal);
    return { applied: true, decision: request.decision, ...result };
  }

  public updateLocations(request: UpdateLocationsRequest): BulkUpdateResult {
    if (request.location !== null) {
      this.regions.assertLocation(request.location);
    }
    return this.repository.updateLocations(request.photoIds, request.location, 'user_action');
  }

  public updateTypes(request: UpdateTypesRequest): BulkUpdateResult {
    return this.repository.updateTypes(request);
  }

  public updateNote(request: UpdateNoteRequest): BulkUpdateResult {
    return this.repository.updateNote(request.photoId, request.note);
  }

  public updateCaptureTime(request: UpdateCaptureTimeRequest): BulkUpdateResult {
    return this.repository.updateCaptureTime(request.photoId, request.localDateTime);
  }

  public async renamePhoto(request: RenamePhotoRequest): Promise<RenamePhotoResult> {
    const finishOperation = this.operations.beginOperation('RENAME_FAILED');
    try {
      const releaseFileRename = this.operations.reserveFileRename();
      try {
        const result = await this.fileRenameService.renamePhoto(request);
        return { ...result, library: this.getLibrary() };
      } finally {
        releaseFileRename();
      }
    } finally {
      finishOperation();
    }
  }

  public createType(request: CreateTypeRequest) {
    return this.repository.createPhotoType(request.name);
  }

  public async trashPhotos(photoIds: string[]): Promise<TrashPhotosResult> {
    const finishOperation = this.operations.beginOperation('RECYCLE_FAILED');
    try {
      const releaseFileTrash = this.operations.reserveFileTrash();
      try {
        const items = await this.trashService.moveConfirmed(photoIds);
        const statusCount = (status: (typeof items)[number]['status']): number =>
          items.filter((item) => item.status === status).length;
        const failed = statusCount('failed');
        const accessDenied = statusCount('access_denied');
        const notFound = statusCount('not_found');
        const cancelled = statusCount('cancelled');
        const partial = statusCount('partial');
        const changed = statusCount('changed');
        const indexFailed = statusCount('index_failed');
        this.recordDiagnostic({
          stage: 'trash',
          ...(failed + accessDenied + notFound + cancelled + partial + changed + indexFailed > 0 ? { errorCode: 'RECYCLE_PARTIAL' } : {}),
          counts: {
            moved: statusCount('moved'),
            failed,
            accessDenied,
            notFound,
            cancelled,
            partial,
            changed,
            indexFailed
          }
        });
        return { items, library: this.getLibrary() };
      } catch (error) {
        this.recordDiagnostic({ stage: 'trash', errorCode: this.errorCode(error, 'RECYCLE_FAILED'), counts: { failed: 1 } });
        throw error;
      } finally {
        releaseFileTrash();
      }
    } finally {
      finishOperation();
    }
  }

  public async saveExport(request: SaveExportRequest): Promise<SaveExportResult> {
    const finishOperation = this.operations.beginOperation('EXPORT_WRITE_FAILED');
    try {
      return await this.saveExportToSelectedPath(request);
    } finally {
      finishOperation();
    }
  }

  private async saveExportToSelectedPath(request: SaveExportRequest): Promise<SaveExportResult> {
    const extension = '.png';
    const baseName = path.basename(request.suggestedName, path.extname(request.suggestedName));
    const result = await dialog.showSaveDialog(this.window, {
      title: '保存分享图',
      defaultPath: path.join(app.getPath('pictures'), `${baseName}${extension}`),
      filters: [{ name: 'PNG 图像', extensions: ['png'] }]
    });
    if (result.canceled || result.filePath === undefined) {
      this.recordDiagnostic({ stage: 'export', counts: { cancelled: 1 } });
      return { cancelled: true };
    }
    const selectedExtension = path.extname(result.filePath).toLocaleLowerCase('en-US');
    if (selectedExtension !== '.png') {
      this.recordDiagnostic({ stage: 'export', errorCode: 'INVALID_REQUEST', counts: { failed: 1 } });
      throw new PhotoMapError('INVALID_REQUEST', '保存文件的扩展名与导出格式不一致。');
    }
    try {
      await this.exportService.save(result.filePath, request);
      this.recordDiagnostic({ stage: 'export', counts: { succeeded: 1 } });
      return { cancelled: false, savedPath: result.filePath };
    } catch (error) {
      this.recordDiagnostic({ stage: 'export', errorCode: this.errorCode(error, 'EXPORT_WRITE_FAILED'), counts: { failed: 1 } });
      throw error;
    }
  }

  public async getAppInfo(): Promise<AppInfo> {
    const mapData = await this.mapData.getStatus();
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      mapData
    };
  }

  public async importMapData(): Promise<ImportMapDataResult> {
    const finishOperation = this.operations.beginOperation('MAP_IMPORT_FAILED');
    try {
      const releaseMapImport = this.operations.reserveMapImport();
      const geometryWasReady = this.regions.isAvailable();
      let outcome!: ImportMapDataResult;
      try {
        const result = await dialog.showOpenDialog(this.window, {
          title: '导入省份和城市地图数据',
          buttonLabel: '导入所选文件',
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: '地图数据', extensions: ['geojson', 'json'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        });
        if (result.canceled || result.filePaths.length === 0) {
          outcome = {
            cancelled: true,
            accepted: [],
            rejected: [],
            status: await this.mapData.getStatus()
          };
        } else {
          outcome = {
            cancelled: false,
            ...await this.mapData.importFiles(result.filePaths)
          };
        }
      } catch (error) {
        if (error instanceof PhotoMapError) throw error;
        throw new PhotoMapError('MAP_IMPORT_FAILED', '地图数据导入未完成，请重试。', {
          retryability: 'retry',
          cause: error
        });
      } finally {
        releaseMapImport();
      }
      if (
        !outcome.cancelled
        && !geometryWasReady
        && outcome.status.ready
        && this.regions.isAvailable()
      ) {
        this.queueMapReadySupplementalScan();
      }
      return outcome;
    } finally {
      finishOperation();
    }
  }

  public async openMapDownload(): Promise<OpenMapDownloadResult> {
    try {
      await shell.openExternal(mapDataManifest.sourceUrl);
      return { opened: true };
    } catch (error) {
      throw new PhotoMapError('UNKNOWN_ERROR', '无法打开天地图下载页面，请稍后重试。', {
        retryability: 'retry',
        cause: error
      });
    }
  }

  public getSettings(): AppSettings {
    return this.settingsStore.get();
  }

  public async updateSettings(settings: AppSettings): Promise<AppSettings> {
    const finishOperation = this.operations.beginOperation('SETTINGS_WRITE_FAILED');
    try {
      const updated = await this.settingsStore.update(settings);
      this.recordDiagnostic({ stage: 'settings', counts: { succeeded: 1 } });
      return updated;
    } catch (error) {
      this.recordDiagnostic({ stage: 'settings', errorCode: this.errorCode(error, 'SETTINGS_WRITE_FAILED'), counts: { failed: 1 } });
      throw error;
    } finally {
      finishOperation();
    }
  }

  public windowAction(action: WindowAction): WindowActionResult {
    if (action === 'minimize') {
      this.window.minimize();
    } else if (action === 'toggleMaximize') {
      if (this.window.isMaximized()) {
        this.window.unmaximize();
      } else {
        this.window.maximize();
      }
    } else {
      setImmediate(() => this.window.close());
    }
    return { maximized: action === 'close' ? false : this.window.isMaximized() };
  }

  public resumeActiveLibrary(): void {
    if (this.operations.isClosing) {
      return;
    }
    const source = this.repository.getActiveSource();
    if (source === null || this.operations.isBusy) {
      return;
    }
    const finishOperation = this.operations.beginOperation('SCAN_FAILED');
    const releaseScanStart = this.operations.reserveScanStart();
    void (async () => {
      let rootPath: string;
      try {
        rootPath = await validateLibraryRoot(source.rootPath);
      } catch (error) {
        if (this.operations.isClosing) {
          return;
        }
        try {
          this.repository.markActiveSourceUnavailable();
        } catch {
          // A failed availability write must not suppress the renderer failure event.
        }
        this.publishFailedScan(source.sourceId, error, false);
        return;
      }
      if (this.operations.isClosing) {
        return;
      }
      let scanStarted = false;
      try {
        this.restoreAvailableSourceAfterValidation(source.sourceId, source.availability);
        scanStarted = true;
        await this.runScan(source.sourceId, rootPath);
      } catch (error) {
        if (!this.operations.isClosing) {
          this.publishFailedScan(source.sourceId, error, scanStarted);
        }
      }
    })()
      .finally(() => {
        releaseScanStart();
        finishOperation();
      })
      .catch(() => undefined);
  }

  public shutdown(): Promise<void> {
    this.pendingMapReadySupplementalSourceId = null;
    return this.operations.shutdown();
  }

  private async runScan(sourceId: string, rootPath: string): Promise<void> {
    await this.operations.runScan((signal) => {
      const gpsMetadataPolicy = this.regions.isAvailable()
        ? 'probe-and-resolve'
        : 'probe-without-resolve';
      if (
        gpsMetadataPolicy === 'probe-and-resolve'
        && this.pendingMapReadySupplementalSourceId === sourceId
      ) {
        this.pendingMapReadySupplementalSourceId = null;
      }
      this.pendingLocationProposal = null;
      return this.scanner
        .scan(sourceId, rootPath, signal, {
          gpsMetadataPolicy,
          onProgress: (progress) => {
            this.currentProgress = progress;
            if (progress.status !== 'running' && progress.status !== 'idle') {
              this.recordDiagnostic({
                stage: 'scan',
                ...(progress.status === 'partial'
                  ? { errorCode: 'SCAN_PARTIAL' }
                  : progress.status === 'failed'
                    ? { errorCode: 'SCAN_FAILED' }
                    : {}),
                ...(progress.runId === null ? {} : { runId: progress.runId }),
                counts: {
                  ...progress.counts,
                  errors: progress.counts.errors + (progress.metadata?.metadataErrorCount ?? 0),
                  ...(progress.status === 'cancelled' ? { cancelled: 1 } : {})
                }
              });
            }
            if (!this.window.isDestroyed()) {
              this.window.webContents.send(PHOTO_MAP_CHANNELS.scanProgress, progress);
            }
          },
          onLocationProposal: (proposal) => {
            this.pendingLocationProposal = proposal;
          }
        });
    }, (error) => {
      if (this.operations.isClosing) {
        this.publishFailedScan(sourceId, error, true);
      }
    });
  }

  private consumeLocationProposal(proposal: ScanLocationProposal): void {
    this.pendingLocationProposal = null;
    if (
      this.currentProgress?.runId === proposal.runId
      && this.currentProgress.sourceId === proposal.sourceId
    ) {
      const progressWithoutMetadata = { ...this.currentProgress };
      delete progressWithoutMetadata.metadata;
      this.currentProgress = progressWithoutMetadata;
    }
  }

  private queueMapReadySupplementalScan(): void {
    if (this.operations.isClosing) {
      return;
    }
    const source = this.repository.getActiveSource();
    if (source === null) {
      return;
    }
    this.pendingMapReadySupplementalSourceId ??= source.sourceId;
    this.scheduleMapReadySupplementalScanDrain();
  }

  private scheduleMapReadySupplementalScanDrain(): void {
    if (
      this.pendingMapReadySupplementalSourceId === null
      || this.mapReadySupplementalDrainScheduled
      || this.operations.isClosing
    ) {
      return;
    }
    this.mapReadySupplementalDrainScheduled = true;
    setImmediate(() => {
      this.mapReadySupplementalDrainScheduled = false;
      if (this.operations.isClosing) {
        return;
      }
      const finishOperation = this.operations.beginOperation('SCAN_FAILED');
      void this.runMapReadySupplementalScan()
        .finally(finishOperation)
        .catch(() => undefined);
    });
  }

  private async runMapReadySupplementalScan(): Promise<void> {
    const expectedSourceId = this.pendingMapReadySupplementalSourceId;
    if (
      this.operations.isClosing
      || expectedSourceId === null
    ) {
      this.pendingMapReadySupplementalSourceId = null;
      return;
    }
    const source = this.repository.getActiveSource();
    if (this.operations.isBusy) {
      return;
    }
    if (
      !this.regions.isAvailable()
      || source === null
      || source.sourceId !== expectedSourceId
    ) {
      this.pendingMapReadySupplementalSourceId = null;
      return;
    }
    this.pendingMapReadySupplementalSourceId = null;
    const releaseScanStart = this.operations.reserveScanStart();
    let scanStarted = false;
    try {
      let rootPath: string;
      try {
        rootPath = await validateLibraryRoot(source.rootPath);
      } catch (error) {
        if (!this.operations.isClosing) {
          try {
            this.repository.markActiveSourceUnavailable();
          } catch {
            // The root validation failure remains the primary user-visible error.
          }
          this.publishFailedScan(source.sourceId, error, false);
        }
        return;
      }
      if (this.operations.isClosing) {
        return;
      }
      const currentSource = this.repository.getActiveSource();
      if (
        !this.regions.isAvailable()
        || currentSource === null
        || currentSource.sourceId !== expectedSourceId
      ) {
        return;
      }
      this.restoreAvailableSourceAfterValidation(
        currentSource.sourceId,
        currentSource.availability
      );
      scanStarted = true;
      await this.runScan(source.sourceId, rootPath);
    } catch (error) {
      if (!this.operations.isClosing) {
        this.publishFailedScan(source.sourceId, error, scanStarted);
      }
    } finally {
      releaseScanStart();
    }
  }

  private restoreAvailableSourceAfterValidation(
    sourceId: string,
    availability: 'available' | 'unavailable' | 'unknown'
  ): void {
    if (availability === 'available') {
      return;
    }
    const activeSource = this.repository.getActiveSource();
    if (activeSource?.sourceId === sourceId) {
      this.repository.markActiveSourceAvailable();
    }
  }

  private publishFailedScan(sourceId: string, error: unknown, persistRun: boolean): void {
    if (this.pendingLocationProposal?.sourceId === sourceId) {
      this.pendingLocationProposal = null;
    }
    const progress: ScanProgress = {
      runId: persistRun && this.currentProgress?.sourceId === sourceId ? this.currentProgress.runId : null,
      sourceId,
      status: 'failed',
      counts:
        this.currentProgress?.sourceId === sourceId
          ? { ...this.currentProgress.counts, errors: Math.max(1, this.currentProgress.counts.errors) }
          : { discovered: 0, indexed: 0, unchanged: 0, errors: 1 }
    };
    this.currentProgress = progress;
    if (progress.runId !== null) {
      try {
        this.repository.finishScanRun(progress.runId, progress);
      } catch {
        // Preserve and expose the original scan failure even if its terminal-state write also fails.
      }
    }
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(PHOTO_MAP_CHANNELS.scanProgress, progress);
    }
    this.recordDiagnostic({
      stage: 'scan',
      errorCode: this.errorCode(error, 'SCAN_FAILED'),
      ...(progress.runId === null ? {} : { runId: progress.runId }),
      counts: progress.counts
    });
  }

  private errorCode(error: unknown, fallback: AppErrorCode): AppErrorCode {
    return error instanceof PhotoMapError ? error.code : fallback;
  }

  private recordDiagnostic(input: DiagnosticInput): void {
    void this.diagnostics.record(input).catch(() => undefined);
  }
}
