'use strict';

const path = require('node:path');
const { existsSync } = require('node:fs');
const { readFile, lstat } = require('node:fs/promises');
const { collectLicenses } = require('./collect-licenses.cjs');
const { checkDocuments } = require('../check-docs.cjs');
const { verifyArtifactDirectory } = require('./artifact-content.cjs');

const appRoot = path.resolve(__dirname, '../..');

async function verifyPackage(directory) {
  const root = path.resolve(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error(`Not a package directory: ${root}`);
  const { archiveEntries } = await verifyArtifactDirectory(root);
  if (!(await lstat(path.join(root, 'resources/app.asar'))).isFile()) throw new Error('Application ASAR is missing.');
  const { outputs } = await collectLicenses(appRoot);
  // Electron 43 installs its binary lazily when first resolved.
  const electronDistribution = path.dirname(require('electron'));
  for (const [name, expected] of Object.entries(outputs)) {
    const actual = await readFile(path.join(root, 'resources/licenses', name), 'utf8');
    if (actual !== expected) throw new Error(`Packaged license differs from current build inputs: ${name}`);
  }
  const documents = checkDocuments(path.join(root, 'resources/licenses'));
  if (documents.failures.length) throw new Error(`Broken packaged document links:\n${documents.failures.join('\n')}`);
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const actual = await readFile(path.join(root, name));
    const expected = await readFile(path.join(electronDistribution, name));
    if (!actual.equals(expected)) throw new Error(`Missing or changed Electron license: ${name}`);
  }
  if ((await lstat(path.join(root, 'PhotoMap.exe'))).size === 0) throw new Error('Application executable is empty.');
  return { directory: root, licenses: 'complete', excludedPrivateData: true, archiveEntries };
}

module.exports = { verifyPackage };
const rawPackage = path.join(appRoot, 'out/PhotoMap-win32-x64');
const defaultPackage = existsSync(rawPackage) ? rawPackage : path.join(appRoot, 'out/PhotoMap-portable-win32-x64');
if (require.main === module) verifyPackage(process.argv[2] || defaultPackage)
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error); process.exitCode = 1; });
