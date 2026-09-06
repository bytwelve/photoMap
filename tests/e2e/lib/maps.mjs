import path from 'node:path';
import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { mapDataContracts, mapDataFixturePath } from './config.mjs';
import { assertCondition, normalizedPath, sha256File } from './utils.mjs';
import { verifyTemporaryOwnership, assertOrdinaryDirectory, assertNonEmptyOrdinaryFile, assertMissing } from './package.mjs';
import { openSession, shutdownSession } from './session.mjs';
import { waitForValue, rendererErrorEvents, screenshot } from './cdp.mjs';

export function mapDataStatusMatches(status, provinceImported, cityImported) {
  if (!status || !Array.isArray(status.items) || status.items.length !== 2) return false;
  const province = status.items.find((item) => item?.kind === 'province');
  const city = status.items.find((item) => item?.kind === 'city');
  const completed = Number(provinceImported) + Number(cityImported);
  return status.completed === completed
    && status.total === 2
    && status.ready === (completed === 2)
    && province?.imported === provinceImported
    && city?.imported === cityImported;
}

export async function stageVerifiedMapDataFixture(runtime, kind) {
  const contract = mapDataContracts[kind];
  assertCondition(contract !== undefined, `Unknown map-data fixture kind: ${kind}`);
  assertCondition(
    runtime.activeLaunches.size === 0,
    `Refusing to stage ${kind} map data while ${runtime.activeLaunches.size} application launch(es) remain active.`,
  );
  await verifyTemporaryOwnership(runtime);
  await assertOrdinaryDirectory(mapDataFixturePath, 'Local map-data fixture directory');
  await assertOrdinaryDirectory(runtime.mapDataDirectory, 'Temporary runtime map-data directory');

  const sourcePath = path.join(mapDataFixturePath, contract.fileName);
  const targetPath = path.join(runtime.mapDataDirectory, contract.fileName);
  assertCondition(
    normalizedPath(path.dirname(sourcePath)) === normalizedPath(mapDataFixturePath),
    `Map-data fixture escaped its expected source directory: ${sourcePath}`,
  );
  assertCondition(
    normalizedPath(path.dirname(targetPath)) === normalizedPath(runtime.mapDataDirectory),
    `Map-data fixture escaped its expected temporary runtime directory: ${targetPath}`,
  );

  const sourceDetails = await assertNonEmptyOrdinaryFile(sourcePath, `${kind} map-data fixture`);
  assertCondition(
    sourceDetails.size === contract.byteLength,
    `${kind} map-data fixture length changed: expected ${contract.byteLength}, received ${sourceDetails.size}.`,
  );
  const sourceSha256 = await sha256File(sourcePath);
  assertCondition(
    sourceSha256 === contract.sha256,
    `${kind} map-data fixture SHA-256 changed: expected ${contract.sha256}, received ${sourceSha256}.`,
  );

  await assertMissing(targetPath, `Temporary runtime ${kind} map-data target before staging`);
  await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
  const targetDetails = await assertNonEmptyOrdinaryFile(targetPath, `Temporary runtime ${kind} map data`);
  const targetSha256 = await sha256File(targetPath);
  assertCondition(
    targetDetails.size === contract.byteLength && targetSha256 === contract.sha256,
    `Temporary runtime ${kind} map data differs from its verified fixture.`,
  );
  return {
    kind,
    fileName: contract.fileName,
    bytes: targetDetails.size,
    sha256: targetSha256,
    runtimeRelativePath: path.relative(runtime.photoMapDataRoot, targetPath),
  };
}

