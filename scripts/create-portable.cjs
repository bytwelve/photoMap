const { lstat, readFile, rename, rm, stat, writeFile } = require('node:fs/promises');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(appRoot, 'out');
const rawDirectory = path.join(outputRoot, 'PhotoMap-win32-x64');
const portableDirectory = path.join(outputRoot, 'PhotoMap-portable-win32-x64');
const executableName = 'PhotoMap.exe';
const markerName = 'photomap.portable';
const portableDataDirectoryName = 'PhotoMapData';
const markerContents = 'PhotoMap portable distribution marker v1\n';

function assertExactOutputPath(candidate, expectedName) {
  if (
    path.dirname(candidate).toLocaleLowerCase('en-US') !== outputRoot.toLocaleLowerCase('en-US')
    || path.basename(candidate) !== expectedName
  ) {
    throw new Error(`Refusing an unexpected portable-package path: ${candidate}`);
  }
}

async function assertDirectory(directoryPath, label) {
  const details = await lstat(directoryPath);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not an ordinary directory: ${directoryPath}`);
  }
}

async function assertNonEmptyFile(filePath, label) {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0) {
    throw new Error(`${label} is not an ordinary non-empty file: ${filePath}`);
  }
}

async function assertMissing(candidate, label) {
  try {
    await lstat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} must be absent: ${candidate}`);
}

async function removePreviousPortableDirectory() {
  try {
    await assertDirectory(portableDirectory, 'Existing portable package');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  await assertMissing(
    path.join(portableDirectory, portableDataDirectoryName),
    'Existing portable data root; refusing to replace a package that contains user data',
  );
  await assertNonEmptyFile(
    path.join(portableDirectory, executableName),
    'Existing portable application',
  );
  const previousMarker = path.join(portableDirectory, markerName);
  await assertNonEmptyFile(previousMarker, 'Existing portable marker');
  if ((await readFile(previousMarker, 'utf8')).trim().length === 0) {
    throw new Error(`Existing portable marker has no content: ${previousMarker}`);
  }
  await rm(portableDirectory, { recursive: true, force: true });
}

async function main() {
  assertExactOutputPath(rawDirectory, 'PhotoMap-win32-x64');
  assertExactOutputPath(portableDirectory, 'PhotoMap-portable-win32-x64');
  await assertDirectory(rawDirectory, 'Raw Forge package');
  await assertNonEmptyFile(path.join(rawDirectory, executableName), 'Raw Forge application');
  await assertMissing(
    path.join(rawDirectory, portableDataDirectoryName),
    'Raw Forge portable data root',
  );
  await assertMissing(
    path.join(rawDirectory, markerName),
    'Raw Forge portable marker',
  );
  await removePreviousPortableDirectory();

  let renamed = false;
  try {
    await rename(rawDirectory, portableDirectory);
    renamed = true;
    const markerPath = path.join(portableDirectory, markerName);
    await writeFile(markerPath, markerContents, { encoding: 'utf8', flag: 'wx' });
    await assertNonEmptyFile(markerPath, 'Portable marker');
    await assertNonEmptyFile(
      path.join(portableDirectory, executableName),
      'Portable application',
    );
    await assertMissing(
      path.join(portableDirectory, portableDataDirectoryName),
      'New portable package data root',
    );
    await assertMissing(rawDirectory, 'Raw Forge package after portable rename');
    console.log(`Portable app: ${portableDirectory}`);
  } catch (error) {
    if (renamed) {
      await rm(path.join(portableDirectory, markerName), { force: true }).catch(() => undefined);
      await stat(rawDirectory).catch(async (statError) => {
        if (statError?.code !== 'ENOENT') throw statError;
        await rename(portableDirectory, rawDirectory);
      });
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
