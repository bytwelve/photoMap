import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ExifGpsProbe,
} from '../../src/main/services/library-scan/exif-gps-reader';

import type { ImageFormat } from '../../src/shared/contracts';

type ByteOrder = 'little' | 'big';

interface GpsFixtureOptions {
  byteOrder?: ByteOrder;
  latitude?: [number, number, number];
  latitudeDenominators?: [number, number, number];
  latitudeRef?: 'N' | 'S';
  longitude?: [number, number, number];
  longitudeDenominators?: [number, number, number];
  longitudeRef?: 'E' | 'W';
  mapDatum?: string;
  rationalType?: 5 | 10;
}

interface CaptureTimeFixtureOptions {
  byteOrder?: ByteOrder;
  dateTimeOriginal: string;
  offsetTimeOriginal?: string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop()!;
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(target).startsWith('photo-map-exif-')).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

async function probeExifFixture(bytes: Buffer, imageFormat: ImageFormat) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-exif-'));
  temporaryRoots.push(root);
  const filePath = path.join(root, `fixture.${imageFormat}`);
  await writeFile(filePath, bytes);
  return new ExifGpsProbe().probe(filePath, imageFormat);
}

function writeUInt16(buffer: Buffer, value: number, offset: number, order: ByteOrder): void {
  if (order === 'little') buffer.writeUInt16LE(value, offset);
  else buffer.writeUInt16BE(value, offset);
}

function writeUInt32(buffer: Buffer, value: number, offset: number, order: ByteOrder): void {
  if (order === 'little') buffer.writeUInt32LE(value, offset);
  else buffer.writeUInt32BE(value, offset);
}

function writeInt32(buffer: Buffer, value: number, offset: number, order: ByteOrder): void {
  if (order === 'little') buffer.writeInt32LE(value, offset);
  else buffer.writeInt32BE(value, offset);
}

function makeTiffWithoutGps(order: ByteOrder = 'little'): Buffer {
  const tiff = Buffer.alloc(14);
  tiff.write(order === 'little' ? 'II' : 'MM', 0, 'ascii');
  writeUInt16(tiff, 42, 2, order);
  writeUInt32(tiff, 8, 4, order);
  writeUInt16(tiff, 0, 8, order);
  writeUInt32(tiff, 0, 10, order);
  return tiff;
}

