const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { verifyPackage } = require('./build/verify-package.cjs');
const installerConfig = require('./build/squirrel-config.json');

const appRoot = path.resolve(__dirname, '..');
const packagedDirectory = path.join(appRoot, 'out', 'PhotoMap-win32-x64');
const outputDirectory = path.join(appRoot, 'out', 'make', 'squirrel.windows', 'x64');
const portableMarkerName = 'photomap.portable';
const portableDataDirectoryName = 'PhotoMapData';
const temporaryPrefix = 'photomap-squirrel-';

function parseSquirrelStageBase(arguments_, defaultBase = os.tmpdir()) {
  if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== '--stage-base')) {
    throw new Error('Usage: node scripts/create-squirrel.cjs [--stage-base <existing ASCII directory>]');
  }
  const value = arguments_.length === 0 ? defaultBase : arguments_[1];
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new Error('Squirrel --stage-base must be a non-empty directory path.');
  }
  const stageBase = path.resolve(value);
  if (/[^\x00-\x7F]/u.test(stageBase)) {
    throw new Error('Squirrel staging needs an ASCII-only path. Supply --stage-base with an existing writable ASCII directory.');
  }
  return stageBase;
}

function assertSquirrelTemporaryPath(candidate, stageBase) {
  const root = path.resolve(candidate);
  const name = path.basename(root);
  if (path.dirname(root).toLowerCase() !== path.resolve(stageBase).toLowerCase()
      || !name.startsWith(temporaryPrefix) || name.length === temporaryPrefix.length) {
    throw new Error(`Refusing an unexpected Squirrel temporary path: ${root}`);
  }
  return root;
}

async function createSquirrelTemporaryRoot(stageBase) {
  const base = parseSquirrelStageBase(['--stage-base', stageBase]);
  const details = await lstat(base);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Squirrel staging base must be an ordinary directory: ${base}`);
  }
  const root = await mkdtemp(path.join(base, temporaryPrefix));
  return assertSquirrelTemporaryPath(root, base);
}

async function removeSquirrelTemporaryRoot(candidate, stageBase) {
  const root = assertSquirrelTemporaryPath(candidate, stageBase);
  let details;
  try { details = await lstat(root); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Refusing to clean a Squirrel temporary path that is not an ordinary directory: ${root}`);
  }
  await rm(root, { recursive: true, force: true });
}

async function assertNonEmptyFile(filePath, label) {
  const details = await stat(filePath);
  if (!details.isFile() || details.size <= 0) {
    throw new Error(`${label} is missing or empty: ${filePath}`);
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

async function hashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const input = createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function sha256(filePath) {
  return hashFile(filePath, 'sha256');
}

async function collectPayloadFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await collectPayloadFiles(fullPath, relativePath));
    else if (entry.isFile()) files.push({ relativePath, sha256: await sha256(fullPath) });
    else throw new Error(`Unexpected non-file payload: ${relativePath}`);
  }
  return files;
}

