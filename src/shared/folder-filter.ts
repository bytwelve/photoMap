export const MAX_FOLDER_FILTER_DEPTH = 2;
export const MAX_FOLDER_FILTER_PATH_LENGTH = 1024;

function normalizedSegments(value: string): string[] | undefined {
  if (value.length === 0 || value.length > MAX_FOLDER_FILTER_PATH_LENGTH) return undefined;
  const normalized = value.normalize('NFC').replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.endsWith('/')) return undefined;
  const segments = normalized.split('/');
  if (
    segments.length === 0
    || segments.length > MAX_FOLDER_FILTER_DEPTH
    || segments.some((segment) => (
      segment.length === 0
      || segment.length > 255
      || segment === '.'
      || segment === '..'
      || /[\u0000-\u001f]/u.test(segment)
      || /[:*?"<>|]/u.test(segment)
      || segment.endsWith('.')
      || segment.endsWith(' ')
    ))
  ) return undefined;
  return segments;
}

export function normalizeFolderFilterPath(value: string): string | undefined {
  return normalizedSegments(value)?.join('/');
}

export function folderFilterPathKey(value: string): string | undefined {
  return normalizeFolderFilterPath(value)?.toLocaleLowerCase('en-US');
}

export function folderPathFromRelativePath(relativePath: string | undefined): string | undefined {
  if (!relativePath) return undefined;
  const normalized = relativePath.normalize('NFC').replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) return undefined;
  const segments = normalized.split('/');
  if (
    segments.length < 2
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) return undefined;
  return normalizeFolderFilterPath(segments.slice(0, -1).slice(0, MAX_FOLDER_FILTER_DEPTH).join('/'));
}

export function folderPathMatches(
  photoFolderPath: string | undefined,
  selectedFolderPaths: ReadonlySet<string>,
): boolean {
  if (selectedFolderPaths.size === 0) return true;
  if (!photoFolderPath) return false;
  const photoKey = folderFilterPathKey(photoFolderPath);
  if (!photoKey) return false;
  for (const selectedPath of selectedFolderPaths) {
    const selectedKey = folderFilterPathKey(selectedPath);
    if (selectedKey && (photoKey === selectedKey || photoKey.startsWith(`${selectedKey}/`))) return true;
  }
  return false;
}
