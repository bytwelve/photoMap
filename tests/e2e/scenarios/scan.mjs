import { openSession } from '../lib/session.mjs';
import { waitForValue, screenshot, evaluate } from '../lib/cdp.mjs';
import { assertCondition } from '../lib/utils.mjs';
import { stageProjectFixtures } from '../lib/fixtures.mjs';
import { clickAriaButtonExpression, clickButtonExpression } from '../lib/ui.mjs';

export async function runScan(context) {
  const { checks, sessions, runtime, seed } = context;
  const firstSession = await openSession(runtime, 'first-run', true);

  sessions.push(firstSession);

  const client = firstSession.client;

  await waitForValue(client, `typeof window.photoMap?.getLibrary === 'function'`, Boolean);

  await waitForValue(client, `Boolean(document.querySelector('[data-testid="wall-canvas"]'))`, Boolean);

  const baselineUiCount = await waitForValue(
    client,
    `(() => {
        const value = document.querySelector('[data-testid="library-photo-count"]')?.textContent?.replaceAll(',', '').match(/\\d+/)?.[0];
        return value === undefined ? null : Number(value);
      })()`,
    (value) => value === 0,
    30_000,
  );

  const baselineScan = await waitForValue(
    client,
    `window.photoMap.getLibrary().then((result) => result.ok ? ({
        runId: result.value.scan.runId,
        status: result.value.scan.status,
        count: result.value.photos.filter((photo) => photo.lifecycleState === 'active').length,
        source: result.value.source?.displayName ?? null
      }) : ({ error: result.error.userMessage }))`,
    (value) => value?.status === 'succeeded' && value.count === 0 && value.runId !== seed.scanRunId,
    120_000,
  );

  assertCondition(baselineUiCount === 0, 'Active source did not render the explicit zero-photo baseline.');

  await screenshot(client, '01b-active-source-zero.png');

  assertCondition(
    await evaluate(client, `(() => {
        const observation = window.__photoMapE2EUiObservation;
        if (!observation) return false;
        observation.counts.splice(0, observation.counts.length, 0);
        observation.sawZero = true;
        observation.sawSeven = false;
        observation.maxVisibleWhileScanning = 0;
        observation.maxScanProcessed = 0;
        observation.sawScanProgress = false;
        return true;
      })()`),
    'UI scan observer was unavailable after the explicit zero-photo baseline.',
  );

  // Wall count intentionally includes only located photos; scan counts belong to annotation mode.
  assertCondition(await evaluate(client, clickButtonExpression('批注模式')), 'Annotation mode missing for scan progress.');
  const stagedFixtures = await stageProjectFixtures();

  assertCondition(
    await evaluate(client, clickAriaButtonExpression('增量扫描')),
    'Incremental scan button missing for the isolated source.',
  );

  const scan = await waitForValue(
    client,
    `window.photoMap.getLibrary().then((result) => result.ok ? ({
        runId: result.value.scan.runId,
        status: result.value.scan.status,
        count: result.value.photos.filter((photo) => photo.lifecycleState === 'active').length,
        counts: result.value.scan.counts,
        source: result.value.source?.displayName ?? null
      }) : ({ error: result.error.userMessage }))`,
    (value) => value?.status === 'succeeded'
      && value.count === 7
      && value.runId !== baselineScan.runId,
    120_000,
  );

  const uiFinalCount = await waitForValue(
    client,
    `(() => {
        const value = document.querySelector('[data-testid="library-photo-count"]')?.textContent?.replaceAll(',', '').match(/\\d+/)?.[0];
        return value === undefined ? null : Number(value);
      })()`,
    (value) => value === 7,
    30_000,
  );

  const uiObservation = await evaluate(client, `window.__photoMapE2EUiObservation ?? null`);

  assertCondition(uiObservation?.sawZero, `Renderer never exposed the seeded zero-photo state: ${JSON.stringify(uiObservation)}`);

  assertCondition(uiObservation?.sawSeven, `Renderer never exposed the terminal seven-photo state: ${JSON.stringify(uiObservation)}`);

  assertCondition(uiObservation?.sawScanProgress, `Renderer never exposed the running scan state: ${JSON.stringify(uiObservation)}`);

  checks.scan = scan;

  checks.uiScanTransition = {
    initialCount: 0,
    finalCount: uiFinalCount,
    baselineRunId: baselineScan.runId,
    terminalRunId: scan.runId,
    stagedFixtures,
    observedCounts: uiObservation.counts,
    sawScanProgress: uiObservation.sawScanProgress,
    maxVisibleWhileScanning: uiObservation.maxVisibleWhileScanning,
    maxScanProcessed: uiObservation.maxScanProcessed,
  };
  assertCondition(await evaluate(client, clickButtonExpression('照片墙模式')), 'Photo wall missing after scan.');
  await waitForValue(client, `Boolean(document.querySelector('[data-testid="wall-canvas"]'))`, Boolean);
  Object.assign(context, { client, firstSession });
}
