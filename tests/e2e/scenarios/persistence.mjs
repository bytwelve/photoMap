import { assertCondition } from '../lib/utils.mjs';
import { evaluate, waitForValue, rendererErrorEvents, screenshot } from '../lib/cdp.mjs';
import { clickButtonExpression, setAnnotationBatchModeExpression, clickButtonInExpression } from '../lib/ui.mjs';
import { expectedSettingsPersisted } from '../lib/evidence.mjs';
import { shutdownSession, openSession } from '../lib/session.mjs';

export async function runPersistence(context) {
  const { checks, sessions, runtime, firstSession, mutation, client, postcardBeforeWheel, postcardNote } = context;
  assertCondition(await evaluate(client, clickButtonExpression('批注模式')), 'Annotation mode button missing for persistence state.');

  await waitForValue(client, `Boolean(document.querySelector('[data-testid="annotation-mode-button"]'))`, Boolean);

  assertCondition(
    await evaluate(client, setAnnotationBatchModeExpression(false)),
    'Annotation batch button could not restore the postcard page for persistence state.',
  );

  await waitForValue(client, `Boolean(document.querySelector('[data-testid="memory-view"]'))`, Boolean);

  const firstPersistedSettings = await waitForValue(
    client,
    `window.photoMap.getSettings().then((result) => result.ok ? result.value : ({ error: result.error.userMessage }))`,
    (settings) => expectedSettingsPersisted(settings, mutation.typeId),
    30_000,
  );

  checks.settingsBeforeRestart = firstPersistedSettings;

  checks.rendererErrorsFirstRun = rendererErrorEvents(client);
  assertCondition(checks.rendererErrorsFirstRun.length === 0, `Renderer errors before restart: ${JSON.stringify(checks.rendererErrorsFirstRun)}`);

  await shutdownSession(firstSession);

  const secondSession = await openSession(runtime, 'second-run');

  sessions.push(secondSession);

  const restartedClient = secondSession.client;

  await waitForValue(restartedClient, `typeof window.photoMap?.getLibrary === 'function'`, Boolean);

  await waitForValue(restartedClient, `Boolean(document.querySelector('[data-testid="memory-view"]'))`, Boolean, 30_000);

  const restoredSettings = await waitForValue(
    restartedClient,
    `window.photoMap.getSettings().then((result) => result.ok ? result.value : ({ error: result.error.userMessage }))`,
    (settings) => expectedSettingsPersisted(settings, mutation.typeId),
    30_000,
  );

  checks.settingsRestoredAfterRestart = restoredSettings;

  const restoredLibrary = await waitForValue(
    restartedClient,
    `window.photoMap.getLibrary().then((result) => result.ok ? ({
        status: result.value.scan.status,
        active: result.value.photos.filter((photo) => photo.lifecycleState === 'active').length,
        tagged: result.value.photos.filter((photo) => photo.photoId === ${JSON.stringify(mutation.photoId)}
          && photo.location?.cityGb === '156420100'
          && photo.typeIds.includes(${JSON.stringify(mutation.typeId)})).length,
        noted: result.value.photos.filter((photo) => photo.photoId === ${JSON.stringify(postcardBeforeWheel.currentPhotoId)}
          && photo.note === ${JSON.stringify(postcardNote)}).length
      }) : ({ error: result.error.userMessage }))`,
    (value) => value?.status === 'succeeded' && value.active === 7 && value.tagged === 1 && value.noted === 1,
    120_000,
  );

  checks.tagsRestoredAfterRestart = restoredLibrary;

  const restoredLocationFilterUi = await evaluate(
    restartedClient,
    `(() => ({
        search: document.querySelector('.search-field input')?.value ?? null,
        locationPressed: [...document.querySelectorAll('.region-filter-list button')]
          .some((button) => button.getAttribute('aria-pressed') === 'true'
            && [...button.querySelectorAll('span')].some((span) => span.textContent?.trim() === '湖北省')),
        mainMode: document.querySelector('.mode-switch button[aria-current="page"]')?.textContent?.trim() ?? null,
        annotationBatchEnabled: document.querySelector('[data-testid="annotation-mode-button"]')?.getAttribute('aria-pressed') === 'true',
        postcardPageVisible: Boolean(document.querySelector('[data-testid="memory-view"]')),
        postcardCount: document.querySelectorAll('[data-testid="memory-view"] [data-testid="postcard-current"]').length,
        emptyResultsText: document.querySelector('[data-testid="memory-view"] .empty-results')?.textContent?.trim() ?? ''
      }))()`,
  );

  assertCondition(
    restoredLocationFilterUi.search === 'beijing'
    && restoredLocationFilterUi.locationPressed
    && restoredLocationFilterUi.mainMode === '批注模式'
    && restoredLocationFilterUi.annotationBatchEnabled === false
    && restoredLocationFilterUi.postcardPageVisible
    && restoredLocationFilterUi.postcardCount === 0
    && restoredLocationFilterUi.emptyResultsText.includes('当前筛选没有照片'),
    `Renderer did not restore mode/location filters: ${JSON.stringify(restoredLocationFilterUi)}`,
  );

  assertCondition(
    await evaluate(restartedClient, clickButtonInExpression('.filter-view-segmented', '类型')),
    'Type filter tab missing after restart.',
  );

  const restoredTypeFilterUi = await evaluate(
    restartedClient,
    `(() => ({
        typePressed: [...document.querySelectorAll('.type-list button')]
          .some((button) => button.getAttribute('aria-pressed') === 'true'
            && [...button.querySelectorAll('span')].some((span) => span.textContent?.trim() === '打包验收')),
        typeTabSelected: document.querySelector('[data-filter-tab="type"]')?.getAttribute('aria-selected') === 'true'
      }))()`,
  );

  assertCondition(
    restoredTypeFilterUi.typePressed && restoredTypeFilterUi.typeTabSelected,
    `Renderer did not restore the type filter in its tab: ${JSON.stringify(restoredTypeFilterUi)}`,
  );

  const restoredFilterUi = { ...restoredLocationFilterUi, ...restoredTypeFilterUi };

  checks.restoredFilterUi = restoredFilterUi;

  await screenshot(restartedClient, '07-restored-memory-and-filters.png');

  assertCondition(await evaluate(restartedClient, clickButtonExpression('照片墙模式')), 'Photo wall mode missing after restart.');

  await waitForValue(restartedClient, `Boolean(document.querySelector('[data-testid="wall-canvas"]'))`, Boolean);

  const restoredMapUi = await waitForValue(
    restartedClient,
    `(() => ({
        level: document.querySelector('[data-testid="map-level"] button.active')?.textContent?.trim() ?? null,
        visibility: document.querySelector('[data-testid="photo-visibility"]')?.textContent?.trim() ?? null,
        placeNames: document.querySelector('[data-testid="place-name-visibility"]')?.textContent?.trim() ?? null,
        density: document.querySelector('[data-testid="map-density"]')?.value ?? null
      }))()`,
    (value) => value?.level === '市级视图'
      && value.visibility?.includes('隐藏照片')
      && value.placeNames?.includes('隐藏地名')
      && value.density === '5',
    30_000,
  );

  checks.restoredMapUi = restoredMapUi;

  await screenshot(restartedClient, '08-restored-wall-map-settings.png');

  // Observe the intermediate mode being saved before expecting the next save.
  // Otherwise the old "memory" value can satisfy the final poll while a debounced wall save is still pending.
  await waitForValue(
    restartedClient,
    `window.photoMap.getSettings().then((result) => result.ok ? result.value.mode : null)`,
    (mode) => mode === 'wall',
  );

  assertCondition(await evaluate(restartedClient, clickButtonExpression('批注模式')), 'Annotation mode missing for final persisted state.');

  await waitForValue(restartedClient, `Boolean(document.querySelector('[data-testid="annotation-mode-button"]'))`, Boolean);

  assertCondition(
    await evaluate(restartedClient, setAnnotationBatchModeExpression(false)),
    'Annotation batch button could not open the final postcard state.',
  );

  await waitForValue(
    restartedClient,
    `window.photoMap.getSettings().then((result) => result.ok ? result.value : ({ error: result.error.userMessage }))`,
    (settings) => expectedSettingsPersisted(settings, mutation.typeId),
    30_000,
  );

  checks.rendererErrorsSecondRun = rendererErrorEvents(restartedClient);

  assertCondition(
    checks.rendererErrorsSecondRun.length === 0,
    `Renderer errors were emitted after restart: ${JSON.stringify(checks.rendererErrorsSecondRun)}`,
  );

  await shutdownSession(secondSession);
  Object.assign(context, { secondSession });
}
