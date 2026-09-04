import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, (request: Request) => Promise<Response>>();
  return {
    handlers,
    handle: vi.fn((scheme: string, handler: (request: Request) => Promise<Response>) => {
      handlers.set(scheme, handler);
    }),
    registerSchemesAsPrivileged: vi.fn(),
  };
});

vi.mock('electron', () => ({
  protocol: {
    handle: electronMocks.handle,
    registerSchemesAsPrivileged: electronMocks.registerSchemesAsPrivileged,
  },
}));

import type { PhotoFileRecord } from '../../src/main/infrastructure/sqlite/catalog-repository';
import { registerControlledProtocols } from '../../src/main/infrastructure/media-protocol/register-protocols';

function protocolRequest(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

async function responseBytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

async function mediaRecord(
  rootPath: string,
  absolutePath: string,
  mediaKind: PhotoFileRecord['mediaKind'],
  mediaFormat: PhotoFileRecord['mediaFormat'],
  companionAbsolutePath: string | null = null,
): Promise<PhotoFileRecord> {
  const stats = await lstat(absolutePath);
  const companionStats = companionAbsolutePath === null ? null : await lstat(companionAbsolutePath);
  return {
    photoId: path.basename(absolutePath),
    absolutePath,
    rootPath,
    lifecycleState: 'active',
    contentSha256: null,
    fileSize: stats.size,
    modifiedAtMs: stats.mtimeMs,
    mediaKind,
    mediaFormat,
    companionAbsolutePath,
    companionFileSize: companionStats?.size ?? null,
    companionModifiedAtMs: companionStats?.mtimeMs ?? null,
  };
}

function mp4Bytes(marker = 'motion'): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x10]),
    Buffer.from('ftypisom', 'ascii'),
    Buffer.from(marker, 'ascii'),
  ]);
}

function isoBox(type: string, payload: Buffer): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

function verifiedMp4Bytes(): Buffer {
  return Buffer.concat([
    isoBox('ftyp', Buffer.from('isom\x00\x00\x00\x00isom', 'binary')),
    isoBox('moov', Buffer.alloc(8, 0)),
    isoBox('mdat', Buffer.from('generic-motion-video', 'ascii')),
  ]);
}

function genericAndroidMotionContainer(video: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]),
    video,
    Buffer.from('private-vendor-tail', 'ascii'),
  ]);
}

function androidMotionContainer(
  video: Buffer,
  totalLength = 256,
  mimeType: 'video/mp4' | 'video/quicktime' = 'video/mp4',
): Buffer {
  const xmp = Buffer.from(
    `<rdf:Description Camera:MotionPhoto="1"/><rdf:li Item:Semantic="MotionPhoto" Item:Mime="${mimeType}" Item:Length="${video.length}"/>`,
    'utf8',
  );
  const paddingLength = totalLength - xmp.length - video.length;
  if (paddingLength < 0) throw new Error('Android motion fixture is larger than its target container');
  return Buffer.concat([xmp, Buffer.alloc(paddingLength, 0x20), video]);
}

