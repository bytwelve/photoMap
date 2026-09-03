import type { ExistingPhotoFact, ScannedFile } from './models';

type IndexedIdentity = Pick<ExistingPhotoFact, 'photoId' | 'canonicalPathKey' | 'contentSha256' | 'lifecycleState'>;

type ScanReconciliationAction =
  | { kind: 'update' | 'replace'; photoId: string; file: ScannedFile }
  | { kind: 'insert'; file: ScannedFile }
  | { kind: 'missing'; photoId: string };

/** Decides identity changes without writing; the repository applies the plan in its existing transaction. */
export function planScanReconciliation(
  existing: readonly IndexedIdentity[],
  files: readonly ScannedFile[],
  complete: boolean
): { actions: ScanReconciliationAction[]; changed: boolean } {
  const currentByPath = new Map<string, IndexedIdentity>();
  const historyByPath = new Map<string, IndexedIdentity[]>();
  for (const row of existing) {
    const history = historyByPath.get(row.canonicalPathKey) ?? [];
    history.push(row);
    historyByPath.set(row.canonicalPathKey, history);
    if (row.lifecycleState === 'active' || row.lifecycleState === 'missing' || row.lifecycleState === 'trash_pending') {
      currentByPath.set(row.canonicalPathKey, row);
    }
  }

  const actions: ScanReconciliationAction[] = [];
  const scannedPathKeys = new Set(files.map((file) => file.canonicalPathKey));
  const seenPhotoIds = new Set<string>();
  const unmatched: ScannedFile[] = [];
  let changed = false;

  for (const file of files) {
    const current = currentByPath.get(file.canonicalPathKey);
    if (current !== undefined) {
      if (sameContent(current, file)) {
        actions.push({ kind: 'update', photoId: current.photoId, file });
        changed ||= current.lifecycleState !== 'active';
      } else {
        actions.push({ kind: 'replace', photoId: current.photoId, file });
        changed = true;
      }
      seenPhotoIds.add(current.photoId);
      continue;
    }

    const trashedMatch = (historyByPath.get(file.canonicalPathKey) ?? [])
      .find((record) => record.lifecycleState === 'trashed' && sameContent(record, file));
    if (trashedMatch !== undefined) {
      actions.push({ kind: 'update', photoId: trashedMatch.photoId, file });
      seenPhotoIds.add(trashedMatch.photoId);
      changed = true;
      continue;
    }
    unmatched.push(file);
  }

  const oldMoveCandidates = existing.filter((record) =>
    !seenPhotoIds.has(record.photoId)
    && !scannedPathKeys.has(record.canonicalPathKey)
    && record.contentSha256 !== null
    && (record.lifecycleState === 'missing'
      || (complete && (record.lifecycleState === 'active' || record.lifecycleState === 'trashed')))
  );
  const oldByHash = groupByHash(oldMoveCandidates);
  const newByHash = groupByHash(unmatched);
  for (const file of unmatched) {
    const oldMatches = file.contentSha256 === null ? [] : oldByHash.get(file.contentSha256) ?? [];
    const newMatches = file.contentSha256 === null ? [] : newByHash.get(file.contentSha256) ?? [];
    const match = oldMatches.length === 1 && newMatches.length === 1 ? oldMatches[0] : undefined;
    if (match !== undefined) {
      actions.push({ kind: 'update', photoId: match.photoId, file });
      seenPhotoIds.add(match.photoId);
    } else {
      actions.push({ kind: 'insert', file });
    }
    changed = true;
  }

  if (complete) {
    for (const record of existing) {
      if (!seenPhotoIds.has(record.photoId)
        && (record.lifecycleState === 'active' || record.lifecycleState === 'trash_pending')) {
        actions.push({ kind: 'missing', photoId: record.photoId });
        changed = true;
      }
    }
  }
  return { actions, changed };
}

function sameContent(existing: IndexedIdentity, file: ScannedFile): boolean {
  return existing.contentSha256 !== null
    && file.contentSha256 !== null
    && existing.contentSha256 === file.contentSha256;
}

function groupByHash<T extends { contentSha256: string | null }>(items: readonly T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    if (item.contentSha256 === null) continue;
    const values = result.get(item.contentSha256) ?? [];
    values.push(item);
    result.set(item.contentSha256, values);
  }
  return result;
}
