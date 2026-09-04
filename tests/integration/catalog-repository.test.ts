import { lstat, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalPathKey } from '../../src/main/infrastructure/filesystem/path-policy';
import {
  CATALOG_SCHEMA_VERSION,
  NodeSqliteCatalogRepository,
} from '../../src/main/infrastructure/sqlite/catalog-repository';
import { LibraryScanner } from '../../src/main/services/library-scan/library-scanner';
import type { MediaProbe, ScannedFile } from '../../src/main/services/library-scan/models';
import { toScanProgress } from '../../src/renderer/bridge';

const temporaryRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-catalog-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop()!;
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(target).startsWith('photo-map-catalog-')).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

function scannedFile(
  absolutePath: string,
  relativePath: string,
  contentSha256: string | null,
  fileSize = 10,
  modifiedAtMs = 1,
  fileCreatedAtMs = 2,
): ScannedFile {
  return {
    absolutePath,
    relativePath,
    canonicalPathKey: canonicalPathKey(absolutePath),
    fileSize,
    modifiedAtMs,
    fileCreatedAtMs,
    contentSha256,
    mediaKind: 'photo',
    mediaFormat: 'jpg',
    pixelWidth: contentSha256 === null ? null : 2,
    pixelHeight: contentSha256 === null ? null : 3,
    decodeState: contentSha256 === null ? 'unreadable' : 'valid',
  };
}

function idFactory(ids: string[]): () => string {
  return () => {
    const id = ids.shift();
    if (!id) throw new Error('Test ID fixture exhausted.');
    return id;
  };
}

describe('active source availability', () => {
  it('prd_fr_003__unavailable_source_root_is_valid_again__mark_available__persists_recovery_idempotently', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-29T00:00:00.000Z',
      createId: idFactory(['source-availability']),
    });
    repository.activateSource(libraryRoot);
    repository.markActiveSourceUnavailable();
    expect(repository.getActiveSource()?.availability).toBe('unavailable');

    repository.markActiveSourceAvailable();
    expect(repository.getActiveSource()?.availability).toBe('available');
    const recoveredRevision = repository.getLibrarySnapshot().catalogRevision;

    repository.markActiveSourceAvailable();
    expect(repository.getLibrarySnapshot().catalogRevision).toBe(recoveredRevision);
    repository.close();
  });
});

describe('TDD-CONTRACT-SCAN-001 SQLite identity and restart persistence', () => {
  it('library_snapshot__projects_relative_paths_to_root_or_at_most_two_folder_levels', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      createId: (() => {
        const ids = ['source-folder', 'photo-root', 'photo-one', 'photo-two', 'photo-deep', 'run-folder'];
        return () => ids.shift() ?? 'extra-id';
      })(),
    });
    const source = repository.activateSource(libraryRoot);
    const runId = repository.startScanRun(source.sourceId);
    repository.reconcileScan(source.sourceId, runId, [
      scannedFile(path.join(libraryRoot, 'root.jpg'), 'root.jpg', 'hash-root'),
      scannedFile(path.join(libraryRoot, '旅行', 'one.jpg'), path.join('旅行', 'one.jpg'), 'hash-one'),
      scannedFile(path.join(libraryRoot, '旅行', '武汉', 'two.jpg'), path.join('旅行', '武汉', 'two.jpg'), 'hash-two'),
      scannedFile(path.join(libraryRoot, '旅行', '武汉', '东湖', 'deep.jpg'), path.join('旅行', '武汉', '东湖', 'deep.jpg'), 'hash-deep'),
    ], true);

    const foldersByName = new Map(repository.getLibrarySnapshot().photos.map((photo) => [
      photo.fileName,
      photo.folderPath,
    ]));

    expect(foldersByName).toEqual(new Map([
      ['root.jpg', null],
      ['one.jpg', '旅行'],
      ['two.jpg', '旅行/武汉'],
      ['deep.jpg', '旅行/武汉'],
    ]));
    repository.close();
  });

  it('prd_ac_002__unique_rename_then_copy_then_delete__reconciles__preserves_original_tags_keeps_copy_independent_and_marks_missing', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const originalPath = path.join(libraryRoot, 'original.jpg');
    const renamedPath = path.join(libraryRoot, 'renamed.jpg');
    const copyPath = path.join(libraryRoot, 'copy.jpg');
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-23T00:00:00.000Z',
      createId: idFactory([
        'source-1',
        'run-initial',
        'photo-original',
        'run-rename',
        'run-copy',
        'photo-copy',
        'run-delete',
      ]),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(originalPath, 'original.jpg', 'content-hash'),
    ], true);
    repository.updateLocations(
      ['photo-original'],
      { provinceGb: '156420000', cityGb: '156420100' },
      'user_action',
    );
    repository.updateTypes({
      photoIds: ['photo-original'],
      addTypeIds: ['builtin-landscape'],
      removeTypeIds: [],
    });
    repository.updateNote('photo-original', '沿途的风景仍然清晰。');

    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(renamedPath, 'renamed.jpg', 'content-hash'),
    ], true);
    const afterRename = repository.getLibrarySnapshot();
    expect(afterRename.photos).toHaveLength(1);
    expect(afterRename.photos[0]).toEqual(expect.objectContaining({
      photoId: 'photo-original',
      fileName: 'renamed.jpg',
      fileCreatedAtMs: 2,
      location: { provinceGb: '156420000', cityGb: '156420100' },
      note: '沿途的风景仍然清晰。',
    }));
    expect(afterRename.photos[0]?.typeIds).toContain('builtin-landscape');

    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(renamedPath, 'renamed.jpg', 'content-hash'),
      scannedFile(copyPath, 'copy.jpg', 'content-hash'),
    ], true);
    const afterCopy = repository.getLibrarySnapshot();
    const original = afterCopy.photos.find(({ photoId }) => photoId === 'photo-original');
    const copy = afterCopy.photos.find(({ fileName }) => fileName === 'copy.jpg');
    expect(afterCopy.photos).toHaveLength(2);
    expect(copy?.photoId).toBe('photo-copy');
    expect(copy?.photoId).not.toBe(original?.photoId);
    expect(copy?.location).toBeNull();
    expect(copy?.typeIds).toEqual([]);
    expect(copy?.note).toBe('');

    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(copyPath, 'copy.jpg', 'content-hash'),
    ], true);
    const facts = repository.getExistingPhotoFacts(source.sourceId);
    expect(facts.find(({ photoId }) => photoId === 'photo-original')?.lifecycleState).toBe('missing');
    expect(facts.find(({ photoId }) => photoId === 'photo-copy')?.lifecycleState).toBe('active');
    repository.close();
  });

  it('prd_fr_005__same_content_at_two_paths__reopens_sqlite__keeps_distinct_ids_and_manual_tags', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const firstPath = path.join(libraryRoot, 'first.jpg');
    const secondPath = path.join(libraryRoot, 'second.jpg');
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-23T00:00:00.000Z',
      createId: idFactory(['source-1', 'run-1', 'photo-1', 'photo-2']),
    });
    const source = repository.activateSource(libraryRoot);
    const runId = repository.startScanRun(source.sourceId);
    repository.reconcileScan(source.sourceId, runId, [
      scannedFile(firstPath, 'first.jpg', 'same-content-hash'),
      scannedFile(secondPath, 'second.jpg', 'same-content-hash'),
    ], true);
    const before = repository.getLibrarySnapshot();
    const first = before.photos.find(({ fileName }) => fileName === 'first.jpg');
    const second = before.photos.find(({ fileName }) => fileName === 'second.jpg');
    expect(first?.photoId).toBeTruthy();
    expect(second?.photoId).toBeTruthy();
    expect(first?.photoId).not.toBe(second?.photoId);
    expect(() => repository.updateLocations(
      [first!.photoId],
      { provinceGb: '156310000' },
      'scanner' as 'user_action',
    )).toThrow('地点只能由用户手动标注');

    repository.updateLocations([first!.photoId], {
      provinceGb: '156420000',
      cityGb: '156420100',
    }, 'user_action');
    repository.updateTypes({
      photoIds: [first!.photoId],
      addTypeIds: ['builtin-landscape'],
      removeTypeIds: [],
    });
    const noteResult = repository.updateNote(first!.photoId, '第一次抵达武汉。');
    expect(noteResult).toEqual(expect.objectContaining({ succeeded: 1, skipped: 0, failed: 0 }));
    const skippedNoteResult = repository.updateNote('unknown-photo', '不会写入');
    expect(skippedNoteResult).toEqual(expect.objectContaining({ succeeded: 0, skipped: 1, failed: 0 }));
    repository.close();

    const reopened = await NodeSqliteCatalogRepository.open(databasePath);
    const after = reopened.getLibrarySnapshot();
    const reopenedFirst = after.photos.find(({ fileName }) => fileName === 'first.jpg');
    const reopenedSecond = after.photos.find(({ fileName }) => fileName === 'second.jpg');
    expect(after.photos).toHaveLength(2);
    expect(reopenedFirst?.photoId).toBe(first?.photoId);
    expect(reopenedSecond?.photoId).toBe(second?.photoId);
    expect(reopenedFirst?.location).toEqual({
      provinceGb: '156420000',
      cityGb: '156420100',
    });
    expect(reopenedFirst?.typeIds).toContain('builtin-landscape');
    expect(reopenedFirst?.note).toBe('第一次抵达武汉。');
    expect(reopenedSecond?.location).toBeNull();
    expect(reopenedSecond?.note).toBe('');
    reopened.close();
  });

  it('prd_fr_005__same_path_hash_is_null_and_file_facts_change__reconciles__creates_new_id_without_old_tags', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const absolutePath = path.join(libraryRoot, 'unreadable.jpg');
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-23T00:00:00.000Z',
      createId: idFactory(['source-1', 'run-1', 'photo-old', 'run-2', 'photo-new']),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(absolutePath, 'unreadable.jpg', null, 10, 1),
    ], true);
    repository.updateLocations(['photo-old'], { provinceGb: '156420000' }, 'user_action');

    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(absolutePath, 'unreadable.jpg', null, 20, 2),
    ], true);
    const snapshot = repository.getLibrarySnapshot();

    expect(snapshot.photos).toHaveLength(1);
    expect(snapshot.photos[0]?.photoId).toBe('photo-new');
    expect(snapshot.photos[0]?.location).toBeNull();
    repository.close();
  });
});

