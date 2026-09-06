import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isMissingPathError, assertCondition, normalizedPath } from './utils.mjs';
import { portableArtifactName, temporaryDirectoryPrefix, portableDataDirectoryName, portableSourcePath, resultRoot, appRoot, stageRawForgePackage, rawForgeArtifactName, portableMarkerName, mapDataContracts, runId, temporaryOwnerFileName } from './config.mjs';

export async function assertOrdinaryDirectory(directoryPath, label) {
  const details = await lstat(directoryPath);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not an ordinary directory: ${directoryPath}`);
  }
}

export async function assertNonEmptyOrdinaryFile(filePath, label) {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0) {
    throw new Error(`${label} is not an ordinary non-empty file: ${filePath}`);
  }
  return details;
}

export async function assertMissing(candidate, label) {
  try {
    await lstat(candidate);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  throw new Error(`${label} must be absent: ${candidate}`);
}

export function assertSafeTemporaryLayout(runtime) {
  const temporaryBase = path.resolve(os.tmpdir());
  const temporaryRoot = path.resolve(runtime.temporaryRoot);
  const temporaryName = path.basename(temporaryRoot);
  const expectedApplicationDirectory = path.join(temporaryRoot, portableArtifactName);

  assertCondition(
    normalizedPath(path.dirname(temporaryRoot)) === normalizedPath(temporaryBase)
    && temporaryName.startsWith(temporaryDirectoryPrefix)
    && temporaryName.length > temporaryDirectoryPrefix.length,
    `Refusing an unsafe temporary package root: ${temporaryRoot}`,
  );
  assertCondition(
    normalizedPath(runtime.applicationDirectory) === normalizedPath(expectedApplicationDirectory),
    `Refusing an unexpected temporary application directory: ${runtime.applicationDirectory}`,
  );
  assertCondition(
    normalizedPath(runtime.executablePath) === normalizedPath(path.join(expectedApplicationDirectory, 'PhotoMap.exe')),
    `Refusing an unexpected temporary executable path: ${runtime.executablePath}`,
  );
  assertCondition(
    normalizedPath(runtime.photoMapDataRoot)
    === normalizedPath(path.join(expectedApplicationDirectory, portableDataDirectoryName)),
    `Refusing an unexpected portable data root: ${runtime.photoMapDataRoot}`,
  );
  assertCondition(
    normalizedPath(runtime.mapDataDirectory)
    === normalizedPath(path.join(expectedApplicationDirectory, portableDataDirectoryName, 'data', 'map-data', 'v1')),
    `Refusing an unexpected temporary map-data directory: ${runtime.mapDataDirectory}`,
  );
  assertCondition(
    normalizedPath(runtime.temporaryRoot) !== normalizedPath(portableSourcePath)
    && normalizedPath(runtime.temporaryRoot) !== normalizedPath(resultRoot)
    && normalizedPath(runtime.temporaryRoot) !== normalizedPath(appRoot),
    `Temporary package root overlaps a protected project path: ${runtime.temporaryRoot}`,
  );
}

export async function verifyTemporaryOwnership(runtime) {
  assertSafeTemporaryLayout(runtime);
  await assertOrdinaryDirectory(runtime.temporaryRoot, 'Temporary package root');
  const ownerDetails = await assertNonEmptyOrdinaryFile(runtime.ownerPath, 'Temporary package ownership marker');
  assertCondition(ownerDetails.size <= 512, `Temporary package ownership marker is unexpectedly large: ${runtime.ownerPath}`);
  const ownerContents = await readFile(runtime.ownerPath, 'utf8');
  assertCondition(
    ownerContents === `${runtime.ownerToken}\n`,
    `Temporary package ownership marker does not match this run: ${runtime.ownerPath}`,
  );
}

export async function removeTemporaryPackage(runtime) {
  if (runtime.activeLaunches.size !== 0) {
    throw new Error(`Refusing to remove a temporary package with ${runtime.activeLaunches.size} active launch(es).`);
  }
  await verifyTemporaryOwnership(runtime);
  await rm(runtime.temporaryRoot, { recursive: true, force: true });
  await assertMissing(runtime.temporaryRoot, 'Removed temporary package root');
}

export async function stagePortablePackage() {
  assertCondition(process.platform === 'win32', 'Packaged PhotoMap E2E requires Windows.');
  assertCondition(
    normalizedPath(path.dirname(portableSourcePath)) === normalizedPath(path.join(appRoot, 'out'))
    && path.basename(portableSourcePath) === (stageRawForgePackage ? rawForgeArtifactName : portableArtifactName),
    `Portable source artifact path is outside the expected output directory: ${portableSourcePath}`,
  );
  await assertOrdinaryDirectory(portableSourcePath, 'Portable source artifact');
  await assertNonEmptyOrdinaryFile(path.join(portableSourcePath, 'PhotoMap.exe'), 'Portable source executable');
  if (stageRawForgePackage) {
    await assertMissing(path.join(portableSourcePath, portableMarkerName), 'Raw Forge source marker');
  } else {
    await assertNonEmptyOrdinaryFile(path.join(portableSourcePath, portableMarkerName), 'Portable source marker');
  }
  await assertMissing(
    path.join(portableSourcePath, portableDataDirectoryName),
    'Portable source runtime data directory',
  );
  for (const contract of Object.values(mapDataContracts)) {
    await assertMissing(
      path.join(portableSourcePath, 'resources', 'data', contract.fileName),
      `Portable source bundled ${contract.kind} map data`,
    );
  }

  const temporaryRoot = await mkdtemp(path.join(path.resolve(os.tmpdir()), temporaryDirectoryPrefix));
  const ownerToken = `${runId}:${randomUUID()}`;
  const applicationDirectory = path.join(temporaryRoot, portableArtifactName);
  const runtime = {
    temporaryRoot,
    ownerPath: path.join(temporaryRoot, temporaryOwnerFileName),
    ownerToken,
    applicationDirectory,
    executablePath: path.join(applicationDirectory, 'PhotoMap.exe'),
    photoMapDataRoot: path.join(applicationDirectory, portableDataDirectoryName),
    mapDataDirectory: path.join(applicationDirectory, portableDataDirectoryName, 'data', 'map-data', 'v1'),
    activeLaunches: new Set(),
  };

  assertSafeTemporaryLayout(runtime);
  let ownerCreated = false;
  try {
    await writeFile(runtime.ownerPath, `${ownerToken}\n`, { encoding: 'utf8', flag: 'wx' });
    ownerCreated = true;
    await verifyTemporaryOwnership(runtime);
    await cp(portableSourcePath, applicationDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    if (stageRawForgePackage) {
      await writeFile(
        path.join(applicationDirectory, portableMarkerName),
        'PhotoMap packaged E2E temporary portable marker v1\n',
        { encoding: 'utf8', flag: 'wx' },
      );
    }
    await assertOrdinaryDirectory(applicationDirectory, 'Temporary portable application');
    await assertNonEmptyOrdinaryFile(runtime.executablePath, 'Temporary portable executable');
    await assertNonEmptyOrdinaryFile(
      path.join(applicationDirectory, portableMarkerName),
      'Temporary portable marker',
    );
    await assertMissing(runtime.photoMapDataRoot, 'Temporary portable data directory before first launch');
    for (const contract of Object.values(mapDataContracts)) {
      await assertMissing(
        path.join(applicationDirectory, 'resources', 'data', contract.fileName),
        `Temporary package bundled ${contract.kind} map data`,
      );
    }
    return runtime;
  } catch (error) {
    try {
      if (ownerCreated) {
        await removeTemporaryPackage(runtime);
      } else {
        assertSafeTemporaryLayout(runtime);
        await assertOrdinaryDirectory(runtime.temporaryRoot, 'Fresh temporary package root');
        await rm(runtime.temporaryRoot, { recursive: true, force: true });
        await assertMissing(runtime.temporaryRoot, 'Fresh temporary package root after failed ownership setup');
      }
    } catch (cleanupError) {
      // AggregateError carries both the staging failure and this cleanup failure in
      // .errors, so neither caught error is lost and a separate cause would duplicate one.
      // eslint-disable-next-line preserve-caught-error
      throw new AggregateError(
        [error, cleanupError],
        `Portable package staging failed and its owned temporary directory could not be removed: ${temporaryRoot}`,
      );
    }
    throw error;
  }
}
