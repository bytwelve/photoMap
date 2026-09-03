import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { FileCandidate } from '../../src/main/infrastructure/filesystem/enumerate-media';
import {
  detectAndroidMotionPhotoFile,
  groupMediaCandidates,
  type MediaInspection,
} from '../../src/main/services/library-scan/media-classification';

const APPLE_ID = '12345678-1234-4abc-9def-1234567890ab';
const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop()!;
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(target).startsWith('photo-map-motion-')).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

async function detectMotionPhotoFixture(bytes: Buffer) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-motion-'));
  temporaryRoots.push(root);
  const filePath = path.join(root, 'fixture.jpg');
  await writeFile(filePath, bytes);
  return detectAndroidMotionPhotoFile(filePath);
}

function candidate(relativePath: string, mediaFormat: FileCandidate['mediaFormat']): FileCandidate {
  return {
    absolutePath: `D:\\library\\${relativePath}`,
    relativePath,
    mediaFormat,
  };
}

function mp4Bytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom', 'ascii'),
    Buffer.alloc(16, 0),
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
    isoBox('mdat', Buffer.from('android-motion-video', 'ascii')),
  ]);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

function jpegBytes(options: { appData?: Buffer; scanData?: Buffer } = {}): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe1, options.appData ?? Buffer.alloc(0)),
    jpegSegment(0xda, Buffer.alloc(6, 0)),
    options.scanData ?? Buffer.from([0x11, 0xff, 0x00, 0xd9, 0xff, 0xd0, 0x22]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function samsungSefMotionPhoto(
  video: Buffer,
  options: {
    imagePaddingBytes?: number;
    includeMotionXmp?: boolean;
    includeMotionDataEntry?: boolean;
  } = {},
): Buffer {
  const includeMotionXmp = options.includeMotionXmp ?? true;
  const includeMotionDataEntry = options.includeMotionDataEntry ?? true;
  const xmp = includeMotionXmp
    ? Buffer.from('<rdf:Description GCamera:MotionPhoto="1"/>', 'utf8')
    : Buffer.alloc(0);
  const image = jpegBytes({
    appData: xmp,
    scanData: Buffer.alloc(options.imagePaddingBytes ?? 0, 0x41),
  });
  const name = Buffer.from('MotionPhoto_Data', 'ascii');
  const fieldHeader = Buffer.alloc(8);
  fieldHeader.writeUInt16LE(0, 0);
  fieldHeader.writeUInt16LE(0x0a30, 2);
  fieldHeader.writeUInt32LE(name.length, 4);
  const field = includeMotionDataEntry
    ? Buffer.concat([fieldHeader, name, video])
    : video;
  const directory = Buffer.alloc(includeMotionDataEntry ? 24 : 12);
  directory.write('SEFH', 0, 4, 'ascii');
  directory.writeUInt32LE(106, 4);
  directory.writeUInt32LE(includeMotionDataEntry ? 1 : 0, 8);
  if (includeMotionDataEntry) {
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x0a30, 14);
    directory.writeUInt32LE(field.length, 16);
    directory.writeUInt32LE(field.length, 20);
  }
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(directory.length, 0);
  footer.write('SEFT', 4, 4, 'ascii');
  return Buffer.concat([image, field, directory, footer]);
}

function modernAndroidMotionPhoto(): Buffer {
  const video = mp4Bytes();
  const xmp = `
    <x:xmpmeta>
      <rdf:Description Camera:MotionPhoto="1" Camera:MotionPhotoVersion="1" />
      <Container:Directory>
        <rdf:Seq>
          <rdf:li Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" />
          <rdf:li Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${video.length}" />
        </rdf:Seq>
      </Container:Directory>
    </x:xmpmeta>`;
  return Buffer.concat([
    jpegBytes({ appData: Buffer.from(xmp, 'utf8') }),
    video,
  ]);
}

