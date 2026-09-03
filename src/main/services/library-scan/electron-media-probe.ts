import { nativeImage } from 'electron';

import { isImageFormat, type MediaFormat, type MediaKind } from '../../../shared/contracts';
import type { MediaProbe, MediaProbeResult } from './models';

const PROBE_EDGE = 512;

export class ElectronMediaProbe implements MediaProbe {
  public async probe(filePath: string, mediaFormat: MediaFormat, mediaKind: MediaKind): Promise<MediaProbeResult> {
    let image = isImageFormat(mediaFormat) && mediaKind !== 'video'
      ? nativeImage.createFromPath(filePath)
      : await nativeImage.createThumbnailFromPath(filePath, { width: PROBE_EDGE, height: PROBE_EDGE });
    if (image.isEmpty() && isImageFormat(mediaFormat)) {
      image = await nativeImage.createThumbnailFromPath(filePath, { width: PROBE_EDGE, height: PROBE_EDGE });
    }
    if (image.isEmpty()) {
      return { pixelWidth: 0, pixelHeight: 0, decodeState: 'corrupt' };
    }
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) {
      return { pixelWidth: 0, pixelHeight: 0, decodeState: 'corrupt' };
    }
    return { pixelWidth: size.width, pixelHeight: size.height, decodeState: 'valid' };
  }
}
