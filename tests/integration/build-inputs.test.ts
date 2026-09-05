import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('../helpers/build-inputs-case.ps1', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../../scripts/build/input-manifest.json', import.meta.url), 'utf8')) as { files: string[]; directories: string[] };
const directories: string[] = [];
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
interface BuildIdentity { sha256: string; fileCount: number }
interface Inspection { paths: string[]; identity: BuildIdentity; stagedIdentity?: BuildIdentity; gitHead: string | null }

function fixture(base = os.tmpdir()) {
  const parent = mkdtempSync(path.join(base, 'photomap-inputs-test-'));
  directories.push(parent);
  const root = path.join(parent, 'source');
  mkdirSync(root);
  for (const name of manifest.files) writeFileSync(path.join(root, name), `${name}\n`);
  for (const name of manifest.directories) mkdirSync(path.join(root, name));
  return { root, stage: path.join(parent, 'stage'), outside: path.join(parent, 'outside') };
}
function write(root: string, relative: string, contents = 'test input') {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
function inspect(root: string, stage?: string): Inspection {
  const args = ['-NoProfile', '-File', helper, '-AppRoot', root];
  if (stage) args.push('-StageRoot', stage);
  return JSON.parse(execFileSync('pwsh', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })) as Inspection;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'win32')('product build inputs', { timeout: 20_000 }, () => {
  it.skipIf(!existsSync(path.join(repositoryRoot, '.git')))('does not borrow a parent repository commit for a nested source ZIP', () => {
    const localRoot = path.join(repositoryRoot, '.local');
    mkdirSync(localRoot, { recursive: true });
    const { root } = fixture(localRoot);
    expect(inspect(root).gitHead).toBeNull();
  });

  it('stages precisely the hashed inputs from a source ZIP, including new code and binary assets', () => {
    const { root, stage } = fixture();
    const included = ['src/new-feature.ts', 'resources/map/layer.png', 'scripts/new-check.cjs', 'tests/new-case.test.ts'];
    for (const file of included) write(root, file);
    const excluded = ['README.md', 'docs/images/example.png', 'node_modules/dependency.js', '.local/nested/src/private.ts',
      'src/node_modules/dependency.js', 'src/.playwright-cli/page.yml', 'src/debug.log', 'src/.env.local', 'src/private.key', 'src/cert.pfx',
      'src/file.ts.orig', 'src/file.ts.bak', 'src/file.ts.backup', 'src/file.ts.rej', 'src/file.ts.tmp', 'src/file.ts.temp',
      'src/file.ts~', 'src/Thumbs.db', 'src/cache.tsbuildinfo',
      'resources/data/china-provinces.geojson', 'resources/data/renamed.geojson', 'tests/PhotoMapData/private.json'];
    for (const file of excluded) write(root, file);
    const result = inspect(root, stage);
    expect(result.gitHead).toBeNull();
    expect(result.paths.sort()).toEqual([...manifest.files, ...included].sort());
    expect(result.stagedIdentity).toMatchObject(result.identity);
    expect(readdirSync(stage, { recursive: true }).map(String).filter(name => name.endsWith('.geojson') || name.endsWith('.key'))).toEqual([]);
    for (const file of included) expect(readFileSync(path.join(stage, file))).toEqual(readFileSync(path.join(root, file)));
  });

  it('changes the fingerprint for new, edited and deleted source files, but not local output', () => {
    const { root } = fixture();
    const before = inspect(root).identity;
    write(root, 'src/new.ts', 'first');
    const added = inspect(root).identity;
    expect(added.sha256).not.toBe(before.sha256);
    expect(added.fileCount).toBe(before.fileCount + 1);
    write(root, 'src/new.ts', 'other');
    const edited = inspect(root).identity;
    expect(edited.sha256).not.toBe(added.sha256);
    write(root, 'src/new.ts.log');
    write(root, '.local/build/src/generated.ts');
    expect(inspect(root).identity.sha256).toBe(edited.sha256);
    rmSync(path.join(root, 'src/new.ts'));
    expect(inspect(root).identity.sha256).toBe(before.sha256);
  });

  it('prunes excluded junctions and rejects linked source directories', () => {
    const { root, outside } = fixture();
    mkdirSync(outside);
    write(outside, 'private.ts');
    symlinkSync(outside, path.join(root, 'src/node_modules'), 'junction');
    expect(inspect(root).paths.sort()).toEqual([...manifest.files].sort());
    symlinkSync(outside, path.join(root, 'src/linked-source'), 'junction');
    expect(() => inspect(root)).toThrow(/reparse point/);
  });

  it('fails on missing build configuration and refuses to overwrite a staging directory', () => {
    const { root, stage } = fixture();
    mkdirSync(stage);
    write(stage, 'keep.txt');
    expect(() => inspect(root, stage)).toThrow(/must not already exist/);
    expect(readFileSync(path.join(stage, 'keep.txt'), 'utf8')).toBe('test input');
    rmSync(path.join(root, 'package-lock.json'));
    expect(() => inspect(root)).toThrow(/package-lock.json/);
  });
});