describe('controlled protocols', () => {
  it('serves canonical GeoJSON only from the user map directory and observes readiness dynamically', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photomap-asset-protocol-'));
    const assetRoot = path.join(root, 'packaged-assets');
    const mapDataRoot = path.join(root, 'user-data', 'map-data', 'v1');
    const packagedMapDirectory = path.join(assetRoot, 'map');
    const provincePath = path.join(mapDataRoot, 'china-provinces.geojson');
    const terrainPath = path.join(packagedMapDirectory, 'terrain.png');
    const provinceBytes = Buffer.from('{"type":"FeatureCollection","features":[]}\n', 'utf8');
    const terrainBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await Promise.all([
      mkdir(mapDataRoot, { recursive: true }),
      mkdir(packagedMapDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(provincePath, provinceBytes),
      writeFile(terrainPath, terrainBytes),
    ]);
    let mapAvailable = false;

    try {
      registerControlledProtocols(
        {} as never,
        assetRoot,
        mapDataRoot,
        {} as never,
        () => mapAvailable,
      );
      const handler = electronMocks.handlers.get('photomap-asset');
      expect(handler).toBeDefined();

      const unavailable = await handler!(protocolRequest('photomap-asset://data/china-provinces.geojson'));
      expect(unavailable.status).toBe(409);

      mapAvailable = true;
      const province = await handler!(protocolRequest('photomap-asset://data/china-provinces.geojson'));
      expect(province.status).toBe(200);
      expect(province.headers.get('content-length')).toBe(String(provinceBytes.length));
      expect(await responseBytes(province)).toEqual(provinceBytes);

      const nonCanonical = await handler!(protocolRequest('photomap-asset://data/renamed.geojson'));
      expect(nonCanonical.status).toBe(404);

      const terrain = await handler!(protocolRequest('photomap-asset://map/terrain.png'));
      expect(terrain.status).toBe(200);
      expect(await responseBytes(terrain)).toEqual(terrainBytes);

      mapAvailable = false;
      const unavailableAgain = await handler!(protocolRequest('photomap-asset://data/china-provinces.geojson'));
      expect(unavailableAgain.status).toBe(409);
    } finally {
      expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root).startsWith('photomap-asset-protocol-')).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serves regular video GET and HEAD requests with one seekable byte range', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photomap-media-range-'));
    const videoPath = path.join(root, 'clip.mp4');
    const heifPath = path.join(root, 'still.heif');
    const videoBytes = Buffer.from('0123456789', 'ascii');
    const heifBytes = Buffer.from('heif-still', 'ascii');
    await Promise.all([writeFile(videoPath, videoBytes), writeFile(heifPath, heifBytes)]);

    try {
      const record = await mediaRecord(root, videoPath, 'video', 'mp4');
      const heifRecord = await mediaRecord(root, heifPath, 'photo', 'heic');
      registerControlledProtocols(
        {
          getMediaRecord: (photoId: string) => (
            photoId === 'video' ? record : photoId === 'heif' ? heifRecord : null
          ),
        } as never,
        root,
        root,
        {} as never,
        () => true,
      );
      const handler = electronMocks.handlers.get('photomap-media');
      expect(handler).toBeDefined();

      const complete = await handler!(protocolRequest('photomap-media://photo/video'));
      expect(complete.status).toBe(200);
      expect(complete.headers.get('content-type')).toBe('video/mp4');
      expect(complete.headers.get('accept-ranges')).toBe('bytes');
      expect(complete.headers.get('content-length')).toBe(String(videoBytes.length));
      expect(await responseBytes(complete)).toEqual(videoBytes);

      const heif = await handler!(protocolRequest('photomap-media://photo/heif'));
      expect(heif.status).toBe(200);
      expect(heif.headers.get('content-type')).toBe('image/heic');
      expect(await responseBytes(heif)).toEqual(heifBytes);

      const partial = await handler!(protocolRequest('photomap-media://photo/video', {
        headers: { Range: 'bytes=2-5' },
      }));
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(partial.headers.get('content-length')).toBe('4');
      expect((await responseBytes(partial)).toString('ascii')).toBe('2345');

      const suffix = await handler!(protocolRequest('photomap-media://photo/video', {
        headers: { Range: 'bytes=-3' },
      }));
      expect(suffix.status).toBe(206);
      expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10');
      expect((await responseBytes(suffix)).toString('ascii')).toBe('789');

      const head = await handler!(protocolRequest('photomap-media://photo/video', {
        method: 'HEAD',
        headers: { Range: 'bytes=4-' },
      }));
      expect(head.status).toBe(200);
      expect(head.headers.get('content-range')).toBeNull();
      expect(head.headers.get('content-length')).toBe('10');
      expect(await responseBytes(head)).toHaveLength(0);

      const multipleRanges = await handler!(protocolRequest('photomap-media://photo/video', {
        headers: { Range: 'bytes=0-1,4-5' },
      }));
      expect(multipleRanges.status).toBe(416);
      expect(multipleRanges.headers.get('content-range')).toBe('bytes */10');

      const unknownRangeUnit = await handler!(protocolRequest('photomap-media://photo/video', {
        headers: { Range: 'items=2-5' },
      }));
      expect(unknownRangeUnit.status).toBe(200);
      expect(unknownRangeUnit.headers.get('content-range')).toBeNull();
      expect(await responseBytes(unknownRangeUnit)).toEqual(videoBytes);

      const outside = await handler!(protocolRequest('photomap-media://photo/video', {
        headers: { Range: 'bytes=10-' },
      }));
      expect(outside.status).toBe(416);
      expect(outside.headers.get('content-range')).toBe('bytes */10');

      const post = await handler!(protocolRequest('photomap-media://photo/video', { method: 'POST' }));
      expect(post.status).toBe(405);
      expect(post.headers.get('allow')).toBe('GET, HEAD');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serves Apple companions and Android embedded payloads as live motion content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photomap-media-motion-'));
    const appleStillPath = path.join(root, 'apple.jpg');
    const appleMotionPath = path.join(root, 'apple.mov');
    const androidPath = path.join(root, 'android.jpg');
    const androidQuickTimePath = path.join(root, 'android-quicktime.jpg');
    const androidGenericPath = path.join(root, 'android-generic.jpg');
    const videoPath = path.join(root, 'regular.mp4');
    const appleMotionBytes = Buffer.from('apple-live-motion', 'ascii');
    const androidMotionBytes = mp4Bytes('android-live');
    const androidGenericMotionBytes = verifiedMp4Bytes();
    await Promise.all([
      writeFile(appleStillPath, Buffer.from('apple-still', 'ascii')),
      writeFile(appleMotionPath, appleMotionBytes),
      writeFile(androidPath, androidMotionContainer(androidMotionBytes)),
      writeFile(androidQuickTimePath, androidMotionContainer(androidMotionBytes, 256, 'video/quicktime')),
      writeFile(androidGenericPath, genericAndroidMotionContainer(androidGenericMotionBytes)),
      writeFile(videoPath, mp4Bytes('regular')),
    ]);

    try {
      const records = new Map<string, PhotoFileRecord>([
        ['apple', await mediaRecord(root, appleStillPath, 'live', 'jpg', appleMotionPath)],
        ['android', await mediaRecord(root, androidPath, 'live', 'jpg')],
        ['android-quicktime', await mediaRecord(root, androidQuickTimePath, 'live', 'jpg')],
        ['android-generic', await mediaRecord(root, androidGenericPath, 'live', 'jpg')],
        ['video', await mediaRecord(root, videoPath, 'video', 'mp4')],
      ]);
      registerControlledProtocols(
        { getMediaRecord: (photoId: string) => records.get(photoId) ?? null } as never,
        root,
        root,
        {} as never,
        () => true,
      );
      const handler = electronMocks.handlers.get('photomap-media');
      expect(handler).toBeDefined();

      const apple = await handler!(protocolRequest('photomap-media://photo/apple?content=motion'));
      expect(apple.status).toBe(200);
      expect(apple.headers.get('content-type')).toBe('video/quicktime');
      expect(await responseBytes(apple)).toEqual(appleMotionBytes);

      const android = await handler!(protocolRequest('photomap-media://photo/android?content=motion'));
      expect(android.status).toBe(200);
      expect(android.headers.get('content-type')).toBe('video/mp4');
      expect(android.headers.get('content-length')).toBe(String(androidMotionBytes.length));
      expect(await responseBytes(android)).toEqual(androidMotionBytes);

      const androidQuickTime = await handler!(protocolRequest('photomap-media://photo/android-quicktime?content=motion'));
      expect(androidQuickTime.status).toBe(200);
      expect(androidQuickTime.headers.get('content-type')).toBe('video/quicktime');
      expect(await responseBytes(androidQuickTime)).toEqual(androidMotionBytes);

      const androidGeneric = await handler!(protocolRequest('photomap-media://photo/android-generic?content=motion'));
      expect(androidGeneric.status).toBe(200);
      expect(androidGeneric.headers.get('content-type')).toBe('video/mp4');
      expect(androidGeneric.headers.get('content-length')).toBe(String(androidGenericMotionBytes.length));
      expect(await responseBytes(androidGeneric)).toEqual(androidGenericMotionBytes);

      const androidRange = await handler!(protocolRequest('photomap-media://photo/android?content=motion', {
        headers: { Range: 'bytes=4-7' },
      }));
      expect(androidRange.status).toBe(206);
      expect(androidRange.headers.get('content-range')).toBe(`bytes 4-7/${androidMotionBytes.length}`);
      expect((await responseBytes(androidRange)).toString('ascii')).toBe('ftyp');

      const replacementMotionBytes = mp4Bytes('android-live-replacement');
      await writeFile(androidPath, androidMotionContainer(replacementMotionBytes));
      const changedAt = new Date(Date.now() + 10_000);
      await utimes(androidPath, changedAt, changedAt);
      const changedAndroid = await handler!(protocolRequest('photomap-media://photo/android?content=motion'));
      expect(changedAndroid.status).toBe(200);
      expect(await responseBytes(changedAndroid)).toEqual(replacementMotionBytes);

      const regularVideoMotion = await handler!(protocolRequest('photomap-media://photo/video?content=motion'));
      expect(regularVideoMotion.status).toBe(404);

      const mixedContent = await handler!(protocolRequest('photomap-media://photo/android?content=motion&size=thumb'));
      expect(mixedContent.status).toBe(400);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