describe('Capture time repository updates', () => {
  it('update_capture_time__active_photo__stores_user_source_and_clears_metadata_offset', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-31T00:00:00.000Z',
      createId: idFactory(['source-capture', 'run-capture', 'photo-capture']),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(path.join(libraryRoot, 'capture.jpg'), 'capture.jpg', 'hash-capture'),
    ], true);
    const revisionBefore = repository.getLibrarySnapshot().catalogRevision;

    const result = repository.updateCaptureTime('photo-capture', '2026-06-17T15:44:34');

    expect(result).toEqual(expect.objectContaining({ succeeded: 1, skipped: 0, failed: 0 }));
    expect(result.library.catalogRevision).toBe(revisionBefore + 1);
    expect(result.library.photos[0]?.captureTime).toEqual({
      localDateTime: '2026-06-17T15:44:34',
      offsetMinutes: null,
      source: 'user',
    });
    repository.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const storedCaptureTime = database.prepare(
      `SELECT capture_time_local, capture_time_offset_minutes, capture_time_source
       FROM photo WHERE photo_id = 'photo-capture'`,
    ).get();
    database.close();
    expect(storedCaptureTime).toEqual({
      capture_time_local: '2026-06-17T15:44:34',
      capture_time_offset_minutes: null,
      capture_time_source: 'user',
    });
  });
});

describe('software-initiated photo path rename persistence', () => {
  it('updates_all_primary_path_columns_in_one_revision_and_preserves_identity_and_metadata', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    const nested = path.join(libraryRoot, 'nested');
    await mkdir(nested, { recursive: true });
    const originalPath = path.join(nested, 'original.jpg');
    const renamedPath = path.join(nested, '武汉之行.jpg');
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-31T00:00:00.000Z',
      createId: idFactory(['source-rename', 'run-rename', 'photo-rename']),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(originalPath, path.join('nested', 'original.jpg'), 'rename-content-hash', 32, 11, 7),
    ], true);
    repository.updateLocations(
      ['photo-rename'],
      { provinceGb: '156420000', cityGb: '156420100' },
      'user_action',
    );
    repository.updateTypes({
      photoIds: ['photo-rename'],
      addTypeIds: ['builtin-landscape'],
      removeTypeIds: [],
    });
    repository.updateNote('photo-rename', '沿江而行。');
    const before = repository.getLibrarySnapshot();

    const updated = repository.updatePhotoPathsAfterRename(
      'photo-rename',
      originalPath,
      renamedPath,
      null,
      null,
    );

    expect(updated).toBe(true);
    const after = repository.getLibrarySnapshot();
    expect(after.catalogRevision).toBe(before.catalogRevision + 1);
    expect(after.photos).toHaveLength(1);
    expect(after.photos[0]).toEqual(expect.objectContaining({
      photoId: 'photo-rename',
      fileName: '武汉之行.jpg',
      fileCreatedAtMs: 7,
      location: { provinceGb: '156420000', cityGb: '156420100' },
      typeIds: expect.arrayContaining(['builtin-landscape']),
      note: '沿江而行。',
    }));
    expect(repository.getPhotoFileRecords(['photo-rename'])[0]).toEqual(expect.objectContaining({
      photoId: 'photo-rename',
      absolutePath: renamedPath,
      fileSize: 32,
      modifiedAtMs: 11,
    }));
    repository.close();

    const database = new DatabaseSync(databasePath);
    try {
      const row = database.prepare(
        'SELECT display_path, relative_path, canonical_path_key FROM photo WHERE photo_id = ?',
      ).get('photo-rename') as Record<string, unknown>;
      expect(row).toEqual(expect.objectContaining({
        display_path: renamedPath,
        relative_path: path.join('nested', '武汉之行.jpg'),
        canonical_path_key: canonicalPathKey(renamedPath),
      }));
    } finally {
      database.close();
    }
  });

  it('rejects_a_stale_expected_source_path_without_changing_paths_or_revision', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const originalPath = path.join(libraryRoot, 'original.jpg');
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-31T00:00:00.000Z',
      createId: idFactory(['source-stale', 'run-stale', 'photo-stale']),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(originalPath, 'original.jpg', 'stale-content-hash'),
    ], true);
    repository.updateNote('photo-stale', '必须保留。');
    const before = repository.getLibrarySnapshot();

    const updated = repository.updatePhotoPathsAfterRename(
      'photo-stale',
      path.join(libraryRoot, 'stale-expected.jpg'),
      path.join(libraryRoot, 'renamed.jpg'),
      null,
      null,
    );

    expect(updated).toBe(false);
    const after = repository.getLibrarySnapshot();
    expect(after.catalogRevision).toBe(before.catalogRevision);
    expect(after.photos[0]).toEqual(expect.objectContaining({
      photoId: 'photo-stale',
      fileName: 'original.jpg',
      note: '必须保留。',
    }));
    expect(repository.getPhotoFileRecords(['photo-stale'])[0]?.absolutePath).toBe(originalPath);
    repository.close();
  });

  it('updates_primary_and_live_companion_paths_transactionally_in_one_revision', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const stillPath = path.join(libraryRoot, 'IMG_0001.jpg');
    const motionPath = path.join(libraryRoot, 'IMG_0001.mov');
    const renamedStillPath = path.join(libraryRoot, '海边.jpg');
    const renamedMotionPath = path.join(libraryRoot, '海边.mov');
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-31T00:00:00.000Z',
      createId: idFactory(['source-live-rename', 'run-live-rename', 'photo-live-rename']),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [{
      ...scannedFile(stillPath, 'IMG_0001.jpg', 'live-still-hash', 31, 10, 6),
      mediaKind: 'live',
      companion: {
        absolutePath: motionPath,
        relativePath: 'IMG_0001.mov',
        canonicalPathKey: canonicalPathKey(motionPath),
        fileSize: 47,
        modifiedAtMs: 12,
        fileCreatedAtMs: 7,
        contentSha256: 'live-motion-hash',
        mediaFormat: 'mov',
      },
    }], true);
    const beforeRevision = repository.getLibrarySnapshot().catalogRevision;

    expect(repository.updatePhotoPathsAfterRename(
      'photo-live-rename',
      stillPath,
      renamedStillPath,
      motionPath,
      renamedMotionPath,
    )).toBe(true);

    expect(repository.getLibrarySnapshot().catalogRevision).toBe(beforeRevision + 1);
    expect(repository.getPhotoFileRecords(['photo-live-rename'])[0]).toEqual(expect.objectContaining({
      absolutePath: renamedStillPath,
      companionAbsolutePath: renamedMotionPath,
      companionFileSize: 47,
      companionModifiedAtMs: 12,
    }));
    repository.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare(
        'SELECT display_path, relative_path, canonical_path_key FROM photo WHERE photo_id = ?',
      ).get('photo-live-rename')).toEqual(expect.objectContaining({
        display_path: renamedStillPath,
        relative_path: '海边.jpg',
        canonical_path_key: canonicalPathKey(renamedStillPath),
      }));
      expect(database.prepare(
        'SELECT display_path, relative_path, canonical_path_key FROM photo_companion WHERE photo_id = ?',
      ).get('photo-live-rename')).toEqual(expect.objectContaining({
        display_path: renamedMotionPath,
        relative_path: '海边.mov',
        canonical_path_key: canonicalPathKey(renamedMotionPath),
      }));
    } finally {
      database.close();
    }
  });

  it('rolls_back_the_primary_path_and_revision_when_the_live_companion_update_fails', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const stillPath = path.join(libraryRoot, 'IMG_0002.jpg');
    const motionPath = path.join(libraryRoot, 'IMG_0002.mov');
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-31T00:00:00.000Z',
      createId: idFactory(['source-live-rollback', 'run-live-rollback', 'photo-live-rollback']),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [{
      ...scannedFile(stillPath, 'IMG_0002.jpg', 'live-still-hash'),
      mediaKind: 'live',
      companion: {
        absolutePath: motionPath,
        relativePath: 'IMG_0002.mov',
        canonicalPathKey: canonicalPathKey(motionPath),
        fileSize: 20,
        modifiedAtMs: 2,
        fileCreatedAtMs: 3,
        contentSha256: 'live-motion-hash',
        mediaFormat: 'mov',
      },
    }], true);
    const beforeRevision = repository.getLibrarySnapshot().catalogRevision;
    const triggerDatabase = new DatabaseSync(databasePath);
    try {
      triggerDatabase.exec(`
        CREATE TRIGGER fail_live_companion_rename
        BEFORE UPDATE OF display_path ON photo_companion
        BEGIN
          SELECT RAISE(ABORT, 'synthetic companion update failure');
        END;
      `);
    } finally {
      triggerDatabase.close();
    }

    expect(() => repository.updatePhotoPathsAfterRename(
      'photo-live-rollback',
      stillPath,
      path.join(libraryRoot, 'renamed.jpg'),
      motionPath,
      path.join(libraryRoot, 'renamed.mov'),
    )).toThrow('无法保存本地索引，本次更改已撤销。');

    expect(repository.getLibrarySnapshot().catalogRevision).toBe(beforeRevision);
    expect(repository.getPhotoFileRecords(['photo-live-rollback'])[0]).toEqual(expect.objectContaining({
      absolutePath: stillPath,
      companionAbsolutePath: motionPath,
    }));
    repository.close();
  });
});

