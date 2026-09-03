import { describe, expect, it } from 'vitest';

import { decodeExportDataUrl } from '../../src/main/services/export/atomic-export';
import { parseSaveExportRequest } from '../../src/shared/schemas';
import { PhotoMapError } from '../../src/shared/errors';

function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

describe('TDD-CONTRACT-EXPORT-002 data URL encoding boundary', () => {
  it('prd_fr_018__png_data_url_matches_format__decodes__preserves_exact_png_bytes', () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);

    expect(decodeExportDataUrl(dataUrl('image/png', bytes))).toEqual(bytes);
  });

  it('rejects the removed JPEG export at the IPC boundary', () => {
    expect(() => parseSaveExportRequest({ format: 'jpeg', suggestedName: 'map.jpg', dataUrl: 'data:image/jpeg;base64,/9j/2Q==' })).toThrow('导出格式只能是 PNG');
  });

  it.each([
    ['data:image/jpeg;base64,/9j/2Q=='],
    ['data:image/png;base64,%%%%'],
    ['data:image/png;base64,AA=='],
  ] as const)(
    'prd_fr_018__data_url_is_mismatched_or_invalid__decodes_%s__rejects_invalid_request',
    (value) => {
      try {
        decodeExportDataUrl(value);
        expect.fail('Expected invalid export data to be rejected.');
      } catch (error) {
        expect(error).toBeInstanceOf(PhotoMapError);
        expect((error as PhotoMapError).code).toBe('INVALID_REQUEST');
      }
    },
  );
});
