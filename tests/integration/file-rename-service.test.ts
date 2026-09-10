import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PhotoFileRecord } from '../../src/main/infrastructure/sqlite/catalog-repository';
import {
  atomicMoveNoReplace,
  FileRenameService,
  type FileMovePort,
  type FileRenameRepository,
} from '../../src/main/services/file-rename/file-rename-service';

const temporaryRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  // Match validateLibraryRoot: Windows TEMP may contain an 8.3 short-path alias.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'photo-map-rename-')));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const target = await realpath(temporaryRoots.pop()!);
    expect(path.dirname(target)).toBe(await realpath(os.tmpdir()));
    expect(path.basename(target).startsWith('photo-map-rename-')).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

interface PathUpdate {
  photoId: string;
  expectedAbsolutePath: string;
  absolutePath: string;
  expectedCompanionAbsolutePath: string | null;
  companionAbsolutePath: string | null;
}

class FakeRenameRepository implements FileRenameRepository {
  public readonly updates: PathUpdate[] = [];
  public updateBehavior: 'success' | 'stale' | 'throw' = 'success';

  public constructor(public readonly record: PhotoFileRecord) {}

  public getPhotoFileRecords(photoIds: string[]): PhotoFileRecord[] {
    return photoIds.includes(this.record.photoId) ? [this.record] : [];
  }

  public updatePhotoPathsAfterRename(
    photoId: string,
    expectedAbsolutePath: string,
    absolutePath: string,
    expectedCompanionAbsolutePath: string | null,
    companionAbsolutePath: string | null,
  ): boolean {
    this.updates.push({
      photoId,
      expectedAbsolutePath,
      absolutePath,
      expectedCompanionAbsolutePath,
      companionAbsolutePath,
    });
    if (this.updateBehavior === 'throw') throw new Error('synthetic repository failure');
    if (this.updateBehavior === 'stale') return false;
    this.record.absolutePath = absolutePath;
    this.record.companionAbsolutePath = companionAbsolutePath;
    return true;
  }
}