function makeGpsTiff(options: GpsFixtureOptions = {}): Buffer {
  const order = options.byteOrder ?? 'little';
  const latitude = options.latitude ?? [30, 30, 0];
  const latitudeDenominators = options.latitudeDenominators ?? [1, 1, 1];
  const longitude = options.longitude ?? [114, 20, 0];
  const longitudeDenominators = options.longitudeDenominators ?? [1, 1, 1];
  const latitudeRef = options.latitudeRef ?? 'N';
  const longitudeRef = options.longitudeRef ?? 'E';
  const rationalType = options.rationalType ?? 5;
  const mapDatumBytes = options.mapDatum === undefined
    ? undefined
    : Buffer.from(`${options.mapDatum}\0`, 'ascii');
  const gpsEntryCount = mapDatumBytes === undefined ? 4 : 5;
  const gpsIfdOffset = 26;
  const dataOffset = gpsIfdOffset + 2 + gpsEntryCount * 12 + 4;
  const latitudeOffset = dataOffset;
  const longitudeOffset = latitudeOffset + 24;
  const datumOffset = longitudeOffset + 24;
  const tiff = Buffer.alloc(datumOffset + (mapDatumBytes?.length ?? 0));

  tiff.write(order === 'little' ? 'II' : 'MM', 0, 'ascii');
  writeUInt16(tiff, 42, 2, order);
  writeUInt32(tiff, 8, 4, order);
  writeUInt16(tiff, 1, 8, order);
  writeUInt16(tiff, 0x8825, 10, order);
  writeUInt16(tiff, 4, 12, order);
  writeUInt32(tiff, 1, 14, order);
  writeUInt32(tiff, gpsIfdOffset, 18, order);
  writeUInt32(tiff, 0, 22, order);

  writeUInt16(tiff, gpsEntryCount, gpsIfdOffset, order);
  const writeEntry = (
    index: number,
    tag: number,
    type: number,
    count: number,
    valueOrOffset: number,
  ): number => {
    const entryOffset = gpsIfdOffset + 2 + index * 12;
    writeUInt16(tiff, tag, entryOffset, order);
    writeUInt16(tiff, type, entryOffset + 2, order);
    writeUInt32(tiff, count, entryOffset + 4, order);
    writeUInt32(tiff, valueOrOffset, entryOffset + 8, order);
    return entryOffset;
  };
  const latitudeRefEntry = writeEntry(0, 0x0001, 2, 2, 0);
  tiff.write(`${latitudeRef}\0`, latitudeRefEntry + 8, 'ascii');
  writeEntry(1, 0x0002, rationalType, 3, latitudeOffset);
  const longitudeRefEntry = writeEntry(2, 0x0003, 2, 2, 0);
  tiff.write(`${longitudeRef}\0`, longitudeRefEntry + 8, 'ascii');
  writeEntry(3, 0x0004, rationalType, 3, longitudeOffset);
  if (mapDatumBytes !== undefined) {
    writeEntry(4, 0x0012, 2, mapDatumBytes.length, datumOffset);
    mapDatumBytes.copy(tiff, datumOffset);
  }
  writeUInt32(tiff, 0, gpsIfdOffset + 2 + gpsEntryCount * 12, order);

  const writeDms = (
    values: [number, number, number],
    denominators: [number, number, number],
    offset: number,
  ): void => {
    const writeComponent = rationalType === 5 ? writeUInt32 : writeInt32;
    values.forEach((value, index) => {
      writeComponent(tiff, value, offset + index * 8, order);
      writeComponent(tiff, denominators[index]!, offset + index * 8 + 4, order);
    });
  };
  writeDms(latitude, latitudeDenominators, latitudeOffset);
  writeDms(longitude, longitudeDenominators, longitudeOffset);
  return tiff;
}

function makeCaptureTimeTiff(options: CaptureTimeFixtureOptions): Buffer {
  const order = options.byteOrder ?? 'little';
  const values = [
    { tag: 0x9003, value: options.dateTimeOriginal },
    ...(options.offsetTimeOriginal === undefined
      ? []
      : [{ tag: 0x9011, value: options.offsetTimeOriginal }]),
  ].map(({ tag, value }) => ({ tag, bytes: Buffer.from(`${value}\0`, 'ascii') }));
  const exifIfdOffset = 26;
  const exifEntriesEnd = exifIfdOffset + 2 + values.length * 12 + 4;
  const totalValueBytes = values.reduce((total, entry) => total + entry.bytes.length, 0);
  const tiff = Buffer.alloc(exifEntriesEnd + totalValueBytes);

  tiff.write(order === 'little' ? 'II' : 'MM', 0, 'ascii');
  writeUInt16(tiff, 42, 2, order);
  writeUInt32(tiff, 8, 4, order);
  writeUInt16(tiff, 1, 8, order);
  writeUInt16(tiff, 0x8769, 10, order);
  writeUInt16(tiff, 4, 12, order);
  writeUInt32(tiff, 1, 14, order);
  writeUInt32(tiff, exifIfdOffset, 18, order);
  writeUInt32(tiff, 0, 22, order);

  writeUInt16(tiff, values.length, exifIfdOffset, order);
  let valueOffset = exifEntriesEnd;
  values.forEach(({ tag, bytes }, index) => {
    const entryOffset = exifIfdOffset + 2 + index * 12;
    writeUInt16(tiff, tag, entryOffset, order);
    writeUInt16(tiff, 2, entryOffset + 2, order);
    writeUInt32(tiff, bytes.length, entryOffset + 4, order);
    writeUInt32(tiff, valueOffset, entryOffset + 8, order);
    bytes.copy(tiff, valueOffset);
    valueOffset += bytes.length;
  });
  writeUInt32(tiff, 0, exifIfdOffset + 2 + values.length * 12, order);
  return tiff;
}

