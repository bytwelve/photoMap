import { consumeJpegChunk, createJpegParserState } from './jpeg-stream';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { isImageFormat, type MediaKind } from '../../../shared/contracts';
import type { FileCandidate } from '../../infrastructure/filesystem/enumerate-media';

const MAX_INSPECTION_BYTES = 1024 * 1024;
const MAX_SAMSUNG_SEF_BLOCK_BYTES = 64 * 1024;
const MAX_SAMSUNG_SEF_ENTRIES = 1024;
const MAX_SAMSUNG_FIELD_NAME_BYTES = 1024;
const MAX_ISO_BOX_COUNT = 4096;
const MAX_ISO_CANDIDATES = 64;
const ISO_SCAN_CHUNK_BYTES = 1024 * 1024;
const JPEG_SCAN_CHUNK_BYTES = 256 * 1024;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
const APPLE_MOV_IDENTIFIER = 'com.apple.quicktime.content.identifier';
const FTYP_MARKER = Buffer.from('ftyp', 'ascii');
const SAMSUNG_MOTION_PHOTO_DATA = 'MotionPhoto_Data';
const SAMSUNG_MOTION_PHOTO_TYPE = 0x0a30;

export interface AndroidMotionPhotoInfo {
  videoStart: number;
  videoLength: number;
  videoContentType: 'video/mp4' | 'video/quicktime';
}

interface MotionPhotoDirectoryItem {
  videoLength: number;
  videoContentType: AndroidMotionPhotoInfo['videoContentType'];
}

interface MotionPhotoMetadata {
  flag: 'absent' | 'disabled' | 'enabled';
  modernItem: MotionPhotoDirectoryItem | null | undefined;
  legacyLength: number | undefined;
}

interface SamsungSefEntry {
  blockStart: number;
  blockSize: number;
  type: number;
}

interface SamsungSefDirectory {
  directoryStart: number;
  entries: readonly SamsungSefEntry[];
}

interface InspectionBytes {
  bytes: Buffer;
  fileSize: number;
  tail: Buffer;
  tailStart: number;
}

export interface MediaInspection {
  androidMotionPhoto: AndroidMotionPhotoInfo | null;
  appleContentIds: readonly string[];
}

export interface MediaCandidate {
  primary: FileCandidate;
  companion?: FileCandidate;
  mediaKind: MediaKind;
  liveSource?: 'apple' | 'android';
}

export async function detectAndroidMotionPhotoFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<AndroidMotionPhotoInfo | null> {
  signal?.throwIfAborted();
  const inspection = await readInspectionBytes(filePath, signal);
  return detectAndroidMotionPhoto(
    filePath,
    inspection.bytes.toString('utf8'),
    inspection.fileSize,
    inspection.tail,
    inspection.tailStart,
    signal,
  );
}

export function groupMediaCandidates(
  candidates: readonly FileCandidate[],
  inspections: ReadonlyMap<string, MediaInspection>,
): MediaCandidate[] {
  const byPath = [...candidates].sort(compareCandidates);
  const used = new Set<string>();
  const result: MediaCandidate[] = [];

  for (const candidate of byPath) {
    const inspection = inspections.get(candidate.absolutePath);
    if (isImageFormat(candidate.mediaFormat) && inspection?.androidMotionPhoto) {
      used.add(candidate.absolutePath);
      result.push({ primary: candidate, mediaKind: 'live', liveSource: 'android' });
    }
  }

  const appleImages = byPath.filter((candidate) => (
    !used.has(candidate.absolutePath)
    && (candidate.mediaFormat === 'jpg' || candidate.mediaFormat === 'heic')
  ));
  const appleVideos = byPath.filter((candidate) => !used.has(candidate.absolutePath) && candidate.mediaFormat === 'mov');

  for (const still of appleImages) {
    if (used.has(still.absolutePath)) continue;
    const stillIds = new Set(inspections.get(still.absolutePath)?.appleContentIds ?? []);
    const idMatches = appleVideos.filter((motion) => (
      !used.has(motion.absolutePath)
      && (inspections.get(motion.absolutePath)?.appleContentIds ?? []).some((id) => stillIds.has(id))
    ));
    let motion = idMatches.length === 1 ? idMatches[0] : undefined;

    if (!motion && stillIds.size === 0) {
      const stemMatches = appleVideos.filter((candidate) => {
        if (used.has(candidate.absolutePath)) return false;
        const motionIds = inspections.get(candidate.absolutePath)?.appleContentIds ?? [];
        return motionIds.length === 0 && sameDirectoryAndStem(still, candidate);
      });
      if (stemMatches.length === 1) motion = stemMatches[0];
    }

    if (motion) {
      used.add(still.absolutePath);
      used.add(motion.absolutePath);
      result.push({ primary: still, companion: motion, mediaKind: 'live', liveSource: 'apple' });
    }
  }

  for (const candidate of byPath) {
    if (used.has(candidate.absolutePath)) continue;
    used.add(candidate.absolutePath);
    result.push({
      primary: candidate,
      mediaKind: isImageFormat(candidate.mediaFormat) ? 'photo' : 'video',
    });
  }

  return result.sort((left, right) => compareCandidates(left.primary, right.primary));
}

