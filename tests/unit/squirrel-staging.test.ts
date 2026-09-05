import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseSquirrelStageBase, createSquirrelTemporaryRoot, removeSquirrelTemporaryRoot } = require('../../scripts/create-squirrel.cjs') as {
  parseSquirrelStageBase: (args: string[], defaultBase?: string) => string;
  createSquirrelTemporaryRoot: (stageBase: string) => Promise<string>;
  removeSquirrelTemporaryRoot: (candidate: string, stageBase: string) => Promise<void>;
};
const directories: string[] = [];
// Filesystem cases need a writable ASCII temp directory. Argument tests above
// cover a non-ASCII system TEMP without assuming another writable drive path.
const hasAsciiTemp = !/[^\x00-\x7F]/u.test(os.tmpdir());
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photomap-staging-test-'));
  directories.push(root);
  return root;
}
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('Squirrel staging path', () => {
  it('uses the explicit base even when the default temp path contains non-ASCII characters', () => {
    const asciiRoot = path.parse(process.cwd()).root;
    const selected = path.join(asciiRoot, 'Build Stage');
    expect(parseSquirrelStageBase(['--stage-base', selected], path.join(asciiRoot, '临时目录'))).toBe(selected);
    expect(parseSquirrelStageBase([], selected)).toBe(selected);
    expect(() => parseSquirrelStageBase([], path.join(asciiRoot, '临时目录'))).toThrow(/ASCII/);
  });
  it('rejects incomplete, unknown, repeated and invalid stage arguments', () => {
    for (const args of [['--stage-base'], ['--other', 'C:/stage'], ['--stage-base', ''],
      ['--stage-base', 'C:/stage', '--stage-base', 'C:/second'], ['--stage-base', 'C:/中文'], ['--stage-base', '\0']]) {
      expect(() => parseSquirrelStageBase(args)).toThrow();
    }
  });
  it.skipIf(!hasAsciiTemp)('creates and removes only its generated child, preserving sibling files and directories', async () => {
    const base = await fixture();
    await writeFile(path.join(base, 'keep.txt'), 'original');
    const first = await createSquirrelTemporaryRoot(base);
    const second = await createSquirrelTemporaryRoot(base);
    expect(path.dirname(first)).toBe(base);
    expect(path.basename(first)).toMatch(/^photomap-squirrel-.+/);
    expect(second).not.toBe(first);
    await writeFile(path.join(first, 'builder.log'), 'temporary');
    await removeSquirrelTemporaryRoot(first, base);
    await expect(readFile(path.join(first, 'builder.log'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(base, 'keep.txt'), 'utf8')).toBe('original');
    await expect(removeSquirrelTemporaryRoot(base, base)).rejects.toThrow(/unexpected/);
    await expect(removeSquirrelTemporaryRoot(second, first)).rejects.toThrow(/unexpected/);
    await removeSquirrelTemporaryRoot(second, base);
  });
  it.skipIf(!hasAsciiTemp)('rejects missing paths and files as the staging base', async () => {
    const base = await fixture();
    const file = path.join(base, 'file.txt');
    await writeFile(file, 'original');
    await expect(createSquirrelTemporaryRoot(file)).rejects.toThrow(/ordinary directory/);
    await expect(createSquirrelTemporaryRoot(path.join(base, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.skipIf(process.platform !== 'win32' || !hasAsciiTemp)('rejects a junction as the base or cleanup target', async () => {
    const base = await fixture();
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.txt'), 'original');
    const linked = path.join(base, 'photomap-squirrel-linked');
    await symlink(outside, linked, 'junction');
    await expect(createSquirrelTemporaryRoot(linked)).rejects.toThrow(/ordinary directory/);
    await expect(removeSquirrelTemporaryRoot(linked, base)).rejects.toThrow(/ordinary directory/);
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('original');
  });
});
