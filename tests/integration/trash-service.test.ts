import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeSqliteCatalogRepository, type PhotoFileRecord } from '../../src/main/infrastructure/sqlite/catalog-repository';
import { canonicalPathKey } from '../../src/main/infrastructure/filesystem/path-policy';
import {
  TrashService,
  type RecycleBinPort,
  type TrashRepository,
} from '../../src/main/services/file-trash/trash-service';
import type { TrashItemStatus } from '../../src/shared/contracts';
import { PhotoMapError } from '../../src/shared/errors';
import { LibraryScanner } from '../../src/main/services/library-scan/library-scanner';

const temporaryRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  // Match validateLibraryRoot: Windows TEMP may contain an 8.3 short-path alias.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'photo-map-trash-fake-')));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const target = await realpath(temporaryRoots.pop()!);
    expect(path.dirname(target)).toBe(await realpath(os.tmpdir()));
    expect(path.basename(target).startsWith('photo-map-trash-fake-')).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

class FakeTrashRepository implements TrashRepository {
  public readonly records = new Map<string, PhotoFileRecord>();
  public readonly settled: Array<{ photoId: string; status: TrashItemStatus }> = [];
  public readonly invalidated = new Set<string>();

  public getPhotoFileRecords(photoIds: string[]): PhotoFileRecord[] {
    return photoIds.flatMap((photoId) => {
      const record = this.records.get(photoId);
      return record ? [record] : [];
    });
  }

  public markTrashPending(photoId: string): boolean {
    const record = this.records.get(photoId);
    if (!record || !['active', 'trash_pending'].includes(record.lifecycleState)) return false;
    record.lifecycleState = 'trash_pending';
    return true;
  }

  public invalidatePhotoForRescan(photoId: string): void {
    this.invalidated.add(photoId);
  }

  public markTrashCompanionMoved(photoId: string, expectedAbsolutePath: string): void {
    const record = this.records.get(photoId)!;
    expect(record.companionAbsolutePath).toBe(expectedAbsolutePath);
    record.companionAbsolutePath = null;
    record.companionFileSize = null;
    record.companionModifiedAtMs = null;
    record.companionContentSha256 = null;
    record.mediaKind = 'photo';
  }

  public settleTrashItem(photoId: string, status: TrashItemStatus): void {
    const record = this.records.get(photoId);
    if (!record || record.lifecycleState !== 'trash_pending') return;
    record.lifecycleState = status === 'moved' ? 'trashed' : 'active';
    this.settled.push({ photoId, status });
  }
}

function platformError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

async function recordFor(rootPath: string, fileName: string, companionFileName?: string): Promise<PhotoFileRecord> {
  const absolutePath = path.join(rootPath, fileName);
  const stats = await lstat(absolutePath);
  const companionAbsolutePath = companionFileName === undefined ? null : path.join(rootPath, companionFileName);
  const companionStats = companionAbsolutePath === null ? null : await lstat(companionAbsolutePath);
  return {
    photoId: path.basename(fileName, '.jpg'),
    absolutePath,
    rootPath,
    lifecycleState: 'active',
    contentSha256: createHash('sha256').update(await readFile(absolutePath)).digest('hex'),
    fileSize: stats.size,
    modifiedAtMs: stats.mtimeMs,
    fileCreatedAtMs: stats.birthtimeMs,
    mediaKind: companionAbsolutePath === null ? 'photo' : 'live',
    mediaFormat: 'jpg',
    companionAbsolutePath,
    companionFileSize: companionStats?.size ?? null,
    companionModifiedAtMs: companionStats?.mtimeMs ?? null,
    companionFileCreatedAtMs: companionStats?.birthtimeMs ?? null,
    companionContentSha256: companionAbsolutePath === null ? null : createHash('sha256').update(await readFile(companionAbsolutePath)).digest('hex'),
  };
}

