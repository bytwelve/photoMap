import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { appRoot, localAppData, isolatedSourcePath, resultRoot, runId, fixturePath, portableSourcePath } from './lib/config.mjs';
import { stagePortablePackage, removeTemporaryPackage } from './lib/package.mjs';
import { assertCondition, errorText, sha256File } from './lib/utils.mjs';
import { seedCatalog, stageProjectFixtures } from './lib/fixtures.mjs';
import { verifyMapDataSetupSession } from './lib/maps.mjs';
import { openSession, shutdownSession } from './lib/session.mjs';
import { evaluate, waitForValue, screenshot, rendererErrorEvents } from './lib/cdp.mjs';
import { clickButtonExpression, clickTestIdExpression, setAnnotationBatchModeExpression, setInputValueExpression } from './lib/ui.mjs';
import { closeTrackedApplications, captureRuntimeEvidence, assertLocalAppDataSentinelHasNoPhotoMap } from './lib/evidence.mjs';
import { runBatchSelection } from './scenarios/batch-selection.mjs';

const libraryExpression = 'window.photoMap.getLibrary().then(r => { if (!r.ok) throw new Error(r.error.userMessage); return r.value; })';

export async function main() {
  const startedAtUtc = new Date().toISOString();
  const requiredNode = (await readFile(path.join(appRoot, '.node-version'), 'utf8')).trim();
  assertCondition(process.versions.node === requiredNode, `Node ${requiredNode} is required.`);
  await Promise.all([mkdir(localAppData, { recursive: true }), mkdir(isolatedSourcePath, { recursive: true })]);
  const checks = {};
  const sessions = [];
  let runtime;
  let failure;
  try {
    runtime = await stagePortablePackage();
    checks.payloadSha256 = await sha256File(path.join(portableSourcePath, 'resources/app.asar'));
    checks.missingMap = await verifyMapDataSetupSession(runtime, 'public-map-missing', false, false, '00-map-setup.png');
    checks.seed = await seedCatalog(runtime);
    checks.fixtures = await stageProjectFixtures();
    const first = await openSession(runtime, 'public-first');
    sessions.push(first);
    const { client } = first;
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    // This is a renderer offline check, not a claim that the host's network was disconnected.
    checks.rendererOffline = true;
    const scanned = await waitForValue(client, libraryExpression, value => value?.scan.status === 'succeeded' && value.photos.length === 7, 120_000);
    assertCondition(scanned.scan.counts.errors === 0, 'Public fixture scan contained errors.');
    checks.scan = { count: scanned.photos.length, status: scanned.scan.status, errors: scanned.scan.counts.errors };
    assertCondition(await evaluate(client, clickButtonExpression('批注模式')), 'Annotation mode is unavailable without map data.');
    await waitForValue(client, 'Boolean(document.querySelector("[data-testid=postcard-current]"))', Boolean);
    await waitForValue(client, `(() => { const image = document.querySelector('[data-testid="postcard-current"] img'); return image?.complete && image.naturalWidth > 0; })()`, Boolean);
    const photoId = await evaluate(client, 'document.querySelector("[data-testid=postcard-current]").dataset.photoId');
    assertCondition(typeof photoId === 'string' && photoId.length > 0, 'Current postcard has no photo identity.');
    const note = '公开测试：旅途中的一张明信片。';
    await evaluate(client, setInputValueExpression('[data-testid="postcard-note"]', note));
    await evaluate(client, 'document.querySelector("[data-testid=postcard-note]").blur()');
    await waitForValue(client, libraryExpression, value => value.photos.some(photo => photo.photoId === photoId && photo.note === note));
    assertCondition(await evaluate(client, clickTestIdExpression('postcard-rename-edit')), 'Rename control missing.');
    await evaluate(client, setInputValueExpression('[data-testid="postcard-file-name-input"]', '公开验收照片.png'));
    assertCondition(await evaluate(client, clickTestIdExpression('postcard-rename-confirm')), 'Rename confirmation missing.');
    await waitForValue(client, libraryExpression, value => value.photos.some(photo => photo.photoId === photoId && photo.fileName === '公开验收照片.png'));
    checks.annotation = await evaluate(client, `(async () => {
      const unwrap = r => { if (!r.ok) throw new Error(r.error.userMessage); return r.value; };
      const tag = unwrap(await window.photoMap.createType({ name: '公开测试' }));
      unwrap(await window.photoMap.updateLocations({ photoIds: [${JSON.stringify(photoId)}], location: { provinceGb: '156420000', cityGb: '156420100' } }));
      unwrap(await window.photoMap.updateTypes({ photoIds: [${JSON.stringify(photoId)}], addTypeIds: [tag.typeId], removeTypeIds: [] }));
      return { photoId: ${JSON.stringify(photoId)}, typeId: tag.typeId };
    })()`);
    await screenshot(client, '01-public-postcard.png');
    assertCondition(await evaluate(client, setAnnotationBatchModeExpression(true)), 'Batch switch missing.');
    await waitForValue(client, 'document.querySelectorAll("[data-testid=batch-grid] .photo-card").length', count => count === 7);
    await runBatchSelection({ checks, client });
    assertCondition(await evaluate(client, setInputValueExpression('.search-field input', '')), 'Search input missing after the empty-state check.');
    await waitForValue(client, 'document.querySelectorAll("[data-testid=batch-grid] .photo-card").length', count => count === 7);
    await screenshot(client, '02-public-batch.png');
    await waitForValue(client, 'window.photoMap.getSettings().then(r => r.ok ? r.value : null)', settings => settings?.mode === 'batch' && settings.filters.search === '');
    checks.rendererErrors = rendererErrorEvents(client);
    assertCondition(checks.rendererErrors.length === 0, 'Renderer emitted errors during the public workflow.');
    const externalRequests = client.events.filter(event => event.method === 'Network.requestWillBeSent' && /^https?:/.test(event.params?.request?.url ?? ''));
    assertCondition(externalRequests.length === 0, 'The offline workflow attempted an external HTTP request.');
    checks.externalHttpRequests = externalRequests.length;
    const closingSearch = '关闭前尚未防抖保存的设置';
    assertCondition(await evaluate(client, setInputValueExpression('.search-field input', closingSearch)), 'Search field missing before close.');
    // Close immediately after React commits the input. Do not wait for the 450ms save timer.
    await evaluate(client, 'new Promise(resolve => requestAnimationFrame(() => resolve(true)))');
    await shutdownSession(first);

    const second = await openSession(runtime, 'public-restart');
    sessions.push(second);
    const restored = await waitForValue(second.client, libraryExpression, value => value?.scan.status === 'succeeded' && value.photos.length === 7, 120_000);
    const photo = restored.photos.find(item => item.photoId === photoId);
    assertCondition(photo?.note === note && photo.fileName === '公开验收照片.png'
      && photo.location?.cityGb === '156420100' && photo.typeIds.includes(checks.annotation.typeId), 'Annotations or rename did not survive restart.');
    await waitForValue(second.client, 'window.photoMap.getSettings().then(r => r.ok ? r.value : null)', settings => settings?.mode === 'batch' && settings.filters.search === closingSearch);
    checks.pendingSettingsSavedOnClose = true;
    assertCondition(await evaluate(second.client, setInputValueExpression('.search-field input', '')), 'Search field missing after restart.');
    await waitForValue(second.client, 'document.querySelectorAll("[data-testid=batch-grid] .photo-card").length', count => count === 7);
    const info = await evaluate(second.client, 'window.photoMap.getAppInfo().then(r => r.ok ? r.value : null)');
    assertCondition(info?.isPackaged && info.mapData.completed === 0 && !info.mapData.ready, 'The test must not bypass the production map-data contract.');
    assertCondition(rendererErrorEvents(second.client).length === 0, 'Renderer emitted errors after restart.');
    checks.persistence = { note: true, rename: true, tag: true, location: true, batchMode: true, noMapData: true };
    await shutdownSession(second);
  } catch (error) {
    failure = error;
  } finally {
    for (const session of [...sessions].reverse()) {
      try { await shutdownSession(session); } catch (error) { failure ??= error; }
    }
    if (runtime) {
      try {
        await closeTrackedApplications(runtime);
        checks.runtimeEvidence = await captureRuntimeEvidence(runtime, false);
        checks.localAppDataSentinel = await assertLocalAppDataSentinelHasNoPhotoMap();
        await removeTemporaryPackage(runtime);
        checks.temporaryPackageRemoved = true;
      } catch (error) { failure ??= error; checks.temporaryPackageRemoved = false; }
    }
  }
  const result = { schemaVersion: 1, suite: 'public', runId, startedAtUtc, finishedAtUtc: new Date().toISOString(), environment: { node: process.version }, fixturePath, passed: !failure, checks, ...(failure ? { error: errorText(failure) } : {}) };
  await writeFile(path.join(resultRoot, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  if (failure) throw failure;
  console.log(`PHOTO_MAP_PUBLIC_E2E_PASSED ${JSON.stringify({ resultRoot, checks })}`);
}
