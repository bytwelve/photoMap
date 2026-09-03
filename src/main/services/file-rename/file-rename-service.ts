import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { link, lstat, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RenamePhotoRequest } from '../../../shared/contracts';
import { PhotoMapError } from '../../../shared/errors';
import { parseRenamePhotoRequest } from '../../../shared/schemas';
import { assertIndexedFileUnchanged, changedIndexedFileError, sameFileIdentity } from '../../infrastructure/filesystem/indexed-file-policy';
import {
  isPathWithin,
  resolveRegularFileWithin,
} from '../../infrastructure/filesystem/path-policy';
import type { PhotoFileRecord } from '../../infrastructure/sqlite/catalog-repository';

export interface FileRenameRepository {
  getPhotoFileRecords(photoIds: string[]): PhotoFileRecord[];
  updatePhotoPathsAfterRename(
    photoId: string,
    expectedAbsolutePath: string,
    absolutePath: string,
    expectedCompanionAbsolutePath: string | null,
    companionAbsolutePath: string | null,
  ): boolean;
}

export interface FileRenameResult {
  renamed: boolean;
  fileName: string;
}

export interface FileRenamePort {
  renamePhoto(request: RenamePhotoRequest): Promise<FileRenameResult>;
}

interface RenameStep {
  sourcePath: string;
  targetPath: string;
}

type TargetState = 'absent' | 'same-entry';

export interface FileMovePort {
  moveNoReplace(sourcePath: string, targetPath: string): Promise<void>;
  renameCaseOnly(sourcePath: string, targetPath: string): Promise<void>;
}

const execFileAsync = promisify(execFile);
const WINDOWS_MOVE_SCRIPT = Buffer.from(`
$ErrorActionPreference = 'Stop'
try {
  [System.IO.File]::Move($env:PHOTOMAP_RENAME_SOURCE, $env:PHOTOMAP_RENAME_TARGET)
  exit 0
} catch {
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) {
    $exception = $exception.InnerException
  }
  $win32Code = $exception.HResult -band 0xffff
  [Console]::Error.WriteLine("PHOTOMAP_WIN32=$win32Code")
  exit 1
}
`, 'utf16le').toString('base64');

function codedFileError(message: string, code: string, cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(message, { cause }), { code });
}

function mapWindowsMoveError(error: unknown): NodeJS.ErrnoException {
  // stderr comes off an unknown rejection value; coercing is deliberate, and a non-string
  // payload simply fails the PHOTOMAP_WIN32 match below and falls through to the default.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const stderr = String((error as { stderr?: unknown }).stderr ?? '');
  const win32Code = Number(/PHOTOMAP_WIN32=(\d+)/u.exec(stderr)?.[1]);
  if (win32Code === 80 || win32Code === 183) {
    return codedFileError('The target file already exists.', 'EEXIST', error);
  }
  if (win32Code === 2 || win32Code === 3) {
    return codedFileError('The source file or parent directory does not exist.', 'ENOENT', error);
  }
  if (win32Code === 5 || win32Code === 32 || win32Code === 33) {
    return codedFileError('The file is not writable or is in use.', 'EACCES', error);
  }
  if (platformCode(error) === 'ENOENT') {
    return codedFileError('Windows PowerShell is unavailable for atomic file rename.', 'ENOSYS', error);
  }
  return codedFileError('The atomic Windows file move failed.', 'EIO', error);
}

async function windowsMoveNoReplace(sourcePath: string, targetPath: string): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot === undefined || !path.isAbsolute(systemRoot)) {
    throw codedFileError('The Windows system directory is unavailable.', 'ENOSYS');
  }
  const powershellPath = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    await execFileAsync(
      powershellPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_MOVE_SCRIPT],
      {
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        maxBuffer: 8 * 1024,
        env: {
          ...process.env,
          PHOTOMAP_RENAME_SOURCE: sourcePath,
          PHOTOMAP_RENAME_TARGET: targetPath,
        },
      },
    );
  } catch (error) {
    throw mapWindowsMoveError(error);
  }
}

async function portableMoveNoReplace(sourcePath: string, targetPath: string): Promise<void> {
  await link(sourcePath, targetPath);
  await unlink(sourcePath);
}

export async function atomicMoveNoReplace(sourcePath: string, targetPath: string): Promise<void> {
  if (process.platform === 'win32') {
    await windowsMoveNoReplace(sourcePath, targetPath);
    return;
  }
  await portableMoveNoReplace(sourcePath, targetPath);
}

const NODE_FILE_MOVE: FileMovePort = {
  moveNoReplace: atomicMoveNoReplace,
  renameCaseOnly: rename,
};

function platformCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function publicRenameError(error: unknown, photoId: string): PhotoMapError {
  if (error instanceof PhotoMapError) {
    return error;
  }
  const code = platformCode(error);
  if (code === 'ENOENT') {
    return new PhotoMapError('MEDIA_NOT_FOUND', '媒体文件已不存在，请刷新照片文件夹后重试。', {
      retryability: 'retry',
      scope: 'item',
      affectedIds: [photoId],
      cause: error,
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new PhotoMapError('RENAME_FAILED', '没有权限重命名这个文件，请关闭占用它的程序或检查文件夹权限。', {
      retryability: 'retry',
      scope: 'item',
      affectedIds: [photoId],
      cause: error,
    });
  }
  if (code === 'EEXIST' || code === 'ENOTEMPTY') {
    return new PhotoMapError('INVALID_REQUEST', '同一文件夹中已存在这个文件名，请换一个名称。', {
      scope: 'item',
      affectedIds: [photoId],
      cause: error,
    });
  }
  return new PhotoMapError('RENAME_FAILED', '文件重命名失败，原文件名已尽量保留。', {
    retryability: 'retry',
    scope: 'item',
    affectedIds: [photoId],
    cause: error,
  });
}

async function targetState(step: RenameStep, photoId: string): Promise<TargetState> {
  if (step.sourcePath === step.targetPath) {
    return 'same-entry';
  }
  let targetStats: Awaited<ReturnType<typeof lstat>>;
  try {
    targetStats = await lstat(step.targetPath);
  } catch (error) {
    if (platformCode(error) === 'ENOENT') {
      return 'absent';
    }
    throw publicRenameError(error, photoId);
  }

  if (targetStats.isSymbolicLink()) {
    throw new PhotoMapError('INVALID_REQUEST', '目标文件名已被占用，请换一个名称。', {
      scope: 'item',
      affectedIds: [photoId],
    });
  }

  let resolvedSource: string;
  try {
    resolvedSource = await realpath(step.sourcePath);
  } catch (error) {
    throw publicRenameError(error, photoId);
  }
  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(step.targetPath);
  } catch (error) {
    if (platformCode(error) === 'ENOENT') {
      return 'absent';
    }
    throw publicRenameError(error, photoId);
  }
  if (path.resolve(resolvedSource) === path.resolve(resolvedTarget)) {
    return 'same-entry';
  }
  throw new PhotoMapError('INVALID_REQUEST', '同一文件夹中已存在这个文件名，请换一个名称。', {
    scope: 'item',
    affectedIds: [photoId],
  });
}

async function moveFileNoReplace(
  step: RenameStep,
  photoId: string,
  fileMove: FileMovePort,
): Promise<void> {
  const state = await targetState(step, photoId);
  if (state === 'same-entry') {
    // On a case-insensitive filesystem both spellings resolve to the same
    // directory entry, so this cannot replace an unrelated target.
    await fileMove.renameCaseOnly(step.sourcePath, step.targetPath);
    return;
  }

  try {
    // The Windows implementation delegates to one File.Move operation, whose
    // target-exists failure is the no-replace commit point. The portable
    // fallback is used only by non-Windows development/test environments.
    await fileMove.moveNoReplace(step.sourcePath, step.targetPath);
  } catch (error) {
    throw publicRenameError(error, photoId);
  }
}

export class FileRenameService implements FileRenamePort {
  public constructor(
    private readonly repository: FileRenameRepository,
    private readonly fileMove: FileMovePort = NODE_FILE_MOVE,
  ) {}

  public async renamePhoto(rawRequest: RenamePhotoRequest): Promise<FileRenameResult> {
    const request = parseRenamePhotoRequest(rawRequest);
    const record = this.repository.getPhotoFileRecords([request.photoId])[0];
    if (record === undefined || record.lifecycleState !== 'active') {
      throw new PhotoMapError('MEDIA_NOT_FOUND', '这项媒体已不在当前照片文件夹中。', {
        retryability: 'retry',
        scope: 'item',
        affectedIds: [request.photoId],
      });
    }

    let sourcePath: string;
    let companionSourcePath: string | null;
    const sourceIdentities = new Map<string, Stats>();
    try {
      sourcePath = await resolveRegularFileWithin(record.rootPath, record.absolutePath);
      companionSourcePath = record.companionAbsolutePath === null
        ? null
        : await resolveRegularFileWithin(record.rootPath, record.companionAbsolutePath);
      const sourceStats = await lstat(sourcePath);
      sourceIdentities.set(sourcePath, sourceStats);
      assertIndexedFileUnchanged(
        sourcePath,
        sourceStats,
        record.fileSize,
        record.modifiedAtMs,
        request.photoId,
        record.fileCreatedAtMs,
      );
      if (
        companionSourcePath !== null
        && record.companionFileSize !== null
        && record.companionModifiedAtMs !== null
      ) {
        const companionStats = await lstat(companionSourcePath);
        sourceIdentities.set(companionSourcePath, companionStats);
        assertIndexedFileUnchanged(
          companionSourcePath,
          companionStats,
          record.companionFileSize,
          record.companionModifiedAtMs,
          request.photoId,
          record.companionFileCreatedAtMs,
        );
      }
    } catch (error) {
      throw publicRenameError(error, request.photoId);
    }

    const currentFileName = path.basename(sourcePath);
    if (request.newFileName === currentFileName) {
      return { renamed: false, fileName: currentFileName };
    }

    const currentExtension = path.extname(currentFileName);
    const requestedExtension = path.extname(request.newFileName);
    if (
      currentExtension.length === 0
      || requestedExtension.toLocaleLowerCase('en-US') !== currentExtension.toLocaleLowerCase('en-US')
    ) {
      throw new PhotoMapError('INVALID_REQUEST', `文件扩展名必须保持为 ${currentExtension || '原格式'}。`, {
        scope: 'item',
        affectedIds: [request.photoId],
      });
    }

    const targetPath = path.join(path.dirname(sourcePath), request.newFileName);
    if (!isPathWithin(record.rootPath, targetPath)) {
      throw new PhotoMapError('INVALID_REQUEST', '只能在原文件夹内修改文件名。', {
        scope: 'item',
        affectedIds: [request.photoId],
      });
    }

    const requestedStem = path.basename(request.newFileName, requestedExtension);
    const currentStem = path.basename(currentFileName, currentExtension);
    const companionStem = companionSourcePath === null
      ? null
      : path.basename(companionSourcePath, path.extname(companionSourcePath));
    const renameCompanion = companionSourcePath !== null
      && companionStem !== null
      && path.dirname(companionSourcePath).toLocaleLowerCase('en-US')
        === path.dirname(sourcePath).toLocaleLowerCase('en-US')
      && companionStem.toLocaleLowerCase('en-US') === currentStem.toLocaleLowerCase('en-US');
    const companionTargetPath = companionSourcePath === null
      ? null
      : renameCompanion
        ? path.join(
            path.dirname(companionSourcePath),
            `${requestedStem}${path.extname(companionSourcePath)}`,
          )
        : companionSourcePath;
    if (companionTargetPath !== null && !isPathWithin(record.rootPath, companionTargetPath)) {
      throw new PhotoMapError('INVALID_REQUEST', '实况照片只能在原文件夹内修改文件名。', {
        scope: 'item',
        affectedIds: [request.photoId],
      });
    }

    const steps: RenameStep[] = [
      ...(companionSourcePath !== null && companionTargetPath !== null && companionSourcePath !== companionTargetPath
        ? [{ sourcePath: companionSourcePath, targetPath: companionTargetPath }]
        : []),
      ...(sourcePath === targetPath ? [] : [{ sourcePath, targetPath }]),
    ];
    for (const step of steps) {
      await targetState(step, request.photoId);
    }

    const completed: RenameStep[] = [];
    try {
      for (const step of steps) {
        const resolvedPath = await resolveRegularFileWithin(record.rootPath, step.sourcePath);
        const expectedIdentity = sourceIdentities.get(step.sourcePath);
        if (resolvedPath !== step.sourcePath || expectedIdentity === undefined
          || !sameFileIdentity(expectedIdentity, await lstat(resolvedPath))) {
          throw changedIndexedFileError(step.sourcePath, request.photoId);
        }
        await moveFileNoReplace(step, request.photoId, this.fileMove);
        completed.push(step);
      }
      const updated = this.repository.updatePhotoPathsAfterRename(
        request.photoId,
        record.absolutePath,
        targetPath,
        record.companionAbsolutePath,
        companionTargetPath,
      );
      if (!updated) {
        throw new PhotoMapError('MEDIA_NOT_FOUND', '媒体索引已变化，请刷新照片文件夹后重试。', {
          retryability: 'retry',
          scope: 'item',
          affectedIds: [request.photoId],
        });
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const step of [...completed].reverse()) {
        try {
          await moveFileNoReplace(
            { sourcePath: step.targetPath, targetPath: step.sourcePath },
            request.photoId,
            this.fileMove,
          );
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new PhotoMapError('RENAME_FAILED', '文件名只完成了部分修改，请刷新照片文件夹并检查实际文件。', {
          retryability: 'retry',
          scope: 'item',
          affectedIds: [request.photoId],
          cause: error,
        });
      }
      throw publicRenameError(error, request.photoId);
    }

    return { renamed: true, fileName: path.basename(targetPath) };
  }
}
