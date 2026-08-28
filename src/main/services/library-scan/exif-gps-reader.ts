import { consumeJpegChunk, createJpegParserState } from './jpeg-stream';
import { open, type FileHandle } from 'node:fs/promises';

import {
  errors as exifReaderErrors,
  load as loadExif,
  type ExpandedTags,
  type IncludeTagsOptions,
} from 'exifreader';

import type { CaptureTimeValue, ImageFormat } from '../../../shared/contracts';

export interface GpsCoordinates {
  latitude: number;
  longitude: number;
  mapDatum?: string;
}

export interface ExifGpsMetadata {
  hasExif: boolean;
  gps: GpsCoordinates | null;
  captureTime: CaptureTimeValue | null;
  metadataError?: boolean;
}

const PHOTO_EXIF_TAGS: IncludeTagsOptions = {
  exif: [
    'GPS Info IFD Pointer',
    'GPSLatitude',
    'GPSLatitudeRef',
    'GPSLongitude',
    'GPSLongitudeRef',
    'GPSMapDatum',
    'DateTimeOriginal',
    'OffsetTimeOriginal',
  ],
  gps: true,
};

const AUTO_LENGTH_NO_METADATA_PREFIX = 'length: "auto" could not locate metadata in this file';
const JPEG_SCAN_CHUNK_BYTES = 256 * 1024;
const MAX_VIVO_EMBEDDED_JPEG_BYTES = 64 * 1024 * 1024;
const VIVO_STREAM_DATA = Buffer.from('streamdata', 'ascii');
const VIVO_STREAM_INFO = Buffer.from('streaminfo', 'ascii');
const VIVO_STREAM_COUNT = Buffer.from('streamcount', 'ascii');
const VIVO_VENDOR_PREFIX = Buffer.from('vivo{', 'ascii');
const VIVO_TRAILER_INSPECTION_BYTES = 256;

interface CaptureTimeParseResult {
  captureTime: CaptureTimeValue | null;
  invalid: boolean;
}

class InvalidExifError extends Error {}

export async function readExifGps(
  filePath: string,
  _imageFormat: ImageFormat,
  signal?: AbortSignal,
): Promise<ExifGpsMetadata> {
  signal?.throwIfAborted();
  let metadata: ExifGpsMetadata;
  try {
    const tags = await loadExif(filePath, {
      expanded: true,
      includeOffsets: true,
      length: 'auto',
      includeTags: PHOTO_EXIF_TAGS,
    });
    signal?.throwIfAborted();
    metadata = parseExifReaderTags(tags);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    metadata = metadataFromReaderError(error);
  }

  if (_imageFormat !== 'jpg') return metadata;
  try {
    const embedded = await readVivoEmbeddedJpeg(filePath, signal);
    return metadataWithVivoCaptureTime(metadata, embedded);
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    return { ...metadata, metadataError: true };
  }
}

export class ExifGpsProbe {
  public probe(
    filePath: string,
    imageFormat: ImageFormat,
    signal?: AbortSignal,
  ): Promise<ExifGpsMetadata> {
    return readExifGps(filePath, imageFormat, signal);
  }
}

