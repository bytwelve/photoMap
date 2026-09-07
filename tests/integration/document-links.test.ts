import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
interface Result { checked: number; checkedRefs: number; skippedRefs: number; files: number; failures: string[] }
const { checkDocuments, collectMarkdownFiles } = require('../../scripts/check-docs.cjs') as {
  checkDocuments(root: string, files?: string[]): Result;
  collectMarkdownFiles(root: string): string[];
};
const { collectLicenses, packageDocument } = require('../../scripts/build/collect-licenses.cjs') as {
  collectLicenses(root?: string): Promise<{ outputs: Record<string, string>; manifest: { files: Record<string, { sha256: string; bytes: number }> } }>;
  packageDocument(source: string): string;
};
const roots: string[] = [];
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'photomap-document-test-'));
  roots.push(root);
  return root;
}
function write(root: string, file: string, value: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, 'utf8');
}
function git(root: string, args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('document link checks', () => {
  it('rejects links to local records and build output even when those files exist', () => {
    const root = fixture();
    write(root, 'README.md', '[record](.local/report.md)\n[build](out/result.md)');
    write(root, '.local/report.md', '# Private record');
    write(root, 'out/result.md', '# Generated output');
    expect(checkDocuments(root).failures).toEqual([
      expect.stringContaining('.local/report.md: target is local-only or generated content'),
      expect.stringContaining('out/result.md: target is local-only or generated content'),
    ]);
  });

  it('finds referenced links and images inside fixture documentation in a source ZIP', () => {
    const root = fixture();
    write(root, 'README.md', '# Readme\n[fixture](tests/fixtures/photos/README.md)');
    write(root, 'tests/fixtures/photos/README.md', [
      '[full][missing]', '![picture][image]', '[collapsed][]', '[shortcut]',
      '[unused]: missing-unused.md', '[missing]: missing.md', '[image]: missing.png',
      '[collapsed]: absent.md', '[shortcut]: missing-shortcut.md',
    ].join('\n'));
    write(root, 'node_modules/private/README.md', '[skip](missing-dependency.md)');
    write(root, '.local/README.md', '[skip](missing-backup.md)');
    write(root, 'src/PhotoMapData/README.md', '[skip](missing-data.md)');
    expect(collectMarkdownFiles(root).map(file => file.replaceAll('\\', '/'))).toEqual(['README.md', 'tests/fixtures/photos/README.md']);
    const result = checkDocuments(root);
    expect(result.files).toBe(2);
    for (const file of ['missing.md', 'missing.png', 'absent.md', 'missing-shortcut.md', 'missing-unused.md']) {
      expect(result.failures.some(message => message.includes(`${file}: target does not exist`))).toBe(true);
    }
  });

  it('checks local headings, encoded names, HTML images and query strings while ignoring examples', () => {
    const root = fixture();
    write(root, 'guide 中文.md', '# 标题\n# 标题\n\nOther heading\n---\n\n<a id="custom"></a>');
    write(root, 'image (1).png', 'image');
    write(root, 'README.md', [
      '# Start', '[a](guide%20%E4%B8%AD%E6%96%87.md#标题)', '[b](<guide 中文.md#标题-1>)',
      '[c](<guide 中文.md?raw=1#other-heading>)', '[d](<guide 中文.md#custom>)',
      '![picture](image%20(1).png)', '<img src="image%20(1).png" />',
      '`[example](missing-code.md)`', '```md', '[fenced](missing-fence.md)', '````',
      '<!-- [comment](missing-comment.md) -->', '[external](https://example.com/docs)',
    ].join('\n'));
    expect(checkDocuments(root).failures).toEqual([]);
    write(root, 'README.md', '[bad](<guide 中文.md#missing>)\n[escape](../secret.md)\n<img src="missing.png" />');
    expect(checkDocuments(root).failures).toEqual(expect.arrayContaining([
      expect.stringContaining('heading anchor does not exist'), expect.stringContaining('target is outside the repository'),
      expect.stringContaining('missing.png: target does not exist'),
    ]));
  });

  it('reports unverified GitHub refs honestly when a source ZIP has no Git metadata', () => {
    const root = fixture();
    write(root, 'README.md', '[version]: ../../releases/tag/v1.0.0\n[compare]: ../../compare/v1.0.0...HEAD');
    expect(checkDocuments(root)).toMatchObject({ failures: [], checkedRefs: 0, skippedRefs: 2 });
  });

  it.skipIf(!hasGit)('rejects missing Git refs and accepts real tags without borrowing a parent checkout', () => {
    const root = fixture();
    git(root, ['init', '--quiet', '--initial-branch=main']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'fixture']);
    git(root, ['tag', 'v1.0.0']);
    write(root, 'README.md', '[valid]: ../../compare/v1.0.0...HEAD\n[missing]: ../../releases/tag/v9.9.9');
    expect(checkDocuments(root)).toMatchObject({ checkedRefs: 1, skippedRefs: 0, failures: [expect.stringContaining('Git reference does not exist: v9.9.9')] });
    const nested = path.join(root, 'nested-source');
    write(nested, 'README.md', '[version]: ../../releases/tag/v9.9.9');
    expect(checkDocuments(nested)).toMatchObject({ failures: [], checkedRefs: 0, skippedRefs: 1 });
  });
});

