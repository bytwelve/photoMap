import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { MediaFormat } from '../../../shared/contracts';

export interface FileCandidate {
  absolutePath: string;
  relativePath: string;
  mediaFormat: MediaFormat;
}

export interface EnumerationIssue {
  relativeDirectory: string;
  code: string;
}

export interface EnumerationResult {
  files: FileCandidate[];
  issues: EnumerationIssue[];
}

function mediaFormatFromName(name: string): MediaFormat | null {
  const extension = path.extname(name).toLocaleLowerCase('en-US');
  switch (extension) {
    case '.png': return 'png';
    case '.jpg':
    case '.jpeg': return 'jpg';
    case '.heic':
    case '.heif': return 'heic';
    case '.avif': return 'avif';
    case '.mp4': return 'mp4';
    case '.mov': return 'mov';
    case '.m4v': return 'm4v';
    default: return null;
  }
}

export async function enumerateMediaFiles(rootPath: string, signal: AbortSignal): Promise<EnumerationResult> {
  const files: FileCandidate[] = [];
  const issues: EnumerationIssue[] = [];

  async function visit(directoryPath: string): Promise<void> {
    if (signal.aborted) {
      return;
    }

    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      issues.push({
        relativeDirectory: path.relative(rootPath, directoryPath),
        code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      });
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US', { sensitivity: 'base' }));
    for (const entry of entries) {
      if (signal.aborted) {
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const mediaFormat = mediaFormatFromName(entry.name);
      if (mediaFormat === null) {
        continue;
      }
      files.push({
        absolutePath,
        relativePath: path.relative(rootPath, absolutePath),
        mediaFormat
      });
    }
  }

  await visit(rootPath);
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, 'en-US', { sensitivity: 'base' })
  );
  return { files, issues };
}
