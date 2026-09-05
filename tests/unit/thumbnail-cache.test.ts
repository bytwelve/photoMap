import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const image = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 320, height: 180 })),
    resize: vi.fn(),
    toJPEG: vi.fn(() => Buffer.from('thumbnail')),
  };
  image.resize.mockReturnValue(image);
  return {
    image,
    createFromPath: vi.fn(() => image),
    createThumbnailFromPath: vi.fn(async () => image),
  };
});

vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: electronMocks.createFromPath,
    createThumbnailFromPath: electronMocks.createThumbnailFromPath,
  },
}));

import { ThumbnailCache } from '../../src/main/services/thumbnails/thumbnail-cache';
import type { PhotoFileRecord } from '../../src/main/infrastructure/sqlite/catalog-repository';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop()!;
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    await rm(target, { recursive: true, force: true });
  }
});

async function fixture(mediaKind: PhotoFileRecord['mediaKind'], mediaFormat: PhotoFileRecord['mediaFormat']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-thumbnail-'));
  temporaryRoots.push(root);
  const sourcePath = path.join(root, `source.${mediaFormat}`);
  await writeFile(sourcePath, Buffer.from('source'));
  const record: PhotoFileRecord = {
    photoId: `${mediaKind}-1`,
    absolutePath: sourcePath,
    rootPath: root,
    lifecycleState: 'active',
    contentSha256: 'hash',
    fileSize: 6,
    modifiedAtMs: 1,
    mediaKind,
    mediaFormat,
    companionAbsolutePath: null,
    companionFileSize: null,
    companionModifiedAtMs: null,
  };
  return {
    root,
    sourcePath,
    record,
  };
}

describe('media thumbnail cache', () => {
  it('prd_ac_010__video__generates_poster_with_the_operating_system_thumbnail_provider', async () => {
    const { root, sourcePath, record } = await fixture('video', 'mp4');

    await new ThumbnailCache(path.join(root, 'cache')).getOrCreate(sourcePath, record);

    expect(electronMocks.createThumbnailFromPath).toHaveBeenCalledWith(sourcePath, { width: 512, height: 512 });
    expect(electronMocks.createFromPath).not.toHaveBeenCalled();
  });

  it('prd_ac_010__apple_live_photo__uses_the_still_component_instead_of_the_motion_companion', async () => {
    const { root, sourcePath, record } = await fixture('live', 'jpg');
    record.companionAbsolutePath = path.join(root, 'source.mov');

    await new ThumbnailCache(path.join(root, 'cache')).getOrCreate(sourcePath, record);

    expect(electronMocks.createFromPath).toHaveBeenCalledWith(sourcePath);
    expect(electronMocks.createThumbnailFromPath).not.toHaveBeenCalled();
  });
});