describe('packaged license documents', () => {
  it('rewrites both inline and reference links without losing source locations or external references', () => {
    const source = ['[license][mit]', '[source](scripts/build/collect-licenses.cjs)', '[asset](ASSETS.md#图片)',
      '[external][upstream]', '[mit]: LICENSE', '[upstream]: https://example.com/license'].join('\n');
    const document = packageDocument(source);
    expect(document).toContain('[license](LICENSE-PhotoMap.txt)');
    expect(document).toContain('source（源码路径：`scripts/build/collect-licenses.cjs`）');
    expect(document).toContain('[asset](ASSETS.md#图片)');
    expect(document).toContain('[external](https://example.com/license)');
    expect(document).not.toContain('[mit]:');
  });

  it('generates the real current license bundle with only resolvable local document links and matching fingerprints', async () => {
    const root = fixture();
    const { outputs, manifest } = await collectLicenses();
    for (const [name, content] of Object.entries(outputs)) write(root, name, content);
    expect(outputs['THIRD_PARTY_NOTICES.md']).toContain('[MIT 许可证](LICENSE-PhotoMap.txt)');
    expect(outputs['ASSETS.md']).toContain('(LICENSE-PhotoMap.txt)');
    expect(checkDocuments(root)).toMatchObject({ failures: [], files: 2 });
    for (const [name, metadata] of Object.entries(manifest.files)) {
      const bytes = readFileSync(path.join(root, name));
      expect(bytes.length).toBe(metadata.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(metadata.sha256);
    }
  });
});

describe.skipIf(!hasGit)('repository ignore patterns', () => {
  it('excludes renamed private inputs, nested data and backups while keeping source and public fixtures', () => {
    const root = fixture();
    git(root, ['init', '--quiet']);
    write(root, '.gitignore', readFileSync(fileURLToPath(new URL('../../.gitignore', import.meta.url)), 'utf8'));
    const excluded = ['src/file.ts.backup', 'src/file.ts.rej', 'src/file.ts.tmp', 'src/file.ts.temp',
      'resources/data/renamed.geojson', 'tests/PhotoMapData/private.json', 'releases/output.zip', '.local/backup.zip'];
    const included = ['src/code.ts', 'tests/fixtures/photos/README.md', 'tests/fixtures/photos/example.png',
      'resources/map/layer.png', 'package-lock.json', '.env.example'];
    const ignored = execFileSync('git', ['-C', root, '-c', 'core.excludesFile=', 'check-ignore', '--no-index', '--stdin'], {
      input: [...excluded, ...included].join('\n') + '\n', encoding: 'utf8', windowsHide: true,
    }).trim().split(/\r?\n/);
    expect(ignored.sort()).toEqual(excluded.sort());
  });
});