function parseExifReaderTags(tags: ExpandedTags): ExifGpsMetadata {
  const hasExif = tags.exif !== undefined
    || tags.metadataRange?.blocks.some((block) => block.type === 'exif') === true;
  if (!hasExif) {
    return { hasExif: false, gps: null, captureTime: null };
  }

  const parsedCaptureTime = parseCaptureTime(tags);
  const latitudeRefTag = tags.exif?.GPSLatitudeRef;
  const latitudeTag = tags.exif?.GPSLatitude;
  const longitudeRefTag = tags.exif?.GPSLongitudeRef;
  const longitudeTag = tags.exif?.GPSLongitude;
  const coordinateTags = [latitudeRefTag, latitudeTag, longitudeRefTag, longitudeTag];
  if (coordinateTags.every((tag) => tag === undefined)) {
    if (tags.exif?.['GPS Info IFD Pointer'] !== undefined) {
      return invalidMetadata(parsedCaptureTime.captureTime);
    }
    return {
      hasExif: true,
      gps: null,
      captureTime: parsedCaptureTime.captureTime,
      ...(parsedCaptureTime.invalid ? { metadataError: true } : {}),
    };
  }
  if (coordinateTags.some((tag) => tag === undefined)) {
    return invalidMetadata(parsedCaptureTime.captureTime);
  }

  try {
    const latitudeRef = readDirection(latitudeRefTag!.value, 'NS');
    const longitudeRef = readDirection(longitudeRefTag!.value, 'EW');
    const latitudeMagnitude = toDecimalDegrees(readDms(latitudeTag!.value), 90);
    const longitudeMagnitude = toDecimalDegrees(readDms(longitudeTag!.value), 180);
    const expectedLatitude = applyDirection(latitudeMagnitude, latitudeRef, 'S');
    const expectedLongitude = applyDirection(longitudeMagnitude, longitudeRef, 'W');
    const latitude = readCalculatedCoordinate(tags.gps?.Latitude, expectedLatitude, 90);
    const longitude = readCalculatedCoordinate(tags.gps?.Longitude, expectedLongitude, 180);
    const mapDatum = readMapDatum(tags.exif?.GPSMapDatum?.value);
    const gps: GpsCoordinates = {
      latitude,
      longitude,
      ...(mapDatum === undefined || mapDatum.length === 0 ? {} : { mapDatum }),
    };
    return {
      hasExif: true,
      gps,
      captureTime: parsedCaptureTime.captureTime,
      ...(parsedCaptureTime.invalid ? { metadataError: true } : {}),
    };
  } catch {
    return invalidMetadata(parsedCaptureTime.captureTime);
  }
}

function parseCaptureTime(tags: ExpandedTags): CaptureTimeParseResult {
  const dateTag = tags.exif?.DateTimeOriginal;
  if (dateTag === undefined) return { captureTime: null, invalid: false };

  const rawDate = readAscii(dateTag.value);
  if (rawDate === null) return { captureTime: null, invalid: true };
  if (rawDate === '' || rawDate === '0000:00:00 00:00:00') {
    return { captureTime: null, invalid: false };
  }
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(rawDate);
  if (match === null) return { captureTime: null, invalid: true };

  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!isValidCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    return { captureTime: null, invalid: true };
  }

  const offsetTag = tags.exif?.OffsetTimeOriginal;
  const offset = parseOffsetMinutes(offsetTag?.value);
  return {
    captureTime: {
      localDateTime: `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`,
      offsetMinutes: offset.offsetMinutes,
    },
    invalid: offset.invalid,
  };
}

function readAscii(value: unknown): string | null {
  if (typeof value === 'string') return value.replace(/\0+$/u, '').trim();
  if (!Array.isArray(value) || value.some((part) => typeof part !== 'string')) return null;
  return value.join('').replace(/\0+$/u, '').trim();
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseOffsetMinutes(value: unknown): { offsetMinutes: number | null; invalid: boolean } {
  if (value === undefined) return { offsetMinutes: null, invalid: false };
  const raw = readAscii(value);
  if (raw === null) return { offsetMinutes: null, invalid: true };
  if (raw === '') return { offsetMinutes: null, invalid: false };
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(raw);
  if (match === null) return { offsetMinutes: null, invalid: true };
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) {
    return { offsetMinutes: null, invalid: true };
  }
  const magnitude = hours * 60 + minutes;
  return { offsetMinutes: match[1] === '-' ? -magnitude : magnitude, invalid: false };
}