describe('Suggested photo locations repository updates', () => {
  it('apply_suggested_metadata__fill_only__applies_gps_and_time_once_and_preserves_existing_and_user_times', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-31T00:00:00.000Z',
      createId: idFactory([
        'source-fill-metadata',
        'run-fill-metadata',
        'photo-empty',
        'photo-existing',
        'photo-user',
      ]),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(path.join(libraryRoot, 'empty.jpg'), 'empty.jpg', 'hash-empty'),
      scannedFile(path.join(libraryRoot, 'existing.jpg'), 'existing.jpg', 'hash-existing'),
      scannedFile(path.join(libraryRoot, 'user.jpg'), 'user.jpg', 'hash-user'),
    ], true);
    repository.applySuggestedMetadata(
      source.sourceId,
      [{ photoId: 'photo-existing', location: { provinceGb: '156110000' } }],
      [{
        photoId: 'photo-existing',
        captureTime: { localDateTime: '2024-01-02T03:04:05', offsetMinutes: 60 },
      }],
      'overwrite-all-resolved',
    );
    repository.updateCaptureTime('photo-user', '2023-02-03T04:05:06');
    const revisionBefore = repository.getLibrarySnapshot().catalogRevision;

    const result = repository.applySuggestedMetadata(
      source.sourceId,
      [
        { photoId: 'photo-empty', location: { provinceGb: '156420000', cityGb: '156420100' } },
        { photoId: 'photo-existing', location: { provinceGb: '156310000' } },
        { photoId: 'photo-user', location: { provinceGb: '156440000', cityGb: '156440100' } },
      ],
      [
        {
          photoId: 'photo-empty',
          captureTime: { localDateTime: '2026-06-17T15:44:34', offsetMinutes: 480 },
        },
        {
          photoId: 'photo-existing',
          captureTime: { localDateTime: '2025-05-06T07:08:09', offsetMinutes: 480 },
        },
        {
          photoId: 'photo-user',
          captureTime: { localDateTime: '2025-06-07T08:09:10', offsetMinutes: 480 },
        },
      ],
      'fill-unlabeled-only',
    );

    expect(result).toEqual(expect.objectContaining({
      succeeded: 2,
      skipped: 1,
      failed: 0,
      locations: { succeeded: 2, skipped: 1, failed: 0 },
      captureTimes: { succeeded: 1, skipped: 2, failed: 0 },
    }));
    expect(result.library.catalogRevision).toBe(revisionBefore + 1);
    const photos = new Map(result.library.photos.map((photo) => [photo.photoId, photo]));
    expect(photos.get('photo-empty')).toEqual(expect.objectContaining({
      location: { provinceGb: '156420000', cityGb: '156420100' },
      captureTime: {
        localDateTime: '2026-06-17T15:44:34',
        offsetMinutes: 480,
        source: 'metadata',
      },
    }));
    expect(photos.get('photo-existing')).toEqual(expect.objectContaining({
      location: { provinceGb: '156110000' },
      captureTime: {
        localDateTime: '2024-01-02T03:04:05',
        offsetMinutes: 60,
        source: 'metadata',
      },
    }));
    expect(photos.get('photo-user')).toEqual(expect.objectContaining({
      location: { provinceGb: '156440000', cityGb: '156440100' },
      captureTime: {
        localDateTime: '2023-02-03T04:05:06',
        offsetMinutes: null,
        source: 'user',
      },
    }));
    repository.close();
  });

  it('apply_suggested_metadata__overwrite__replaces_gps_and_metadata_time_but_never_user_time', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-31T00:00:00.000Z',
      createId: idFactory([
        'source-overwrite-metadata',
        'run-overwrite-metadata',
        'photo-metadata',
        'photo-user',
      ]),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(path.join(libraryRoot, 'metadata.jpg'), 'metadata.jpg', 'hash-metadata'),
      scannedFile(path.join(libraryRoot, 'user.jpg'), 'user.jpg', 'hash-user'),
    ], true);
    repository.applySuggestedMetadata(
      source.sourceId,
      [
        { photoId: 'photo-metadata', location: { provinceGb: '156110000' } },
        { photoId: 'photo-user', location: { provinceGb: '156120000' } },
      ],
      [{
        photoId: 'photo-metadata',
        captureTime: { localDateTime: '2024-01-02T03:04:05', offsetMinutes: 60 },
      }],
      'overwrite-all-resolved',
    );
    repository.updateCaptureTime('photo-user', '2023-02-03T04:05:06');
    const revisionBefore = repository.getLibrarySnapshot().catalogRevision;

    const result = repository.applySuggestedMetadata(
      source.sourceId,
      [
        { photoId: 'photo-metadata', location: { provinceGb: '156420000', cityGb: '156420100' } },
        { photoId: 'photo-user', location: { provinceGb: '156440000', cityGb: '156440100' } },
      ],
      [
        {
          photoId: 'photo-metadata',
          captureTime: { localDateTime: '2026-06-17T15:44:34', offsetMinutes: 480 },
        },
        {
          photoId: 'photo-user',
          captureTime: { localDateTime: '2025-06-07T08:09:10', offsetMinutes: 480 },
        },
      ],
      'overwrite-all-resolved',
    );

    expect(result).toEqual(expect.objectContaining({
      succeeded: 2,
      skipped: 0,
      failed: 0,
      locations: { succeeded: 2, skipped: 0, failed: 0 },
      captureTimes: { succeeded: 1, skipped: 1, failed: 0 },
    }));
    expect(result.library.catalogRevision).toBe(revisionBefore + 1);
    const photos = new Map(result.library.photos.map((photo) => [photo.photoId, photo]));
    expect(photos.get('photo-metadata')).toEqual(expect.objectContaining({
      location: { provinceGb: '156420000', cityGb: '156420100' },
      captureTime: {
        localDateTime: '2026-06-17T15:44:34',
        offsetMinutes: 480,
        source: 'metadata',
      },
    }));
    expect(photos.get('photo-user')).toEqual(expect.objectContaining({
      location: { provinceGb: '156440000', cityGb: '156440100' },
      captureTime: {
        localDateTime: '2023-02-03T04:05:06',
        offsetMinutes: null,
        source: 'user',
      },
    }));
    repository.close();
  });

  it('applies_distinct_locations_overwrites_manual_tags_and_preserves_unlisted_tags_in_one_revision', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-27T00:00:00.000Z',
      createId: idFactory(['source-1', 'run-1', 'photo-1', 'photo-2', 'photo-3']),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(path.join(libraryRoot, 'a.jpg'), 'a.jpg', 'hash-a'),
      scannedFile(path.join(libraryRoot, 'b.jpg'), 'b.jpg', 'hash-b'),
      scannedFile(path.join(libraryRoot, 'c.jpg'), 'c.jpg', 'hash-c'),
    ], true);
    repository.updateLocations(
      ['photo-1'],
      { provinceGb: '156110000' },
      'user_action',
    );
    repository.updateLocations(
      ['photo-3'],
      { provinceGb: '156440000', cityGb: '156440100' },
      'user_action',
    );
    const revisionBefore = repository.getLibrarySnapshot().catalogRevision;

    const result = repository.applySuggestedMetadata(source.sourceId, [
      {
        photoId: 'photo-1',
        location: { provinceGb: '156310000' },
      },
      {
        photoId: 'photo-2',
        location: { provinceGb: '156420000', cityGb: '156420100' },
      },
    ], [], 'overwrite-all-resolved');

    expect(result).toEqual(expect.objectContaining({
      succeeded: 2,
      skipped: 0,
      failed: 0,
    }));
    expect(result.library.catalogRevision).toBe(revisionBefore + 1);
    expect(result.library.photos.find(({ photoId }) => photoId === 'photo-1')?.location).toEqual({
      provinceGb: '156310000',
    });
    expect(result.library.photos.find(({ photoId }) => photoId === 'photo-2')?.location).toEqual({
      provinceGb: '156420000',
      cityGb: '156420100',
    });
    expect(result.library.photos.find(({ photoId }) => photoId === 'photo-3')?.location).toEqual({
      provinceGb: '156440000',
      cityGb: '156440100',
    });
    repository.close();
  });

  it('fill_unlabeled_only_checks_current_photo_place_rows_and_preserves_every_existing_tag', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-29T00:00:00.000Z',
      createId: idFactory(['source-fill', 'run-fill', 'photo-province', 'photo-city', 'photo-empty']),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(path.join(libraryRoot, 'province.jpg'), 'province.jpg', 'hash-province'),
      scannedFile(path.join(libraryRoot, 'city.jpg'), 'city.jpg', 'hash-city'),
      scannedFile(path.join(libraryRoot, 'empty.jpg'), 'empty.jpg', 'hash-empty'),
    ], true);
    const proposal = [
      {
        photoId: 'photo-province',
        location: { provinceGb: '156310000', cityGb: '156310100' },
      },
      {
        photoId: 'photo-city',
        location: { provinceGb: '156420000', cityGb: '156420100' },
      },
      {
        photoId: 'photo-empty',
        location: { provinceGb: '156440000', cityGb: '156440100' },
      },
    ];

    // These labels are written after the GPS proposal exists. Eligibility must use current DB state.
    repository.updateLocations(
      ['photo-province'],
      { provinceGb: '156110000' },
      'user_action',
    );
    repository.updateLocations(
      ['photo-city'],
      { provinceGb: '156120000', cityGb: '156120100' },
      'user_action',
    );
    const revisionBeforeDecision = repository.getLibrarySnapshot().catalogRevision;

    const result = repository.applySuggestedMetadata(
      source.sourceId,
      proposal,
      [],
      'fill-unlabeled-only',
    );

    expect(result).toEqual(expect.objectContaining({
      succeeded: 1,
      skipped: 2,
      failed: 0,
    }));
    expect(result.library.catalogRevision).toBe(revisionBeforeDecision + 1);
    expect(result.library.photos.find(({ photoId }) => photoId === 'photo-province')?.location)
      .toEqual({ provinceGb: '156110000' });
    expect(result.library.photos.find(({ photoId }) => photoId === 'photo-city')?.location)
      .toEqual({ provinceGb: '156120000', cityGb: '156120100' });
    expect(result.library.photos.find(({ photoId }) => photoId === 'photo-empty')?.location)
      .toEqual({ provinceGb: '156440000', cityGb: '156440100' });
    repository.close();
  });

  it('skips_unknown_inactive_and_wrong_source_photos_without_changing_their_tags', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const firstRoot = path.join(fixture, 'first-library');
    const secondRoot = path.join(fixture, 'second-library');
    await Promise.all([mkdir(firstRoot, { recursive: true }), mkdir(secondRoot, { recursive: true })]);
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-27T00:00:00.000Z',
      createId: idFactory([
        'source-first',
        'run-first',
        'photo-wrong-source',
        'source-second',
        'run-second-initial',
        'photo-active',
        'photo-missing',
        'run-second-refresh',
      ]),
    });
    const firstSource = repository.activateSource(firstRoot);
    repository.reconcileScan(firstSource.sourceId, repository.startScanRun(firstSource.sourceId), [
      scannedFile(path.join(firstRoot, 'wrong.jpg'), 'wrong.jpg', 'hash-wrong'),
    ], true);
    repository.updateLocations(
      ['photo-wrong-source'],
      { provinceGb: '156110000' },
      'user_action',
    );

    const secondSource = repository.activateSource(secondRoot);
    const activeFile = scannedFile(path.join(secondRoot, 'active.jpg'), 'active.jpg', 'hash-active');
    repository.reconcileScan(
      secondSource.sourceId,
      repository.startScanRun(secondSource.sourceId),
      [
        activeFile,
        scannedFile(path.join(secondRoot, 'missing.jpg'), 'missing.jpg', 'hash-missing'),
      ],
      true,
    );
    repository.updateLocations(
      ['photo-missing'],
      { provinceGb: '156120000' },
      'user_action',
    );
    repository.reconcileScan(
      secondSource.sourceId,
      repository.startScanRun(secondSource.sourceId),
      [activeFile],
      true,
    );
    const revisionBefore = repository.getLibrarySnapshot().catalogRevision;

    const result = repository.applySuggestedMetadata(secondSource.sourceId, [
      { photoId: 'photo-active', location: { provinceGb: '156420000' } },
      { photoId: 'photo-wrong-source', location: { provinceGb: '156310000' } },
      { photoId: 'photo-missing', location: { provinceGb: '156310000' } },
      { photoId: 'photo-unknown', location: { provinceGb: '156310000' } },
    ], [], 'overwrite-all-resolved');

    expect(result).toEqual(expect.objectContaining({
      succeeded: 1,
      skipped: 3,
      failed: 0,
    }));
    expect(result.library.catalogRevision).toBe(revisionBefore + 1);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const storedPlaces = database
      .prepare(
        `SELECT photo_id, province_gb FROM photo_place
         WHERE photo_id IN ('photo-active', 'photo-wrong-source', 'photo-missing', 'photo-unknown')
         ORDER BY photo_id`
      )
      .all();
    database.close();
    expect(storedPlaces).toEqual([
      { photo_id: 'photo-active', province_gb: '156420000' },
      { photo_id: 'photo-missing', province_gb: '156120000' },
      { photo_id: 'photo-wrong-source', province_gb: '156110000' },
    ]);

    const inactiveSourceResult = repository.applySuggestedMetadata(firstSource.sourceId, [
      { photoId: 'photo-active', location: { provinceGb: '156310000' } },
    ], [], 'overwrite-all-resolved');
    expect(inactiveSourceResult).toEqual(expect.objectContaining({
      succeeded: 0,
      skipped: 1,
      failed: 0,
    }));
    expect(inactiveSourceResult.library.catalogRevision).toBe(result.library.catalogRevision);
    expect(
      inactiveSourceResult.library.photos.find(({ photoId }) => photoId === 'photo-active')?.location,
    ).toEqual({ provinceGb: '156420000' });
    repository.close();
  });

  it('treats_empty_input_as_a_noop_uses_last_duplicate_and_rolls_back_the_whole_batch_on_failure', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-27T00:00:00.000Z',
      createId: idFactory(['source-1', 'run-1', 'photo-1', 'photo-2']),
    });
    const source = repository.activateSource(libraryRoot);
    repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [
      scannedFile(path.join(libraryRoot, 'a.jpg'), 'a.jpg', 'hash-a'),
      scannedFile(path.join(libraryRoot, 'b.jpg'), 'b.jpg', 'hash-b'),
    ], true);
    repository.updateLocations(
      ['photo-2'],
      { provinceGb: '156440000', cityGb: '156440100' },
      'user_action',
    );
    const revisionBeforeEmpty = repository.getLibrarySnapshot().catalogRevision;

    const emptyResult = repository.applySuggestedMetadata(
      source.sourceId,
      [],
      [],
      'overwrite-all-resolved',
    );

    expect(emptyResult).toEqual(expect.objectContaining({ succeeded: 0, skipped: 0, failed: 0 }));
    expect(emptyResult.library.catalogRevision).toBe(revisionBeforeEmpty);
    expect(emptyResult.library.photos.find(({ photoId }) => photoId === 'photo-2')?.location)
      .toEqual({ provinceGb: '156440000', cityGb: '156440100' });

    const duplicateResult = repository.applySuggestedMetadata(source.sourceId, [
      { photoId: 'photo-1', location: { provinceGb: '156110000' } },
      {
        photoId: 'photo-1',
        location: { provinceGb: '156420000', cityGb: '156420100' },
      },
    ], [], 'overwrite-all-resolved');
    expect(duplicateResult).toEqual(expect.objectContaining({
      succeeded: 1,
      skipped: 0,
      failed: 0,
    }));
    expect(duplicateResult.library.catalogRevision).toBe(revisionBeforeEmpty + 1);
    expect(duplicateResult.library.photos.find(({ photoId }) => photoId === 'photo-1')?.location)
      .toEqual({ provinceGb: '156420000', cityGb: '156420100' });
    const beforeFailedBatch = repository.getLibrarySnapshot();

    let batchError: unknown;
    try {
      repository.applySuggestedMetadata(source.sourceId, [
        { photoId: 'photo-1', location: { provinceGb: '156310000' } },
        { photoId: 'photo-2', location: { provinceGb: null as unknown as string } },
      ], [], 'overwrite-all-resolved');
    } catch (error) {
      batchError = error;
    }

    expect(batchError).toMatchObject({ code: 'INDEX_WRITE_FAILED' });
    const afterFailedBatch = repository.getLibrarySnapshot();
    expect(afterFailedBatch.catalogRevision).toBe(beforeFailedBatch.catalogRevision);
    expect(afterFailedBatch.photos.find(({ photoId }) => photoId === 'photo-1')?.location)
      .toEqual({ provinceGb: '156420000', cityGb: '156420100' });
    expect(afterFailedBatch.photos.find(({ photoId }) => photoId === 'photo-2')?.location)
      .toEqual({ provinceGb: '156440000', cityGb: '156440100' });
    repository.close();
  });
});