async function photoRecord(
  rootPath: string,
  fileName: string,
  options: {
    photoId?: string;
    mediaKind?: PhotoFileRecord['mediaKind'];
    companionFileName?: string;
  } = {},
): Promise<PhotoFileRecord> {
  const absolutePath = path.join(rootPath, fileName);
  const stats = await lstat(absolutePath);
  const companionAbsolutePath = options.companionFileName === undefined
    ? null
    : path.join(rootPath, options.companionFileName);
  const companionStats = companionAbsolutePath === null ? null : await lstat(companionAbsolutePath);
  return {
    photoId: options.photoId ?? 'photo-1',
    absolutePath,
    rootPath,
    lifecycleState: 'active',
    contentSha256: null,
    fileSize: stats.size,
    modifiedAtMs: stats.mtimeMs,
    mediaKind: options.mediaKind ?? 'photo',
    mediaFormat: 'jpg',
    companionAbsolutePath,
    companionFileSize: companionStats?.size ?? null,
    companionModifiedAtMs: companionStats?.mtimeMs ?? null,
  };
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(lstat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('file rename service filesystem and catalog contract', () => {
  it('renames_an_ordinary_photo_without_changing_its_bytes_and_updates_the_catalog_paths', async () => {
    const root = await fixtureRoot();
    const originalPath = path.join(root, 'original.jpg');
    const renamedPath = path.join(root, '旅途.jpg');
    await writeFile(originalPath, Buffer.from('ordinary-photo'));
    const repository = new FakeRenameRepository(await photoRecord(root, 'original.jpg'));

    const result = await new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: '旅途.jpg',
    });

    expect(result).toEqual({ renamed: true, fileName: '旅途.jpg' });
    await expect(expectMissing(originalPath)).resolves.toBeUndefined();
    await expect(readFile(renamedPath, 'utf8')).resolves.toBe('ordinary-photo');
    expect(repository.updates).toEqual([{
      photoId: 'photo-1',
      expectedAbsolutePath: originalPath,
      absolutePath: renamedPath,
      expectedCompanionAbsolutePath: null,
      companionAbsolutePath: null,
    }]);
  });

  it('passes_unicode_and_shell_metacharacters_as_literal_file_name_data', async () => {
    const root = await fixtureRoot();
    const originalPath = path.join(root, 'original.jpg');
    const specialFileName = "旅途 & $() ; [] % ! ` ' 😀.jpg";
    const specialPath = path.join(root, specialFileName);
    await writeFile(originalPath, Buffer.from('literal-path-data'));
    const repository = new FakeRenameRepository(await photoRecord(root, 'original.jpg'));

    await expect(new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: specialFileName,
    })).resolves.toEqual({ renamed: true, fileName: specialFileName });

    await expect(expectMissing(originalPath)).resolves.toBeUndefined();
    await expect(readFile(specialPath, 'utf8')).resolves.toBe('literal-path-data');
  });

  it('refuses_an_existing_target_without_overwriting_either_file_or_touching_the_catalog', async () => {
    const root = await fixtureRoot();
    const originalPath = path.join(root, 'original.jpg');
    const occupiedPath = path.join(root, 'occupied.jpg');
    await Promise.all([
      writeFile(originalPath, Buffer.from('original-bytes')),
      writeFile(occupiedPath, Buffer.from('occupied-bytes')),
    ]);
    const repository = new FakeRenameRepository(await photoRecord(root, 'original.jpg'));

    await expect(new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: 'occupied.jpg',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await expect(readFile(originalPath, 'utf8')).resolves.toBe('original-bytes');
    await expect(readFile(occupiedPath, 'utf8')).resolves.toBe('occupied-bytes');
    expect(repository.updates).toEqual([]);
  });

  it('does_not_overwrite_a_target_created_after_preflight', async () => {
    const root = await fixtureRoot();
    const originalPath = path.join(root, 'original.jpg');
    const racedTargetPath = path.join(root, 'raced.jpg');
    await writeFile(originalPath, Buffer.from('original-bytes'));
    const repository = new FakeRenameRepository(await photoRecord(root, 'original.jpg'));
    let raceInjected = false;
    const fileMove: FileMovePort = {
      moveNoReplace: async (sourcePath, targetPath) => {
        if (!raceInjected && targetPath === racedTargetPath) {
          raceInjected = true;
          await writeFile(racedTargetPath, Buffer.from('racer-bytes'));
        }
        await atomicMoveNoReplace(sourcePath, targetPath);
      },
      renameCaseOnly: rename,
    };

    await expect(new FileRenameService(repository, fileMove).renamePhoto({
      photoId: 'photo-1',
      newFileName: 'raced.jpg',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    expect(raceInjected).toBe(true);
    await expect(readFile(originalPath, 'utf8')).resolves.toBe('original-bytes');
    await expect(readFile(racedTargetPath, 'utf8')).resolves.toBe('racer-bytes');
    expect(repository.updates).toEqual([]);
  });

  it('supports_a_case_only_file_name_change_without_treating_the_source_as_a_conflict', async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, 'Photo.JPG'), Buffer.from('case-only-photo'));
    const repository = new FakeRenameRepository(await photoRecord(root, 'Photo.JPG'));

    await expect(new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: 'photo.jpg',
    })).resolves.toEqual({ renamed: true, fileName: 'photo.jpg' });

    expect(await readdir(root)).toEqual(['photo.jpg']);
    await expect(readFile(path.join(root, 'photo.jpg'), 'utf8')).resolves.toBe('case-only-photo');
    expect(repository.updates).toHaveLength(1);
  });

  it('treats_a_different_path_to_the_same_hardlinked_file_as_an_existing_target', async () => {
    const root = await fixtureRoot();
    const originalPath = path.join(root, 'original.jpg');
    const aliasPath = path.join(root, 'alias.jpg');
    await writeFile(originalPath, Buffer.from('hardlinked-photo'));
    await link(originalPath, aliasPath);
    const repository = new FakeRenameRepository(await photoRecord(root, 'original.jpg'));

    await expect(new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: 'alias.jpg',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await expect(readFile(originalPath, 'utf8')).resolves.toBe('hardlinked-photo');
    await expect(readFile(aliasPath, 'utf8')).resolves.toBe('hardlinked-photo');
    expect(repository.updates).toEqual([]);
  });

  it('rejects_an_extension_change_without_moving_the_source_or_updating_the_catalog', async () => {
    const root = await fixtureRoot();
    const originalPath = path.join(root, 'original.jpg');
    await writeFile(originalPath, Buffer.from('photo'));
    const repository = new FakeRenameRepository(await photoRecord(root, 'original.jpg'));

    await expect(new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: 'original.png',
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('扩展名必须保持为 .jpg'),
    });

    await expect(readFile(originalPath, 'utf8')).resolves.toBe('photo');
    await expectMissing(path.join(root, 'original.png'));
    expect(repository.updates).toEqual([]);
  });

  it.each([
    '',
    '.',
    '..',
    '../escape.jpg',
    'nested/photo.jpg',
    'nested\\photo.jpg',
    'bad?.jpg',
    'CON.jpg',
    'photo.jpg.',
    `${'a'.repeat(252)}.jpg`,
  ])('rejects_invalid_file_name_%j_before_reading_or_mutating_the_catalog', async (newFileName) => {
    const root = await fixtureRoot();
    const originalPath = path.join(root, 'original.jpg');
    await writeFile(originalPath, Buffer.from('photo'));
    const repository = new FakeRenameRepository(await photoRecord(root, 'original.jpg'));

    await expect(new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await expect(readFile(originalPath, 'utf8')).resolves.toBe('photo');
    expect(repository.updates).toEqual([]);
  });

  it('rejects_a_source_changed_outside_the_app_since_indexing', async () => {
    const root = await fixtureRoot();
    const originalPath = path.join(root, 'original.jpg');
    await writeFile(originalPath, Buffer.from('indexed'));
    const repository = new FakeRenameRepository(await photoRecord(root, 'original.jpg'));
    await writeFile(originalPath, Buffer.from('changed-outside-the-application'));

    await expect(new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: 'renamed.jpg',
    })).rejects.toMatchObject({
      code: 'MEDIA_NOT_FOUND',
      message: expect.stringContaining('已在软件外发生变化'),
    });

    await expect(readFile(originalPath, 'utf8')).resolves.toBe('changed-outside-the-application');
    await expectMissing(path.join(root, 'renamed.jpg'));
    expect(repository.updates).toEqual([]);
  });

  it('rolls_the_physical_file_back_when_the_repository_update_throws', async () => {
    const root = await fixtureRoot();
    const originalPath = path.join(root, 'original.jpg');
    const renamedPath = path.join(root, 'renamed.jpg');
    await writeFile(originalPath, Buffer.from('rollback-photo'));
    const repository = new FakeRenameRepository(await photoRecord(root, 'original.jpg'));
    repository.updateBehavior = 'throw';

    await expect(new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: 'renamed.jpg',
    })).rejects.toMatchObject({ code: 'RENAME_FAILED' });

    await expect(readFile(originalPath, 'utf8')).resolves.toBe('rollback-photo');
    await expectMissing(renamedPath);
    expect(repository.updates).toHaveLength(1);
  });

  it('renames_an_apple_live_photo_still_and_same_stem_companion_together', async () => {
    const root = await fixtureRoot();
    const stillPath = path.join(root, 'IMG_0001.jpg');
    const motionPath = path.join(root, 'IMG_0001.mov');
    const renamedStillPath = path.join(root, '海边.jpg');
    const renamedMotionPath = path.join(root, '海边.mov');
    await Promise.all([
      writeFile(stillPath, Buffer.from('live-still')),
      writeFile(motionPath, Buffer.from('live-motion')),
    ]);
    const repository = new FakeRenameRepository(await photoRecord(root, 'IMG_0001.jpg', {
      mediaKind: 'live',
      companionFileName: 'IMG_0001.mov',
    }));

    const result = await new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: '海边.jpg',
    });

    expect(result).toEqual({ renamed: true, fileName: '海边.jpg' });
    await Promise.all([expectMissing(stillPath), expectMissing(motionPath)]);
    await expect(readFile(renamedStillPath, 'utf8')).resolves.toBe('live-still');
    await expect(readFile(renamedMotionPath, 'utf8')).resolves.toBe('live-motion');
    expect(repository.updates).toEqual([{
      photoId: 'photo-1',
      expectedAbsolutePath: stillPath,
      absolutePath: renamedStillPath,
      expectedCompanionAbsolutePath: motionPath,
      companionAbsolutePath: renamedMotionPath,
    }]);
  });

  it('leaves_an_entire_same_stem_live_pair_unchanged_when_the_companion_target_is_occupied', async () => {
    const root = await fixtureRoot();
    const stillPath = path.join(root, 'IMG_0001.jpg');
    const motionPath = path.join(root, 'IMG_0001.mov');
    const occupiedMotionPath = path.join(root, '海边.mov');
    await Promise.all([
      writeFile(stillPath, Buffer.from('live-still')),
      writeFile(motionPath, Buffer.from('live-motion')),
      writeFile(occupiedMotionPath, Buffer.from('occupied-motion')),
    ]);
    const repository = new FakeRenameRepository(await photoRecord(root, 'IMG_0001.jpg', {
      mediaKind: 'live',
      companionFileName: 'IMG_0001.mov',
    }));

    await expect(new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: '海边.jpg',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    await expect(readFile(stillPath, 'utf8')).resolves.toBe('live-still');
    await expect(readFile(motionPath, 'utf8')).resolves.toBe('live-motion');
    await expect(readFile(occupiedMotionPath, 'utf8')).resolves.toBe('occupied-motion');
    await expectMissing(path.join(root, '海边.jpg'));
    expect(repository.updates).toEqual([]);
  });

  it('rechecks_the_still_after_moving_the_companion_and_rolls_back_without_moving_a_replacement', async () => {
    const root = await fixtureRoot();
    const stillPath = path.join(root, 'live.jpg');
    const motionPath = path.join(root, 'live.mov');
    await writeFile(stillPath, 'original-still');
    await writeFile(motionPath, 'original-motion');
    const repository = new FakeRenameRepository(await photoRecord(root, 'live.jpg', {
      mediaKind: 'live', companionFileName: 'live.mov',
    }));
    const movedPaths: string[] = [];
    const fileMove: FileMovePort = {
      async moveNoReplace(sourcePath, targetPath) {
        movedPaths.push(sourcePath);
        await rename(sourcePath, targetPath);
        if (sourcePath === motionPath) await writeFile(stillPath, 'external-replacement-still');
      },
      renameCaseOnly: rename,
    };
    await expect(new FileRenameService(repository, fileMove).renamePhoto({
      photoId: 'photo-1', newFileName: 'renamed.jpg',
    })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND', message: expect.stringContaining('已在软件外发生变化') });
    expect(movedPaths).toEqual([motionPath, path.join(root, 'renamed.mov')]);
    expect(await readFile(stillPath, 'utf8')).toBe('external-replacement-still');
    expect(await readFile(motionPath, 'utf8')).toBe('original-motion');
    await expectMissing(path.join(root, 'renamed.jpg'));
    await expectMissing(path.join(root, 'renamed.mov'));
    expect(repository.updates).toEqual([]);
  });

  it('keeps_a_different_stem_live_companion_in_place_while_renaming_the_still', async () => {
    const root = await fixtureRoot();
    const stillPath = path.join(root, 'cover.jpg');
    const motionPath = path.join(root, 'motion.mov');
    const renamedStillPath = path.join(root, 'renamed.jpg');
    await Promise.all([
      writeFile(stillPath, Buffer.from('live-still')),
      writeFile(motionPath, Buffer.from('live-motion')),
    ]);
    const repository = new FakeRenameRepository(await photoRecord(root, 'cover.jpg', {
      mediaKind: 'live',
      companionFileName: 'motion.mov',
    }));

    await expect(new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: 'renamed.jpg',
    })).resolves.toEqual({ renamed: true, fileName: 'renamed.jpg' });

    await expectMissing(stillPath);
    await expect(readFile(renamedStillPath, 'utf8')).resolves.toBe('live-still');
    await expect(readFile(motionPath, 'utf8')).resolves.toBe('live-motion');
    await expectMissing(path.join(root, 'renamed.mov'));
    expect(repository.updates).toEqual([{
      photoId: 'photo-1',
      expectedAbsolutePath: stillPath,
      absolutePath: renamedStillPath,
      expectedCompanionAbsolutePath: motionPath,
      companionAbsolutePath: motionPath,
    }]);
  });

  it('keeps_a_same_stem_content_id_companion_in_another_folder_in_place', async () => {
    const root = await fixtureRoot();
    const companionDirectory = path.join(root, 'motion');
    await mkdir(companionDirectory);
    const stillPath = path.join(root, 'cover.jpg');
    const motionPath = path.join(companionDirectory, 'cover.mov');
    const renamedStillPath = path.join(root, 'renamed.jpg');
    await Promise.all([
      writeFile(stillPath, Buffer.from('live-still')),
      writeFile(motionPath, Buffer.from('live-motion')),
    ]);
    const repository = new FakeRenameRepository(await photoRecord(root, 'cover.jpg', {
      mediaKind: 'live',
      companionFileName: path.join('motion', 'cover.mov'),
    }));

    await expect(new FileRenameService(repository).renamePhoto({
      photoId: 'photo-1',
      newFileName: 'renamed.jpg',
    })).resolves.toEqual({ renamed: true, fileName: 'renamed.jpg' });

    await expectMissing(stillPath);
    await expect(readFile(renamedStillPath, 'utf8')).resolves.toBe('live-still');
    await expect(readFile(motionPath, 'utf8')).resolves.toBe('live-motion');
    await expectMissing(path.join(companionDirectory, 'renamed.mov'));
    expect(repository.updates[0]).toEqual(expect.objectContaining({
      expectedCompanionAbsolutePath: motionPath,
      companionAbsolutePath: motionPath,
    }));
  });
});
