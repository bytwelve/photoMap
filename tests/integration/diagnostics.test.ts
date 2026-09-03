import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  JsonlDiagnostics,
  type DiagnosticInput,
} from '../../src/main/infrastructure/diagnostics/diagnostics';

const temporaryRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-diagnostics-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop()!;
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(target).startsWith('photo-map-diagnostics-')).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

describe('PRD-NFR-002 local diagnostics privacy contract', () => {
  it('serializes only the diagnostic allowlist when untrusted callers inject paths, tags, or GPS', async () => {
    const logsDirectory = await fixtureRoot();
    const diagnostics = new JsonlDiagnostics(logsDirectory, '1.0.0', 1);
    const injected = {
      stage: 'scan',
      runId: 'run-safe',
      errorCode: 'MEDIA_DECODE_FAILED',
      counts: {
        discovered: 4,
        indexed: 2,
        errors: 1,
        partial: 1,
        changed: 2,
        indexFailed: 1,
        path: 'D:\\Private\\family.jpg',
        tag: '秘密标签',
        gps: { latitude: 30.5, longitude: 114.3 },
      },
      absolutePath: 'D:\\Private\\family.jpg',
      relativePath: 'vacation/family.jpg',
      tags: ['秘密标签'],
      latitude: 30.5,
      longitude: 114.3,
      exifGps: '30.5,114.3',
    } as unknown as DiagnosticInput;

    await diagnostics.record(injected);
    await diagnostics.flush();

    const serialized = await readFile(path.join(logsDirectory, 'diagnostics.jsonl'), 'utf8');
    const event = JSON.parse(serialized.trim()) as Record<string, unknown>;
    expect(event).toEqual({
      appVersion: '1.0.0',
      schemaVersion: 1,
      stage: 'scan',
      runId: 'run-safe',
      errorCode: 'MEDIA_DECODE_FAILED',
      counts: { discovered: 4, indexed: 2, errors: 1, partial: 1, changed: 2, indexFailed: 1 },
    });
    expect(serialized).not.toContain('Private');
    expect(serialized).not.toContain('family.jpg');
    expect(serialized).not.toContain('秘密标签');
    expect(serialized).not.toMatch(/"(?:gps|exif|latitude|longitude|absolutePath|relativePath|tags?)"/iu);
    expect(serialized).not.toContain('30.5');
    expect(serialized).not.toContain('114.3');
  });
});

describe('SDD bounded diagnostics rotation', () => {
  it('keeps the active log plus at most the configured backup count and bounds each file', async () => {
    const logsDirectory = await fixtureRoot();
    const maxBytes = 260;
    const maxBackups = 2;
    const diagnostics = new JsonlDiagnostics(
      logsDirectory,
      '1.0.0',
      1,
      { maxBytes, maxBackups },
    );

    await Promise.all(Array.from({ length: 30 }, (_, index) => diagnostics.record({
      stage: 'scan',
      runId: `run-${index}`,
      counts: { discovered: index, indexed: index, errors: 0 },
    })));
    await diagnostics.flush();

    const logFiles = (await readdir(logsDirectory))
      .filter((name) => name.startsWith('diagnostics.jsonl'))
      .sort();
    expect(logFiles).toEqual([
      'diagnostics.jsonl',
      'diagnostics.jsonl.1',
      'diagnostics.jsonl.2',
    ]);
    await Promise.all(logFiles.map(async (name) => {
      const facts = await stat(path.join(logsDirectory, name));
      expect(facts.isFile()).toBe(true);
      expect(facts.size).toBeGreaterThan(0);
      expect(facts.size).toBeLessThanOrEqual(maxBytes);
      const lines = (await readFile(path.join(logsDirectory, name), 'utf8')).trim().split('\n');
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    }));
  });
});