function metadataWithVivoCaptureTime(
  metadata: ExifGpsMetadata,
  embeddedJpeg: Buffer | null,
): ExifGpsMetadata {
  if (embeddedJpeg === null) return metadata;
  try {
    const tags = loadExif(embeddedJpeg, {
      expanded: true,
      includeOffsets: true,
      includeTags: PHOTO_EXIF_TAGS,
    });
    const parsed = parseCaptureTime(tags);
    const hasEmbeddedExif = tags.exif !== undefined
      || tags.metadataRange?.blocks.some((block) => block.type === 'exif') === true;
    return {
      ...metadata,
      hasExif: metadata.hasExif || hasEmbeddedExif,
      captureTime: parsed.captureTime ?? metadata.captureTime,
      ...(parsed.invalid || metadata.metadataError === true ? { metadataError: true } : {}),
    };
  } catch (error) {
    const embeddedMetadata = metadataFromReaderError(error);
    return embeddedMetadata.metadataError === true
      ? { ...metadata, metadataError: true }
      : metadata;
  }
}

async function readVivoEmbeddedJpeg(
  filePath: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  signal?.throwIfAborted();
  const file = await open(filePath, 'r');
  try {
    const { size } = await file.stat();
    const outerEnd = await jpegEndOffsetFile(file, 0, size, signal);
    if (outerEnd === null) return null;

    const streamHeaderLength = VIVO_STREAM_DATA.length + 3;
    const streamHeader = await readFileRange(file, outerEnd, streamHeaderLength, signal);
    if (streamHeader === null) return null;
    const innerStart = vivoInnerStart(streamHeader, outerEnd, size);
    if (innerStart === null) return null;

    const innerEnd = await jpegEndOffsetFile(file, innerStart, size, signal);
    if (innerEnd === null) return null;
    const innerLength = innerEnd - innerStart;
    if (innerLength <= 2 || innerLength > MAX_VIVO_EMBEDDED_JPEG_BYTES) return null;

    const trailerLength = Math.min(VIVO_TRAILER_INSPECTION_BYTES, size - innerEnd);
    const trailer = await readFileRange(file, innerEnd, trailerLength, signal);
    if (trailer === null || !isValidVivoTrailer(trailer)) return null;
    return await readFileRange(file, innerStart, innerLength, signal);
  } finally {
    await file.close();
  }
}

function vivoInnerStart(bytesAtOuterEnd: Buffer, outerEnd: number, fileSize: number): number | null {
  const minimumLength = VIVO_STREAM_DATA.length + 3;
  if (bytesAtOuterEnd.length < minimumLength) return null;
  if (!bytesAtOuterEnd.subarray(0, VIVO_STREAM_DATA.length).equals(VIVO_STREAM_DATA)) return null;
  const innerMarker = VIVO_STREAM_DATA.length;
  if (
    bytesAtOuterEnd[innerMarker] !== 0xff
    || bytesAtOuterEnd[innerMarker + 1] !== 0xd8
    || bytesAtOuterEnd[innerMarker + 2] !== 0xff
  ) {
    return null;
  }
  const innerStart = outerEnd + VIVO_STREAM_DATA.length;
  return innerStart < fileSize ? innerStart : null;
}

function isValidVivoTrailer(trailer: Buffer): boolean {
  if (trailer.length < VIVO_STREAM_INFO.length + VIVO_STREAM_COUNT.length + VIVO_VENDOR_PREFIX.length) {
    return false;
  }
  if (!trailer.subarray(0, VIVO_STREAM_INFO.length).equals(VIVO_STREAM_INFO)) return false;

  const streamCountOffset = trailer.indexOf(VIVO_STREAM_COUNT, VIVO_STREAM_INFO.length);
  if (
    streamCountOffset < VIVO_STREAM_INFO.length
    || streamCountOffset > VIVO_STREAM_INFO.length + 64
  ) {
    return false;
  }
  const vendorOffset = trailer.indexOf(VIVO_VENDOR_PREFIX, streamCountOffset + VIVO_STREAM_COUNT.length);
  return vendorOffset >= streamCountOffset + VIVO_STREAM_COUNT.length
    && vendorOffset <= streamCountOffset + VIVO_STREAM_COUNT.length + 32;
}

