import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { isPathWithin, resolveRegularFileWithin } from '../filesystem/path-policy';
import type { NodeSqliteCatalogRepository } from '../sqlite/catalog-repository';
import {
  CITY_MAP_DATA_CONTRACT,
  PROVINCE_MAP_DATA_CONTRACT,
} from '../../services/map-data/map-data-contract';
import {
  detectAndroidMotionPhotoFile,
  type AndroidMotionPhotoInfo,
} from '../../services/library-scan/media-classification';
import type { ThumbnailCache } from '../../services/thumbnails/thumbnail-cache';

const ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.json', '.geojson', '.woff', '.woff2']);
const ASSET_HOSTS = new Set(['data', 'map', 'photos', 'root']);
const MAP_DATA_ASSET_FILES = new Set([
  PROVINCE_MAP_DATA_CONTRACT.canonicalFileName,
  CITY_MAP_DATA_CONTRACT.canonicalFileName,
]);
const ANDROID_MOTION_CACHE_LIMIT = 32;

interface FileWindow {
  offset: number;
  length: number;
  contentType?: string;
}

interface ByteRange {
  start: number;
  end: number;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'photomap-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  },
  {
    scheme: 'photomap-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
]);

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLocaleLowerCase('en-US');
  switch (extension) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.heic':
    case '.heif':
      return 'image/heic';
    case '.avif':
      return 'image/avif';
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.json':
    case '.geojson':
      return 'application/json; charset=utf-8';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function requestMethod(request: Request): string {
  return typeof request.method === 'string' && request.method.length > 0
    ? request.method.toLocaleUpperCase('en-US')
    : 'GET';
}

function requestRange(request: Request): string | null {
  const headers = request.headers as Headers | undefined;
  return typeof headers?.get === 'function' ? headers.get('range') : null;
}

function parseSingleRange(value: string | null, totalLength: number): ByteRange | null | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  if (!/^bytes=/iu.test(normalized)) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(normalized);
  if (!match || (match[1] === '' && match[2] === '') || totalLength <= 0) return null;

  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, totalLength - suffixLength),
      end: totalLength - 1,
    };
  }

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalLength) return null;
  const requestedEnd = match[2] === '' ? totalLength - 1 : Number(match[2]);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, totalLength - 1) };
}

function responseHeaders(mimeType: string, contentLength: number): Headers {
  return new Headers({
    'Content-Type': mimeType,
    'Content-Length': String(contentLength),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  });
}

function methodNotAllowedResponse(): Response {
  return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
}

async function fileResponse(
  filePath: string,
  request: Request,
  window?: FileWindow,
): Promise<Response> {
  const method = requestMethod(request);
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowedResponse();

  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) return new Response(null, { status: 404 });
  const offset = window?.offset ?? 0;
  const totalLength = window?.length ?? stats.size;
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(totalLength)
    || offset < 0
    || totalLength < 0
    || !Number.isSafeInteger(offset + totalLength)
    || offset + totalLength > stats.size
  ) {
    return new Response(null, { status: 404 });
  }

  const mimeType = window?.contentType ?? contentType(filePath);
  const range = parseSingleRange(method === 'GET' ? requestRange(request) : null, totalLength);
  if (range === null) {
    const headers = responseHeaders(mimeType, 0);
    headers.set('Content-Range', `bytes */${totalLength}`);
    return new Response(null, { status: 416, headers });
  }

  const selected = range ?? { start: 0, end: totalLength - 1 };
  const responseLength = totalLength === 0 ? 0 : selected.end - selected.start + 1;
  const headers = responseHeaders(mimeType, responseLength);
  const status = range === undefined ? 200 : 206;
  if (range !== undefined) headers.set('Content-Range', `bytes ${selected.start}-${selected.end}/${totalLength}`);
  if (method === 'HEAD' || responseLength === 0) return new Response(null, { status, headers });

  const stream = createReadStream(filePath, {
    start: offset + selected.start,
    end: offset + selected.end,
  });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
}

