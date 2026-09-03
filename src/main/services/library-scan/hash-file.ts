import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function sha256File(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  const abort = (): void => {
    stream.destroy(new DOMException('Scan cancelled', 'AbortError'));
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal.aborted) {
        throw new DOMException('Scan cancelled', 'AbortError');
      }
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
