import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SaveExportRequest } from '../../../shared/contracts';
import { PhotoMapError } from '../../../shared/errors';

export interface ExportImageEncoder {
  sanitize(bytes: Buffer): Promise<Buffer>;
}

export function decodeExportDataUrl(dataUrl: string): Buffer {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) {
    throw new PhotoMapError('INVALID_REQUEST', '导出图像格式与选择不一致。');
  }
  const base64 = dataUrl.slice(prefix.length);
  if (base64.length === 0 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new PhotoMapError('INVALID_REQUEST', '导出图像数据无效。');
  }
  const bytes = Buffer.from(base64, 'base64');
  const validSignature = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!validSignature) {
    throw new PhotoMapError('INVALID_REQUEST', '导出图像签名无效。');
  }
  return bytes;
}

export async function writeFileAtomically(targetPath: string, bytes: Buffer): Promise<void> {
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.photomap-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw new PhotoMapError('EXPORT_WRITE_FAILED', '无法保存分享图，未留下残缺文件。', {
      retryability: 'retry',
      cause: error
    });
  }
}

export class AtomicExportService {
  public constructor(private readonly encoder: ExportImageEncoder) {}

  public async save(targetPath: string, request: SaveExportRequest): Promise<void> {
    const sourceBytes = decodeExportDataUrl(request.dataUrl);
    const sanitizedBytes = await this.encoder.sanitize(sourceBytes);
    await writeFileAtomically(targetPath, sanitizedBytes);
  }
}
