import { nativeImage } from 'electron';
import { PhotoMapError } from '../../../shared/errors';
import type { ExportImageEncoder } from './atomic-export';

export class ElectronExportEncoder implements ExportImageEncoder {
  public async sanitize(bytes: Buffer): Promise<Buffer> {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) {
      throw new PhotoMapError('INVALID_REQUEST', '导出图像无法解码。');
    }
    return image.toPNG();
  }
}
