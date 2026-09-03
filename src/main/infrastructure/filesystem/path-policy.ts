import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { PhotoMapError } from '../../../shared/errors';

export function canonicalPathKey(value: string): string {
  return path.resolve(value).normalize('NFC').toLocaleLowerCase('en-US');
}

export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function validateLibraryRoot(rootPath: string): Promise<string> {
  if (path.resolve(rootPath).startsWith('\\\\') || rootPath.startsWith('\\\\')) {
    throw new PhotoMapError('SOURCE_ACCESS_DENIED', '一期只支持本机照片文件夹，不支持网络或 UNC 路径。', {
      retryability: 'choose_other',
      scope: 'global'
    });
  }
  try {
    const stats = await lstat(rootPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new PhotoMapError('SOURCE_NOT_FOUND', '请选择一个可读的普通文件夹。', {
        retryability: 'choose_other',
        scope: 'global'
      });
    }
    await access(rootPath, constants.R_OK);
    return await realpath(rootPath);
  } catch (error) {
    if (error instanceof PhotoMapError) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException).code;
    throw new PhotoMapError(
      code === 'EACCES' || code === 'EPERM' ? 'SOURCE_ACCESS_DENIED' : 'SOURCE_NOT_FOUND',
      code === 'EACCES' || code === 'EPERM'
        ? '无法读取该文件夹，请检查权限或选择其他文件夹。'
        : '照片文件夹不存在或不可用。',
      { retryability: 'choose_other', scope: 'global', cause: error }
    );
  }
}

export async function resolveRegularFileWithin(rootPath: string, candidatePath: string): Promise<string> {
  const canonicalRoot = await realpath(rootPath);
  const stats = await lstat(candidatePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new PhotoMapError('MEDIA_NOT_FOUND', '照片文件已不可用。', {
      retryability: 'retry',
      scope: 'item'
    });
  }
  const canonicalCandidate = await realpath(candidatePath);
  if (!isPathWithin(canonicalRoot, canonicalCandidate) || canonicalCandidate.startsWith('\\\\')) {
    throw new PhotoMapError('MEDIA_NOT_FOUND', '已拒绝访问照片根目录外的文件。', {
      scope: 'item'
    });
  }
  return canonicalCandidate;
}