export async function classifyMediaCandidates(
  candidates: readonly FileCandidate[],
  signal: AbortSignal,
): Promise<MediaCandidate[]> {
  const inspections = new Map<string, MediaInspection>();
  for (const candidate of candidates) {
    if (signal.aborted) break;
    try {
      inspections.set(candidate.absolutePath, await inspectCandidate(candidate, signal));
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      inspections.set(candidate.absolutePath, { androidMotionPhoto: null, appleContentIds: [] });
    }
  }
  return groupMediaCandidates(candidates, inspections);
}

async function inspectCandidate(candidate: FileCandidate, signal: AbortSignal): Promise<MediaInspection> {
  signal.throwIfAborted();
  const inspection = await readInspectionBytes(candidate.absolutePath, signal);
  const appleContentIds = appleIdentifiers(inspection.bytes, candidate.mediaFormat === 'mov');
  if (!isImageFormat(candidate.mediaFormat)) {
    return { androidMotionPhoto: null, appleContentIds };
  }
  return {
    androidMotionPhoto: await detectAndroidMotionPhoto(
      candidate.absolutePath,
      inspection.bytes.toString('utf8'),
      inspection.fileSize,
      inspection.tail,
      inspection.tailStart,
      signal,
    ),
    appleContentIds,
  };
}

async function readInspectionBytes(
  filePath: string,
  signal?: AbortSignal,
): Promise<InspectionBytes> {
  const file = await open(filePath, 'r');
  try {
    const stats = await file.stat();
    const headLength = Math.min(MAX_INSPECTION_BYTES, stats.size);
    const head = Buffer.alloc(headLength);
    await file.read(head, 0, headLength, 0);
    if (stats.size <= MAX_INSPECTION_BYTES) {
      return { bytes: head, fileSize: stats.size, tail: head, tailStart: 0 };
    }
    signal?.throwIfAborted();
    const tailLength = Math.min(MAX_INSPECTION_BYTES, stats.size - headLength);
    const tail = Buffer.alloc(tailLength);
    const tailStart = stats.size - tailLength;
    await file.read(tail, 0, tailLength, tailStart);
    return { bytes: Buffer.concat([head, tail]), fileSize: stats.size, tail, tailStart };
  } finally {
    await file.close();
  }
}

async function detectAndroidMotionPhoto(
  filePath: string,
  text: string,
  fileSize: number,
  tail: Buffer,
  tailStart: number,
  signal?: AbortSignal,
): Promise<AndroidMotionPhotoInfo | null> {
  const metadata = motionPhotoMetadata(text);
  if (metadata.flag === 'disabled' || metadata.modernItem === null) return null;
  const samsungDirectory = parseSamsungSefDirectory(tail, tailStart, fileSize);
  const hasSamsungMotionEntry = samsungDirectory?.entries.some(({ type }) => type === SAMSUNG_MOTION_PHOTO_TYPE) === true;
  const allowGenericJpegStructure = isJpegPath(filePath);
  if (metadata.flag !== 'enabled' && !hasSamsungMotionEntry && !allowGenericJpegStructure) return null;

  const file = await open(filePath, 'r');
  try {
    if (samsungDirectory !== null) {
      const samsungMotion = await samsungMotionPhotoFromFile(file, samsungDirectory, signal);
      if (samsungMotion !== null) return samsungMotion;
    }

    const declared = declaredMotionPhotoInfo(fileSize, metadata);
    if (declared !== null && await fileHasIsoBaseMediaHeader(file, declared.videoStart, declared.videoLength, signal)) {
      const structuralEnd = await verifiedIsoVideoEndFile(
        file,
        declared.videoStart,
        declared.videoStart + declared.videoLength,
        signal,
      );
      return structuralEnd === null
        ? declared
        : { ...declared, videoLength: structuralEnd - declared.videoStart };
    }

    return await findVerifiedIsoVideoFile(
      file,
      samsungDirectory?.directoryStart ?? fileSize,
      metadata.modernItem?.videoContentType ?? 'video/mp4',
      allowGenericJpegStructure,
      signal,
    );
  } finally {
    await file.close();
  }
}

