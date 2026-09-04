import { copyFile, lstat, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { enumerateMediaFiles } from '../../src/main/infrastructure/filesystem/enumerate-media';
import { NodeSqliteCatalogRepository } from '../../src/main/infrastructure/sqlite/catalog-repository';
import {
  LibraryScanner,
  PROGRESSIVE_SCAN_BATCH_SIZE,
} from '../../src/main/services/library-scan/library-scanner';
import type {
  ExistingPhotoFact,
  GpsLocationResolver,
  MediaProbe,
  PhotoMetadataProbe,
  ScanLocationProposal,
  ScanRepository,
  ScannedFile,
} from '../../src/main/services/library-scan/models';
import type { ScanProgress } from '../../src/shared/contracts';

const temporaryRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-scan-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop()!;
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(target).startsWith('photo-map-scan-')).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

class RecordingRepository implements ScanRepository {
  public reconciled: ScannedFile[] = [];
  public readonly reconcileCalls: Array<{ files: ScannedFile[]; complete: boolean }> = [];
  public complete = false;
  public finalProgress: ScanProgress | undefined;

  public startScanRun(): string {
    return 'scan-run-1';
  }

  public getExistingPhotoFacts(): ExistingPhotoFact[] {
    return [];
  }

  public reconcileScan(
    _sourceId: string,
    _runId: string,
    files: ScannedFile[],
    complete: boolean,
  ): { indexed: number; changed: boolean } {
    this.reconcileCalls.push({ files: [...files], complete });
    this.reconciled = files;
    this.complete = complete;
    return { indexed: files.length, changed: files.length > 0 };
  }

  public finishScanRun(_runId: string, progress: ScanProgress): void {
    this.finalProgress = progress;
  }
}

const validProbe: MediaProbe = {
  async probe() {
    return { pixelWidth: 2, pixelHeight: 3, decodeState: 'valid' };
  },
};

async function buildFileTree(): Promise<{
  root: string;
  symlinkCreated: boolean;
}> {
  const fixture = await fixtureRoot();
  const root = path.join(fixture, 'library');
  const nested = path.join(root, 'nested');
  const outside = path.join(fixture, 'outside');
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(outside, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(root, 'alpha.PNG'), Buffer.from('png-alpha')),
    writeFile(path.join(root, 'duplicate.jpg'), Buffer.from('same-photo-bytes')),
    writeFile(path.join(nested, 'duplicate-copy.JpG'), Buffer.from('same-photo-bytes')),
    writeFile(path.join(nested, 'ignored.webp'), Buffer.from('not-supported')),
    writeFile(path.join(root, 'notes.txt'), Buffer.from('not-an-image')),
    writeFile(path.join(outside, 'must-not-follow.jpg'), Buffer.from('outside')),
  ]);

  let symlinkCreated = false;
  try {
    await symlink(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkCreated = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP') throw error;
  }
  return { root, symlinkCreated };
}

