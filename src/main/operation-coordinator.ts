import { PhotoMapError } from '../shared/errors';

type OperationErrorCode = 'SCAN_FAILED' | 'MAP_IMPORT_FAILED' | 'RENAME_FAILED' | 'RECYCLE_FAILED'
  | 'SETTINGS_WRITE_FAILED' | 'EXPORT_WRITE_FAILED';
type Reservation = 'scanStart' | 'mapImport' | 'fileRename' | 'fileTrash';

/** Owns operation exclusion and shutdown; UI and scan result handling stay with the controller. */
export class AppOperationCoordinator {
  private activeScan: Promise<void> | null = null;
  private scanAbortController: AbortController | null = null;
  private readonly reservations = new Set<Reservation>();
  private readonly inFlightOperations = new Set<Promise<void>>();
  private shuttingDown = false;
  private shutdownTask: Promise<void> | null = null;

  public constructor(private readonly onAvailable: () => void) {}

  public get isScanning(): boolean {
    return this.activeScan !== null;
  }

  public get isClosing(): boolean {
    return this.shuttingDown;
  }

  public get isBusy(): boolean {
    return this.isScanning || this.reservations.size > 0;
  }

  public beginOperation(errorCode: OperationErrorCode): () => void {
    this.assertAcceptingOperations(errorCode);
    let resolveOperation!: () => void;
    const operation = new Promise<void>((resolve) => { resolveOperation = resolve; });
    this.inFlightOperations.add(operation);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.inFlightOperations.delete(operation);
      resolveOperation();
    };
  }

  public assertAcceptingOperations(errorCode: OperationErrorCode): void {
    if (this.shuttingDown) {
      throw new PhotoMapError(errorCode, '应用正在关闭，无法开始新任务。', {
        retryability: 'non_retryable'
      });
    }
  }

  public reserveScanStart(): () => void {
    this.assertScanAllowed();
    if (this.reservations.has('scanStart')) {
      this.reject('SCAN_FAILED', '另一项照片扫描正在准备，请稍后重试。');
    }
    return this.reserve('scanStart');
  }

  public reserveMapImport(): () => void {
    this.assertAcceptingOperations('MAP_IMPORT_FAILED');
    if (this.reservations.has('mapImport')) {
      this.reject('MAP_IMPORT_FAILED', '地图数据正在导入，请等待当前操作完成。');
    }
    if (this.reservations.has('fileRename')) {
      this.reject('MAP_IMPORT_FAILED', '文件重命名进行中，请等待当前操作结束后再导入地图数据。');
    }
    if (this.reservations.has('scanStart') || this.isScanning) {
      this.reject('MAP_IMPORT_FAILED', '照片扫描进行中，请等待扫描结束后再导入地图数据。');
    }
    return this.reserve('mapImport');
  }

  public reserveFileRename(): () => void {
    this.assertAcceptingOperations('RENAME_FAILED');
    if (this.reservations.has('fileRename')) {
      this.reject('RENAME_FAILED', '另一项文件重命名正在进行，请稍后重试。');
    }
    if (this.reservations.has('fileTrash')) {
      this.reject('RENAME_FAILED', '文件正在移入回收站，请等待当前操作结束后再重命名。');
    }
    if (this.reservations.has('scanStart') || this.isScanning) {
      this.reject('RENAME_FAILED', '照片扫描进行中，请等待扫描结束后再重命名。');
    }
    if (this.reservations.has('mapImport')) {
      this.reject('RENAME_FAILED', '地图数据导入中，请稍后再重命名文件。');
    }
    return this.reserve('fileRename');
  }

  public reserveFileTrash(): () => void {
    this.assertAcceptingOperations('RECYCLE_FAILED');
    if (this.reservations.has('fileTrash')) {
      this.reject('RECYCLE_FAILED', '另一项移入回收站操作正在进行，请稍后重试。');
    }
    if (this.reservations.has('fileRename')) {
      this.reject('RECYCLE_FAILED', '文件重命名正在进行，请等待当前操作结束后再移入回收站。');
    }
    if (this.reservations.has('scanStart') || this.isScanning) {
      this.reject('RECYCLE_FAILED', '照片扫描进行中，请等待扫描结束后再移入回收站。');
    }
    return this.reserve('fileTrash');
  }

  public async runScan(
    start: (signal: AbortSignal) => Promise<unknown>,
    onFailure: (error: unknown) => void
  ): Promise<void> {
    this.assertScanAllowed();
    if (this.activeScan !== null) {
      await this.activeScan;
      return;
    }
    const abortController = new AbortController();
    this.scanAbortController = abortController;
    const task = start(abortController.signal)
      .then(() => undefined)
      .finally(() => {
        if (this.activeScan === task) {
          this.activeScan = null;
          this.scanAbortController = null;
        }
        this.onAvailable();
      });
    this.activeScan = task;
    try {
      await task;
    } catch (error) {
      onFailure(error);
      throw error;
    }
  }

  public async cancelActiveScan(): Promise<void> {
    const task = this.activeScan;
    if (task === null) return;
    this.scanAbortController?.abort();
    await task;
  }

  public shutdown(): Promise<void> {
    if (this.shutdownTask !== null) return this.shutdownTask;
    this.shuttingDown = true;
    this.scanAbortController?.abort();
    this.shutdownTask = this.settleForShutdown();
    return this.shutdownTask;
  }

  private assertScanAllowed(): void {
    this.assertAcceptingOperations('SCAN_FAILED');
    if (this.reservations.has('mapImport')) {
      this.reject('MAP_IMPORT_FAILED', '地图数据导入中，请等待完成后再扫描照片。');
    }
    if (this.reservations.has('fileRename')) {
      this.reject('SCAN_FAILED', '文件重命名正在进行，请稍后再扫描照片。');
    }
    if (this.reservations.has('fileTrash')) {
      this.reject('SCAN_FAILED', '文件正在移入回收站，请等待当前操作结束后再扫描照片。');
    }
  }

  private reserve(kind: Reservation): () => void {
    this.reservations.add(kind);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(kind);
      this.onAvailable();
    };
  }

  private reject(code: OperationErrorCode, message: string): never {
    throw new PhotoMapError(code, message, { retryability: 'retry' });
  }

  private async settleForShutdown(): Promise<void> {
    while (this.inFlightOperations.size > 0) {
      await Promise.allSettled([...this.inFlightOperations]);
    }
    await this.cancelActiveScan();
  }
}
