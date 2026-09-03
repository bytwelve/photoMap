import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AppErrorCode } from '../../../shared/contracts';

export type DiagnosticStage = 'startup' | 'settings' | 'scan' | 'export' | 'trash' | 'failure' | 'shutdown';

export interface DiagnosticCounts {
  discovered?: number;
  indexed?: number;
  unchanged?: number;
  errors?: number;
  succeeded?: number;
  skipped?: number;
  failed?: number;
  moved?: number;
  notFound?: number;
  accessDenied?: number;
  cancelled?: number;
  partial?: number;
  changed?: number;
  indexFailed?: number;
}

export interface DiagnosticInput {
  stage: DiagnosticStage;
  runId?: string | null;
  errorCode?: AppErrorCode;
  counts?: DiagnosticCounts;
}

export interface DiagnosticsPort {
  record(input: DiagnosticInput): Promise<void>;
}

export interface DiagnosticsOptions {
  maxBytes?: number;
  maxBackups?: number;
}

const COUNT_KEYS: ReadonlyArray<keyof DiagnosticCounts> = [
  'discovered',
  'indexed',
  'unchanged',
  'errors',
  'succeeded',
  'skipped',
  'failed',
  'moved',
  'notFound',
  'accessDenied',
  'cancelled',
  'partial',
  'changed',
  'indexFailed'
];
const STAGES = new Set<DiagnosticStage>(['startup', 'settings', 'scan', 'export', 'trash', 'failure', 'shutdown']);

export class JsonlDiagnostics implements DiagnosticsPort {
  private readonly logPath: string;
  private readonly maxBytes: number;
  private readonly maxBackups: number;
  private queue: Promise<void> = Promise.resolve();

  public constructor(
    logsDirectory: string,
    private readonly appVersion: string,
    private readonly schemaVersion: number,
    options: DiagnosticsOptions = {}
  ) {
    this.logPath = path.join(logsDirectory, 'diagnostics.jsonl');
    this.appVersion = /^[A-Za-z0-9.+-]{1,64}$/.test(appVersion) ? appVersion : 'unknown';
    this.schemaVersion = Number.isSafeInteger(schemaVersion) && schemaVersion >= 0 ? schemaVersion : 0;
    this.maxBytes = options.maxBytes ?? 512 * 1024;
    this.maxBackups = options.maxBackups ?? 3;
  }

  public record(input: DiagnosticInput): Promise<void> {
    const line = `${JSON.stringify(this.sanitize(input))}\n`;
    const operation = this.queue.then(() => this.append(line));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  public async flush(): Promise<void> {
    await this.queue;
  }

  private sanitize(input: DiagnosticInput): Record<string, unknown> {
    const event: Record<string, unknown> = {
      appVersion: this.appVersion,
      schemaVersion: this.schemaVersion,
      stage: STAGES.has(input.stage) ? input.stage : 'failure'
    };
    if (typeof input.runId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input.runId)) {
      event.runId = input.runId;
    }
    if (input.errorCode !== undefined && /^[A-Z][A-Z0-9_]{1,63}$/.test(input.errorCode)) {
      event.errorCode = input.errorCode;
    }
    if (input.counts !== undefined) {
      const counts: Record<string, number> = {};
      for (const key of COUNT_KEYS) {
        const value = input.counts[key];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          counts[key] = value;
        }
      }
      if (Object.keys(counts).length > 0) {
        event.counts = counts;
      }
    }
    return event;
  }

  private async append(line: string): Promise<void> {
    await mkdir(path.dirname(this.logPath), { recursive: true });
    let currentSize = 0;
    try {
      const fileStats = await lstat(this.logPath);
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
        throw new Error('Diagnostics target is not a regular file.');
      }
      currentSize = fileStats.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (currentSize + Buffer.byteLength(line, 'utf8') > this.maxBytes) {
      await this.rotate();
    }
    const handle = await open(this.logPath, 'a', 0o600);
    try {
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async rotate(): Promise<void> {
    if (this.maxBackups <= 0) {
      await unlink(this.logPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      return;
    }
    for (let index = this.maxBackups; index >= 1; index -= 1) {
      const target = `${this.logPath}.${index}`;
      const source = index === 1 ? this.logPath : `${this.logPath}.${index - 1}`;
      await unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await rename(source, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
