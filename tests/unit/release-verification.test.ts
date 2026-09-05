import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('../helpers/release-verification-case.ps1', import.meta.url));
const directories: string[] = [];
function step(name: string) { return { name, status: 'passed', exitCode: 0, log: `logs/${name}.log` }; }
function fixture() {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'photomap-gate-test-'));
  directories.push(parent);
  const root = path.join(parent, 'test-run');
  mkdirSync(path.join(root, 'logs'), { recursive: true });
  writeFileSync(path.join(root, 'logs/app-check.log'), 'Real check output');
  writeFileSync(path.join(root, 'logs/app-make.log'), 'Real build output');
  return { root, summary: {
    gate: 'fast', runId: 'test-run', exitCode: 0, failed: 0, passed: 1,
    environment: { node: 'v24.19.0', npm: '11.12.1' },
    sourceIdentity: { sha256: 'A'.repeat(64), fileCount: 25 }, steps: [step('app-check')],
  } };
}
function run(root: string, summary: unknown) {
  writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary));
  return JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', helper, '-ResultRoot', root], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })) as { passed: boolean };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'win32')('release gate evidence', { timeout: 20_000 }, () => {
  it('accepts fast and all command evidence without a synthetic requirements.json', () => {
    const { root, summary } = fixture();
    expect(run(root, summary)).toEqual({ passed: true });
    expect(run(root, { ...summary, gate: 'all', passed: 2, steps: [step('app-check'), step('app-make')] })).toEqual({ passed: true });
  });
  it('rejects mismatched source, incomplete builds and duplicate step records', () => {
    const { root, summary } = fixture();
    expect(() => run(root, { ...summary, sourceIdentity: { ...summary.sourceIdentity, sha256: 'B'.repeat(64) } })).toThrow();
    expect(() => run(root, { ...summary, gate: 'all' })).toThrow();
    expect(() => run(root, { ...summary, steps: [step('app-check'), step('app-check')] })).toThrow();
    expect(() => run(root, { ...summary, steps: [{ ...step('app-check'), status: 'failed', exitCode: 1 }] })).toThrow();
  });
  it('requires the expected real log and rejects path traversal', () => {
    const { root, summary } = fixture();
    expect(() => run(root, { ...summary, steps: [{ ...step('app-check'), log: '../outside.log' }] })).toThrow(/log path/);
    rmSync(path.join(root, 'logs/app-check.log'));
    expect(() => run(root, summary)).toThrow(/app-check.log/);
  });
});
