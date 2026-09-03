import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { nativeImage } from 'electron';
import { PhotoMapError } from '../../../shared/errors';
import type { PhotoFileRecord } from '../../infrastructure/sqlite/catalog-repository';

const THUMBNAIL_MAX_EDGE = 512;
const THUMBNAIL_VERSION = 'v2';

export class ThumbnailCache {
  public constructor(private readonly cacheRoot: string) {}

  public async getOrCreate(sourcePath: string, record: PhotoFileRecord): Promise<string> {
    await mkdir(this.cacheRoot, { recursive: true });
    const identity = record.contentSha256 ?? `${record.fileSize}:${record.modifiedAtMs}`;
    const key = createHash('sha256')
      .update(`${THUMBNAIL_VERSION}:${record.photoId}:${record.mediaKind}:${record.mediaFormat}:${identity}:${THUMBNAIL_MAX_EDGE}`)
      .digest('hex');
    const targetPath = path.join(this.cacheRoot, `${key}.jpg`);
    try {
      const targetStats = await stat(targetPath);
      if (targetStats.isFile()) {
        return targetPath;
      }
    } catch {
      // Cache misses are regenerated below.
    }

    let image = record.mediaKind === 'video'
      ? await nativeImage.createThumbnailFromPath(sourcePath, {
          width: THUMBNAIL_MAX_EDGE,
          height: THUMBNAIL_MAX_EDGE,
        })
      : nativeImage.createFromPath(sourcePath);
    if (image.isEmpty() && record.mediaKind !== 'video') {
      image = await nativeImage.createThumbnailFromPath(sourcePath, {
        width: THUMBNAIL_MAX_EDGE,
        height: THUMBNAIL_MAX_EDGE,
      });
    }
    if (image.isEmpty()) {
      throw new PhotoMapError('MEDIA_DECODE_FAILED', '无法生成媒体缩略图。', {
        retryability: 'retry',
        scope: 'item',
        affectedIds: [record.photoId]
      });
    }
    const size = image.getSize();
    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(size.width, size.height));
    const resized = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good'
    });
    const bytes = resized.toJPEG(84);
    const temporaryPath = path.join(this.cacheRoot, `.${key}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, 'wx');
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, targetPath);
      return targetPath;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await unlink(temporaryPath).catch(() => undefined);
      try {
        const targetStats = await stat(targetPath);
        if (targetStats.isFile()) {
          return targetPath;
        }
      } catch {
        // Preserve the original cache-write error.
      }
      throw new PhotoMapError('MEDIA_DECODE_FAILED', '无法保存媒体缩略图。', {
        retryability: 'retry',
        scope: 'item',
        affectedIds: [record.photoId],
        cause: error
      });
    }
  }
}