describe('media classification', () => {
  it('prd_ac_015__android_motion_photo__has_xmp_and_appended_video__is_verified_as_one_live_asset', async () => {
    const bytes = modernAndroidMotionPhoto();

    expect(await detectMotionPhotoFixture(bytes)).toEqual({
      videoStart: bytes.length - mp4Bytes().length,
      videoLength: mp4Bytes().length,
      videoContentType: 'video/mp4',
    });
  });

  it('android_motion_photo__quicktime_directory_item__preserves_declared_content_type', async () => {
    const video = mp4Bytes();
    const xmp = `<rdf:Description Camera:MotionPhoto="1"/><rdf:li Item:Semantic="MotionPhoto" Item:Mime="video/quicktime" Item:Length="${video.length}"/>`;
    const bytes = Buffer.concat([jpegBytes({ appData: Buffer.from(xmp, 'utf8') }), video]);

    expect(await detectMotionPhotoFixture(bytes)).toEqual({
      videoStart: bytes.length - video.length,
      videoLength: video.length,
      videoContentType: 'video/quicktime',
    });
  });

  it('android_motion_photo__samsung_sef_motion_data__is_verified_without_google_xmp', async () => {
    const video = verifiedMp4Bytes();
    const bytes = samsungSefMotionPhoto(video, { includeMotionXmp: false });

    expect(await detectMotionPhotoFixture(bytes)).toEqual({
      videoStart: bytes.indexOf(video),
      videoLength: video.length,
      videoContentType: 'video/mp4',
    });
  });

  it('android_motion_photo__samsung_motion_flag_with_unlisted_mp4__finds_verified_video_before_sef', async () => {
    const video = verifiedMp4Bytes();
    const bytes = samsungSefMotionPhoto(video, { includeMotionDataEntry: false });

    expect(await detectMotionPhotoFixture(bytes)).toEqual({
      videoStart: bytes.indexOf(video),
      videoLength: video.length,
      videoContentType: 'video/mp4',
    });
  });

  it('android_motion_photo__element_form_xmp_with_verified_video__is_supported', async () => {
    const video = verifiedMp4Bytes();
    const bytes = Buffer.concat([
      jpegBytes({ appData: Buffer.from('<GCamera:MotionPhoto>1</GCamera:MotionPhoto>', 'utf8') }),
      video,
    ]);

    expect(await detectMotionPhotoFixture(bytes)).toEqual({
      videoStart: bytes.length - video.length,
      videoLength: video.length,
      videoContentType: 'video/mp4',
    });
  });

  it('android_motion_photo__complete_trailing_mp4_without_motion_metadata__is_detected', async () => {
    const video = verifiedMp4Bytes();
    const bytes = samsungSefMotionPhoto(video, {
      includeMotionXmp: false,
      includeMotionDataEntry: false,
    });

    expect(await detectMotionPhotoFixture(bytes)).toEqual({
      videoStart: bytes.indexOf(video),
      videoLength: video.length,
      videoContentType: 'video/mp4',
    });
  });

  it('android_motion_photo__jpeg_contains_complete_mp4_before_real_eoi__stays_a_photo', async () => {
    const bytes = jpegBytes({
      appData: Buffer.concat([
        Buffer.from([0x11, 0xff, 0xd9, 0x22]),
        verifiedMp4Bytes(),
      ]),
    });

    expect(await detectMotionPhotoFixture(bytes)).toBeNull();
  });

  it('android_motion_photo__trailing_mp4_with_private_vendor_tail__records_only_mp4_range', async () => {
    const still = jpegBytes();
    const video = verifiedMp4Bytes();
    const privateTail = Buffer.from('vendor-private-tail-SEFH-not-an-iso-box', 'ascii');
    const bytes = Buffer.concat([still, video, privateTail]);

    expect(await detectMotionPhotoFixture(bytes)).toEqual({
      videoStart: still.length,
      videoLength: video.length,
      videoContentType: 'video/mp4',
    });
  });

  it('android_motion_photo__declared_length_includes_private_tail__is_trimmed_to_valid_boxes', async () => {
    const video = verifiedMp4Bytes();
    const privateTail = Buffer.from('vendor-private-tail', 'ascii');
    const declaredLength = video.length + privateTail.length;
    const xmp = Buffer.from(
      `<rdf:Description Camera:MotionPhoto="1"/><rdf:li Item:Semantic="MotionPhoto" Item:Mime="video/mp4" Item:Length="${declaredLength}"/>`,
      'utf8',
    );
    const still = jpegBytes({ appData: xmp });
    const bytes = Buffer.concat([still, video, privateTail]);

    expect(await detectMotionPhotoFixture(bytes)).toEqual({
      videoStart: still.length,
      videoLength: video.length,
      videoContentType: 'video/mp4',
    });
  });

  it('android_motion_photo__jpeg_with_incomplete_ftyp_after_eoi__stays_a_photo', async () => {
    const bytes = Buffer.concat([
      jpegBytes(),
      isoBox('ftyp', Buffer.from('isom\x00\x00\x00\x00isom', 'binary')),
    ]);

    expect(await detectMotionPhotoFixture(bytes)).toBeNull();
  });

  it('android_motion_photo__jpeg_with_malformed_ftyp_and_movie_boxes__stays_a_photo', async () => {
    const malformedVideo = Buffer.concat([
      isoBox('ftyp', Buffer.alloc(9, 0)),
      isoBox('moov', Buffer.alloc(8, 0)),
      isoBox('mdat', Buffer.from('not-a-valid-ftyp-layout', 'ascii')),
    ]);
    const bytes = Buffer.concat([jpegBytes(), malformedVideo]);

    expect(await detectMotionPhotoFixture(bytes)).toBeNull();
  });

  it('android_motion_photo__large_samsung_file_with_video_outside_inspection_windows__is_detected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-motion-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, 'large-samsung.jpg');
    const video = verifiedMp4Bytes();
    const bytes = samsungSefMotionPhoto(video, {
      imagePaddingBytes: 2 * 1024 * 1024,
      includeMotionDataEntry: false,
    });
    await writeFile(filePath, bytes);

    const detected = await detectAndroidMotionPhotoFile(filePath);
    expect(detected).toEqual({
      videoStart: bytes.indexOf(video),
      videoLength: video.length,
      videoContentType: 'video/mp4',
    });
  });

  it('android_motion_photo__large_samsung_sef_motion_data_without_xmp__is_detected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-motion-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, 'large-samsung-sef.jpg');
    const video = verifiedMp4Bytes();
    const bytes = samsungSefMotionPhoto(video, {
      imagePaddingBytes: 2 * 1024 * 1024,
      includeMotionXmp: false,
    });
    await writeFile(filePath, bytes);

    await expect(detectAndroidMotionPhotoFile(filePath)).resolves.toEqual({
      videoStart: bytes.indexOf(video),
      videoLength: video.length,
      videoContentType: 'video/mp4',
    });
  });

  it('android_motion_photo__file_scan_with_private_tail__returns_seekable_mp4_window_only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-motion-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, 'generic-tail.jpg');
    const still = jpegBytes();
    const video = verifiedMp4Bytes();
    const bytes = Buffer.concat([
      still,
      video,
      Buffer.from('private-vendor-trailer', 'ascii'),
    ]);
    await writeFile(filePath, bytes);

    await expect(detectAndroidMotionPhotoFile(filePath)).resolves.toEqual({
      videoStart: still.length,
      videoLength: video.length,
      videoContentType: 'video/mp4',
    });
  });

  it('android_motion_photo__modern_item_without_required_mime__is_rejected', async () => {
    const video = mp4Bytes();
    const xmp = `<rdf:Description Camera:MotionPhoto="1"/><rdf:li Item:Semantic="MotionPhoto" Item:Length="${video.length}"/>`;

    expect(await detectMotionPhotoFixture(Buffer.concat([jpegBytes({ appData: Buffer.from(xmp, 'utf8') }), video]))).toBeNull();
  });

  it('prd_ac_015__android_motion_photo__has_residual_xmp_but_no_video__stays_a_photo', async () => {
    const bytes = Buffer.from('<rdf:Description Camera:MotionPhoto="1" Camera:MotionPhotoVersion="1" />');

    expect(await detectMotionPhotoFixture(bytes)).toBeNull();
  });

  it('prd_ac_015__apple_live_photo__matching_content_identifiers__groups_photo_and_mov_even_with_different_stems', () => {
    const still = candidate('IMG_E0001.jpg', 'jpg');
    const motion = candidate('IMG_0001.mov', 'mov');
    const inspections = new Map<string, MediaInspection>([
      [still.absolutePath, { androidMotionPhoto: null, appleContentIds: [APPLE_ID] }],
      [motion.absolutePath, { androidMotionPhoto: null, appleContentIds: [APPLE_ID] }],
    ]);

    const grouped = groupMediaCandidates([still, motion], inspections);

    expect(grouped).toEqual([{
      primary: still,
      companion: motion,
      mediaKind: 'live',
      liveSource: 'apple',
    }]);
  });

  it('prd_ac_015__android_motion_photo_and_regular_video__group__remain_two_assets', () => {
    const motionPhoto = candidate('PXL_0001.MP.jpg', 'jpg');
    const video = candidate('clip.mp4', 'mp4');
    const inspections = new Map<string, MediaInspection>([
      [motionPhoto.absolutePath, {
        androidMotionPhoto: { videoStart: 100, videoLength: 24, videoContentType: 'video/mp4' },
        appleContentIds: [],
      }],
      [video.absolutePath, { androidMotionPhoto: null, appleContentIds: [] }],
    ]);

    expect(groupMediaCandidates([motionPhoto, video], inspections)).toEqual([
      { primary: video, mediaKind: 'video' },
      { primary: motionPhoto, mediaKind: 'live', liveSource: 'android' },
    ]);
  });

  it('prd_ac_015__apple_candidates__conflicting_identifiers_with_the_same_stem__do_not_false_pair', () => {
    const still = candidate('same.jpg', 'jpg');
    const motion = candidate('same.mov', 'mov');
    const inspections = new Map<string, MediaInspection>([
      [still.absolutePath, { androidMotionPhoto: null, appleContentIds: [APPLE_ID] }],
      [motion.absolutePath, {
        androidMotionPhoto: null,
        appleContentIds: ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
      }],
    ]);

    expect(groupMediaCandidates([still, motion], inspections)).toEqual([
      { primary: still, mediaKind: 'photo' },
      { primary: motion, mediaKind: 'video' },
    ]);
  });
});
