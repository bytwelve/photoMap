import type { Stats } from 'node:fs';
import path from 'node:path';
import { PhotoMapError } from '../../../shared/errors';

export function assertIndexedFileUnchanged(
  filePath: string,
  stats: Stats,
  expectedSize: number,
  expectedModifiedAtMs: number,
  photoId: string,
  expectedCreatedAtMs?: number | null,
): void {
  if (
    stats.isFile()
    && !stats.isSymbolicLink()
    && stats.size === expectedSize
    && stats.mtimeMs === expectedModifiedAtMs
    && (expectedCreatedAtMs == null || stats.birthtimeMs === expectedCreatedAtMs)
  ) {
    return;
  }
  throw changedIndexedFileError(filePath, photoId);
}

export function changedIndexedFileError(filePath: string, photoId: string): PhotoMapError {
  return new PhotoMapError('MEDIA_NOT_FOUND', `${path.basename(filePath)} 已在软件外发生变化，请先刷新照片文件夹。`, {
    retryability: 'retry',
    scope: 'item',
    affectedIds: [photoId],
  });
}

export function sameFileIdentity(before: Stats, after: Stats): boolean {
  return after.isFile()
    && !after.isSymbolicLink()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && before.birthtimeMs === after.birthtimeMs;
}
