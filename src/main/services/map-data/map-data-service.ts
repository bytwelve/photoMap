import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  ImportMapDataResult,
  MapDataImportRejection,
  MapDataKind,
  MapDataStatus,
} from '../../../shared/contracts';
import { PhotoMapError } from '../../../shared/errors';
import {
  PHOTO_MAP_DATA_CONTRACT,
  type MapDataFileContract,
} from './map-data-contract';

export type MapDataImportOutcome = Omit<ImportMapDataResult, 'cancelled'>;
export type MapDataAtomicWriter = (targetPath: string, bytes: Buffer) => Promise<void>;

export interface MapDataCatalogPort {
  isAvailable(): boolean;
  load(mapDataDirectory: string): Promise<void>;
  reset(): void;
}

export interface MapDataManagerPort {
  initialize(): Promise<MapDataStatus>;
  getStatus(): Promise<MapDataStatus>;
  importFiles(filePaths: readonly string[]): Promise<MapDataImportOutcome>;
}

interface StoredItemProbe {
  imported: boolean;
  invalid: boolean;
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeMapDataAtomically(targetPath: string, bytes: Buffer): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.photomap-${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export class MapDataService implements MapDataManagerPort {
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly mapDataDirectory: string,
    private readonly catalog: MapDataCatalogPort,
    private readonly contract: readonly MapDataFileContract[] = PHOTO_MAP_DATA_CONTRACT,
    private readonly atomicWriter: MapDataAtomicWriter = writeMapDataAtomically,
  ) {
    this.assertContract();
  }

  public initialize(): Promise<MapDataStatus> {
    return this.enqueue(async () => {
      await mkdir(this.mapDataDirectory, { recursive: true });
      return this.inspectAndSynchronizeCatalog();
    });
  }

  public getStatus(): Promise<MapDataStatus> {
    return this.enqueue(async () => {
      await mkdir(this.mapDataDirectory, { recursive: true });
      return this.inspectAndSynchronizeCatalog();
    });
  }

  public importFiles(filePaths: readonly string[]): Promise<MapDataImportOutcome> {
    return this.enqueue(async () => {
      try {
        await mkdir(this.mapDataDirectory, { recursive: true });
      } catch (error) {
        throw this.importWriteFailure('无法准备地图数据存储目录，请检查磁盘权限和可用空间。', error);
      }
      const accepted = new Set<MapDataKind>();
      const rejected: MapDataImportRejection[] = [];

      for (const sourcePath of filePaths) {
        const fileName = path.basename(sourcePath) || '未命名文件';
        let source: { item: MapDataFileContract; bytes: Buffer } | undefined;
        try {
          source = await this.readAndClassifySource(sourcePath);
        } catch {
          rejected.push({ fileName, reason: 'source_unreadable' });
          continue;
        }
        if (source === undefined) {
          rejected.push({ fileName, reason: 'unrecognized' });
          continue;
        }

        const existing = await this.inspectStoredItem(source.item);
        if (!existing.imported) {
          try {
            await this.atomicWriter(
              path.join(this.mapDataDirectory, source.item.canonicalFileName),
              source.bytes,
            );
          } catch (error) {
            throw this.importWriteFailure(
              `无法保存${source.item.label}，请检查磁盘权限和可用空间后重试。`,
              error,
            );
          }
        }
        accepted.add(source.item.kind);
      }

      return {
        accepted: [...accepted],
        rejected,
        status: await this.inspectAndSynchronizeCatalog(),
      };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async inspectAndSynchronizeCatalog(): Promise<MapDataStatus> {
    const probes = await Promise.all(this.contract.map((item) => this.inspectStoredItem(item)));
    const items = this.contract.map((item, index) => ({
      kind: item.kind,
      label: item.label,
      imported: probes[index]?.imported === true,
    }));
    const completed = items.filter((item) => item.imported).length;
    const invalidStoredData = probes.some((probe) => probe.invalid);
    let error = invalidStoredData ? '已导入的地图数据校验失败，请重新导入。' : undefined;

    if (completed !== items.length) {
      this.catalog.reset();
    } else if (!this.catalog.isAvailable()) {
      try {
        await this.catalog.load(this.mapDataDirectory);
      } catch (loadError) {
        this.catalog.reset();
        error = loadError instanceof Error
          ? loadError.message
          : '本地地图数据无法载入，请重新导入。';
      }
    }

    return {
      items,
      completed,
      total: items.length,
      ready: completed === items.length && this.catalog.isAvailable(),
      ...(error === undefined ? {} : { error }),
    };
  }

  private async inspectStoredItem(item: MapDataFileContract): Promise<StoredItemProbe> {
    const targetPath = path.join(this.mapDataDirectory, item.canonicalFileName);
    try {
      const bytes = await this.readExactRegularFile(targetPath, item.byteLength);
      const imported = bytes !== undefined && sha256(bytes) === item.sha256;
      return {
        imported,
        invalid: !imported,
      };
    } catch (error) {
      if (isMissingPathError(error)) return { imported: false, invalid: false };
      return { imported: false, invalid: true };
    }
  }

  private async readAndClassifySource(
    sourcePath: string,
  ): Promise<{ item: MapDataFileContract; bytes: Buffer } | undefined> {
    const stats = await lstat(sourcePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('Map data source must be an ordinary file.');
    }
    const possibleItems = this.contract.filter((item) => item.byteLength === stats.size);
    if (possibleItems.length === 0) return undefined;

    const bytes = await this.readExactRegularFile(sourcePath, stats.size);
    if (bytes === undefined) return undefined;
    const digest = sha256(bytes);
    const item = possibleItems.find((candidate) => candidate.sha256 === digest);
    return item === undefined ? undefined : { item, bytes };
  }

  private async readExactRegularFile(filePath: string, expectedLength: number): Promise<Buffer | undefined> {
    const pathStats = await lstat(filePath);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size !== expectedLength) {
      return undefined;
    }
    const handle = await open(filePath, 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size !== expectedLength) return undefined;
      const bytes = Buffer.alloc(expectedLength);
      let offset = 0;
      while (offset < expectedLength) {
        const read = await handle.read(bytes, offset, expectedLength - offset, offset);
        if (read.bytesRead === 0) return undefined;
        offset += read.bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await handle.read(extra, 0, 1, expectedLength)).bytesRead !== 0) return undefined;
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private importWriteFailure(message: string, cause: unknown): PhotoMapError {
    return new PhotoMapError('MAP_IMPORT_FAILED', message, {
      retryability: 'retry',
      scope: 'task',
      cause,
    });
  }

  private assertContract(): void {
    const kinds = new Set<MapDataKind>();
    const fileNames = new Set<string>();
    for (const item of this.contract) {
      if (
        (item.kind !== 'province' && item.kind !== 'city')
        || kinds.has(item.kind)
        || fileNames.has(item.canonicalFileName)
        || path.basename(item.canonicalFileName) !== item.canonicalFileName
        || !Number.isSafeInteger(item.byteLength)
        || item.byteLength <= 0
        || !/^[a-f0-9]{64}$/u.test(item.sha256)
      ) {
        throw new Error('Invalid map data contract.');
      }
      kinds.add(item.kind);
      fileNames.add(item.canonicalFileName);
    }
    if (kinds.size !== 2 || this.contract.length !== 2) {
      throw new Error('Map data contract must contain exactly one province and one city file.');
    }
  }
}
