import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalPathKey } from '../../src/main/infrastructure/filesystem/path-policy';
import { NodeSqliteCatalogRepository } from '../../src/main/infrastructure/sqlite/catalog-repository';
import type { ScannedFile } from '../../src/main/services/library-scan/models';

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop()!;
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    await rm(target, { recursive: true, force: true });
  }
});

function media(
  root: string,
  name: string,
  mediaKind: ScannedFile['mediaKind'],
  mediaFormat: ScannedFile['mediaFormat'],
  companionName?: string,
): ScannedFile {
  const absolutePath = path.join(root, name);
  return {
    absolutePath,
    relativePath: name,
    canonicalPathKey: canonicalPathKey(absolutePath),
    fileSize: 100,
    modifiedAtMs: 10,
    fileCreatedAtMs: 5,
    contentSha256: `${name}-hash`,
    mediaKind,
    mediaFormat,
    pixelWidth: 320,
    pixelHeight: 180,
    decodeState: 'valid',
    ...(companionName ? {
      companion: {
        absolutePath: path.join(root, companionName),
        relativePath: companionName,
        canonicalPathKey: canonicalPathKey(path.join(root, companionName)),
        fileSize: 50,
        modifiedAtMs: 11,
        fileCreatedAtMs: 6,
        contentSha256: `${companionName}-hash`,
        mediaFormat: 'mov' as const,
      },
    } : {}),
  };
}

describe('media catalog persistence', () => {
  it('prd_ac_015__photo_video_android_live_and_apple_live__restart__preserves_intrinsic_kinds_and_companion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-media-catalog-'));
    temporaryRoots.push(root);
    const libraryRoot = path.join(root, 'library');
    await mkdir(libraryRoot, { recursive: true });
    const ids = ['source', 'run', 'photo', 'video', 'android-live', 'apple-live'];
    const repository = await NodeSqliteCatalogRepository.open(path.join(root, 'index.sqlite3'), {
      createId: () => ids.shift()!,
    });
    const source = repository.activateSource(libraryRoot);
    const runId = repository.startScanRun(source.sourceId);
    try {
      repository.reconcileScan(source.sourceId, runId, [
        media(libraryRoot, 'photo.jpg', 'photo', 'jpg'),
        media(libraryRoot, 'video.mp4', 'video', 'mp4'),
        media(libraryRoot, 'androidMP.jpg', 'live', 'jpg'),
        media(libraryRoot, 'apple.jpg', 'live', 'jpg', 'apple.mov'),
      ], true);
    } finally {
      repository.close();
    }

    const reopened = await NodeSqliteCatalogRepository.open(path.join(root, 'index.sqlite3'));
    try {
      const snapshot = reopened.getLibrarySnapshot();
      const apple = snapshot.photos.find(({ fileName }) => fileName === 'apple.jpg');
      const appleRecord = apple ? reopened.getPhotoFileRecords([apple.photoId])[0] : undefined;

      expect(snapshot.photos.map(({ fileName, mediaKind, mediaFormat }) => [fileName, mediaKind, mediaFormat]))
        .toEqual([
          ['androidMP.jpg', 'live', 'jpg'],
          ['apple.jpg', 'live', 'jpg'],
          ['photo.jpg', 'photo', 'jpg'],
          ['video.mp4', 'video', 'mp4'],
        ]);
      expect(appleRecord?.companionAbsolutePath).toBe(path.join(libraryRoot, 'apple.mov'));
    } finally {
      reopened.close();
    }
  });
});