export async function verifyMapDataSetupSession(
  runtime,
  prefix,
  provinceImported,
  cityImported,
  screenshotName,
) {
  const session = await openSession(runtime, prefix);
  try {
    const { client } = session;
    await waitForValue(client, `typeof window.photoMap?.getAppInfo === 'function'`, Boolean);
    await waitForValue(
      client,
      `Boolean(document.querySelector('[data-testid="map-data-setup"]'))`,
      Boolean,
    );
    const appInfo = await waitForValue(
      client,
      `window.photoMap.getAppInfo().then((result) => result.ok ? result.value : ({ error: result.error.userMessage }))`,
      (value) => mapDataStatusMatches(value?.mapData, provinceImported, cityImported),
    );
    const expectedCompleted = Number(provinceImported) + Number(cityImported);
    const ui = await waitForValue(
      client,
      `(() => {
        const setup = document.querySelector('[data-testid="map-data-setup"]');
        const progress = document.querySelector('[data-testid="map-data-progress-count"]');
        const province = document.querySelector('[data-testid="map-data-status-province"] strong');
        const city = document.querySelector('[data-testid="map-data-status-city"] strong');
        return {
          setup: Boolean(setup),
          progress: progress?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
          province: province?.textContent?.trim() ?? null,
          city: city?.textContent?.trim() ?? null,
          wallCanvas: Boolean(document.querySelector('[data-testid="wall-canvas"]'))
        };
      })()`,
      (value) => value?.setup === true
        && value.progress === `已完成 ${expectedCompleted} / 2`
        && value.province === (provinceImported ? '已导入' : '未导入')
        && value.city === (cityImported ? '已导入' : '未导入')
        && value.wallCanvas === false,
    );
    const rendererErrors = rendererErrorEvents(client);
    assertCondition(
      rendererErrors.length === 0,
      `Renderer errors were emitted for ${prefix}: ${JSON.stringify(rendererErrors)}`,
    );
    await screenshot(client, screenshotName);
    return { mapData: appInfo.mapData, ui, rendererErrorCount: rendererErrors.length };
  } finally {
    await shutdownSession(session);
  }
}

export async function verifyReadyEmptySourceSession(runtime) {
  const session = await openSession(runtime, 'bootstrap');
  try {
    const { client } = session;
    await waitForValue(client, `typeof window.photoMap?.getAppInfo === 'function'`, Boolean);
    const appInfo = await waitForValue(
      client,
      `window.photoMap.getAppInfo().then((result) => result.ok ? result.value : ({ error: result.error.userMessage }))`,
      (value) => mapDataStatusMatches(value?.mapData, true, true),
    );
    const ui = await waitForValue(
      client,
      `({
        setup: Boolean(document.querySelector('[data-testid="map-data-setup"]')),
        sourceEmpty: Boolean(document.querySelector('[data-testid="source-empty"]')),
        wallCanvas: Boolean(document.querySelector('[data-testid="wall-canvas"]'))
      })`,
      (value) => value?.setup === false && value.sourceEmpty === true && value.wallCanvas === false,
    );
    const rendererErrors = rendererErrorEvents(client);
    assertCondition(
      rendererErrors.length === 0,
      `Renderer errors were emitted after both map-data files were staged: ${JSON.stringify(rendererErrors)}`,
    );
    await screenshot(client, '01-empty-source.png');
    return { mapData: appInfo.mapData, ui, rendererErrorCount: rendererErrors.length };
  } finally {
    await shutdownSession(session);
  }
}

export async function bootstrapCatalog(runtime, checks) {
  checks.mapDataBootstrap = {};
  checks.mapDataBootstrap.empty = await verifyMapDataSetupSession(
    runtime,
    'bootstrap-map-data-empty',
    false,
    false,
    '00-map-data-setup-0-of-2.png',
  );
  checks.mapDataBootstrap.provinceFixture = await stageVerifiedMapDataFixture(runtime, 'province');
  checks.mapDataBootstrap.provinceOnly = await verifyMapDataSetupSession(
    runtime,
    'bootstrap-map-data-province',
    true,
    false,
    '00b-map-data-setup-1-of-2.png',
  );
  checks.mapDataBootstrap.cityFixture = await stageVerifiedMapDataFixture(runtime, 'city');
  checks.mapDataBootstrap.ready = await verifyReadyEmptySourceSession(runtime);
  checks.emptySource = true;
}
