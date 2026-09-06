import path from 'node:path';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { assertNonEmptyOrdinaryFile, assertMissing } from './package.mjs';
import { assertCondition, isMissingPathError } from './utils.mjs';
import { fixturePath, isolatedSourcePath, localAppData, runtimeEvidenceRoot, portableMarkerName, resultRoot, portableSourcePath, stageRawForgePackage, portableDataDirectoryName } from './config.mjs';
import { closeApplication, writeLaunchLogs } from './processes.mjs';

export function expectedSettingsPersisted(settings, typeId) {
  return settings?.schemaVersion === 2
    && settings.mode === 'memory'
    && settings.filters?.search === 'beijing'
    && settings.filters.locationCodes?.length === 1
    && settings.filters.locationCodes[0] === '156420000'
    && settings.filters.includeUnlocated === false
    && settings.filters.typeIds?.length === 1
    && settings.filters.typeIds[0] === typeId
    && settings.map?.level === 'city'
    && settings.map.showPhotos === false
    && settings.map.showPlaceNames === false
    && settings.map.density === 5
    && Number.isFinite(settings.map.camera?.zoom)
    && settings.map.camera.zoom > 1
    && Number.isFinite(settings.map.camera.panX)
    && Number.isFinite(settings.map.camera.panY)
    && Math.hypot(settings.map.camera.panX, settings.map.camera.panY) > 0.0001
    && !Object.hasOwn(settings, 'export');
}

export async function inspectRuntimeArtifacts(runtime, typeId) {
  const settingsPath = path.join(runtime.photoMapDataRoot, 'settings.json');
  const diagnosticsPath = path.join(runtime.photoMapDataRoot, 'logs', 'diagnostics.jsonl');
  const databasePath = path.join(runtime.photoMapDataRoot, 'data', 'index.sqlite3');
  const [settingsDetails, diagnosticsDetails, databaseDetails] = await Promise.all([
    assertNonEmptyOrdinaryFile(settingsPath, 'Portable settings evidence'),
    assertNonEmptyOrdinaryFile(diagnosticsPath, 'Portable diagnostics evidence'),
    assertNonEmptyOrdinaryFile(databasePath, 'Portable SQLite evidence'),
  ]);
  const [settingsText, diagnosticsText] = await Promise.all([
    readFile(settingsPath, 'utf8'),
    readFile(diagnosticsPath, 'utf8'),
  ]);
  const settings = JSON.parse(settingsText);
  assertCondition(
    expectedSettingsPersisted(settings, typeId),
    `settings.json did not contain the final persisted UI state: ${JSON.stringify(settings)}`,
  );

  const lines = diagnosticsText.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  assertCondition(lines.length > 0, 'diagnostics.jsonl was empty.');
  const events = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`diagnostics.jsonl line ${index + 1} is invalid JSON: ${String(error)}`, { cause: error });
    }
  });
  const allowedEventKeys = new Set(['appVersion', 'schemaVersion', 'stage', 'runId', 'errorCode', 'counts']);
  const allowedStages = new Set(['startup', 'settings', 'scan', 'export', 'trash', 'failure', 'shutdown']);
  const allowedCountKeys = new Set([
    'discovered', 'indexed', 'unchanged', 'errors', 'succeeded', 'skipped',
    'failed', 'moved', 'notFound', 'accessDenied', 'cancelled',
  ]);
  for (const [index, event] of events.entries()) {
    assertCondition(event && typeof event === 'object' && !Array.isArray(event), `Diagnostic line ${index + 1} is not an object.`);
    for (const key of Object.keys(event)) {
      assertCondition(allowedEventKeys.has(key), `Diagnostic line ${index + 1} contains non-whitelisted key ${key}.`);
    }
    assertCondition(
      typeof event.appVersion === 'string' && /^[A-Za-z0-9.+-]{1,64}$/u.test(event.appVersion),
      `Diagnostic line ${index + 1} has invalid appVersion.`,
    );
    assertCondition(
      Number.isSafeInteger(event.schemaVersion) && event.schemaVersion >= 0,
      `Diagnostic line ${index + 1} has invalid schemaVersion.`,
    );
    assertCondition(allowedStages.has(event.stage), `Diagnostic line ${index + 1} has invalid stage.`);
    if (event.runId !== undefined) {
      assertCondition(
        typeof event.runId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(event.runId),
        `Diagnostic line ${index + 1} has invalid runId.`,
      );
    }
    if (event.errorCode !== undefined) {
      assertCondition(
        typeof event.errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(event.errorCode),
        `Diagnostic line ${index + 1} has invalid errorCode.`,
      );
    }
    if (event.counts !== undefined) {
      assertCondition(event.counts && typeof event.counts === 'object' && !Array.isArray(event.counts), `Diagnostic line ${index + 1} has invalid counts.`);
      for (const [key, value] of Object.entries(event.counts)) {
        assertCondition(allowedCountKeys.has(key), `Diagnostic line ${index + 1} contains non-whitelisted count ${key}.`);
        assertCondition(Number.isSafeInteger(value) && value >= 0, `Diagnostic line ${index + 1} contains invalid count ${key}.`);
      }
    }
  }
  for (const privateValue of [
    fixturePath,
    isolatedSourcePath,
    localAppData,
    runtime.temporaryRoot,
    runtime.applicationDirectory,
    runtime.photoMapDataRoot,
    '打包验收',
    'beijing-great-wall.png',
  ]) {
    assertCondition(
      !diagnosticsText.toLocaleLowerCase('en-US').includes(privateValue.toLocaleLowerCase('en-US')),
      `diagnostics.jsonl leaked private value ${privateValue}.`,
    );
  }
  const stages = [...new Set(events.map((event) => event.stage))].sort();
  assertCondition(stages.includes('startup'), 'Diagnostics did not record startup.');
  assertCondition(stages.includes('scan'), 'Diagnostics did not record scan completion.');
  assertCondition(stages.includes('shutdown'), 'Diagnostics did not record shutdown.');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let quickCheck;
  let activePhotoCount;
  try {
    quickCheck = Object.values(database.prepare('PRAGMA quick_check').get() ?? {})[0];
    activePhotoCount = Number(
      database.prepare("SELECT COUNT(*) AS count FROM photo WHERE lifecycle_state = 'active'").get().count,
    );
  } finally {
    database.close();
  }
  assertCondition(quickCheck === 'ok', `Portable SQLite quick_check failed: ${String(quickCheck)}`);
  assertCondition(activePhotoCount === 7, `Portable SQLite contains ${activePhotoCount} active photos instead of 7.`);
  return {
    settingsRelativePath: 'settings.json',
    diagnosticsRelativePath: path.join('logs', 'diagnostics.jsonl'),
    databaseRelativePath: path.join('data', 'index.sqlite3'),
    settingsBytes: settingsDetails.size,
    diagnosticsBytes: diagnosticsDetails.size,
    databaseBytes: databaseDetails.size,
    settings,
    diagnosticLineCount: lines.length,
    diagnosticStages: stages,
    privacyWhitelistPassed: true,
    databaseQuickCheck: quickCheck,
    activePhotoCount,
  };
}

