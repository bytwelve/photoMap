import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
type Spawn = (executable: string, args: string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string; windowsHide?: boolean }) => Promise<string>;
const { createIsolatedBuilderSpawn } = require('../../scripts/create-squirrel.cjs') as {
  createIsolatedBuilderSpawn: (spawn: Spawn, localAppData: string) => Spawn;
};
const originalSpawn = (require('electron-winstaller/lib/spawn-promise') as { default: Spawn }).default;

describe('isolated Squirrel child environment', () => {
  it('passes isolated LocalAppData through the actual upstream spawn implementation without changing the parent', async () => {
    const before = { ...process.env };
    const target = 'isolated-squirrel-test-directory';
    const spawn = createIsolatedBuilderSpawn(originalSpawn, target);
    const output = await spawn(process.execPath, ['-e', 'console.log(JSON.stringify({local:process.env.LOCALAPPDATA,temp:process.env.SQUIRREL_TEMP,marker:process.env.PHOTOMAP_BUILD_TEST}))'], {
      env: { LocalAppData: 'must-not-be-used', Squirrel_Temp: 'must-not-be-used', PHOTOMAP_BUILD_TEST: 'preserved' },
    });
    expect(JSON.parse(output)).toEqual({ local: target, temp: path.join(target, 'SquirrelTemp'), marker: 'preserved' });
    expect(process.env).toEqual(before);
  });
  it('keeps the parent environment unchanged when the builder fails', async () => {
    const before = { ...process.env };
    const spawn = createIsolatedBuilderSpawn(originalSpawn, 'isolated-squirrel-test-directory');
    await expect(spawn(process.execPath, ['-e', 'process.exit(7)'])).rejects.toThrow(/exit code: 7/);
    expect(process.env).toEqual(before);
  });
});