function requiredArgument(parameters, name) {
  const index = parameters.findIndex((value) => value.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'));
  const value = index >= 0 ? parameters[index + 1] : undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing ${name} in the controlled NuGet invocation.`);
  }
  return value;
}

function createIsolatedBuilderSpawn(spawn, localAppData) {
  return (executable, parameters, options = {}) => {
    const env = { ...process.env, ...options.env };
    // Windows environment names are case-insensitive; avoid duplicate spellings
    // selecting the user's real LocalAppData when Node starts the child.
    for (const name of Object.keys(env)) {
      if (['localappdata', 'squirrel_temp'].includes(name.toLowerCase())) delete env[name];
    }
    env.LOCALAPPDATA = localAppData;
    // Squirrel's .NET special-folder fallback can ignore LOCALAPPDATA. Use its
    // explicit override: https://github.com/Squirrel/Squirrel.Windows/blob/develop/src/Squirrel/Utility.cs
    env.SQUIRREL_TEMP = path.join(localAppData, 'SquirrelTemp');
    return spawn(executable, parameters, { ...options, env, windowsHide: true });
  };
}

async function main() {
  const stageBase = parseSquirrelStageBase(process.argv.slice(2));
  // This adapter depends on a private spawn entry point and NuGet 2.8 behavior.
  // Updating electron-winstaller requires revalidating the full installer path
  // (npm run make), including payload hashes and install/uninstall acceptance.
  const winstallerVersion = require('electron-winstaller/package.json').version;
  if (winstallerVersion !== '5.4.4') {
    throw new Error(`Squirrel compatibility has only been validated with electron-winstaller 5.4.4; received ${winstallerVersion}. Revalidate before updating this guard.`);
  }
  const sevenZip = path.resolve(path.dirname(require.resolve('electron-winstaller')), '..', 'vendor', '7z.exe');
  const spawnPromise = require('electron-winstaller/lib/spawn-promise');
  const originalSpawn = spawnPromise.default;
  if (typeof originalSpawn !== 'function') throw new Error('The electron-winstaller spawn adapter contract changed.');
  await assertNonEmptyFile(path.join(packagedDirectory, 'PhotoMap.exe'), 'Packaged application');
  await assertMissing(
    path.join(packagedDirectory, portableDataDirectoryName),
    'Raw Forge portable data root',
  );
  await assertMissing(
    path.join(packagedDirectory, portableMarkerName),
    'Raw Forge portable marker',
  );
  const expectedPayloads = await collectPayloadFiles(packagedDirectory);

  const temporaryRoot = await createSquirrelTemporaryRoot(stageBase);
  const temporaryApp = path.join(temporaryRoot, 'app');
  const injectionRoot = path.join(temporaryRoot, 'nupkg-injection');
  const verificationRoot = path.join(temporaryRoot, 'nupkg-verification');
  const localAppData = path.join(temporaryRoot, 'localappdata');
  // NuGet and Squirrel must not reuse the signed-in user's SquirrelTemp.
  // Only child environments change; the builder's process.env stays untouched.
  const builderSpawn = createIsolatedBuilderSpawn(originalSpawn, localAppData);
  const injectedPayloads = [
    {
      name: 'Electron dxcompiler.dll',
      source: path.join(temporaryApp, 'dxcompiler.dll'),
      archivePath: path.join('lib', 'net45', 'dxcompiler.dll'),
    },
    {
      name: 'PhotoMap executable',
      source: path.join(temporaryApp, 'PhotoMap.exe'),
      archivePath: path.join('lib', 'net45', 'PhotoMap.exe'),
    },
  ].map((payload) => ({
    ...payload,
    held: path.join(injectionRoot, payload.archivePath),
    expectedHash: undefined,
  }));
  let nugetPackInvocations = 0;

  spawnPromise.default = async (executable, parameters, options) => {
    const nextParameters = [...parameters];
    const isNugetPack = (
      path.basename(executable).toLocaleLowerCase('en-US') === 'nuget.exe'
      && nextParameters[0]?.toLocaleLowerCase('en-US') === 'pack'
    );
    if (!isNugetPack) {
      return builderSpawn(executable, nextParameters, options);
    }

    nugetPackInvocations += 1;
    if (nugetPackInvocations !== 1) {
      throw new Error('Refusing an unexpected additional NuGet pack invocation.');
    }
    const basePath = path.resolve(requiredArgument(nextParameters, '-BasePath'));
    const nugetOutput = path.resolve(requiredArgument(nextParameters, '-OutputDirectory'));
    if (basePath.toLocaleLowerCase('en-US') !== temporaryApp.toLocaleLowerCase('en-US')) {
      throw new Error(`Refusing to adapt an unexpected NuGet base path: ${basePath}`);
    }
    if (!nextParameters.includes('-NonInteractive')) nextParameters.push('-NonInteractive');

    if (nextParameters.some((value) => value.toLocaleLowerCase('en-US') === '-exclude')) {
      throw new Error('Refusing a NuGet invocation that already contains exclusions.');
    }
    for (const payload of injectedPayloads) {
      nextParameters.push('-Exclude', path.basename(payload.source));
      await mkdir(path.dirname(payload.held), { recursive: true });
      await copyFile(payload.source, payload.held);
    }
    const output = await builderSpawn(executable, nextParameters, options);
    const packages = (await readdir(nugetOutput)).filter((name) => name.endsWith('.nupkg'));
    if (packages.length !== 1) {
      throw new Error(`Expected one intermediate NuGet package, found ${packages.length}.`);
    }
    const nupkg = path.join(nugetOutput, packages[0]);

    // NuGet 2.8 closes its output stream while adding the two largest binaries
    // on this Windows toolchain. Let NuGet create the OPC/ZIP package without
    // them, then add exactly those unchanged files before Squirrel releasifies it.
    await builderSpawn(
      sevenZip,
      ['a', '-tzip', '-mx=9', '-y', nupkg, '.\\lib'],
      { cwd: injectionRoot, windowsHide: true },
    );
    await builderSpawn(sevenZip, ['t', nupkg], { windowsHide: true });
    await rm(verificationRoot, { recursive: true, force: true });
    await builderSpawn(
      sevenZip,
      ['x', '-y', `-o${verificationRoot}`, nupkg, ...injectedPayloads.map((payload) => payload.archivePath)],
      { windowsHide: true },
    );
    for (const payload of injectedPayloads) {
      const injectedHash = await sha256(path.join(verificationRoot, payload.archivePath));
      if (injectedHash !== payload.expectedHash) {
        throw new Error(`The injected ${payload.name} hash does not match the packaged application.`);
      }
    }
    return output;
  };

  try {
    await mkdir(localAppData, { recursive: true });
    await cp(packagedDirectory, temporaryApp, { recursive: true, force: true });
    await assertMissing(
      path.join(temporaryApp, portableDataDirectoryName),
      'Temporary Squirrel payload portable data root',
    );
    await assertMissing(
      path.join(temporaryApp, portableMarkerName),
      'Temporary Squirrel payload portable marker',
    );
    await assertNonEmptyFile(sevenZip, 'Bundled 7-Zip');
    for (const payload of injectedPayloads) {
      await assertNonEmptyFile(payload.source, payload.name);
      payload.expectedHash = await sha256(payload.source);
    }
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });

    // Load only after installing the bounded spawn adapter above. This leaves
    // node_modules untouched while avoiding the observed NuGet 2.8 package-writing
    // failures on Electron's native dxcompiler.dll and the packaged application.
    const { createWindowsInstaller } = require('electron-winstaller');
    await createWindowsInstaller({
      ...installerConfig,
      appDirectory: temporaryApp,
      outputDirectory,
    });

    if (nugetPackInvocations !== 1) {
      throw new Error(`Expected one controlled NuGet pack call, observed ${nugetPackInvocations}.`);
    }
    await assertNonEmptyFile(path.join(outputDirectory, 'PhotoMap-Setup.exe'), 'Squirrel installer');
    const releasesPath = path.join(outputDirectory, 'RELEASES');
    await assertNonEmptyFile(releasesPath, 'Squirrel release manifest');
    const packageNames = (await readdir(outputDirectory)).filter((name) => name.endsWith('-full.nupkg'));
    if (packageNames.length !== 1) {
      throw new Error(`Expected one full Squirrel package, found ${packageNames.length}.`);
    }
    const fullPackage = path.join(outputDirectory, packageNames[0]);
    await assertNonEmptyFile(fullPackage, 'Squirrel full package');
    await builderSpawn(sevenZip, ['t', fullPackage], { windowsHide: true });
    const fullPackageListing = await builderSpawn(
      sevenZip,
      ['l', '-slt', fullPackage],
      { windowsHide: true },
    );
    const archiveEntries = fullPackageListing
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('Path = '))
      .map((line) => line.slice('Path = '.length).trim())
      .slice(1);
    const markerEntries = archiveEntries
      .filter((entry) => (
        path.win32.basename(entry.replaceAll('/', '\\')).toLocaleLowerCase('en-US')
        === portableMarkerName.toLocaleLowerCase('en-US')
      ));
    if (markerEntries.length > 0) {
      throw new Error(
        `Squirrel full package contains the portable marker: ${markerEntries.join(', ')}`,
      );
    }
    const portableDataEntries = archiveEntries.filter((entry) => (
      entry
        .replaceAll('/', '\\')
        .split('\\')
        .some((component) => (
          component.toLocaleLowerCase('en-US')
          === portableDataDirectoryName.toLocaleLowerCase('en-US')
        ))
    ));
    if (portableDataEntries.length > 0) {
      throw new Error(
        `Squirrel full package contains portable user data: ${portableDataEntries.join(', ')}`,
      );
    }
    await rm(verificationRoot, { recursive: true, force: true });
    await builderSpawn(
      sevenZip,
      [
        'x',
        '-y',
        `-o${verificationRoot}`,
        fullPackage,
      ],
      { windowsHide: true },
    );
    const releasedApp = path.join(verificationRoot, 'lib', 'net45');
    for (const payload of expectedPayloads) {
      const releasedHash = await sha256(path.join(releasedApp, payload.relativePath));
      if (releasedHash !== payload.sha256) {
        throw new Error(`The released ${payload.relativePath} hash does not match the packaged application.`);
      }
    }
    await verifyPackage(releasedApp);
    console.log(`Squirrel payload verified: ${expectedPayloads.length} application files and complete licenses.`);
    await assertNonEmptyFile(
      path.join(verificationRoot, 'lib', 'net45', 'PhotoMap_ExecutionStub.exe'),
      'Squirrel execution stub',
    );
    const releaseLines = (await readFile(releasesPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    const releaseMatch = releaseLines.length === 1
      ? releaseLines[0].match(/^([a-f\d]{40})\s+(\S+)\s+(\d+)$/i)
      : null;
    const fullPackageDetails = await stat(fullPackage);
    if (
      !releaseMatch
      || releaseMatch[2] !== packageNames[0]
      || Number(releaseMatch[3]) !== fullPackageDetails.size
      || releaseMatch[1].toLocaleLowerCase('en-US') !== await hashFile(fullPackage, 'sha1')
    ) {
      throw new Error('The Squirrel RELEASES entry does not match the full package.');
    }
  } finally {
    spawnPromise.default = originalSpawn;
    await removeSquirrelTemporaryRoot(temporaryRoot, stageBase);
  }
}

module.exports = { createIsolatedBuilderSpawn, parseSquirrelStageBase, createSquirrelTemporaryRoot, removeSquirrelTemporaryRoot };
if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