describe('PRD-FR-003 scan progress accounting', () => {
  it('prd_fr_003__second_scan_has_no_file_changes__reports_progress__processed_never_exceeds_discovered', async () => {
    const fixture = await fixtureRoot();
    const libraryRoot = path.join(fixture, 'library');
    await mkdir(libraryRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(libraryRoot, 'a.jpg'), Buffer.from('a')),
      writeFile(path.join(libraryRoot, 'b.PNG'), Buffer.from('b')),
    ]);
    const repository = await NodeSqliteCatalogRepository.open(
      path.join(fixture, 'data', 'index.sqlite3'),
    );
    const source = repository.activateSource(libraryRoot);
    const probe = vi.fn(async () => ({ pixelWidth: 2, pixelHeight: 3, decodeState: 'valid' as const }));
    const imageProbe: MediaProbe = { probe };
    const scanner = new LibraryScanner(repository, imageProbe);

    await scanner.scan(source.sourceId, libraryRoot, new AbortController().signal, {
      gpsMetadataPolicy: 'skip',
      onProgress: () => undefined,
    });
    const second = await scanner.scan(
      source.sourceId,
      libraryRoot,
      new AbortController().signal,
      { gpsMetadataPolicy: 'skip', onProgress: () => undefined },
    );
    const rendererProgress = toScanProgress(second.progress);

    expect(second.progress.counts.discovered).toBe(2);
    expect(second.progress.counts.unchanged).toBe(2);
    expect(rendererProgress.processed).toBe(2);
    expect(rendererProgress.succeeded).toBe(2);
    expect(rendererProgress.processed).toBeLessThanOrEqual(rendererProgress.discovered);
    expect(probe).toHaveBeenCalledTimes(2);
    repository.close();
  });
});

