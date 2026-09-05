import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('../helpers/release-acceptance-case.ps1', import.meta.url));
const directories: string[] = [];
const evidence = () => ({
  schemaVersion: 1, applicationVersion: '1.0.0', reviewedBy: 'Test reviewer',
  reviewedAtUtc: '2026-01-01T00:00:00Z', statement: 'Reviewed this fixture only.',
  installerSha256: 'A'.repeat(64), applicationPayloadSha256: 'B'.repeat(64),
  installerSmokeTest: { status: 'passed', notes: 'Install, launch and uninstall verified.' },
  offlineSmokeTest: { status: 'passed', notes: 'Host network disconnected during the workflow.' },
});
function run(input?: unknown): Record<string, unknown> {
  const args = ['-NoProfile', '-File', helper];
  if (input !== undefined) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'photomap-acceptance-test-'));
    directories.push(directory);
    const file = path.join(directory, 'evidence.json');
    writeFileSync(file, JSON.stringify(input));
    args.push('-EvidencePath', file);
  }
  return JSON.parse(execFileSync('pwsh', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })) as Record<string, unknown>;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'win32')('release owner evidence', { timeout: 15_000 }, () => {
  it('keeps an automated build pending without owner evidence', () => {
    expect(run()).toMatchObject({ status: 'pending', source: 'no-owner-evidence', reviewedBy: null, installerSmokeTest: { status: 'notRun' } });
  });
  it('accepts evidence only for the exact artifacts', () => {
    expect(run(evidence())).toMatchObject({ status: 'accepted', source: 'supplied-owner-evidence' });
    expect(() => run({ ...evidence(), installerSha256: 'C'.repeat(64) })).toThrow();
    expect(() => run({ ...evidence(), applicationVersion: '0.3.0' })).toThrow();
  });
  it('preserves incomplete or failed smoke tests', () => {
    expect(run({ ...evidence(), offlineSmokeTest: { status: 'notRun', notes: 'Not executed.' } })).toMatchObject({ status: 'reviewed-with-gaps', offlineSmokeTest: { status: 'notRun' } });
    expect(run({ ...evidence(), installerSmokeTest: { status: 'failed', notes: 'Launch failed.' } })).toMatchObject({ status: 'reviewed-with-gaps', installerSmokeTest: { status: 'failed' } });
  });
  it('rejects unnamed reviewers and ambiguous smoke results', () => {
    expect(() => run({ ...evidence(), reviewedBy: '' })).toThrow();
    expect(() => run({ ...evidence(), offlineSmokeTest: { status: 'passed', notes: '' } })).toThrow();
  });
});
