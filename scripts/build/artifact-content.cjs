'use strict';

const path = require('node:path');
const { readdir, lstat } = require('node:fs/promises');
const { listPackage, statFile, uncache } = require('@electron/asar');
const manifest = require('./input-manifest.json');
const policy = require('./artifact-policy.json');

const directories = new Set(policy.forbiddenDirectoryNames.map(name => name.toLowerCase()));
const filePatterns = manifest.excludedFilePatterns.map(pattern => new RegExp('^' + pattern
  .split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i'));

function isForbiddenArtifactPath(relative, directory = false) {
  const parts = relative.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').split('/');
  if (parts.some(part => part === '..' || part === '.')) return true;
  const parents = directory ? parts : parts.slice(0, -1);
  return parents.some(part => directories.has(part.toLowerCase())) ||
    (!directory && filePatterns.some(pattern => pattern.test(parts.at(-1))));
}

function verifyAsarContents(archivePath) {
  uncache(archivePath);
  const entries = listPackage(archivePath).map(name => name.replaceAll('\\', '/'));
  for (const entry of entries) {
    const metadata = statFile(archivePath, entry.replace(/^\//, '').replaceAll('/', path.sep), false);
    if ('link' in metadata) throw new Error(`Package contains an ASAR symbolic link: ${entry}`);
    const directory = 'files' in metadata;
    // Forge may leave this one empty directory; any descendant is still rejected.
    if (entry === '/node_modules' && directory && Object.keys(metadata.files).length === 0) continue;
    if (isForbiddenArtifactPath(entry, directory)) throw new Error(`Unexpected packaged ASAR entry: ${entry}`);
  }
  return entries.length;
}

async function verifyArtifactDirectory(root) {
  root = path.resolve(root);
  if ((await lstat(root)).isSymbolicLink()) throw new Error(`Package contains a symbolic link: ${root}`);
  let archiveEntries = 0;
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name);
      const relative = path.relative(root, full).replaceAll('\\', '/');
      if (item.isSymbolicLink()) throw new Error(`Package contains a symbolic link: ${relative}`);
      if (isForbiddenArtifactPath(relative, item.isDirectory())) throw new Error(`Unexpected packaged resource: ${relative}`);
      if (item.isDirectory()) await walk(full);
      else if (/\.asar$/i.test(item.name)) archiveEntries += verifyAsarContents(full);
    }
  }
  await walk(root);
  return { archiveEntries };
}

module.exports = { isForbiddenArtifactPath, verifyAsarContents, verifyArtifactDirectory };
if (require.main === module) {
  const [mode, target] = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (!target) throw new Error('An artifact path is required.');
    if (mode === '--asar') return { archiveEntries: verifyAsarContents(target) };
    if (mode === '--directory') return verifyArtifactDirectory(target);
    throw new Error('Expected --asar or --directory.');
  }).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