function makeJpeg(tiff?: Buffer): Buffer {
  const start = Buffer.from([0xff, 0xd8]);
  if (tiff === undefined) return Buffer.concat([start, Buffer.from([0xff, 0xd9])]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe1;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([start, header, payload, Buffer.from([0xff, 0xd9])]);
}

function withJpegAppSegment(jpeg: Buffer, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe2;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

function makeVivoDualJpeg(outer: Buffer, inner: Buffer, validTrailer = true): Buffer {
  const trailer = validTrailer
    ? Buffer.concat([
        Buffer.from('streaminfo', 'ascii'),
        Buffer.from([0x00, 0x03, 0x00, 0x01, 0x01, 0x00, 0x13, 0x01, 0xc7]),
        Buffer.from('streamcount', 'ascii'),
        Buffer.from([0x00, 0x01]),
        Buffer.from('vivo{}', 'ascii'),
      ])
    : Buffer.from('not-a-vivo-trailer', 'ascii');
  return Buffer.concat([outer, Buffer.from('streamdata', 'ascii'), inner, trailer]);
}

function makePng(tiff: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const exifHeader = Buffer.alloc(8);
  exifHeader.writeUInt32BE(tiff.length, 0);
  exifHeader.write('eXIf', 4, 'ascii');
  const iend = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0]);
  return Buffer.concat([signature, exifHeader, tiff, Buffer.alloc(4), iend]);
}

function makeIsoBmffBox(type: string, content: Buffer): Buffer {
  const box = Buffer.alloc(8 + content.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 'ascii');
  content.copy(box, 8);
  return box;
}

function makeIsoBmffFullBox(type: string, version: number, content: Buffer): Buffer {
  return makeIsoBmffBox(type, Buffer.concat([
    Buffer.from([version, 0, 0, 0]),
    content,
  ]));
}

function makeIsoBmffFileTypeBox(brand: 'heic' | 'avif'): Buffer {
  return makeIsoBmffBox('ftyp', Buffer.concat([
    Buffer.from(brand, 'ascii'),
    Buffer.alloc(4),
    Buffer.from(brand, 'ascii'),
  ]));
}

function makeIsoBmffWithExif(tiff: Buffer, brand: 'heic' | 'avif'): Buffer {
  const ftyp = makeIsoBmffFileTypeBox(brand);
  const exifBlock = Buffer.concat([Buffer.alloc(4), tiff]);

  const itemInfo = Buffer.alloc(8);
  itemInfo.writeUInt16BE(1, 0);
  itemInfo.writeUInt16BE(0, 2);
  itemInfo.write('Exif', 4, 'ascii');
  const infe = makeIsoBmffFullBox('infe', 2, Buffer.concat([
    itemInfo,
    Buffer.from('Exif\0', 'ascii'),
  ]));
  const itemCount = Buffer.alloc(2);
  itemCount.writeUInt16BE(1, 0);
  const iinf = makeIsoBmffFullBox('iinf', 0, Buffer.concat([itemCount, infe]));

  const location = Buffer.alloc(20);
  location[0] = 0x44;
  location.writeUInt16BE(1, 2);
  location.writeUInt16BE(1, 4);
  location.writeUInt16BE(1, 6);
  location.writeUInt16BE(0, 8);
  location.writeUInt16BE(1, 10);
  location.writeUInt32BE(0, 12);
  location.writeUInt32BE(exifBlock.length, 16);
  const iloc = makeIsoBmffFullBox('iloc', 1, location);
  const idat = makeIsoBmffBox('idat', exifBlock);
  const meta = makeIsoBmffFullBox('meta', 0, Buffer.concat([iinf, iloc, idat]));
  return Buffer.concat([ftyp, meta]);
}

