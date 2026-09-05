import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPackageWithOptions } from '@electron/asar';

const require = createRequire(import.meta.url);
const { verifyPackage } = require('../../scripts/build/verify-package.cjs') as {
  verifyPackage(directory: string): Promise<{ excludedPrivateData: boolean }>;
};
const { collectLicenses } = require('../../scripts/build/collect-licenses.cjs') as {
  collectLicenses(): Promise<{ outputs: Record<string, string> }>;
};
const helper = fileURLToPath(new URL('../helpers/artifact-content-case.ps1', import.meta.url));
const repository = fileURLToPath(new URL('../../', import.meta.url));
const roots: string[] = [];
function write(root: string, relative: string, content = 'fixture') {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}
async function fixture(extra?: string, inAsar = false) {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'photomap-artifact-test-'));
  roots.push(parent);
  const root = path.join(parent, 'package');
  const source = path.join(parent, 'source');
  write(source, '.webpack/main/index.js', 'console.log("fixture")');
  mkdirSync(path.join(source, 'node_modules'));
  if (extra && inAsar) write(source, extra);
  mkdirSync(path.join(root, 'resources'), { recursive: true });
  const output = await createPackageWithOptions(source, path.join(root, 'resources/app.asar'), { dot: true });
  await finished(output);
  if (extra && !inAsar) write(root, extra);
  return { parent, root };
}
function powershell(mode: string, root: string, archivePath?: string) {
  const args = ['-NoProfile', '-File', helper, '-Mode', mode, '-Root', root];
  if (archivePath) args.push('-ArchivePath', archivePath);
  return execFileSync('pwsh', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('actual packaged file checks', () => {
  beforeAll(async () => {
    // Electron 43 lazily installs its distribution on first resolution. Keep
    // that preparation outside the assertion deadline, with a process timeout
    // so an unavailable download cannot leave the suite waiting indefinitely.
    await promisify(execFile)(process.execPath, ['-e', "require('electron')"], {
      cwd: repository, windowsHide: true, timeout: 120_000,
    });
  }, 125_000);

  it('accepts a complete license bundle and representative Electron runtime files', { timeout: 15_000 }, async () => {
    const { root } = await fixture();
    const { outputs } = await collectLicenses();
    for (const [name, content] of Object.entries(outputs)) write(root, `resources/licenses/${name}`, content);
    const electron = path.dirname(require('electron') as string);
    for (const name of ['LICENSE', 'LICENSES.chromium.html']) copyFileSync(path.join(electron, name), path.join(root, name));
    for (const name of ['PhotoMap.exe', 'locales/zh-CN.pak', 'chrome_100_percent.pak', 'snapshot_blob.bin',
      'v8_context_snapshot.bin', 'libEGL.dll', 'vk_swiftshader_icd.json', 'version', 'RELEASES']) write(root, name);
    await expect(verifyPackage(root)).resolves.toMatchObject({ excludedPrivateData: true });
  });

  for (const inAsar of [false, true]) {
    it.each(['resources/data/renamed.GEOJSON', 'nested/PhotoMapData/catalog.sqlite', 'nested/file.backup',
      'nested/file.tmp', 'nested/file.rej', 'nested/.env.local', 'nested/.local/history.zip',
      'nested/.playwright-cli/page.yml'])(
      `rejects %s ${inAsar ? 'inside ASAR' : 'in package resources'}`, async (entry) => {
        const { root } = await fixture(entry, inAsar);
        await expect(verifyPackage(root)).rejects.toThrow(/Unexpected packaged (ASAR entry|resource)/);
      });
  }
});

describe.skipIf(process.platform !== 'win32')('release archive checks', { timeout: 20_000 }, () => {
  it('accepts both portable ZIP and Squirrel nupkg layouts', async () => {
    for (const prefix of ['PhotoMap-portable-win32-x64', 'lib/net45']) {
      const { parent, root } = await fixture();
      const staging = path.join(parent, 'archive-source');
      write(staging, `${prefix}/locales/en-US.pak`);
      write(staging, `${prefix}/RELEASES`);
      write(staging, `${prefix}/resources/app.asar`, 'placeholder');
      copyFileSync(path.join(root, 'resources/app.asar'), path.join(staging, prefix, 'resources/app.asar'));
      const archive = path.join(parent, 'application.zip');
      powershell('CreateArchive', staging, archive);
      expect(() => powershell('Archive', archive)).not.toThrow();
    }
  });

  it.each(['renamed.geojson', 'nested/PhotoMapData/catalog.sqlite', 'nested/app.js.bak'])(
    'rejects a prohibited archive entry: %s', async (entry) => {
      const { parent, root } = await fixture(`lib/net45/${entry}`);
      const archive = path.join(parent, 'application.nupkg');
      powershell('CreateArchive', root, archive);
      expect(() => powershell('Archive', archive)).toThrow(/forbidden application content/);
    });

  it('opens the actual ASAR inside an archive and rejects private content hidden there', async () => {
    const { parent, root } = await fixture('nested/private.geojson', true);
    const archive = path.join(parent, 'application.zip');
    powershell('CreateArchive', root, archive);
    expect(() => powershell('Archive', archive)).toThrow(/invalid ASAR content/);
  });

  it.skipIf(spawnSync('git', ['--version'], { windowsHide: true }).status !== 0)(
    'rejects a renamed map in a real public tag before preparing release output', async () => {
      const { parent } = await fixture();
      const source = path.join(parent, 'tagged-source');
      for (const file of ['scripts/release/prepare-github-release.ps1', 'scripts/release/artifact-content.ps1', 'scripts/release/filesystem.ps1',
        'scripts/build/artifact-policy.json', 'scripts/build/input-manifest.json']) {
        write(source, file, readFileSync(path.join(repository, file), 'utf8'));
      }
      write(source, 'resources/private-renamed.geojson');
      const git = (args: string[]) => execFileSync('git', ['-C', source, '-c', 'core.excludesFile=', '-c', 'core.autocrlf=false', ...args],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      git(['init', '--quiet']);
      git(['add', '.']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
      git(['tag', 'v1.0.0']);
      expect(() => execFileSync('pwsh', ['-NoProfile', '-File', path.join(source, 'scripts/release/prepare-github-release.ps1'),
        '-TagName', 'v1.0.0', '-OutputRoot', path.join(parent, 'public-output')],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })).toThrow(/local, backup or private input/);
    });
});
