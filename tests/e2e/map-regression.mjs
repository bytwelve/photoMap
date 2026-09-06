import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mapDataFixturePath, appRoot, localAppData, isolatedSourcePath, portableSourcePath, stageRawForgePackage, portableDataDirectoryName, resultRoot, portableMarkerName, runId, fixturePath } from './lib/config.mjs';
import { assertCondition, sha256File, retainFailure, errorText } from './lib/utils.mjs';
import { stagePortablePackage, removeTemporaryPackage } from './lib/package.mjs';
import { bootstrapCatalog } from './lib/maps.mjs';
import { seedCatalog } from './lib/fixtures.mjs';
import { shutdownSession } from './lib/session.mjs';
import { closeTrackedApplications, inspectRuntimeArtifacts, captureRuntimeEvidence, assertLocalAppDataSentinelHasNoPhotoMap } from './lib/evidence.mjs';
import { debugPortIsClosed } from './lib/processes.mjs';

import { runScan } from './scenarios/scan.mjs';
import { runWallBasics } from './scenarios/wall-basics.mjs';
import { runImageRetry } from './scenarios/image-retry.mjs';
import { runPostcardGestures } from './scenarios/postcard-gestures.mjs';
import { runPostcardPlayback } from './scenarios/postcard-playback.mjs';
import { runBatchLayout } from './scenarios/batch-layout.mjs';
import { runBatchSelection } from './scenarios/batch-selection.mjs';
import { runRegionPicker } from './scenarios/region-picker.mjs';
import { runWallSettings } from './scenarios/wall-settings.mjs';
import { runExportText } from './scenarios/export-text.mjs';
import { runExportLayout } from './scenarios/export-layout.mjs';
import { runPersistence } from './scenarios/persistence.mjs';

export async function main() {
  const startedAtUtc = new Date().toISOString();
  if (!mapDataFixturePath) throw new Error('PHOTOMAP_E2E_MAP_DATA_FIXTURES must point to your separately obtained map files for --map-data.');
  const requiredNodeVersion = `v${(await readFile(path.join(appRoot, '.node-version'), 'utf8')).trim()}`;
  assertCondition(process.version === requiredNodeVersion, `Node.js ${requiredNodeVersion} is required; current runtime is ${process.version}.`);
  await Promise.all([
    mkdir(localAppData, { recursive: true }),
    mkdir(isolatedSourcePath, { recursive: true }),
  ]);
  const checks = {};
  const sessions = [];
  let firstSession;
  let secondSession;
  let mutation;
  let runtime;
  let failure;

  try {
    runtime = await stagePortablePackage();

    checks.portableContract = {
      sourceArtifact: path.join('out', path.basename(portableSourcePath)),
      stagedFromRawForgePackage: stageRawForgePackage,
      launchedFromTemporaryCopy: true,
      dataDirectoryBesideExecutable: portableDataDirectoryName,
      localAppDataSentinel: path.relative(resultRoot, localAppData),
      hashes: {
        portableExecutableSha256: await sha256File(path.join(portableSourcePath, 'PhotoMap.exe')),
        portableMarkerSha256: await sha256File(path.join(runtime.applicationDirectory, portableMarkerName)),
        applicationPayloadSha256: await sha256File(path.join(portableSourcePath, 'resources', 'app.asar')),
      },
    };

    await bootstrapCatalog(runtime, checks);

    const seed = await seedCatalog(runtime);

    checks.seed = seed;
    const context = { checks, sessions, runtime, seed, firstSession, secondSession, mutation };
    try {
      const scenarios = [
        ['scan', runScan], ['wall-basics', runWallBasics], ['image-retry', runImageRetry],
        ['postcard-gestures', runPostcardGestures], ['postcard-playback', runPostcardPlayback],
        ['batch-layout', runBatchLayout], ['batch-selection', runBatchSelection],
        ['region-picker', runRegionPicker], ['wall-settings', runWallSettings],
        ['export-text', runExportText], ['export-layout', runExportLayout], ['persistence', runPersistence],
      ];
      checks.completedScenarios = [];
      for (const [name, run] of scenarios) {
        console.log(`Packaged E2E: ${name}`);
        await run(context);
        checks.completedScenarios.push(name);
      }
    } finally {
      ({ firstSession, secondSession, mutation } = context);
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const session of [...sessions].reverse()) {
      if (session.closed) continue;
      try {
        await shutdownSession(session);
      } catch (cleanupError) {
        failure = retainFailure(failure, checks, `shutdown-${session.prefix}`, cleanupError);
      }
    }
    if (runtime !== undefined) {
      try {
        await closeTrackedApplications(runtime);
      } catch (cleanupError) {
        failure = retainFailure(failure, checks, 'close-tracked-applications', cleanupError);
      }
    }
  }

  if (failure === undefined && runtime !== undefined) {
    try {
      checks.runtimeArtifacts = await inspectRuntimeArtifacts(runtime, mutation.typeId);
      checks.cleanup = {
        firstDebugPortClosed: await debugPortIsClosed(firstSession.port),
        secondDebugPortClosed: await debugPortIsClosed(secondSession.port),
      };
      assertCondition(checks.cleanup.firstDebugPortClosed && checks.cleanup.secondDebugPortClosed, 'A packaged-app debugging port remained open.');
    } catch (error) {
      failure = error;
    }
  }

  if (runtime !== undefined && runtime.activeLaunches.size === 0) {
    try {
      checks.runtimeEvidence = await captureRuntimeEvidence(runtime, checks.emptySource === true);
    } catch (evidenceError) {
      failure = retainFailure(failure, checks, 'capture-runtime-evidence', evidenceError);
    }
    try {
      checks.localAppDataSentinel = await assertLocalAppDataSentinelHasNoPhotoMap();
    } catch (sentinelError) {
      failure = retainFailure(failure, checks, 'assert-localappdata-sentinel', sentinelError);
    }
    try {
      await removeTemporaryPackage(runtime);
      checks.cleanup = {
        ...(checks.cleanup ?? {}),
        temporaryPackageRemoved: true,
      };
    } catch (cleanupError) {
      checks.cleanup = {
        ...(checks.cleanup ?? {}),
        temporaryPackageRemoved: false,
        retainedTemporaryPackage: runtime.temporaryRoot,
      };
      failure = retainFailure(failure, checks, 'remove-temporary-package', cleanupError);
    }
  } else if (runtime !== undefined) {
    const cleanupError = new Error(
      `Refusing to clean the temporary package while ${runtime.activeLaunches.size} exact process launch(es) remain active: ${runtime.temporaryRoot}`,
    );
    checks.cleanup = {
      ...(checks.cleanup ?? {}),
      temporaryPackageRemoved: false,
      retainedTemporaryPackage: runtime.temporaryRoot,
    };
    failure = retainFailure(failure, checks, 'temporary-package-still-active', cleanupError);
  }

  await mkdir(resultRoot, { recursive: true });
  const finishedAtUtc = new Date().toISOString();
  const result = failure === undefined
    ? { schemaVersion: 1, suite: 'full-map', runId, startedAtUtc, finishedAtUtc, environment: { node: process.version }, passed: true, fixturePath, checks }
    : { schemaVersion: 1, suite: 'full-map', runId, startedAtUtc, finishedAtUtc, environment: { node: process.version }, passed: false, fixturePath, error: errorText(failure), checks };
  await writeFile(path.join(resultRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (failure !== undefined) throw failure;
  console.log(`PHOTO_MAP_E2E_PASSED ${JSON.stringify({ resultRoot, checks })}`);
}