export async function copyEvidenceFile(sourcePath, destinationName, required) {
  try {
    await assertNonEmptyOrdinaryFile(sourcePath, `Runtime evidence ${destinationName}`);
  } catch (error) {
    if (!required && isMissingPathError(error)) return null;
    throw error;
  }
  const destinationPath = path.join(runtimeEvidenceRoot, destinationName);
  await copyFile(sourcePath, destinationPath);
  await assertNonEmptyOrdinaryFile(destinationPath, `Copied runtime evidence ${destinationName}`);
  return destinationPath;
}

export async function captureRuntimeEvidence(runtime, requireComplete) {
  await mkdir(runtimeEvidenceRoot, { recursive: true });
  const evidence = {
    portableMarker: await copyEvidenceFile(
      path.join(runtime.applicationDirectory, portableMarkerName),
      portableMarkerName,
      true,
    ),
    settings: await copyEvidenceFile(
      path.join(runtime.photoMapDataRoot, 'settings.json'),
      'settings.json',
      requireComplete,
    ),
    diagnostics: await copyEvidenceFile(
      path.join(runtime.photoMapDataRoot, 'logs', 'diagnostics.jsonl'),
      'diagnostics.jsonl',
      requireComplete,
    ),
    database: await copyEvidenceFile(
      path.join(runtime.photoMapDataRoot, 'data', 'index.sqlite3'),
      'index.sqlite3',
      requireComplete,
    ),
  };
  const copiedFiles = Object.fromEntries(
    Object.entries(evidence).map(([key, filePath]) => [
      key,
      filePath === null ? null : path.relative(resultRoot, filePath),
    ]),
  );
  const layout = {
    contractVersion: 1,
    sourceArtifact: path.join('out', path.basename(portableSourcePath)),
    stagedFromRawForgePackage: stageRawForgePackage,
    executableName: 'PhotoMap.exe',
    portableMarkerName,
    dataDirectoryBesideExecutable: portableDataDirectoryName,
    localAppDataSentinel: path.relative(resultRoot, localAppData),
    copiedFiles,
  };
  const layoutPath = path.join(runtimeEvidenceRoot, 'portable-layout.json');
  await writeFile(layoutPath, `${JSON.stringify(layout, null, 2)}\n`, 'utf8');
  return {
    directory: path.relative(resultRoot, runtimeEvidenceRoot),
    files: copiedFiles,
    layout: path.relative(resultRoot, layoutPath),
  };
}

export async function assertLocalAppDataSentinelHasNoPhotoMap() {
  const entries = await readdir(localAppData, { withFileTypes: true });
  const forbiddenEntries = entries.filter(
    (entry) => entry.name.toLocaleLowerCase('en-US') === 'photomap',
  );
  assertCondition(
    forbiddenEntries.length === 0,
    `Portable app wrote PhotoMap into the LOCALAPPDATA sentinel: ${localAppData}`,
  );
  await assertMissing(path.join(localAppData, 'PhotoMap'), 'LOCALAPPDATA PhotoMap directory');
  return {
    sentinel: path.relative(resultRoot, localAppData),
    photoMapAbsent: true,
    entries: entries.map((entry) => entry.name).sort(),
  };
}

export async function closeTrackedApplications(runtime) {
  const errors = [];
  for (const launched of [...runtime.activeLaunches]) {
    try {
      await closeApplication(undefined, launched);
    } catch (error) {
      errors.push(error);
    }
    try {
      await writeLaunchLogs(launched.prefix, launched);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'One or more exact packaged-app processes could not be closed cleanly.');
  }
}