function appleIdentifiers(bytes: Buffer, requireMovMarker: boolean): string[] {
  const text = bytes.toString('latin1');
  if (requireMovMarker && !text.includes(APPLE_MOV_IDENTIFIER)) return [];
  const matches = text.match(UUID_PATTERN) ?? [];
  return [...new Set(matches.map((value) => value.toLocaleLowerCase('en-US')))];
}

function motionPhotoMetadata(text: string): MotionPhotoMetadata {
  const explicitMotionValue = propertyInteger(text, 'MotionPhoto');
  const legacyMotionValue = propertyInteger(text, 'MicroVideo');
  const flag = explicitMotionValue !== undefined
    ? explicitMotionValue === 1 ? 'enabled' : 'disabled'
    : legacyMotionValue !== undefined
      ? legacyMotionValue === 1 ? 'enabled' : 'disabled'
      : 'absent';
  return {
    flag,
    modernItem: modernMotionPhotoItem(text),
    legacyLength: propertyInteger(text, 'MicroVideoOffset'),
  };
}

function declaredMotionPhotoInfo(
  fileSize: number,
  metadata: MotionPhotoMetadata,
): AndroidMotionPhotoInfo | null {
  const videoLength = metadata.modernItem?.videoLength ?? metadata.legacyLength;
  const videoContentType = metadata.modernItem?.videoContentType
    ?? (metadata.legacyLength === undefined ? undefined : 'video/mp4');
  if (
    videoLength === undefined
    || videoContentType === undefined
    || videoLength <= 8
    || videoLength > fileSize
  ) {
    return null;
  }
  return { videoStart: fileSize - videoLength, videoLength, videoContentType };
}

function parseSamsungSefDirectory(
  bytes: Buffer,
  bytesStart: number,
  fileEnd: number,
): SamsungSefDirectory | null {
  if (bytesStart < 0 || bytesStart + bytes.length !== fileEnd) return null;
  let blockEnd = fileEnd;

  for (let blockIndex = 0; blockIndex < 8; blockIndex += 1) {
    const footerStart = blockEnd - 8;
    const footerOffset = footerStart - bytesStart;
    if (footerOffset < 0 || footerOffset + 8 > bytes.length) return null;
    const blockLength = bytes.readUInt32LE(footerOffset);
    const blockType = bytes.toString('ascii', footerOffset + 4, footerOffset + 8);
    if (
      blockLength < 4
      || blockLength >= MAX_SAMSUNG_SEF_BLOCK_BYTES
      || !/^\w{4}$/u.test(blockType)
    ) {
      return null;
    }
    const blockStart = footerStart - blockLength;
    const blockOffset = blockStart - bytesStart;
    if (blockStart < 0 || blockOffset < 0 || blockOffset + blockLength > bytes.length) return null;

    if (blockType !== 'SEFT') {
      blockEnd = blockStart;
      continue;
    }
    if (blockLength < 12 || bytes.toString('ascii', blockOffset, blockOffset + 4) !== 'SEFH') return null;
    const entryCount = bytes.readUInt32LE(blockOffset + 8);
    if (
      entryCount > MAX_SAMSUNG_SEF_ENTRIES
      || 12 + entryCount * 12 > blockLength
    ) {
      return null;
    }

    const entries: SamsungSefEntry[] = [];
    for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
      const entryOffset = blockOffset + 12 + entryIndex * 12;
      const type = bytes.readUInt16LE(entryOffset + 2);
      const negativeOffset = bytes.readUInt32LE(entryOffset + 4);
      const blockSize = bytes.readUInt32LE(entryOffset + 8);
      if (
        negativeOffset > blockStart
        || blockSize > negativeOffset
        || blockSize < 8
      ) {
        return null;
      }
      entries.push({
        blockStart: blockStart - negativeOffset,
        blockSize,
        type,
      });
    }
    return { directoryStart: blockStart, entries };
  }
  return null;
}

