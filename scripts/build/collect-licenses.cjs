'use strict';

const { createHash } = require('node:crypto');
const { readFile, readdir, mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { parseMarkdownLinks } = require('../markdown-links.cjs');

const appRoot = path.resolve(__dirname, '../..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function packageDocument(source) {
  const available = new Map([
    ['LICENSE', 'LICENSE-PhotoMap.txt'], ['ASSETS.md', 'ASSETS.md'],
    ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
    ['THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_LICENSES.txt'], ['manifest.json', 'manifest.json'],
  ]);
  const { links, definitions } = parseMarkdownLinks(source);
  const edits = definitions.map(({ start, end }) => ({ start, end, text: '' }));
  for (const link of links) {
    const external = /^[a-z][a-z\d+.-]*:|^\/\//i.test(link.url);
    const [pathname] = link.url.split(/[?#]/, 1);
    const mapped = available.get(path.posix.normalize(decodeURIComponent(pathname)));
    let text;
    if (external || !pathname || mapped) {
      const url = mapped ? mapped + link.url.slice(pathname.length) : link.url;
      text = link.html ? source.slice(link.start, link.end).replace(link.url, url)
        : `${link.image ? '!' : ''}[${link.label}](${url})`;
    } else {
      // A binary distribution has no source checkout; preserve its location as
      // text instead of emitting broken links or guessing a GitHub repository.
      text = `${link.html ? '资源' : link.label}（源码路径：\`${link.url}\`）`;
    }
    edits.push({ start: link.start, end: link.end, text });
  }
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return '> 此为随包说明。项目许可证见 [LICENSE-PhotoMap.txt](LICENSE-PhotoMap.txt)；标为“源码路径”的文件需在对应版本源码中查看。\n\n' + result;
}

async function collectLicenses(root = appRoot) {
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const project = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const entries = [];
  for (const [relative, metadata] of Object.entries(lock.packages)) {
    if (!relative || metadata.dev || !relative.startsWith('node_modules/')) continue;
    const directory = path.resolve(root, relative);
    if (!directory.startsWith(path.join(root, 'node_modules') + path.sep)) {
      throw new Error(`Unexpected dependency directory: ${relative}`);
    }
    const packageInfo = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (packageInfo.version !== metadata.version) throw new Error(`Installed version differs from lockfile: ${relative}`);
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^(licen[cs]e|notice|copying)(\.|$)/i.test(entry.name))
      .map((entry) => entry.name).sort();
    if (!files.some((file) => /^(licen[cs]e|copying)(\.|$)/i.test(file))) {
      throw new Error(`Dependency license text is missing: ${packageInfo.name}`);
    }
    const notices = [];
    for (const file of files) {
      const text = (await readFile(path.join(directory, file), 'utf8')).replaceAll('\r\n', '\n').trim();
      if (!text) throw new Error(`Empty license file: ${relative}/${file}`);
      notices.push({ file, text });
    }
    entries.push({
      name: packageInfo.name,
      version: packageInfo.version,
      license: packageInfo.license ?? metadata.license,
      sourceArchive: metadata.resolved,
      notices,
    });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const title = `PhotoMap ${project.version} — third-party licenses`;
  const sections = [title, 'Electron and Chromium licenses are also supplied beside the application executable.'];
  for (const entry of entries) {
    sections.push(`${entry.name}@${entry.version}\nLicense: ${entry.license}\nSource archive: ${entry.sourceArchive}`);
    if (entry.license === 'MPL-2.0') {
      sections.push('The MPL-covered source is available under MPL-2.0 in the source archive above. ExifReader is used without modifications; its archive includes the original src/ files.');
    }
    for (const notice of entry.notices) sections.push(`${entry.name}/${notice.file}\n\n${notice.text}`);
  }
  const outputs = {
    'LICENSE-PhotoMap.txt': await readFile(path.join(root, 'LICENSE'), 'utf8'),
    'THIRD_PARTY_NOTICES.md': packageDocument(await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')),
    'ASSETS.md': packageDocument(await readFile(path.join(root, 'ASSETS.md'), 'utf8')),
    'THIRD_PARTY_LICENSES.txt': sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n',
  };
  const manifest = {
    schemaVersion: 1,
    applicationVersion: project.version,
    packages: entries.map(({ notices, ...entry }) => ({ ...entry, licenseFiles: notices.map((notice) => notice.file) })),
    files: Object.fromEntries(Object.entries(outputs).map(([name, content]) => [name, { sha256: sha256(content), bytes: Buffer.byteLength(content) }])),
  };
  return { outputs: { ...outputs, 'manifest.json': JSON.stringify(manifest, null, 2) + '\n' }, manifest };
}

async function main() {
  const { outputs, manifest } = await collectLicenses();
  if (!process.argv.includes('--check')) {
    const output = path.join(appRoot, 'out/build-resources/licenses');
    await mkdir(output, { recursive: true });
    for (const [name, content] of Object.entries(outputs)) await writeFile(path.join(output, name), content, 'utf8');
  }
  console.log(`Verified full license texts for ${manifest.packages.length} runtime dependencies.`);
}

module.exports = { collectLicenses, packageDocument };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