async function readFileRange(
  file: FileHandle,
  start: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0) return null;
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, total, length - total, start + total);
    if (bytesRead <= 0) return null;
    total += bytesRead;
  }
  return buffer;
}

async function jpegEndOffsetFile(
  file: FileHandle,
  start: number,
  limit: number,
  signal?: AbortSignal,
): Promise<number | null> {
  if (
    !Number.isSafeInteger(start)
    || start < 0
    || !Number.isSafeInteger(limit)
    || limit <= start
  ) {
    return null;
  }
  const state = createJpegParserState();
  let position = start;
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

function readDms(value: unknown): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new InvalidExifError('Invalid GPS DMS entry.');
  }
  const components = value.map(readRational);
  return [components[0]!, components[1]!, components[2]!];
}

function readRational(value: unknown): number {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || typeof value[0] !== 'number'
    || typeof value[1] !== 'number'
    || !Number.isFinite(value[0])
    || !Number.isFinite(value[1])
    || value[1] === 0
  ) {
    throw new InvalidExifError('Invalid GPS rational value.');
  }
  const result = value[0] / value[1];
  if (!Number.isFinite(result)) {
    throw new InvalidExifError('Invalid GPS rational value.');
  }
  return result;
}

function readDirection(value: unknown, allowed: 'NS' | 'EW'): string {
  if (!Array.isArray(value) || value.some((character) => typeof character !== 'string')) {
    throw new InvalidExifError('Invalid GPS direction reference.');
  }
  const direction = value.join('').replace(/\0+$/u, '').trim().toUpperCase();
  if (direction.length !== 1 || !allowed.includes(direction)) {
    throw new InvalidExifError('Invalid GPS direction reference.');
  }
  return direction;
}

function applyDirection(magnitude: number, direction: string, negativeDirection: string): number {
  return direction === negativeDirection && magnitude !== 0 ? -magnitude : magnitude;
}

function readCalculatedCoordinate(value: unknown, expected: number, maximum: number): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < -maximum
    || value > maximum
  ) {
    throw new InvalidExifError('GPS coordinates are outside the valid range.');
  }
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(expected)) * 8;
  if (Math.abs(value - expected) > tolerance) {
    throw new InvalidExifError('GPS coordinate calculation is inconsistent.');
  }
  return Object.is(value, -0) ? 0 : value;
}

function readMapDatum(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((character) => typeof character !== 'string')) {
    throw new InvalidExifError('Invalid GPS map datum.');
  }
  const mapDatum = value.join('').replace(/\0+$/u, '').trim();
  if ([...mapDatum].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0x20 || codePoint > 0x7e;
  })) {
    throw new InvalidExifError('Invalid GPS map datum.');
  }
  return mapDatum;
}

function toDecimalDegrees(
  [degrees, minutes, seconds]: [number, number, number],
  maximum: number,
): number {
  if (
    !Number.isFinite(degrees)
    || !Number.isFinite(minutes)
    || !Number.isFinite(seconds)
    || degrees < 0
    || minutes < 0
    || minutes >= 60
    || seconds < 0
    || seconds >= 60
  ) {
    throw new InvalidExifError('Invalid GPS DMS values.');
  }
  const value = degrees + minutes / 60 + seconds / 3600;
  if (!Number.isFinite(value) || value > maximum) {
    throw new InvalidExifError('GPS coordinates are outside the valid range.');
  }
  return value;
}

function metadataFromReaderError(error: unknown): ExifGpsMetadata {
  if (
    error instanceof exifReaderErrors.MetadataMissingError
    || (error instanceof Error && error.message.startsWith(AUTO_LENGTH_NO_METADATA_PREFIX))
  ) {
    return { hasExif: false, gps: null, captureTime: null };
  }
  return { hasExif: false, gps: null, captureTime: null, metadataError: true };
}

function invalidMetadata(captureTime: CaptureTimeValue | null = null): ExifGpsMetadata {
  return { hasExif: true, gps: null, captureTime, metadataError: true };
}