async function samsungMotionPhotoFromFile(
  file: FileHandle,
  directory: SamsungSefDirectory,
  signal?: AbortSignal,
): Promise<AndroidMotionPhotoInfo | null> {
  for (const entry of directory.entries) {
    if (entry.type !== SAMSUNG_MOTION_PHOTO_TYPE) continue;
    const header = await readFileSlice(
      file,
      entry.blockStart,
      Math.min(entry.blockSize, 8 + MAX_SAMSUNG_FIELD_NAME_BYTES),
      signal,
    );
    if (header === null || header.length < 8) continue;
    if (header.readUInt16LE(2) !== entry.type) continue;
    const nameLength = header.readUInt32LE(4);
    if (nameLength > MAX_SAMSUNG_FIELD_NAME_BYTES || nameLength + 8 > entry.blockSize) continue;
    const nameBytes = nameLength + 8 <= header.length
      ? header
      : await readFileSlice(file, entry.blockStart, nameLength + 8, signal);
    if (nameBytes === null) continue;
    const name = nameBytes.toString('ascii', 8, 8 + nameLength);
    if (name !== SAMSUNG_MOTION_PHOTO_DATA) continue;
    const videoStart = entry.blockStart + 8 + nameLength;
    const videoLength = entry.blockSize - 8 - nameLength;
    if (videoLength <= 8) continue;
    if (await fileHasIsoBaseMediaHeader(file, videoStart, videoLength, signal)) {
      return { videoStart, videoLength, videoContentType: 'video/mp4' };
    }
  }
  return null;
}

async function jpegEndOffsetFile(
  file: FileHandle,
  limit: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const state = createJpegParserState();
  let position = 0;
  while (position < limit) {
    signal?.throwIfAborted();
    const requested = Math.min(JPEG_SCAN_CHUNK_BYTES, limit - position);
    const chunk = Buffer.alloc(requested);
    const { bytesRead } = await file.read(chunk, 0, requested, position);
    if (bytesRead <= 0) break;
    const actualChunk = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
    const result = consumeJpegChunk(state, actualChunk, position);
    if (result.endOffset !== undefined) return result.endOffset;
    if (result.invalid === true) return null;
    position += bytesRead;
  }
  return null;
}

async function findVerifiedIsoVideoFile(
  file: FileHandle,
  scanEnd: number,
  videoContentType: AndroidMotionPhotoInfo['videoContentType'],
  requireJpegEnd: boolean,
  signal?: AbortSignal,
): Promise<AndroidMotionPhotoInfo | null> {
  const searchStart = requireJpegEnd
    ? await jpegEndOffsetFile(file, scanEnd, signal)
    : 0;
  if (searchStart === null) return null;
  const candidates = await findIsoBaseMediaCandidates(file, searchStart, scanEnd, signal);

  for (const videoStart of candidates) {
    const videoEnd = await verifiedIsoVideoEndFile(file, videoStart, scanEnd, signal);
    if (videoEnd !== null) {
      return { videoStart, videoLength: videoEnd - videoStart, videoContentType };
    }
  }
  return null;
}

async function findIsoBaseMediaCandidates(
  file: FileHandle,
  scanStart: number,
  scanEnd: number,
  signal?: AbortSignal,
): Promise<number[]> {
  const candidates: number[] = [];
  let carry = Buffer.alloc(0);
  let position = scanStart;

  while (position < scanEnd && candidates.length < MAX_ISO_CANDIDATES) {
    signal?.throwIfAborted();
    const requested = Math.min(ISO_SCAN_CHUNK_BYTES, scanEnd - position);
    const chunk = Buffer.alloc(requested);
    const { bytesRead } = await file.read(chunk, 0, requested, position);
    if (bytesRead <= 0) break;
    const actualChunk = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
    const combined = carry.length === 0 ? actualChunk : Buffer.concat([carry, actualChunk]);
    const combinedStart = position - carry.length;
    let markerOffset = combined.indexOf(FTYP_MARKER);
    while (markerOffset >= 0 && candidates.length < MAX_ISO_CANDIDATES) {
      const absoluteMarker = combinedStart + markerOffset;
      if (absoluteMarker >= scanStart + 4 && absoluteMarker < scanEnd) candidates.push(absoluteMarker - 4);
      markerOffset = combined.indexOf(FTYP_MARKER, markerOffset + FTYP_MARKER.length);
    }
    carry = combined.subarray(Math.max(0, combined.length - (FTYP_MARKER.length - 1)));
    position += bytesRead;
  }
  return [...new Set(candidates)];
}

