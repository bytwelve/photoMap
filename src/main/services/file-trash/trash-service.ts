import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { TrashFailureReason, TrashItemResult, TrashItemStatus } from '../../../shared/contracts';
import { PhotoMapError } from '../../../shared/errors';
import {
  assertIndexedFileUnchanged,
  changedIndexedFileError,
  sameFileIdentity,
} from '../../infrastructure/filesystem/indexed-file-policy';
import { resolveRegularFileWithin } from '../../infrastructure/filesystem/path-policy';
import type { PhotoFileRecord } from '../../infrastructure/sqlite/catalog-repository';
import { sha256File } from '../library-scan/hash-file';

export interface RecycleBinPort {
  move(filePath: string): Promise<void>;
}

export interface TrashRepository {
  getPhotoFileRecords(photoIds: string[]): PhotoFileRecord[];
  markTrashPending(photoId: string): boolean;
  invalidatePhotoForRescan(photoId: string): void;
  markTrashCompanionMoved(photoId: string, expectedAbsolutePath: string): void;
  settleTrashItem(photoId: string, status: TrashItemStatus): void;
}

interface VerifiedFile {
  absolutePath: string;
  stats: Stats;
}

async function verifyFile(record: PhotoFileRecord, companion: boolean): Promise<VerifiedFile> {
  const candidate = companion ? record.companionAbsolutePath : record.absolutePath;
  const size = companion ? record.companionFileSize : record.fileSize;
  const modifiedAtMs = companion ? record.companionModifiedAtMs : record.modifiedAtMs;
  if (candidate === null || size === null || modifiedAtMs === null) {
    throw changedIndexedFileError(candidate ?? record.absolutePath, record.photoId);
  }
  const absolutePath = await resolveRegularFileWithin(record.rootPath, candidate);
  const stats = await lstat(absolutePath);
  assertIndexedFileUnchanged(
    absolutePath,
    stats,
    size,
    modifiedAtMs,
    record.photoId,
    companion ? record.companionFileCreatedAtMs : record.fileCreatedAtMs,
  );
  const expectedHash = companion ? record.companionContentSha256 : record.contentSha256;
  if (expectedHash != null && await sha256File(absolutePath, new AbortController().signal) !== expectedHash) {
    throw changedIndexedFileError(absolutePath, record.photoId);
  }
  const verified = { absolutePath, stats };
  await recheckFile(record, verified);
  return verified;
}

async function recheckFile(record: PhotoFileRecord, verified: VerifiedFile): Promise<void> {
  const resolvedPath = await resolveRegularFileWithin(record.rootPath, verified.absolutePath);
  if (resolvedPath !== verified.absolutePath || !sameFileIdentity(verified.stats, await lstat(resolvedPath))) {
    throw changedIndexedFileError(verified.absolutePath, record.photoId);
  }
}

function failureReason(error: unknown): TrashFailureReason {
  if (error instanceof PhotoMapError) {
    if (error.code === 'MEDIA_NOT_FOUND') return 'changed';
    if (error.code === 'INDEX_WRITE_FAILED') return 'index_failed';
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' ? 'access_denied' : code === 'ENOENT' ? 'not_found' : 'failed';
}

export class TrashService {
  public constructor(
    private readonly repository: TrashRepository,
    private readonly recycleBin: RecycleBinPort
  ) {}

  public async moveConfirmed(photoIds: string[]): Promise<TrashItemResult[]> {
    const results: TrashItemResult[] = [];
    for (const photoId of new Set(photoIds)) {
      // Reload each item so retries observe the persisted, remaining files.
      const record = this.repository.getPhotoFileRecords([photoId])[0];
      if (record === undefined || !['active', 'trash_pending'].includes(record.lifecycleState)) {
        results.push({ photoId, status: 'not_found' });
        continue;
      }

      const movedFileNames: string[] = [];
      let result: TrashItemResult;
      try {
        // Validate both files before moving either of them.
        const primary = await verifyFile(record, false);
        const companion = record.companionAbsolutePath === null ? null : await verifyFile(record, true);
        if (!this.repository.markTrashPending(photoId)) {
          results.push({ photoId, status: 'not_found' });
          continue;
        }
        if (companion !== null) {
          await recheckFile(record, companion);
          await this.recycleBin.move(companion.absolutePath);
          movedFileNames.push(path.basename(companion.absolutePath));
          this.repository.markTrashCompanionMoved(photoId, record.companionAbsolutePath!);
        }
        // The primary may have changed while Windows processed the companion.
        await recheckFile(record, primary);
        await this.recycleBin.move(primary.absolutePath);
        movedFileNames.push(path.basename(primary.absolutePath));
        result = { photoId, status: 'moved' };
      } catch (error) {
        const reason = failureReason(error);
        result = movedFileNames.length === 0
          ? { photoId, status: reason }
          : { photoId, status: 'partial', movedFileNames, failureReason: reason };
      }
      try {
        if (result.status === 'changed' || result.failureReason === 'changed') {
          this.repository.invalidatePhotoForRescan(photoId);
        }
        this.repository.settleTrashItem(photoId, result.status);
      } catch {
        result = movedFileNames.length === 0
          ? { photoId, status: 'index_failed' }
          : { photoId, status: 'partial', movedFileNames, failureReason: 'index_failed' };
      }
      // A missing file alone never counts as a successful recycle-bin operation.
      // A crash between the OS move and SQLite commit requires a refresh/check.
      results.push(result);
    }
    return results;
  }
}