export function registerControlledProtocols(
  repository: NodeSqliteCatalogRepository,
  assetRoot: string,
  mapDataRoot: string,
  thumbnailCache: ThumbnailCache,
  mapAvailable: () => boolean
): void {
  const androidMotionCache = new Map<string, Promise<AndroidMotionPhotoInfo | null>>();
  const androidMotionInfo = async (filePath: string): Promise<AndroidMotionPhotoInfo | null> => {
    const stats = await lstat(filePath);
    const cacheKey = `${filePath}\u0000${stats.size}\u0000${stats.mtimeMs}`;
    const cached = androidMotionCache.get(cacheKey);
    if (cached !== undefined) {
      androidMotionCache.delete(cacheKey);
      androidMotionCache.set(cacheKey, cached);
      return await cached;
    }

    const pending = detectAndroidMotionPhotoFile(filePath);
    androidMotionCache.set(cacheKey, pending);
    while (androidMotionCache.size > ANDROID_MOTION_CACHE_LIMIT) {
      const oldestKey = androidMotionCache.keys().next().value;
      if (oldestKey === undefined) break;
      androidMotionCache.delete(oldestKey);
    }
    try {
      return await pending;
    } catch (error) {
      androidMotionCache.delete(cacheKey);
      throw error;
    }
  };

  protocol.handle('photomap-media', async (request) => {
    try {
      if (requestMethod(request) !== 'GET' && requestMethod(request) !== 'HEAD') {
        return methodNotAllowedResponse();
      }
      const url = new URL(request.url);
      if (url.hostname !== 'photo') {
        return new Response(null, { status: 404 });
      }
      const photoId = decodeURIComponent(url.pathname.slice(1));
      if (photoId.length === 0 || photoId.length > 128 || photoId.includes('/')) {
        return new Response(null, { status: 400 });
      }
      const record = repository.getMediaRecord(photoId);
      if (record === null) {
        return new Response(null, { status: 404 });
      }
      const safePath = await resolveRegularFileWithin(record.rootPath, record.absolutePath);
      const thumbnailRequested = url.searchParams.size === 1 && url.searchParams.get('size') === 'thumb';
      const motionRequested = url.searchParams.size === 1 && url.searchParams.get('content') === 'motion';
      if (url.searchParams.size > 0 && !thumbnailRequested && !motionRequested) {
        return new Response(null, { status: 400 });
      }
      if (thumbnailRequested) {
        return await fileResponse(await thumbnailCache.getOrCreate(safePath, record), request);
      }
      if (!motionRequested) return await fileResponse(safePath, request);
      if (record.mediaKind !== 'live') return new Response(null, { status: 404 });

      if (record.companionAbsolutePath !== null) {
        const companionPath = await resolveRegularFileWithin(record.rootPath, record.companionAbsolutePath);
        return await fileResponse(companionPath, request);
      }
      const motion = await androidMotionInfo(safePath);
      if (motion === null) return new Response(null, { status: 404 });
      return await fileResponse(safePath, request, {
        offset: motion.videoStart,
        length: motion.videoLength,
        contentType: motion.videoContentType,
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  protocol.handle('photomap-asset', async (request) => {
    try {
      if (requestMethod(request) !== 'GET' && requestMethod(request) !== 'HEAD') {
        return methodNotAllowedResponse();
      }
      const url = new URL(request.url);
      if (!ASSET_HOSTS.has(url.hostname)) {
        return new Response(null, { status: 404 });
      }
      if (!mapAvailable() && url.hostname === 'data') {
        return new Response(null, { status: 409 });
      }
      const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (url.hostname === 'data' && !MAP_DATA_ASSET_FILES.has(pathname)) {
        return new Response(null, { status: 404 });
      }
      const root = url.hostname === 'data' ? mapDataRoot : assetRoot;
      const relativePath = url.hostname === 'root' || url.hostname === 'data'
        ? pathname
        : path.join(url.hostname, pathname);
      if (relativePath.length === 0 || !ASSET_EXTENSIONS.has(path.extname(relativePath).toLocaleLowerCase('en-US'))) {
        return new Response(null, { status: 404 });
      }
      const canonicalRoot = await realpath(root);
      const candidate = path.resolve(canonicalRoot, relativePath);
      const stats = await lstat(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return new Response(null, { status: 404 });
      }
      const canonicalCandidate = await realpath(candidate);
      if (!isPathWithin(canonicalRoot, canonicalCandidate)) {
        return new Response(null, { status: 404 });
      }
      return await fileResponse(canonicalCandidate, request);
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