async function verifiedIsoVideoEndFile(
  file: FileHandle,
  videoStart: number,
  scanEnd: number,
  signal?: AbortSignal,
): Promise<number | null> {
  if (videoStart < 0 || videoStart + 8 > scanEnd) return null;
  let cursor = videoStart;
  let boxCount = 0;
  let hasMovieMetadata = false;
  let hasMediaData = false;
  let verifiedEnd: number | null = null;

  while (cursor + 8 <= scanEnd && boxCount < MAX_ISO_BOX_COUNT) {
    const header = await readFileSlice(file, cursor, Math.min(16, scanEnd - cursor), signal);
    if (header === null || header.length < 8) break;
    const size32 = header.readUInt32BE(0);
    const type = header.toString('ascii', 4, 8);
    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1) {
      if (header.length < 16) break;
      const extendedSize = header.readBigUInt64BE(8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      boxSize = Number(extendedSize);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = scanEnd - cursor;
    }
    if (
      (boxCount === 0 && (
        type !== 'ftyp'
        || boxSize < headerSize + 8
        || (boxSize - headerSize) % 4 !== 0
      ))
      || !/^[\x20-\x7e]{4}$/u.test(type)
      || boxSize < headerSize
      || cursor + boxSize > scanEnd
    ) {
      break;
    }
    if (type === 'moov') hasMovieMetadata = true;
    if (type === 'mdat') hasMediaData = true;
    cursor += boxSize;
    boxCount += 1;
    if (hasMovieMetadata && hasMediaData) verifiedEnd = cursor;
    if (size32 === 0) break;
  }
  if (boxCount >= MAX_ISO_BOX_COUNT) return null;
  return verifiedEnd;
}

async function fileHasIsoBaseMediaHeader(
  file: FileHandle,
  videoStart: number,
  videoLength: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const probe = await readFileSlice(file, videoStart, Math.min(128, videoLength), signal);
  return probe !== null && hasIsoBaseMediaHeader(probe, 0);
}

async function readFileSlice(
  file: FileHandle,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) return null;
  signal?.throwIfAborted();
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, position);
  return bytesRead === length ? bytes : null;
}

function propertyInteger(text: string, localName: string): number | undefined {
  return attributeInteger(text, localName) ?? elementInteger(text, localName);
}

function elementInteger(text: string, localName: string): number | undefined {
  const qualifiedName = `(?:[A-Za-z_][A-Za-z0-9_.-]{0,63}:)?${localName}`;
  const pattern = new RegExp(
    `<${qualifiedName}(?:\\s[^>]*)?>\\s*(-?\\d+)\\s*</${qualifiedName}\\s*>`,
    'iu',
  );
  const match = pattern.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function attributeInteger(text: string, localName: string): number | undefined {
  const qualifiedName = `(?:[A-Za-z_][A-Za-z0-9_.-]{0,63}:)?${localName}`;
  const pattern = new RegExp(`(?<![A-Za-z0-9_.:-])${qualifiedName}\\s*=\\s*["'](-?\\d+)["']`, 'iu');
  const match = pattern.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function modernMotionPhotoItem(text: string): MotionPhotoDirectoryItem | null | undefined {
  const tags = text.match(/<[^>]+>/gu) ?? [];
  for (const tag of tags) {
    if (!/(?:\b|:)Semantic\s*=\s*["']MotionPhoto["']/iu.test(tag)) continue;
    const length = attributeInteger(tag, 'Length');
    const mime = attributeString(tag, 'Mime');
    if (
      length === undefined
      || (mime !== 'video/mp4' && mime !== 'video/quicktime')
    ) {
      return null;
    }
    return { videoLength: length, videoContentType: mime };
  }
  return undefined;
}

function attributeString(text: string, localName: string): string | undefined {
  const qualifiedName = `(?:[A-Za-z_][A-Za-z0-9_.-]{0,63}:)?${localName}`;
  const pattern = new RegExp(`(?<![A-Za-z0-9_.:-])${qualifiedName}\\s*=\\s*["']([^"']+)["']`, 'iu');
  return pattern.exec(text)?.[1]?.toLocaleLowerCase('en-US');
}

function hasIsoBaseMediaHeader(bytes: Buffer, start: number): boolean {
  const end = Math.min(bytes.length - 4, start + 64);
  for (let offset = Math.max(0, start); offset <= end; offset += 1) {
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'ftyp') return true;
  }
  return false;
}

function isJpegPath(filePath: string): boolean {
  const extension = path.extname(filePath).toLocaleLowerCase('en-US');
  return extension === '.jpg' || extension === '.jpeg';
}

function sameDirectoryAndStem(left: FileCandidate, right: FileCandidate): boolean {
  return path.dirname(left.absolutePath).toLocaleLowerCase('en-US') === path.dirname(right.absolutePath).toLocaleLowerCase('en-US')
    && path.parse(left.absolutePath).name.toLocaleLowerCase('en-US') === path.parse(right.absolutePath).name.toLocaleLowerCase('en-US');
}

function compareCandidates(left: FileCandidate, right: FileCandidate): number {
  return left.relativePath.localeCompare(right.relativePath, 'en-US', { sensitivity: 'base' });
}