describe('ExifGpsProbe', () => {
  it('image_without_exif__probe__reports_no_exif_without_an_error', async () => {
    expect(await probeExifFixture(makeJpeg(), 'jpg')).toEqual({
      hasExif: false,
      gps: null,
      captureTime: null,
    });
  });

  it('valid_exif_without_gps_ifd__probe__reports_exif_and_no_gps', async () => {
    expect(await probeExifFixture(makeJpeg(makeTiffWithoutGps()), 'jpg')).toEqual({
      hasExif: true,
      gps: null,
      captureTime: null,
    });
  });

  it('datetime_original_with_positive_offset__probe__returns_strict_local_time_without_host_conversion', async () => {
    const result = await probeExifFixture(makeJpeg(makeCaptureTimeTiff({
      dateTimeOriginal: '2026:06:17 15:44:34',
      offsetTimeOriginal: '+08:00',
    })), 'jpg');

    expect(result).toEqual({
      hasExif: true,
      gps: null,
      captureTime: {
        localDateTime: '2026-06-17T15:44:34',
        offsetMinutes: 480,
      },
    });
  });

  it('datetime_original_without_offset__probe__keeps_the_local_civil_time_and_null_offset', async () => {
    const result = await probeExifFixture(makeJpeg(makeCaptureTimeTiff({
      byteOrder: 'big',
      dateTimeOriginal: '2024:02:29 23:59:58',
    })), 'jpg');

    expect(result.captureTime).toEqual({
      localDateTime: '2024-02-29T23:59:58',
      offsetMinutes: null,
    });
  });

  it('invalid_calendar_datetime_original__probe__fails_closed_without_using_file_time', async () => {
    const result = await probeExifFixture(makeJpeg(makeCaptureTimeTiff({
      dateTimeOriginal: '2025:02:29 12:00:00',
      offsetTimeOriginal: '+08:00',
    })), 'jpg');

    expect(result).toEqual({
      hasExif: true,
      gps: null,
      captureTime: null,
      metadataError: true,
    });
  });

  it('validated_vivo_dual_jpeg__probe__prefers_inner_datetime_and_ignores_marker_like_app_data', async () => {
    const outer = withJpegAppSegment(
      makeJpeg(makeCaptureTimeTiff({
        dateTimeOriginal: '2026:08:30 23:59:16',
        offsetTimeOriginal: '+08:00',
      })),
      Buffer.concat([
        Buffer.from('streamdata-inside-an-app-segment', 'ascii'),
        Buffer.from([0xff, 0xd9]),
      ]),
    );
    const inner = makeJpeg(makeCaptureTimeTiff({
      dateTimeOriginal: '2026:06:17 15:44:34',
      offsetTimeOriginal: '+08:00',
    }));

    const result = await probeExifFixture(makeVivoDualJpeg(outer, inner), 'jpg');

    expect(result.captureTime).toEqual({
      localDateTime: '2026-06-17T15:44:34',
      offsetMinutes: 480,
    });
  });

  it('unvalidated_vivo_like_trailer__probe__keeps_the_outer_datetime', async () => {
    const outer = makeJpeg(makeCaptureTimeTiff({
      dateTimeOriginal: '2026:08:30 23:59:16',
      offsetTimeOriginal: '+08:00',
    }));
    const inner = makeJpeg(makeCaptureTimeTiff({
      dateTimeOriginal: '2026:06:17 15:44:34',
      offsetTimeOriginal: '+08:00',
    }));

    const result = await probeExifFixture(makeVivoDualJpeg(outer, inner, false), 'jpg');

    expect(result.captureTime).toEqual({
      localDateTime: '2026-08-30T23:59:16',
      offsetMinutes: 480,
    });
  });

  it('little_endian_jpeg_with_dms_and_datum__probe__returns_decimal_coordinates', async () => {
    const result = await probeExifFixture(makeJpeg(makeGpsTiff({ mapDatum: 'WGS-84' })), 'jpg');

    expect(result).toEqual({
      hasExif: true,
      gps: {
        latitude: 30.5,
        longitude: 114 + 20 / 60,
        mapDatum: 'WGS-84',
      },
      captureTime: null,
    });
  });

  it('synthetic_unsigned_rational_high_bits__probe__keeps_uint32_semantics', async () => {
    const secondsNumerator = 2_147_483_648;
    const secondsDenominator = 4_294_967_295;
    const result = await probeExifFixture(makeJpeg(makeGpsTiff({
      latitude: [12, 15, secondsNumerator],
      latitudeDenominators: [1, 1, secondsDenominator],
    })), 'jpg');

    expect(result.gps?.latitude).toBeCloseTo(
      12 + 15 / 60 + (secondsNumerator / secondsDenominator) / 3600,
      12,
    );
  });

  it('big_endian_png_exif_with_south_west_refs__probe__returns_negative_coordinates', async () => {
    const result = await probeExifFixture(makePng(makeGpsTiff({
      byteOrder: 'big',
      latitude: [12, 15, 30],
      latitudeRef: 'S',
      longitude: [77, 30, 0],
      longitudeRef: 'W',
    })), 'png');

    expect(result).toEqual({
      hasExif: true,
      gps: { latitude: -(12 + 15 / 60 + 30 / 3600), longitude: -77.5 },
      captureTime: null,
    });
  });

  it('synthetic_big_endian_srational_dms__probe__returns_decimal_coordinates', async () => {
    const result = await probeExifFixture(makeJpeg(makeGpsTiff({
      byteOrder: 'big',
      latitude: [12, 15, 30],
      longitude: [77, 30, 0],
      rationalType: 10,
    })), 'jpg');

    expect(result).toEqual({
      hasExif: true,
      gps: { latitude: 12 + 15 / 60 + 30 / 3600, longitude: 77.5 },
      captureTime: null,
    });
  });

  it('synthetic_little_endian_srational_fractions__probe__returns_decimal_coordinates', async () => {
    const result = await probeExifFixture(makeJpeg(makeGpsTiff({
      latitude: [12, 15, 1],
      latitudeDenominators: [1, 1, 2],
      longitude: [77, 30, 3],
      longitudeDenominators: [1, 1, 2],
      rationalType: 10,
    })), 'jpg');

    expect(result.gps?.latitude).toBeCloseTo(12 + 15 / 60 + 0.5 / 3600, 12);
    expect(result.gps?.longitude).toBeCloseTo(77.5 + 1.5 / 3600, 12);
  });

  it('srational_with_negative_numerator__probe__preserves_dms_range_validation', async () => {
    const result = await probeExifFixture(makeJpeg(makeGpsTiff({
      latitude: [12, 15, -1],
      latitudeDenominators: [1, 1, 2_147_483_647],
      rationalType: 10,
    })), 'jpg');

    expect(result).toEqual({ hasExif: true, gps: null, captureTime: null, metadataError: true });
  });

  it('srational_with_negative_denominator__probe__preserves_dms_range_validation', async () => {
    const result = await probeExifFixture(makeJpeg(makeGpsTiff({
      latitude: [12, 15, 30],
      latitudeDenominators: [-1, 1, 1],
      rationalType: 10,
    })), 'jpg');

    expect(result).toEqual({ hasExif: true, gps: null, captureTime: null, metadataError: true });
  });

  it('gps_rational_with_zero_denominator__probe__fails_closed_without_coordinates', async () => {
    const tiff = makeGpsTiff();
    const latitudeValueOffset = tiff.readUInt32LE(26 + 2 + 12 + 8);
    tiff.writeUInt32LE(0, latitudeValueOffset + 4);

    expect(await probeExifFixture(makeJpeg(tiff), 'jpg')).toEqual({
      hasExif: true,
      gps: null,
      captureTime: null,
      metadataError: true,
    });
  });

  it('out_of_range_dms__probe__fails_closed_without_coordinates', async () => {
    const result = await probeExifFixture(makeJpeg(makeGpsTiff({ latitude: [91, 0, 0] })), 'jpg');

    expect(result).toEqual({ hasExif: true, gps: null, captureTime: null, metadataError: true });
  });

  it('truncated_exif_pointer__probe__fails_closed_without_throwing', async () => {
    const tiff = makeGpsTiff().subarray(0, 30);

    expect(await probeExifFixture(makePng(tiff), 'png')).toEqual({
      hasExif: true,
      gps: null,
      captureTime: null,
      metadataError: true,
    });
  });

  it('local_file_probe__reads_exif_without_mutating_the_source_file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-exif-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, 'gps.jpg');
    const bytes = makeJpeg(makeGpsTiff({ longitude: [121, 28, 13], mapDatum: 'WGS-84' }));
    await writeFile(filePath, bytes);

    const result = await new ExifGpsProbe().probe(filePath, 'jpg');

    expect(result.gps?.longitude).toBeCloseTo(121.4702777778, 8);
    expect(result.gps?.mapDatum).toBe('WGS-84');
  });

  it('vivo_dual_jpeg_local_file_probe__reads_inner_time_without_mutating_the_source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-exif-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, 'vivo.jpg');
    const bytes = makeVivoDualJpeg(
      makeJpeg(makeCaptureTimeTiff({ dateTimeOriginal: '2026:08:30 23:59:16' })),
      makeJpeg(makeCaptureTimeTiff({
        dateTimeOriginal: '2026:06:17 15:44:34',
        offsetTimeOriginal: '+08:00',
      })),
    );
    await writeFile(filePath, bytes);

    const result = await new ExifGpsProbe().probe(filePath, 'jpg');

    expect(result.captureTime).toEqual({
      localDateTime: '2026-06-17T15:44:34',
      offsetMinutes: 480,
    });
    expect(await readFile(filePath)).toEqual(bytes);
  });

  it.each([
    ['heic', 'heic'],
    ['avif', 'avif'],
  ] as const)('synthetic_%s_iso_bmff__local_file_probe__returns_gps', async (format, extension) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-exif-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, `gps.${extension}`);
    await writeFile(filePath, makeIsoBmffWithExif(makeGpsTiff({
      latitude: [8, 9, 10],
      longitude: [42, 5, 6],
      mapDatum: 'WGS-84',
      rationalType: 10,
    }), format));

    const result = await new ExifGpsProbe().probe(filePath, format);

    expect(result).toEqual({
      hasExif: true,
      gps: {
        latitude: 8 + 9 / 60 + 10 / 3600,
        longitude: 42 + 5 / 60 + 6 / 3600,
        mapDatum: 'WGS-84',
      },
      captureTime: null,
    });
  });

  it.each([
    ['heic', 'heic'],
    ['avif', 'avif'],
  ] as const)('synthetic_%s_iso_bmff__local_file_probe__returns_capture_time', async (format, extension) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-exif-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, `capture.${extension}`);
    await writeFile(filePath, makeIsoBmffWithExif(makeCaptureTimeTiff({
      dateTimeOriginal: '2023:11:05 01:02:03',
      offsetTimeOriginal: '-07:00',
    }), format));

    const result = await new ExifGpsProbe().probe(filePath, format);

    expect(result.captureTime).toEqual({
      localDateTime: '2023-11-05T01:02:03',
      offsetMinutes: -420,
    });
  });

  it.each([
    ['heic', 'heic'],
    ['avif', 'avif'],
  ] as const)('synthetic_%s_without_exif__local_file_probe__reports_no_exif', async (format, extension) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-exif-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, `plain.${extension}`);
    await writeFile(filePath, makeIsoBmffFileTypeBox(format));

    await expect(new ExifGpsProbe().probe(filePath, format)).resolves.toEqual({
      hasExif: false,
      gps: null,
      captureTime: null,
    });
  });

  it('already_aborted_scan__local_file_probe__stops_before_reading_metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-exif-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, 'gps.jpg');
    await writeFile(filePath, makeJpeg(makeGpsTiff()));
    const controller = new AbortController();
    controller.abort();

    await expect(new ExifGpsProbe().probe(filePath, 'jpg', controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