async function liveFixture(): Promise<{ root: string; record: PhotoFileRecord; repository: FakeTrashRepository }> {
  const root = await fixtureRoot();
  await Promise.all([
    writeFile(path.join(root, 'live.jpg'), 'still'),
    writeFile(path.join(root, 'live.mov'), 'motion'),
  ]);
  const record = await recordFor(root, 'live.jpg', 'live.mov');
  const repository = new FakeTrashRepository();
  repository.records.set(record.photoId, record);
  return { root, record, repository };
}

describe('TDD-CONTRACT-RECYCLE-001 fake recycle-bin settlement', () => {
  it('prd_fr_022__recycle_batch_is_partial__settles_items__only_moved_becomes_trashed', async () => {
    const root = await fixtureRoot();
    const movedPath = path.join(root, 'moved.jpg');
    const deniedPath = path.join(root, 'denied.jpg');
    const notFoundPath = path.join(root, 'not-found.jpg');
    await Promise.all([
      writeFile(movedPath, Buffer.from('moved')),
      writeFile(deniedPath, Buffer.from('denied')),
      writeFile(notFoundPath, Buffer.from('not-found')),
    ]);

    const repository = new FakeTrashRepository();
    for (const [photoId, absolutePath] of [
      ['moved', movedPath],
      ['denied', deniedPath],
      ['not-found', notFoundPath],
    ] as const) {
      repository.records.set(photoId, await recordFor(root, path.basename(absolutePath)));
    }
    const move = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('denied.jpg')) throw platformError('EACCES');
      if (filePath.endsWith('not-found.jpg')) throw platformError('ENOENT');
    });
    const recycleBin: RecycleBinPort = { move };
    const service = new TrashService(repository, recycleBin);

    const results = await service.moveConfirmed(['moved', 'denied', 'not-found', 'not-indexed']);

    expect(results).toEqual([
      { photoId: 'moved', status: 'moved' },
      { photoId: 'denied', status: 'access_denied' },
      { photoId: 'not-found', status: 'not_found' },
      { photoId: 'not-indexed', status: 'not_found' },
    ]);
    expect(repository.records.get('moved')?.lifecycleState).toBe('trashed');
    expect(repository.records.get('denied')?.lifecycleState).toBe('active');
    expect(repository.records.get('not-found')?.lifecycleState).toBe('active');
    expect(repository.settled).toEqual([
      { photoId: 'moved', status: 'moved' },
      { photoId: 'denied', status: 'access_denied' },
      { photoId: 'not-found', status: 'not_found' },
    ]);
    expect(move).toHaveBeenCalledTimes(3);
  });

  it('prd_ac_011__apple_live_photo__confirmed_trash__moves_motion_companion_then_still_as_one_item', async () => {
    const root = await fixtureRoot();
    const stillPath = path.join(root, 'live.jpg');
    const motionPath = path.join(root, 'live.mov');
    await Promise.all([
      writeFile(stillPath, Buffer.from('still')),
      writeFile(motionPath, Buffer.from('motion')),
    ]);
    const repository = new FakeTrashRepository();
    repository.records.set('live', await recordFor(root, 'live.jpg', 'live.mov'));
    const move = vi.fn(async (_filePath: string) => undefined);

    const results = await new TrashService(repository, { move }).moveConfirmed(['live']);

    expect(results).toEqual([{ photoId: 'live', status: 'moved' }]);
    expect(move.mock.calls.map(([filePath]) => filePath)).toEqual([motionPath, stillPath]);
    expect(repository.records.get('live')?.lifecycleState).toBe('trashed');
  });

  it('reports_the_moved_companion_and_retries_only_the_remaining_photo', async () => {
    const { root, repository, record } = await liveFixture();
    const move = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('.jpg')) throw platformError('EACCES');
      await rename(filePath, path.join(root, 'recycled.mov'));
    });
    const first = await new TrashService(repository, { move }).moveConfirmed(['live']);
    expect(first).toEqual([{
      photoId: 'live', status: 'partial', movedFileNames: ['live.mov'], failureReason: 'access_denied',
    }]);
    expect(record.mediaKind).toBe('photo');
    expect(record.companionAbsolutePath).toBeNull();
    expect(record.lifecycleState).toBe('active');

    // A newly created/restored companion is a separate file; do not delete it implicitly.
    await writeFile(path.join(root, 'live.mov'), 'new-video');
    const retryMove = vi.fn(async (filePath: string) => rename(filePath, path.join(root, 'recycled.jpg')));
    const retried = await new TrashService(repository, { move: retryMove }).moveConfirmed(['live']);
    expect(retried).toEqual([{ photoId: 'live', status: 'moved' }]);
    expect(retryMove.mock.calls).toEqual([[path.join(root, 'live.jpg')]]);
    expect(await readFile(path.join(root, 'live.mov'), 'utf8')).toBe('new-video');
  });

  it('does_not_treat_an_unrecorded_missing_companion_as_already_recycled', async () => {
    const { root, repository } = await liveFixture();
    await rename(path.join(root, 'live.mov'), path.join(root, 'externally-moved.mov'));
    const move = vi.fn(async () => undefined);
    expect(await new TrashService(repository, { move }).moveConfirmed(['live'])).toEqual([
      { photoId: 'live', status: 'not_found' },
    ]);
    expect(move).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, 'live.jpg'), 'utf8')).toBe('still');
  });

  it.each(['live.jpg', 'live.mov'])('rejects_a_changed_%s_before_moving_either_file', async (fileName) => {
    const { root, repository } = await liveFixture();
    await writeFile(path.join(root, fileName), 'replaced-content');
    const move = vi.fn(async () => undefined);
    expect(await new TrashService(repository, { move }).moveConfirmed(['live'])).toEqual([
      { photoId: 'live', status: 'changed' },
    ]);
    expect(move).not.toHaveBeenCalled();
  });

  it('detects_changed_bytes_even_when_the_indexed_size_and_timestamp_match', async () => {
    const { root, repository, record } = await liveFixture();
    const source = path.join(root, 'live.jpg');
    await writeFile(source, 'other');
    // Round to an exact timestamp so filesystem precision does not decide this test.
    await utimes(source, 1_750_000_000, 1_750_000_000);
    record.modifiedAtMs = (await lstat(source)).mtimeMs;
    const move = vi.fn(async () => undefined);
    expect(await new TrashService(repository, { move }).moveConfirmed(['live'])).toEqual([
      { photoId: 'live', status: 'changed' },
    ]);
    expect(move).not.toHaveBeenCalled();
  });

  it('rechecks_the_primary_after_the_companion_move_before_touching_a_replacement', async () => {
    const { root, repository } = await liveFixture();
    const move = vi.fn(async (filePath: string) => {
      await rename(filePath, path.join(root, 'recycled.mov'));
      await writeFile(path.join(root, 'live.jpg'), 'replaced-while-recycling');
    });
    expect(await new TrashService(repository, { move }).moveConfirmed(['live'])).toEqual([{
      photoId: 'live', status: 'partial', movedFileNames: ['live.mov'], failureReason: 'changed',
    }]);
    expect(move).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(root, 'live.jpg'), 'utf8')).toBe('replaced-while-recycling');
    expect(repository.invalidated.has('live')).toBe(true);
  });

  it('reports_a_successful_OS_move_even_if_persisting_that_step_fails_and_stops_before_the_primary', async () => {
    const { root, repository } = await liveFixture();
    vi.spyOn(repository, 'markTrashCompanionMoved').mockImplementation(() => {
      throw new PhotoMapError('INDEX_WRITE_FAILED', 'synthetic disk failure');
    });
    const move = vi.fn(async (filePath: string) => rename(filePath, path.join(root, 'recycled.mov')));
    const result = await new TrashService(repository, { move }).moveConfirmed(['live']);
    expect(result).toEqual([{
      photoId: 'live', status: 'partial', movedFileNames: ['live.mov'], failureReason: 'index_failed',
    }]);
    expect(move).toHaveBeenCalledTimes(1);
    const retry = await new TrashService(repository, { move }).moveConfirmed(['live']);
    expect(retry).toEqual([{ photoId: 'live', status: 'not_found' }]);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('reports_all_confirmed_moves_if_final_index_settlement_fails', async () => {
    const { root, repository } = await liveFixture();
    vi.spyOn(repository, 'settleTrashItem').mockImplementation(() => {
      throw new PhotoMapError('INDEX_WRITE_FAILED', 'synthetic final settlement failure');
    });
    const move = vi.fn(async (filePath: string) => rename(filePath, path.join(root, `recycled${path.extname(filePath)}`)));
    expect(await new TrashService(repository, { move }).moveConfirmed(['live'])).toEqual([{
      photoId: 'live', status: 'partial', movedFileNames: ['live.mov', 'live.jpg'], failureReason: 'index_failed',
    }]);
    expect(move).toHaveBeenCalledTimes(2);
  });

  it.each(['live.jpg', 'live.mov'])('rehashes_only_the_invalidated_item_after_%s_changes_with_the_same_size_and_mtime', async (fileName) => {
    const { root } = await liveFixture();
    await writeFile(path.join(root, 'unrelated.jpg'), 'unrelated-photo');
    const modifiedPath = path.join(root, fileName);
    await utimes(modifiedPath, 1_750_000_000, 1_750_000_000);
    const databasePath = path.join(root, 'catalog.sqlite3');
    let repository = await NodeSqliteCatalogRepository.open(databasePath);
    const probe = vi.fn(async () => ({ pixelWidth: 1, pixelHeight: 1, decodeState: 'valid' as const }));
    const scan = async () => {
      const source = repository.getActiveSource()!;
      return new LibraryScanner(repository, { probe }).scan(source.sourceId, root, new AbortController().signal, {
        gpsMetadataPolicy: 'skip', onProgress: () => undefined,
      });
    };
    try {
      repository.activateSource(root);
      await scan();
      const before = repository.getLibrarySnapshot();
      const original = before.photos.find((photo) => photo.fileName === 'live.jpg')!;
      const unrelated = before.photos.find((photo) => photo.fileName === 'unrelated.jpg')!;
      expect(original.mediaKind).toBe('live');
      repository.updateNote(unrelated.photoId, '保留无关项标注');
      const oldRecord = repository.getPhotoFileRecords([original.photoId])[0]!;
      const replacement = fileName === 'live.jpg' ? 'other' : 'edited';
      await writeFile(modifiedPath, replacement);
      await utimes(modifiedPath, 1_750_000_000, 1_750_000_000);
      const move = vi.fn(async (filePath: string) => rename(filePath, path.join(root, `recycled${path.extname(filePath)}`)));
      expect(await new TrashService(repository, { move }).moveConfirmed([original.photoId])).toEqual([
        { photoId: original.photoId, status: 'changed' },
      ]);
      expect(move).not.toHaveBeenCalled();
      // A restart must retain the hint without replacing the recorded file facts.
      repository.close();
      repository = await NodeSqliteCatalogRepository.open(databasePath);
      const source = repository.getActiveSource()!;
      expect(repository.getExistingPhotoFacts(source.sourceId).find((photo) => photo.photoId === original.photoId)?.needsRescan).toBe(true);
      expect(repository.getPhotoFileRecords([original.photoId])[0]).toEqual(oldRecord);
      probe.mockClear();
      const refreshed = await scan();
      expect(refreshed.progress.counts).toEqual({ discovered: 2, indexed: 1, unchanged: 1, errors: 0 });
      expect(probe).toHaveBeenCalledTimes(1);
      const after = repository.getLibrarySnapshot();
      const refreshedPhoto = after.photos.find((photo) => photo.fileName === 'live.jpg')!;
      const refreshedRecord = repository.getPhotoFileRecords([refreshedPhoto.photoId])[0]!;
      expect(fileName === 'live.jpg' ? refreshedRecord.contentSha256 : refreshedRecord.companionContentSha256)
        .toBe(createHash('sha256').update(replacement).digest('hex'));
      expect(after.photos.find((photo) => photo.fileName === 'unrelated.jpg')).toEqual(expect.objectContaining({
        photoId: unrelated.photoId, note: '保留无关项标注',
      }));
      expect(repository.getExistingPhotoFacts(source.sourceId).find((photo) => photo.photoId === refreshedPhoto.photoId)?.needsRescan).toBe(false);
      expect((await scan()).progress.counts.unchanged).toBe(2);
      // Only the user's fresh confirmation authorizes the newly scanned bytes.
      expect(await new TrashService(repository, { move }).moveConfirmed([refreshedPhoto.photoId])).toEqual([
        { photoId: refreshedPhoto.photoId, status: 'moved' },
      ]);
      expect(move).toHaveBeenCalledTimes(2);
      expect(await readFile(path.join(root, 'unrelated.jpg'), 'utf8')).toBe('unrelated-photo');
      expect(repository.getLibrarySnapshot().photos.map((photo) => photo.photoId)).toEqual([unrelated.photoId]);
    } finally {
      repository.close();
    }
  });

  it.each([false, true])('persists_partial_success_and_continues_after_reopening_with_pending_state_%s', async (pending) => {
    const { root, record } = await liveFixture();
    const dataRoot = path.join(root, 'data');
    await mkdir(dataRoot);
    const databasePath = path.join(dataRoot, 'catalog.sqlite3');
    let repository = await NodeSqliteCatalogRepository.open(databasePath);
    try {
      const source = repository.activateSource(root);
      const runId = repository.startScanRun(source.sourceId);
      repository.reconcileScan(source.sourceId, runId, [{
        absolutePath: record.absolutePath,
        relativePath: 'live.jpg',
        canonicalPathKey: canonicalPathKey(record.absolutePath),
        fileSize: record.fileSize,
        modifiedAtMs: record.modifiedAtMs,
        fileCreatedAtMs: record.fileCreatedAtMs ?? null,
        contentSha256: record.contentSha256,
        mediaKind: 'live', mediaFormat: 'jpg', pixelWidth: 1, pixelHeight: 1, decodeState: 'valid',
        companion: {
          absolutePath: record.companionAbsolutePath!, relativePath: 'live.mov',
          canonicalPathKey: canonicalPathKey(record.companionAbsolutePath!),
          fileSize: record.companionFileSize!, modifiedAtMs: record.companionModifiedAtMs!,
          fileCreatedAtMs: record.companionFileCreatedAtMs ?? null,
          contentSha256: record.companionContentSha256 ?? null, mediaFormat: 'mov',
        },
      }], true);
      const photoId = repository.getLibrarySnapshot().photos[0]!.photoId;
      const initialMove = vi.fn(async (filePath: string) => {
        if (filePath.endsWith('.jpg')) throw platformError('EACCES');
        await rename(filePath, path.join(root, 'recycled.mov'));
      });
      expect(await new TrashService(repository, { move: initialMove }).moveConfirmed([photoId])).toEqual([{
        photoId, status: 'partial', movedFileNames: ['live.mov'], failureReason: 'access_denied',
      }]);
      if (pending) repository.markTrashPending(photoId);
      repository.close();
      repository = await NodeSqliteCatalogRepository.open(databasePath);
      expect(repository.getPhotoFileRecords([photoId])[0]).toEqual(expect.objectContaining({
        lifecycleState: pending ? 'trash_pending' : 'active', mediaKind: 'photo', companionAbsolutePath: null,
      }));
      const retryMove = vi.fn(async (filePath: string) => rename(filePath, path.join(root, 'recycled.jpg')));
      expect(await new TrashService(repository, { move: retryMove }).moveConfirmed([photoId])).toEqual([
        { photoId, status: 'moved' },
      ]);
      expect(retryMove.mock.calls).toEqual([[record.absolutePath]]);
      expect(repository.getLibrarySnapshot().photos).toHaveLength(0);
    } finally {
      repository.close();
    }
  });
});