describe('TDD-CONTRACT-SCAN-001', () => {
  it('nested_two_levels_and_deeper__enumerates__keeps_every_supported_media_file', async () => {
    const fixture = await fixtureRoot();
    const root = path.join(fixture, 'library');
    await mkdir(path.join(root, '旅行', '武汉', '东湖'), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, 'root.jpg'), Buffer.from('root')),
      writeFile(path.join(root, '旅行', 'one.jpg'), Buffer.from('one')),
      writeFile(path.join(root, '旅行', '武汉', 'two.jpg'), Buffer.from('two')),
      writeFile(path.join(root, '旅行', '武汉', '东湖', 'deep.jpg'), Buffer.from('deep')),
    ]);

    const result = await enumerateMediaFiles(root, new AbortController().signal);

    expect(result.files.map(({ relativePath }) => relativePath.replaceAll('\\', '/'))).toEqual([
      'root.jpg',
      '旅行/one.jpg',
      '旅行/武汉/two.jpg',
      '旅行/武汉/东湖/deep.jpg',
    ]);
  });

  it('prd_fr_002__mixed_nested_file_tree__enumerates__includes_supported_media_and_skips_unknown_formats_and_reparse_points', async (context) => {
    const { root, symlinkCreated } = await buildFileTree();
    if (!symlinkCreated) context.skip('This host does not permit creating the test-only directory link.');

    const result = await enumerateMediaFiles(root, new AbortController().signal);
    const relativeNames = result.files.map(({ relativePath }) => relativePath.replaceAll('\\', '/'));

    expect(relativeNames).toEqual([
      'alpha.PNG',
      'duplicate.jpg',
      'nested/duplicate-copy.JpG',
    ]);
    expect(relativeNames.some((name) => name.endsWith('.webp'))).toBe(false);
    expect(relativeNames.some((name) => name.includes('outside-link'))).toBe(false);
  });

  it('prd_ac_015__supported_extensions__enumerates_photos_videos_and_live_photo_components', async () => {
    const fixture = await fixtureRoot();
    const root = path.join(fixture, 'library');
    await mkdir(root, { recursive: true });
    const names = ['a.jpg', 'b.jpeg', 'c.png', 'd.heic', 'e.heif', 'f.avif', 'g.mp4', 'h.mov', 'i.m4v', 'ignored.gif'];
    await Promise.all(names.map((name) => writeFile(path.join(root, name), Buffer.from(name))));

    const result = await enumerateMediaFiles(root, new AbortController().signal);

    expect(result.files.map(({ relativePath, mediaFormat }) => [relativePath, mediaFormat])).toEqual([
      ['a.jpg', 'jpg'],
      ['b.jpeg', 'jpg'],
      ['c.png', 'png'],
      ['d.heic', 'heic'],
      ['e.heif', 'heic'],
      ['f.avif', 'avif'],
      ['g.mp4', 'mp4'],
      ['h.mov', 'mov'],
      ['i.m4v', 'm4v'],
    ]);
  });

  it('prd_ac_015__apple_android_generic_motion_and_video_files__scan__indexes_five_logical_media_items', async () => {
    const fixture = await fixtureRoot();
    const root = path.join(fixture, 'library');
    await mkdir(root, { recursive: true });
    const appleId = '12345678-1234-4abc-9def-1234567890ab';
    const androidVideo = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypisom', 'ascii'),
      Buffer.alloc(16, 0),
    ]);
    const androidXmp = `<rdf:Description Camera:MotionPhoto="1"/><rdf:li Item:Semantic="MotionPhoto" Item:Mime="video/mp4" Item:Length="${androidVideo.length}"/>`;
    const isoBox = (type: string, payload: Buffer): Buffer => {
      const box = Buffer.alloc(8 + payload.length);
      box.writeUInt32BE(box.length, 0);
      box.write(type, 4, 4, 'ascii');
      payload.copy(box, 8);
      return box;
    };
    const genericAndroidVideo = Buffer.concat([
      isoBox('ftyp', Buffer.from('isom\x00\x00\x00\x00isom', 'binary')),
      isoBox('moov', Buffer.alloc(8, 0)),
      isoBox('mdat', Buffer.from('generic-motion-video', 'ascii')),
    ]);
    await Promise.all([
      writeFile(path.join(root, 'plain.jpg'), Buffer.from('plain-photo')),
      writeFile(path.join(root, 'clip.mp4'), Buffer.from('plain-video')),
      writeFile(path.join(root, 'apple.jpg'), Buffer.from(`Apple MakerNote ${appleId}`)),
      writeFile(path.join(root, 'apple.mov'), Buffer.from(`com.apple.quicktime.content.identifier ${appleId}`)),
      writeFile(path.join(root, 'androidMP.jpg'), Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from(androidXmp),
        Buffer.from([0xff, 0xd9]),
        androidVideo,
      ])),
      writeFile(path.join(root, 'generic-motion.jpg'), Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]),
        genericAndroidVideo,
        Buffer.from('vendor-tail', 'ascii'),
      ])),
    ]);
    const repository = new RecordingRepository();
    const scanner = new LibraryScanner(repository, validProbe);

    const result = await scanner.scan('source-1', root, new AbortController().signal, {
      gpsMetadataPolicy: 'skip',
      onProgress: () => undefined,
    });

    expect(result.progress.counts.discovered).toBe(5);
    expect(repository.reconciled.map(({ relativePath, mediaKind }) => [relativePath, mediaKind]))
      .toEqual([
        ['androidMP.jpg', 'live'],
        ['apple.jpg', 'live'],
        ['clip.mp4', 'video'],
        ['generic-motion.jpg', 'live'],
        ['plain.jpg', 'photo'],
      ]);
    expect(repository.reconciled.find(({ relativePath }) => relativePath === 'apple.jpg')?.companion?.relativePath)
      .toBe('apple.mov');
  });

  it('prd_fr_005__same_bytes_at_two_paths__scans__keeps_two_file_candidates_with_one_shared_hash', async () => {
    const { root } = await buildFileTree();
    const repository = new RecordingRepository();
    const scanner = new LibraryScanner(repository, validProbe);

    const result = await scanner.scan(
      'source-1',
      root,
      new AbortController().signal,
      { gpsMetadataPolicy: 'skip', onProgress: () => undefined },
    );
    const duplicateRecords = repository.reconciled.filter(({ relativePath }) =>
      relativePath.toLocaleLowerCase('en-US').includes('duplicate'),
    );
    const alphaStats = await lstat(path.join(root, 'alpha.PNG'));
    const alpha = repository.reconciled.find(({ relativePath }) => relativePath === 'alpha.PNG');

    expect(result.progress.status).toBe('succeeded');
    expect(repository.complete).toBe(true);
    expect(duplicateRecords).toHaveLength(2);
    expect(new Set(duplicateRecords.map(({ canonicalPathKey }) => canonicalPathKey)).size).toBe(2);
    expect(new Set(duplicateRecords.map(({ contentSha256 }) => contentSha256)).size).toBe(1);
    expect(alpha?.fileCreatedAtMs).toBe(alphaStats.birthtimeMs > 0 ? alphaStats.birthtimeMs : null);
  });

  it('prd_nfr_002__scanner_scan_facts__complete__do_not_persist_raw_exif_gps_or_location_fields', async () => {
    const { root } = await buildFileTree();
    const repository = new RecordingRepository();
    const metadataProbe: PhotoMetadataProbe = {
      probe: vi.fn(async () => ({
        hasExif: true,
        gps: { latitude: 30.5928, longitude: 114.3055, mapDatum: 'WGS-84' },
        captureTime: null,
      })),
    };
    const scanner = new LibraryScanner(repository, validProbe, metadataProbe);
    const result = await scanner.scan('source-1', root, new AbortController().signal, {
      gpsMetadataPolicy: 'skip',
      onProgress: () => undefined,
      onLocationProposal: () => {
        throw new Error('GPS-disabled base indexing must not create a location proposal');
      },
    });

    expect(result.progress.metadata).toBeUndefined();
    expect(result.progress.status).toBe('succeeded');
    expect(metadataProbe.probe).not.toHaveBeenCalled();
    const serialized = JSON.stringify(repository.reconciled);
    expect(serialized).not.toMatch(/gps|latitude|longitude|exif/iu);
    expect(serialized).not.toMatch(/province|city|location/iu);
    expect(Object.keys(await validProbe.probe('fixture.jpg', 'jpg', 'photo'))).toEqual([
      'pixelWidth',
      'pixelHeight',
      'decodeState',
    ]);
  });

  it('prd_fr_007__all_photos_including_unchanged__scan_metadata__summarizes_exif_gps_and_stages_resolved_locations', async () => {
    const fixture = await fixtureRoot();
    const { root } = await buildFileTree();
    const repository = await NodeSqliteCatalogRepository.open(path.join(fixture, 'catalog.sqlite'));
    const source = repository.activateSource(root);
    const metadataProbe: PhotoMetadataProbe = {
      probe: vi.fn(async (filePath) => {
        const name = path.basename(filePath);
        if (name === 'alpha.PNG') return { hasExif: true, gps: null, captureTime: null };
        if (name === 'duplicate.jpg') {
          return {
            hasExif: true,
            gps: { latitude: 30.5928, longitude: 114.3055, mapDatum: 'WGS-84' },
            captureTime: null,
          };
        }
        if (name === 'duplicate-copy.JpG') throw new Error('synthetic metadata read failure');
        return { hasExif: false, gps: null, captureTime: null };
      }),
    };
    const locationResolver: GpsLocationResolver = {
      resolveGps: vi.fn(() => ({ provinceGb: '156420000', cityGb: '156420100' })),
    };
    const proposals: ScanLocationProposal[] = [];
    const scanner = new LibraryScanner(repository, validProbe, metadataProbe, locationResolver);

    try {
      const first = await scanner.scan(
        source.sourceId,
        root,
        new AbortController().signal,
        {
          gpsMetadataPolicy: 'probe-and-resolve',
          onProgress: () => undefined,
          onLocationProposal: (proposal) => proposals.push(proposal),
        },
      );

      expect(first.progress.metadata).toEqual({
        examined: 3,
        exifCount: 2,
        gpsCount: 1,
        resolvedLocationCount: 1,
        captureTimeCount: 0,
        metadataErrorCount: 1,
      });
      expect(first.progress.status).toBe('partial');
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.assignments).toHaveLength(1);
      expect(proposals[0]?.assignments[0]?.location).toEqual({
        provinceGb: '156420000',
        cityGb: '156420100',
      });
      expect(JSON.stringify(repository.getLibrarySnapshot())).not.toMatch(/latitude|longitude|gps|exif/iu);

      const second = await scanner.scan(
        source.sourceId,
        root,
        new AbortController().signal,
        {
          gpsMetadataPolicy: 'probe-and-resolve',
          onProgress: () => undefined,
          onLocationProposal: (proposal) => proposals.push(proposal),
        },
      );

      expect(second.progress.counts.unchanged).toBe(3);
      expect(metadataProbe.probe).toHaveBeenCalledTimes(6);
      expect(proposals).toHaveLength(2);
      expect(proposals[1]?.assignments[0]?.photoId).toBe(proposals[0]?.assignments[0]?.photoId);
    } finally {
      repository.close();
    }
  });

  it('gps_without_geometry_and_capture_time__scan_and_unchanged_rescan__stages_only_capture_time', async () => {
    const fixture = await fixtureRoot();
    const { root } = await buildFileTree();
    const repository = await NodeSqliteCatalogRepository.open(path.join(fixture, 'catalog.sqlite'));
    const source = repository.activateSource(root);
    const metadataProbe: PhotoMetadataProbe = {
      probe: vi.fn(async () => ({
        hasExif: true,
        gps: { latitude: 30.59, longitude: 114.3, mapDatum: 'WGS-84' },
        captureTime: {
          localDateTime: '2026-06-17T15:44:34',
          offsetMinutes: 480,
        },
      })),
    };
    const locationResolver: GpsLocationResolver = {
      resolveGps: vi.fn(() => ({ provinceGb: '156420000' })),
    };
    const proposals: ScanLocationProposal[] = [];
    const scanner = new LibraryScanner(repository, validProbe, metadataProbe, locationResolver);

    try {
      const first = await scanner.scan(
        source.sourceId,
        root,
        new AbortController().signal,
        {
          gpsMetadataPolicy: 'probe-without-resolve',
          onProgress: () => undefined,
          onLocationProposal: (proposal) => proposals.push(proposal),
        },
      );

      expect(first.progress.metadata).toEqual({
        examined: 3,
        exifCount: 3,
        gpsCount: 3,
        resolvedLocationCount: 0,
        captureTimeCount: 3,
        metadataErrorCount: 0,
      });
      expect(first.progress.status).toBe('succeeded');
      expect(locationResolver.resolveGps).not.toHaveBeenCalled();
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.assignments).toEqual([]);
      expect(proposals[0]?.captureTimes).toHaveLength(3);
      expect(proposals[0]?.captureTimes.map(({ captureTime }) => captureTime)).toEqual([
        { localDateTime: '2026-06-17T15:44:34', offsetMinutes: 480 },
        { localDateTime: '2026-06-17T15:44:34', offsetMinutes: 480 },
        { localDateTime: '2026-06-17T15:44:34', offsetMinutes: 480 },
      ]);

      const firstPhotoIds = new Set(proposals[0]?.captureTimes.map(({ photoId }) => photoId));
      const second = await scanner.scan(
        source.sourceId,
        root,
        new AbortController().signal,
        {
          gpsMetadataPolicy: 'probe-without-resolve',
          onProgress: () => undefined,
          onLocationProposal: (proposal) => proposals.push(proposal),
        },
      );

      expect(second.progress.counts.unchanged).toBe(3);
      expect(second.progress.metadata?.captureTimeCount).toBe(3);
      expect(metadataProbe.probe).toHaveBeenCalledTimes(6);
      expect(proposals).toHaveLength(2);
      expect(new Set(proposals[1]?.captureTimes.map(({ photoId }) => photoId))).toEqual(firstPhotoIds);
    } finally {
      repository.close();
    }
  });

  it('prd_fr_007__gps_does_not_match_geometry__scan__reports_summary_without_staging_an_empty_proposal', async () => {
    const { root } = await buildFileTree();
    const repository = new RecordingRepository();
    const metadataProbe: PhotoMetadataProbe = {
      probe: vi.fn(async () => ({
        hasExif: true,
        gps: { latitude: 0, longitude: 0, mapDatum: 'WGS-84' },
        captureTime: null,
      })),
    };
    const locationResolver: GpsLocationResolver = {
      resolveGps: vi.fn(() => null),
    };
    const onLocationProposal = vi.fn();
    const scanner = new LibraryScanner(repository, validProbe, metadataProbe, locationResolver);

    const result = await scanner.scan('source-1', root, new AbortController().signal, {
      gpsMetadataPolicy: 'probe-and-resolve',
      onProgress: () => undefined,
      onLocationProposal,
    });

    expect(result.progress.metadata).toEqual({
      examined: 3,
      exifCount: 3,
      gpsCount: 3,
      resolvedLocationCount: 0,
      captureTimeCount: 0,
      metadataErrorCount: 0,
    });
    expect(metadataProbe.probe).toHaveBeenCalledTimes(3);
    expect(locationResolver.resolveGps).toHaveBeenCalledTimes(3);
    expect(onLocationProposal).not.toHaveBeenCalled();
  });

  it('prd_us_001__first_scan__successful_photos__commit_first_then_bounded_batches_before_terminal', async () => {
    const fixture = await fixtureRoot();
    const root = path.join(fixture, 'library');
    await mkdir(root, { recursive: true });
    const fileCount = PROGRESSIVE_SCAN_BATCH_SIZE + 2;
    await Promise.all(Array.from({ length: fileCount }, (_, index) =>
      writeFile(
        path.join(root, `${String(index).padStart(2, '0')}.jpg`),
        Buffer.from(`photo-${index}`),
      )));
    const repository = new RecordingRepository();
    const visible = new Set<string>();
    const visibleAtCommit: Array<{ committed: number; visible: number }> = [];
    let lastCommitCount = 0;
    let visibleAtTerminal = 0;
    repository.reconcileScan = (_sourceId, _runId, files, complete) => {
      repository.reconcileCalls.push({ files: [...files], complete });
      repository.reconciled = files;
      repository.complete = complete;
      for (const file of files) visible.add(file.canonicalPathKey);
      return { indexed: files.length, changed: files.length > 0 };
    };

    const scanner = new LibraryScanner(repository, validProbe);
    await scanner.scan('source-1', root, new AbortController().signal, {
      gpsMetadataPolicy: 'skip',
      onProgress: (scanProgress) => {
        const commitCount = scanProgress.catalogCommitCount ?? 0;
        if (scanProgress.status === 'running' && commitCount > lastCommitCount) {
          visibleAtCommit.push({ committed: commitCount, visible: visible.size });
          lastCommitCount = commitCount;
        }
        if (scanProgress.status === 'succeeded') visibleAtTerminal = visible.size;
      },
    });

    expect(visibleAtCommit).toEqual([
      { committed: 1, visible: 1 },
      { committed: PROGRESSIVE_SCAN_BATCH_SIZE + 1, visible: PROGRESSIVE_SCAN_BATCH_SIZE + 1 },
    ]);
    expect(visibleAtTerminal).toBe(fileCount);
    expect(repository.reconcileCalls.map(({ files, complete }) => ({ count: files.length, complete })))
      .toEqual([
        { count: 1, complete: false },
        { count: PROGRESSIVE_SCAN_BATCH_SIZE, complete: false },
        { count: 1, complete: false },
        { count: fileCount, complete: true },
      ]);
  });

  it('prd_us_002__rename_then_copy__rescans__preserves_tags_only_for_the_unique_move', async () => {
    const fixture = await fixtureRoot();
    const root = path.join(fixture, 'library');
    await mkdir(root, { recursive: true });
    const originalPath = path.join(root, 'original.jpg');
    const renamedPath = path.join(root, 'renamed.jpg');
    const copyPath = path.join(root, 'copy.jpg');
    await writeFile(originalPath, Buffer.from('stable-photo-content'));

    const repository = await NodeSqliteCatalogRepository.open(path.join(fixture, 'catalog.sqlite'));
    try {
      const source = repository.activateSource(root);
      const scanner = new LibraryScanner(repository, validProbe);
      await scanner.scan(source.sourceId, root, new AbortController().signal, {
        gpsMetadataPolicy: 'skip',
        onProgress: () => undefined,
      });
      const original = repository.getLibrarySnapshot().photos[0];
      expect(original).toBeDefined();
      repository.updateLocations(
        [original!.photoId],
        { provinceGb: '110000' },
        'user_action',
      );

      await rename(originalPath, renamedPath);
      await scanner.scan(source.sourceId, root, new AbortController().signal, {
        gpsMetadataPolicy: 'skip',
        onProgress: () => undefined,
      });
      const moved = repository.getLibrarySnapshot().photos;
      expect(moved).toHaveLength(1);
      expect(moved[0]?.photoId).toBe(original!.photoId);
      expect(moved[0]?.location).toEqual({ provinceGb: '110000' });

      await copyFile(renamedPath, copyPath);
      await scanner.scan(source.sourceId, root, new AbortController().signal, {
        gpsMetadataPolicy: 'skip',
        onProgress: () => undefined,
      });
      const afterCopy = repository.getLibrarySnapshot().photos;
      expect(afterCopy).toHaveLength(2);
      expect(afterCopy.find((photo) => photo.photoId === original!.photoId)?.location)
        .toEqual({ provinceGb: '110000' });
      const independentCopy = afterCopy.find((photo) => photo.photoId !== original!.photoId);
      expect(independentCopy?.location).toBeNull();
    } finally {
      repository.close();
    }
  });
});