describe('TDD-CONTRACT-GPS-001 SQLite schema guard', () => {
  it('prd_nfr_002__catalog_schema_created__reflects_columns__contains_no_gps_exif_or_coordinate_fields', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const repository = await NodeSqliteCatalogRepository.open(databasePath);
    repository.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const versionRow = database.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const schema = database
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY name")
      .all();
    database.close();

    const serializedSchema = JSON.stringify(schema);
    expect(Number(versionRow.user_version)).toBe(5);
    expect(serializedSchema).not.toMatch(/\bgps\b|\bexif\b|\blatitude\b|\blongitude\b/iu);
  });
});

describe('SQLite catalog migrations', () => {
  it('catalog_v1__opens_with_existing_photo__migrates_through_v2_v3_v4_to_v5_without_losing_the_row', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    const photoPath = path.join(libraryRoot, 'existing.jpg');
    await mkdir(libraryRoot, { recursive: true });
    await writeFile(photoPath, Buffer.from('existing-content'));
    const imageProbe: MediaProbe = {
      probe: vi.fn(async () => ({ pixelWidth: 2, pixelHeight: 3, decodeState: 'valid' as const })),
    };
    const current = await NodeSqliteCatalogRepository.open(databasePath);
    const source = current.activateSource(libraryRoot);
    await new LibraryScanner(current, imageProbe).scan(
      source.sourceId,
      libraryRoot,
      new AbortController().signal,
      { gpsMetadataPolicy: 'skip', onProgress: () => undefined },
    );
    const originalPhotoId = current.getLibrarySnapshot().photos[0]!.photoId;
    current.updateLocations(
      [originalPhotoId],
      { provinceGb: '156420000', cityGb: '156420100' },
      'user_action',
    );
    current.updateTypes({
      photoIds: [originalPhotoId],
      addTypeIds: ['builtin-landscape'],
      removeTypeIds: [],
    });
    current.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE photo_companion;
      ALTER TABLE photo DROP COLUMN capture_time_source;
      ALTER TABLE photo DROP COLUMN capture_time_offset_minutes;
      ALTER TABLE photo DROP COLUMN capture_time_local;
      ALTER TABLE photo DROP COLUMN media_kind;
      ALTER TABLE photo DROP COLUMN media_format;
      ALTER TABLE photo DROP COLUMN note;
      ALTER TABLE photo DROP COLUMN file_created_at_ms;
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const repository = await NodeSqliteCatalogRepository.open(databasePath);
    const snapshotBeforeBackfill = repository.getLibrarySnapshot();
    await new LibraryScanner(repository, imageProbe).scan(
      source.sourceId,
      libraryRoot,
      new AbortController().signal,
      { gpsMetadataPolicy: 'skip', onProgress: () => undefined },
    );
    const snapshotAfterBackfill = repository.getLibrarySnapshot();
    const expectedFileCreatedAtMs = (await lstat(photoPath)).birthtimeMs;
    repository.close();

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    const versionRow = migrated.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const columns = migrated.prepare('PRAGMA table_info(photo)').all() as Record<string, unknown>[];
    const existing = migrated.prepare(
      `SELECT photo_id, file_created_at_ms, note,
              capture_time_local, capture_time_offset_minutes, capture_time_source
       FROM photo`,
    ).get() as Record<string, unknown>;
    migrated.close();

    const backupRoot = path.join(fixture, 'data', 'backups');
    const backupDirectories = (await readdir(backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    expect(backupDirectories).toHaveLength(4);
    const v1ToV2Backup = backupDirectories.find((entry) => /^schema-v1-to-v2-/u.test(entry.name));
    const v2ToV3Backup = backupDirectories.find((entry) => /^schema-v2-to-v3-/u.test(entry.name));
    const v3ToV4Backup = backupDirectories.find((entry) => /^schema-v3-to-v4-/u.test(entry.name));
    const v4ToV5Backup = backupDirectories.find((entry) => /^schema-v4-to-v5-/u.test(entry.name));
    expect(v1ToV2Backup).toBeDefined();
    expect(v2ToV3Backup).toBeDefined();
    expect(v3ToV4Backup).toBeDefined();
    expect(v4ToV5Backup).toBeDefined();
    const backupPath = path.join(
      backupRoot,
      v1ToV2Backup!.name,
      path.basename(databasePath),
    );
    const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
    const backupVersion = backupDatabase.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const backupColumns = backupDatabase.prepare('PRAGMA table_info(photo)').all() as Record<string, unknown>[];
    const backupPhoto = backupDatabase.prepare('SELECT photo_id FROM photo').get() as Record<string, unknown>;
    backupDatabase.close();
    const v2BackupDatabase = new DatabaseSync(path.join(
      backupRoot,
      v2ToV3Backup!.name,
      path.basename(databasePath),
    ), { readOnly: true });
    const v2BackupVersion = v2BackupDatabase.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const v2BackupColumns = v2BackupDatabase.prepare('PRAGMA table_info(photo)').all() as Record<string, unknown>[];
    v2BackupDatabase.close();

    expect(Number(versionRow.user_version)).toBe(CATALOG_SCHEMA_VERSION);
    expect(columns.map((column) => String(column.name))).toContain('file_created_at_ms');
    expect(columns.map((column) => String(column.name))).toContain('note');
    expect(columns.map((column) => String(column.name))).toEqual(expect.arrayContaining([
      'capture_time_local',
      'capture_time_offset_minutes',
      'capture_time_source',
    ]));
    expect(existing).toEqual({
      photo_id: originalPhotoId,
      file_created_at_ms: expectedFileCreatedAtMs,
      note: '',
      capture_time_local: null,
      capture_time_offset_minutes: null,
      capture_time_source: null,
    });
    expect(snapshotBeforeBackfill.photos[0]).toEqual(expect.objectContaining({
      photoId: originalPhotoId,
      fileName: 'existing.jpg',
      fileCreatedAtMs: null,
      captureTime: null,
      location: { provinceGb: '156420000', cityGb: '156420100' },
      note: '',
    }));
    expect(snapshotBeforeBackfill.photos[0]?.typeIds).toContain('builtin-landscape');
    expect(snapshotAfterBackfill.photos[0]).toEqual(expect.objectContaining({
      photoId: originalPhotoId,
      fileCreatedAtMs: expectedFileCreatedAtMs,
      captureTime: null,
      location: { provinceGb: '156420000', cityGb: '156420100' },
      note: '',
    }));
    expect(snapshotAfterBackfill.photos[0]?.typeIds).toContain('builtin-landscape');
    expect(Number(backupVersion.user_version)).toBe(1);
    expect(backupColumns.map((column) => String(column.name))).not.toContain('file_created_at_ms');
    expect(backupPhoto).toEqual({ photo_id: originalPhotoId });
    expect(Number(v2BackupVersion.user_version)).toBe(2);
    expect(v2BackupColumns.map((column) => String(column.name))).toContain('file_created_at_ms');
    expect(v2BackupColumns.map((column) => String(column.name))).not.toContain('note');
  });

  it('catalog_v2__opens_with_existing_tags__migrates_to_v5_with_an_empty_note_and_verified_backups', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    const photoPath = path.join(libraryRoot, 'existing-v2.jpg');
    await mkdir(libraryRoot, { recursive: true });
    const current = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-29T00:00:00.000Z',
      createId: idFactory(['source-v2', 'run-v2', 'photo-v2']),
    });
    const source = current.activateSource(libraryRoot);
    current.reconcileScan(source.sourceId, current.startScanRun(source.sourceId), [
      scannedFile(photoPath, 'existing-v2.jpg', 'existing-v2-content'),
    ], true);
    current.updateLocations(['photo-v2'], { provinceGb: '156420000' }, 'user_action');
    current.updateTypes({
      photoIds: ['photo-v2'],
      addTypeIds: ['builtin-landscape'],
      removeTypeIds: [],
    });
    current.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE photo_companion;
      ALTER TABLE photo DROP COLUMN capture_time_source;
      ALTER TABLE photo DROP COLUMN capture_time_offset_minutes;
      ALTER TABLE photo DROP COLUMN capture_time_local;
      ALTER TABLE photo DROP COLUMN media_kind;
      ALTER TABLE photo DROP COLUMN media_format;
      ALTER TABLE photo DROP COLUMN note;
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const repository = await NodeSqliteCatalogRepository.open(databasePath);
    const snapshot = repository.getLibrarySnapshot();
    repository.close();

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    const versionRow = migrated.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const columns = migrated.prepare('PRAGMA table_info(photo)').all() as Record<string, unknown>[];
    const photo = migrated.prepare(
      `SELECT photo_id, note, capture_time_local,
              capture_time_offset_minutes, capture_time_source
       FROM photo`,
    ).get();
    const place = migrated.prepare('SELECT photo_id, province_gb FROM photo_place').get();
    const typeLink = migrated.prepare('SELECT photo_id, type_id FROM photo_type_link').get();
    migrated.close();

    const backupRoot = path.join(fixture, 'data', 'backups');
    const backupDirectories = (await readdir(backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    expect(backupDirectories).toHaveLength(3);
    const v2ToV3Backup = backupDirectories.find((entry) => /^schema-v2-to-v3-/u.test(entry.name));
    const v3ToV4Backup = backupDirectories.find((entry) => /^schema-v3-to-v4-/u.test(entry.name));
    const v4ToV5Backup = backupDirectories.find((entry) => /^schema-v4-to-v5-/u.test(entry.name));
    expect(v2ToV3Backup).toBeDefined();
    expect(v3ToV4Backup).toBeDefined();
    expect(v4ToV5Backup).toBeDefined();
    const backupDatabase = new DatabaseSync(path.join(
      backupRoot,
      v2ToV3Backup!.name,
      path.basename(databasePath),
    ), { readOnly: true });
    const backupVersion = backupDatabase.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const backupColumns = backupDatabase.prepare('PRAGMA table_info(photo)').all() as Record<string, unknown>[];
    backupDatabase.close();

    expect(Number(versionRow.user_version)).toBe(CATALOG_SCHEMA_VERSION);
    expect(columns.map((column) => String(column.name))).toContain('note');
    expect(columns.map((column) => String(column.name))).toEqual(expect.arrayContaining([
      'capture_time_local',
      'capture_time_offset_minutes',
      'capture_time_source',
    ]));
    expect(photo).toEqual({
      photo_id: 'photo-v2',
      note: '',
      capture_time_local: null,
      capture_time_offset_minutes: null,
      capture_time_source: null,
    });
    expect(place).toEqual({ photo_id: 'photo-v2', province_gb: '156420000' });
    expect(typeLink).toEqual({ photo_id: 'photo-v2', type_id: 'builtin-landscape' });
    expect(snapshot.photos[0]).toEqual(expect.objectContaining({
      photoId: 'photo-v2',
      note: '',
      captureTime: null,
      location: { provinceGb: '156420000' },
    }));
    expect(snapshot.photos[0]?.typeIds).toContain('builtin-landscape');
    expect(Number(backupVersion.user_version)).toBe(2);
    expect(backupColumns.map((column) => String(column.name))).not.toContain('note');
  });

  it('catalog_v4__opens_with_existing_rows__migrates_to_v5_and_keeps_a_verified_v4_backup', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    const photoPath = path.join(libraryRoot, 'existing-v4.jpg');
    await mkdir(libraryRoot, { recursive: true });
    const current = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-30T00:00:00.000Z',
      createId: idFactory(['source-v4', 'run-v4', 'photo-v4']),
    });
    const source = current.activateSource(libraryRoot);
    current.reconcileScan(source.sourceId, current.startScanRun(source.sourceId), [
      scannedFile(photoPath, 'existing-v4.jpg', 'existing-v4-content'),
    ], true);
    current.updateLocations(
      ['photo-v4'],
      { provinceGb: '156420000', cityGb: '156420100' },
      'user_action',
    );
    current.updateTypes({
      photoIds: ['photo-v4'],
      addTypeIds: ['builtin-landscape'],
      removeTypeIds: [],
    });
    current.updateNote('photo-v4', 'v4 数据必须保留。');
    current.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      ALTER TABLE photo DROP COLUMN capture_time_source;
      ALTER TABLE photo DROP COLUMN capture_time_offset_minutes;
      ALTER TABLE photo DROP COLUMN capture_time_local;
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const repository = await NodeSqliteCatalogRepository.open(databasePath, {
      now: () => '2026-08-31T00:00:00.000Z',
      createId: idFactory(['backup-v4-v5']),
    });
    const snapshot = repository.getLibrarySnapshot();
    repository.close();

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    const versionRow = migrated.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const columns = migrated.prepare('PRAGMA table_info(photo)').all() as Record<string, unknown>[];
    const photo = migrated.prepare(
      `SELECT photo_id, note, capture_time_local,
              capture_time_offset_minutes, capture_time_source
       FROM photo`,
    ).get();
    const place = migrated.prepare(
      'SELECT photo_id, province_gb, city_gb FROM photo_place',
    ).get();
    const typeLink = migrated.prepare('SELECT photo_id, type_id FROM photo_type_link').get();
    migrated.close();

    expect(Number(versionRow.user_version)).toBe(5);
    expect(columns.map((column) => String(column.name))).toEqual(expect.arrayContaining([
      'capture_time_local',
      'capture_time_offset_minutes',
      'capture_time_source',
    ]));
    expect(photo).toEqual({
      photo_id: 'photo-v4',
      note: 'v4 数据必须保留。',
      capture_time_local: null,
      capture_time_offset_minutes: null,
      capture_time_source: null,
    });
    expect(place).toEqual({
      photo_id: 'photo-v4',
      province_gb: '156420000',
      city_gb: '156420100',
    });
    expect(typeLink).toEqual({ photo_id: 'photo-v4', type_id: 'builtin-landscape' });
    expect(snapshot.photos[0]).toEqual(expect.objectContaining({
      photoId: 'photo-v4',
      note: 'v4 数据必须保留。',
      captureTime: null,
      location: { provinceGb: '156420000', cityGb: '156420100' },
    }));
    expect(snapshot.photos[0]?.typeIds).toContain('builtin-landscape');

    const backupRoot = path.join(fixture, 'data', 'backups');
    const backupDirectories = (await readdir(backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    expect(backupDirectories).toHaveLength(1);
    expect(backupDirectories[0]?.name).toMatch(/^schema-v4-to-v5-/u);
    const backupDatabase = new DatabaseSync(path.join(
      backupRoot,
      backupDirectories[0]!.name,
      path.basename(databasePath),
    ), { readOnly: true });
    const backupVersion = backupDatabase.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const backupColumns = backupDatabase.prepare('PRAGMA table_info(photo)').all() as Record<string, unknown>[];
    const backupPhoto = backupDatabase.prepare('SELECT photo_id, note FROM photo').get();
    const backupPlace = backupDatabase.prepare(
      'SELECT photo_id, province_gb, city_gb FROM photo_place',
    ).get();
    const backupTypeLink = backupDatabase.prepare(
      'SELECT photo_id, type_id FROM photo_type_link',
    ).get();
    backupDatabase.close();
    expect(Number(backupVersion.user_version)).toBe(4);
    const backupColumnNames = backupColumns.map((column) => String(column.name));
    expect(backupColumnNames).not.toContain('capture_time_local');
    expect(backupColumnNames).not.toContain('capture_time_offset_minutes');
    expect(backupColumnNames).not.toContain('capture_time_source');
    expect(backupPhoto).toEqual({ photo_id: 'photo-v4', note: 'v4 数据必须保留。' });
    expect(backupPlace).toEqual({
      photo_id: 'photo-v4',
      province_gb: '156420000',
      city_gb: '156420100',
    });
    expect(backupTypeLink).toEqual({ photo_id: 'photo-v4', type_id: 'builtin-landscape' });
  });

  it('catalog_v1__migration_structure_is_invalid__rejects_it_and_keeps_a_verified_backup', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    await mkdir(path.dirname(databasePath), { recursive: true });
    const invalidLegacy = new DatabaseSync(databasePath);
    invalidLegacy.exec(`
      CREATE TABLE sentinel (value TEXT NOT NULL);
      INSERT INTO sentinel (value) VALUES ('preserve-me');
      PRAGMA user_version = 1;
    `);
    invalidLegacy.close();

    await expect(NodeSqliteCatalogRepository.open(databasePath)).rejects.toMatchObject({
      code: 'INDEX_OPEN_FAILED',
    });

    const original = new DatabaseSync(databasePath, { readOnly: true });
    const originalVersion = original.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const sentinel = original.prepare('SELECT value FROM sentinel').get();
    original.close();
    expect(Number(originalVersion.user_version)).toBe(1);
    expect(sentinel).toEqual({ value: 'preserve-me' });

    const backupRoot = path.join(fixture, 'data', 'backups');
    const backupDirectories = (await readdir(backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    expect(backupDirectories).toHaveLength(1);
    const backupPath = path.join(
      backupRoot,
      backupDirectories[0]!.name,
      path.basename(databasePath),
    );
    const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
    const backupVersion = backupDatabase.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const backupSentinel = backupDatabase.prepare('SELECT value FROM sentinel').get();
    backupDatabase.close();
    expect(Number(backupVersion.user_version)).toBe(1);
    expect(backupSentinel).toEqual({ value: 'preserve-me' });
  });

  it('catalog_v1__commit_fails_after_alter__rolls_back_schema_and_preserves_tags_and_backup', async () => {
    const fixture = await fixtureRoot();
    const databasePath = path.join(fixture, 'data', 'index.sqlite3');
    const libraryRoot = path.join(fixture, 'library');
    const photoPath = path.join(libraryRoot, 'tagged.jpg');
    await mkdir(libraryRoot, { recursive: true });
    const current = await NodeSqliteCatalogRepository.open(databasePath);
    const source = current.activateSource(libraryRoot);
    current.reconcileScan(source.sourceId, current.startScanRun(source.sourceId), [
      scannedFile(photoPath, 'tagged.jpg', 'tagged-content'),
    ], true);
    const photoId = current.getLibrarySnapshot().photos[0]!.photoId;
    current.updateLocations([photoId], { provinceGb: '156420000' }, 'user_action');
    current.updateTypes({
      photoIds: [photoId],
      addTypeIds: ['builtin-landscape'],
      removeTypeIds: [],
    });
    current.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      ALTER TABLE photo DROP COLUMN capture_time_source;
      ALTER TABLE photo DROP COLUMN capture_time_offset_minutes;
      ALTER TABLE photo DROP COLUMN capture_time_local;
      ALTER TABLE photo DROP COLUMN note;
      ALTER TABLE photo DROP COLUMN file_created_at_ms;
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const originalExec = DatabaseSync.prototype.exec;
    const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function execWithFailure(
      this: DatabaseSync,
      sql: string,
    ): void {
      if (sql === 'COMMIT') {
        throw new Error('injected commit failure');
      }
      originalExec.call(this, sql);
    });
    try {
      await expect(NodeSqliteCatalogRepository.open(databasePath)).rejects.toMatchObject({
        code: 'INDEX_OPEN_FAILED',
      });
    } finally {
      execSpy.mockRestore();
    }

    const original = new DatabaseSync(databasePath, { readOnly: true });
    const originalVersion = original.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const originalColumns = original.prepare('PRAGMA table_info(photo)').all() as Record<string, unknown>[];
    const originalPhoto = original.prepare('SELECT photo_id FROM photo').get();
    const originalPlace = original.prepare('SELECT photo_id, province_gb FROM photo_place').get();
    const originalTypeLink = original.prepare('SELECT photo_id, type_id FROM photo_type_link').get();
    original.close();
    expect(Number(originalVersion.user_version)).toBe(1);
    expect(originalColumns.map((column) => String(column.name))).not.toContain('file_created_at_ms');
    expect(originalPhoto).toEqual({ photo_id: photoId });
    expect(originalPlace).toEqual({ photo_id: photoId, province_gb: '156420000' });
    expect(originalTypeLink).toEqual({ photo_id: photoId, type_id: 'builtin-landscape' });

    const backupRoot = path.join(fixture, 'data', 'backups');
    const backupDirectories = (await readdir(backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    expect(backupDirectories).toHaveLength(1);
    const backupPath = path.join(
      backupRoot,
      backupDirectories[0]!.name,
      path.basename(databasePath),
    );
    const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
    const backupVersion = backupDatabase.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    const backupPhoto = backupDatabase.prepare('SELECT photo_id FROM photo').get();
    const backupPlace = backupDatabase.prepare('SELECT photo_id, province_gb FROM photo_place').get();
    const backupTypeLink = backupDatabase.prepare('SELECT photo_id, type_id FROM photo_type_link').get();
    backupDatabase.close();
    expect(Number(backupVersion.user_version)).toBe(1);
    expect(backupPhoto).toEqual({ photo_id: photoId });
    expect(backupPlace).toEqual({ photo_id: photoId, province_gb: '156420000' });
    expect(backupTypeLink).toEqual({ photo_id: photoId, type_id: 'builtin-landscape' });
  });
});

describe('partial scan identity reconciliation', () => {
  it('recovers_unique_missing_files_within_the_source_without_moving_active_copies_or_marking_unseen_files_missing', async () => {
    const fixture = await fixtureRoot();
    const root = path.join(fixture, 'library');
    const repository = await NodeSqliteCatalogRepository.open(path.join(fixture, 'index.sqlite3'));
    try {
      const source = repository.activateSource(root);
      const file = (name: string, hash: string) => scannedFile(path.join(root, name), name, hash);
      const old = file('old.jpg', 'moved-hash');
      const active = file('active.jpg', 'copy-hash');
      const unseen = file('unseen.jpg', 'unseen-hash');
      repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [old, active, unseen], true);
      const originals = new Map(repository.getExistingPhotoFacts(source.sourceId).map((fact) => [fact.relativePath, fact.photoId]));
      repository.updateNote(originals.get('old.jpg')!, 'Keep the original note after recovery.');
      repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [active, unseen], true);

      const otherRoot = path.join(fixture, 'other-library');
      const other = repository.activateSource(otherRoot);
      repository.reconcileScan(other.sourceId, repository.startScanRun(other.sourceId), [
        scannedFile(path.join(otherRoot, 'same-hash.jpg'), 'same-hash.jpg', 'moved-hash'),
      ], true);
      repository.reconcileScan(other.sourceId, repository.startScanRun(other.sourceId), [], true);
      repository.activateSource(root);

      const renamed = file('renamed.jpg', 'moved-hash');
      const copied = file('copy.jpg', 'copy-hash');
      const runId = repository.startScanRun(source.sourceId);
      repository.reconcileScan(source.sourceId, runId, [renamed, copied], false);
      const facts = new Map(repository.getExistingPhotoFacts(source.sourceId).map((fact) => [fact.relativePath, fact]));
      expect(facts.get('renamed.jpg')?.photoId).toBe(originals.get('old.jpg'));
      expect(facts.get('active.jpg')?.photoId).toBe(originals.get('active.jpg'));
      expect(facts.get('copy.jpg')?.photoId).not.toBe(originals.get('active.jpg'));
      expect(facts.get('unseen.jpg')?.lifecycleState).toBe('active');
      expect(repository.getLibrarySnapshot().photos.find((photo) => photo.photoId === originals.get('old.jpg'))?.note)
        .toBe('Keep the original note after recovery.');
      const snapshot = repository.getLibrarySnapshot();
      expect(repository.reconcileScan(source.sourceId, runId, [], false)).toEqual({ indexed: 0, changed: false });
      expect(repository.getLibrarySnapshot()).toEqual(snapshot);

      repository.reconcileScan(source.sourceId, runId, [renamed, copied, active], true);
      expect(repository.getExistingPhotoFacts(source.sourceId).find((fact) => fact.relativePath === 'unseen.jpg')?.lifecycleState)
        .toBe('missing');
    } finally {
      repository.close();
    }
  });

  it('does_not_guess_an_identity_when_multiple_missing_files_share_the_same_hash', async () => {
    const fixture = await fixtureRoot();
    const root = path.join(fixture, 'library');
    const repository = await NodeSqliteCatalogRepository.open(path.join(fixture, 'index.sqlite3'));
    try {
      const source = repository.activateSource(root);
      const file = (name: string) => scannedFile(path.join(root, name), name, 'shared-hash');
      repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [file('a.jpg'), file('b.jpg')], true);
      const oldIds = new Set(repository.getExistingPhotoFacts(source.sourceId).map((fact) => fact.photoId));
      repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [], true);
      repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [file('new.jpg')], false);
      const facts = repository.getExistingPhotoFacts(source.sourceId);
      expect(facts.filter((fact) => fact.lifecycleState === 'missing')).toHaveLength(2);
      const added = facts.find((fact) => fact.relativePath === 'new.jpg')!;
      expect(added.lifecycleState).toBe('active');
      expect(oldIds.has(added.photoId)).toBe(false);
    } finally {
      repository.close();
    }
  });

  it('keeps_same_path_replacement_history_and_restores_the_matching_trashed_identity', async () => {
    const fixture = await fixtureRoot();
    const root = path.join(fixture, 'library');
    const repository = await NodeSqliteCatalogRepository.open(path.join(fixture, 'index.sqlite3'));
    try {
      const source = repository.activateSource(root);
      const original = scannedFile(path.join(root, 'same.jpg'), 'same.jpg', 'original-hash');
      repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [original], true);
      const originalId = repository.getExistingPhotoFacts(source.sourceId)[0]!.photoId;
      repository.updateNote(originalId, 'Original identity only.');

      const replacement = { ...original, contentSha256: 'replacement-hash' };
      repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [replacement], false);
      const replacementId = repository.getExistingPhotoFacts(source.sourceId)[0]!.photoId;
      expect(replacementId).not.toBe(originalId);
      expect(repository.getLibrarySnapshot().photos[0]?.note).toBe('');
      repository.updateNote(replacementId, 'Restored identity keeps its note.');
      expect(repository.markTrashPending(replacementId)).toBe(true);
      repository.settleTrashItem(replacementId, 'moved');

      repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [replacement], false);
      expect(repository.getLibrarySnapshot().photos).toEqual([
        expect.objectContaining({ photoId: replacementId, note: 'Restored identity keeps its note.' }),
      ]);
      expect(repository.getPhotoFileRecords([originalId])[0]?.lifecycleState).toBe('replaced');
    } finally {
      repository.close();
    }
  });

  it('accepts_a_large_partial_batch_without_deleting_unseen_files_then_reconciles_the_complete_scan', async () => {
    const fixture = await fixtureRoot();
    const root = path.join(fixture, 'library');
    const repository = await NodeSqliteCatalogRepository.open(path.join(fixture, 'index.sqlite3'));
    try {
      const source = repository.activateSource(root);
      const unseen = scannedFile(path.join(root, 'unseen.jpg'), 'unseen.jpg', 'unseen-hash');
      repository.reconcileScan(source.sourceId, repository.startScanRun(source.sourceId), [unseen], true);
      const incoming = Array.from({ length: 512 }, (_, index) => (
        scannedFile(path.join(root, `${index}.jpg`), `${index}.jpg`, `hash-${index}`)
      ));
      const runId = repository.startScanRun(source.sourceId);
      expect(repository.reconcileScan(source.sourceId, runId, incoming, false).indexed).toBe(512);
      expect(repository.getLibrarySnapshot().photos).toHaveLength(513);
      repository.reconcileScan(source.sourceId, runId, incoming, true);
      expect(repository.getLibrarySnapshot().photos).toHaveLength(512);
      expect(repository.getExistingPhotoFacts(source.sourceId).find((fact) => fact.relativePath === 'unseen.jpg')?.lifecycleState)
        .toBe('missing');
    } finally {
      repository.close();
    }
  });
});
