import { assertCondition } from '../lib/utils.mjs';
import { evaluate, waitForValue, screenshot } from '../lib/cdp.mjs';
import { setAnnotationBatchModeExpression, batchColumnStateExpression, setInputValueExpression } from '../lib/ui.mjs';

export async function runBatchLayout(context) {
  let { checks, client, postcardBeforeWheel, postcardAfterWheel } = context;
  assertCondition(
    await evaluate(client, setAnnotationBatchModeExpression(true)),
    'Annotation batch button could not open the batch page.',
  );

  await waitForValue(client, `Boolean(document.querySelector('[data-testid="batch-grid"]'))`, Boolean);

  const batchChronology = await evaluate(client, `(async () => {
      const result = await window.photoMap.getLibrary();
      if (!result.ok) return { error: result.error.userMessage };
      const actualIds = [...document.querySelectorAll('[data-testid="batch-grid"] [data-photo-card]')]
        .map((card) => card.dataset.photoId);
      const visible = result.value.photos.filter((photo) => actualIds.includes(photo.photoId));
      const expectedPhotos = [...visible].sort((left, right) => {
        const leftTime = Number.isFinite(left.fileCreatedAtMs) ? left.fileCreatedAtMs : null;
        const rightTime = Number.isFinite(right.fileCreatedAtMs) ? right.fileCreatedAtMs : null;
        if (leftTime === null && rightTime !== null) return 1;
        if (leftTime !== null && rightTime === null) return -1;
        if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
        return left.photoId < right.photoId ? -1 : left.photoId > right.photoId ? 1 : 0;
      });
      const expectedIds = expectedPhotos.map((photo) => photo.photoId);
      const creationTimes = expectedPhotos.map((photo) => photo.fileCreatedAtMs);
      const distinctCreationTimeCount = new Set(
        creationTimes.filter((value) => Number.isFinite(value)),
      ).size;
      return {
        actualIds,
        expectedIds,
        creationTimes,
        distinctCreationTimeCount,
        postcardSequenceMatches: expectedIds[0] === ${JSON.stringify(postcardBeforeWheel.currentPhotoId)}
          && expectedIds[1] === ${JSON.stringify(postcardAfterWheel.currentPhotoId)},
        matches: actualIds.length === expectedIds.length
          && actualIds.every((photoId, index) => photoId === expectedIds[index])
      };
    })()`);

  assertCondition(
    batchChronology.matches === true
    && batchChronology.distinctCreationTimeCount >= 2
    && batchChronology.postcardSequenceMatches === true,
    `Batch photos were not ordered from oldest creation time to newest: ${JSON.stringify(batchChronology)}`,
  );

  await screenshot(client, '04-batch-view.png');

  checks.batchMode = true;

  checks.batchChronology = batchChronology;

  const batchLayout = await evaluate(client, `(() => {
      const grid = document.querySelector('[data-testid="batch-grid"]');
      const firstCard = grid?.querySelector('[data-photo-card]');
      const toolbar = document.querySelector('.batch-toolbar');
      const help = document.querySelector('[data-testid="batch-operation-guide"]');
      const toolbarLabels = [...document.querySelectorAll('.batch-toolbar-actions button')]
        .map((button) => button.textContent?.trim() ?? '');
      if (!(grid instanceof HTMLElement)
        || !(firstCard instanceof HTMLElement)
        || !(toolbar instanceof HTMLElement)
        || !(help instanceof HTMLElement)) return null;
      const columnsBefore = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean);
      const cardBounds = firstCard.getBoundingClientRect();
      return {
        columnsBefore,
        cardRatio: cardBounds.width / cardBounds.height,
        toolbarLabels,
        summary: document.querySelector('.batch-summary')?.textContent?.trim() ?? '',
        help: help.textContent?.trim() ?? '',
        helpRole: help.getAttribute('role'),
        helpHasAction: Boolean(help.querySelector('button')),
        helpHeight: help.getBoundingClientRect().height,
        toolbarDivider: getComputedStyle(toolbar).borderBottomWidth,
        helpDivider: getComputedStyle(help).borderBottomWidth
      };
    })()`);

  assertCondition(batchLayout, 'Batch grid or first photo card missing for layout checks.');

  const batchColumnInitial = await evaluate(client, batchColumnStateExpression());

  assertCondition(
    batchColumnInitial?.value === '4'
    && batchColumnInitial.type === 'number'
    && batchColumnInitial.min === '2'
    && batchColumnInitial.max === '10'
    && batchColumnInitial.step === '1'
    && batchColumnInitial.columns === 4
    && batchColumnInitial.firstAction
    && batchColumnInitial.controlText.includes('每行')
    && batchColumnInitial.controlText.includes('张')
    && batchColumnInitial.leftOfSelectAll
    && !batchColumnInitial.legacyLabelVisible,
    `Batch column input was not initialized or positioned correctly: ${JSON.stringify(batchColumnInitial)}`,
  );

  const batchManyPhotoLayout = await evaluate(client, `(async () => {
      const grid = document.querySelector('[data-testid="batch-grid"]');
      if (!(grid instanceof HTMLElement)) return null;
      const originals = [...grid.querySelectorAll('[data-photo-card]')];
      if (originals.length === 0) return null;
      for (let index = originals.length; index < 162; index += 1) {
        const clone = originals[index % originals.length].cloneNode(true);
        clone.dataset.e2eLayoutClone = 'true';
        clone.dataset.photoId = 'layout-clone-' + index;
        clone.setAttribute('aria-hidden', 'true');
        clone.tabIndex = -1;
        grid.append(clone);
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const cards = [...grid.querySelectorAll('[data-photo-card]')];
      const rects = cards.map((card) => card.getBoundingClientRect());
      const rowTops = [];
      for (const rect of rects) {
        if (!rowTops.some((top) => Math.abs(top - rect.top) < 1)) rowTops.push(rect.top);
      }
      const firstRowTops = rects.slice(0, 4).map((rect) => rect.top);
      const overlapCount = rects.slice(4)
        .filter((rect, index) => rect.top < rects[index].bottom - 0.5)
        .length;
      return {
        total: cards.length,
        rowCount: rowTops.length,
        overlapCount,
        firstRowTopSpread: Math.max(...firstRowTops) - Math.min(...firstRowTops),
        firstRowGap: rects[4].top - rects[0].bottom,
        firstCardHeight: rects[0].height,
        scrollHeight: grid.scrollHeight,
        clientHeight: grid.clientHeight
      };
    })()`);

  assertCondition(
    batchManyPhotoLayout?.total === 162
    && batchManyPhotoLayout.rowCount === 41
    && batchManyPhotoLayout.overlapCount === 0
    && batchManyPhotoLayout.firstRowTopSpread < 1
    && batchManyPhotoLayout.firstRowGap >= 6
    && batchManyPhotoLayout.scrollHeight > batchManyPhotoLayout.clientHeight,
    `Batch grid overlapped or failed to scroll with 162 cards: ${JSON.stringify(batchManyPhotoLayout)}`,
  );

  await screenshot(client, '04a-batch-162-card-layout.png');

  checks.batchManyPhotoLayout = batchManyPhotoLayout;

  const batchWheelPoint = await evaluate(client, `(() => {
      const grid = document.querySelector('[data-testid="batch-grid"]');
      if (!(grid instanceof HTMLElement)) return null;
      grid.scrollTop = 0;
      const bounds = grid.getBoundingClientRect();
      window.__batchWheelObservation = null;
      document.addEventListener('wheel', (event) => {
        window.__batchWheelObservation = { defaultPrevented: event.defaultPrevented };
      }, { once: true });
      return {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
        overflow: grid.scrollHeight > grid.clientHeight
      };
    })()`);

  assertCondition(batchWheelPoint?.overflow, `Batch grid did not overflow in the bounded wheel check: ${JSON.stringify(batchWheelPoint)}`);

  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: batchWheelPoint.x,
    y: batchWheelPoint.y,
    deltaX: 0,
    deltaY: 120,
  });

  const batchWheelObservation = await waitForValue(
    client,
    `(() => {
        const grid = document.querySelector('[data-testid="batch-grid"]');
        const observation = window.__batchWheelObservation;
        return observation && grid ? { ...observation, scrollTop: grid.scrollTop } : null;
      })()`,
    (value) => value?.scrollTop > 0,
  );

  batchLayout.columnsAfter = await evaluate(
    client,
    `(() => {
        const grid = document.querySelector('[data-testid="batch-grid"]');
        const columns = [...getComputedStyle(grid).gridTemplateColumns.split(' ')].filter(Boolean);
        grid.scrollTop = 0;
        grid.querySelectorAll('[data-e2e-layout-clone]').forEach((clone) => clone.remove());
        return columns;
      })()`,
  );

  batchLayout.wheelDefaultPrevented = batchWheelObservation.defaultPrevented;

  batchLayout.wheelScrollTop = batchWheelObservation.scrollTop;

  assertCondition(
    batchLayout?.columnsBefore.length === 4 && batchLayout.columnsAfter.length === 4,
    `Batch grid did not default to four columns: ${JSON.stringify(batchLayout)}`,
  );

  assertCondition(
    Math.abs(batchLayout.cardRatio - 1.5) < 0.03,
    `Batch card ratio was not 3:2: ${JSON.stringify(batchLayout)}`,
  );

  assertCondition(
    JSON.stringify(batchLayout.toolbarLabels) === JSON.stringify(['全选当前结果', '清空已选'])
    && batchLayout.summary.includes('当前结果 7 项')
    && batchLayout.summary.includes('已选 0 项')
    && batchLayout.help.includes('单击媒体切换选择')
    && batchLayout.help.includes('按住拖动可框选多项')
    && batchLayout.helpRole === 'note'
    && !batchLayout.helpHasAction
    && Math.abs(batchLayout.helpHeight - 34) <= 1
    && batchLayout.toolbarDivider === '0px'
    && batchLayout.helpDivider === '0px'
    && !batchLayout.wheelDefaultPrevented,
    `Batch toolbar or wheel behavior did not match the merged interaction: ${JSON.stringify(batchLayout)}`,
  );

  checks.batchOperationGuide = {
    text: batchLayout.help,
    role: batchLayout.helpRole,
    hasAction: batchLayout.helpHasAction,
    height: batchLayout.helpHeight,
    toolbarDivider: batchLayout.toolbarDivider,
    guideDivider: batchLayout.helpDivider,
  };

  assertCondition(
    await evaluate(client, `(() => {
        const input = document.querySelector('[data-testid="batch-column-input"]');
        if (!(input instanceof HTMLInputElement)) return false;
        input.focus();
        return document.activeElement === input;
      })()`),
    'Batch column input could not receive focus.',
  );

  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });

  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });

  const batchColumnAfterIncrement = await waitForValue(
    client,
    batchColumnStateExpression(),
    (value) => value?.value === '5' && value.columns === 5,
  );

  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });

  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });

  const batchColumnAfterDecrement = await waitForValue(
    client,
    batchColumnStateExpression(),
    (value) => value?.value === '4' && value.columns === 4,
  );

  assertCondition(
    await evaluate(client, setInputValueExpression('[data-testid="batch-column-input"]', 8)),
    'Batch column input was missing for manual entry.',
  );

  const batchColumnAfterManualEntry = await waitForValue(
    client,
    batchColumnStateExpression(),
    (value) => value?.value === '8' && value.columns === 8,
  );

  assertCondition(
    await evaluate(client, setInputValueExpression('[data-testid="batch-column-input"]', 10)),
    'Batch column input was missing for upper-bound entry.',
  );

  await waitForValue(client, batchColumnStateExpression(), (value) => value?.value === '10' && value.columns === 10);

  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });

  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });

  const batchColumnUpperBound = await evaluate(client, batchColumnStateExpression());

  assertCondition(
    await evaluate(client, setInputValueExpression('[data-testid="batch-column-input"]', 2)),
    'Batch column input was missing for lower-bound entry.',
  );

  await waitForValue(client, batchColumnStateExpression(), (value) => value?.value === '2' && value.columns === 2);

  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });

  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });

  const batchColumnLowerBound = await evaluate(client, batchColumnStateExpression());

  assertCondition(
    batchColumnUpperBound?.value === '10'
    && batchColumnUpperBound.columns === 10
    && batchColumnLowerBound?.value === '2'
    && batchColumnLowerBound.columns === 2,
    `Batch column input did not respect its 2-10 limits: ${JSON.stringify({ batchColumnUpperBound, batchColumnLowerBound })}`,
  );

  assertCondition(
    await evaluate(client, setInputValueExpression('[data-testid="batch-column-input"]', 11)),
    'Batch column input was missing for upper normalization.',
  );

  await waitForValue(client, batchColumnStateExpression(), (value) => value?.value === '11' && value.columns === 2);

  await evaluate(client, `(() => { const input = document.querySelector('[data-testid="batch-column-input"]'); input?.focus(); input?.blur(); return true; })()`);

  const batchColumnNormalizedUpper = await waitForValue(
    client,
    batchColumnStateExpression(),
    (value) => value?.value === '10' && value.columns === 10,
  );

  assertCondition(
    await evaluate(client, setInputValueExpression('[data-testid="batch-column-input"]', 1)),
    'Batch column input was missing for lower normalization.',
  );

  await waitForValue(client, batchColumnStateExpression(), (value) => value?.value === '1' && value.columns === 10);

  await evaluate(client, `(() => { const input = document.querySelector('[data-testid="batch-column-input"]'); input?.focus(); input?.blur(); return true; })()`);

  const batchColumnNormalizedLower = await waitForValue(
    client,
    batchColumnStateExpression(),
    (value) => value?.value === '2' && value.columns === 2,
  );

  assertCondition(
    await evaluate(client, setInputValueExpression('[data-testid="batch-column-input"]', 6.6)),
    'Batch column input was missing for decimal normalization.',
  );

  await waitForValue(client, batchColumnStateExpression(), (value) => value?.value === '6.6' && value.columns === 2);

  await evaluate(client, `(() => { const input = document.querySelector('[data-testid="batch-column-input"]'); input?.focus(); input?.blur(); return true; })()`);

  const batchColumnNormalizedDecimal = await waitForValue(
    client,
    batchColumnStateExpression(),
    (value) => value?.value === '7' && value.columns === 7,
  );

  assertCondition(
    await evaluate(client, setInputValueExpression('[data-testid="batch-column-input"]', '')),
    'Batch column input was missing for empty-value normalization.',
  );

  await waitForValue(client, batchColumnStateExpression(), (value) => value?.value === '' && value.columns === 7);

  await evaluate(client, `(() => { const input = document.querySelector('[data-testid="batch-column-input"]'); input?.focus(); input?.blur(); return true; })()`);

  const batchColumnNormalizedEmpty = await waitForValue(
    client,
    batchColumnStateExpression(),
    (value) => value?.value === '7' && value.columns === 7,
  );

  assertCondition(
    await evaluate(client, setInputValueExpression('[data-testid="batch-column-input"]', 4)),
    'Batch column input could not be restored after validation.',
  );

  await waitForValue(client, batchColumnStateExpression(), (value) => value?.value === '4' && value.columns === 4);

  assertCondition(
    await evaluate(client, setInputValueExpression('[data-testid="batch-column-input"]', 11)),
    'Batch column input was missing for wheel draft validation.',
  );

  await waitForValue(client, batchColumnStateExpression(), (value) => value?.value === '11' && value.columns === 4);

  const batchColumnWheelPoint = await evaluate(client, `(() => {
      const input = document.querySelector('[data-testid="batch-column-input"]');
      if (!(input instanceof HTMLInputElement)) return null;
      input.focus();
      const bounds = input.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);

  assertCondition(batchColumnWheelPoint, 'Batch column input was missing for wheel validation.');

  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: batchColumnWheelPoint.x,
    y: batchColumnWheelPoint.y,
    deltaX: 0,
    deltaY: 120,
  });

  const batchColumnAfterWheel = await waitForValue(
    client,
    batchColumnStateExpression(),
    (value) => value?.value === '4' && value.columns === 4 && !value.focused,
  );

  checks.batchColumnControl = {
    initial: batchColumnInitial,
    incremented: batchColumnAfterIncrement,
    decremented: batchColumnAfterDecrement,
    manual: batchColumnAfterManualEntry,
    upperBound: batchColumnUpperBound,
    lowerBound: batchColumnLowerBound,
    normalizedUpper: batchColumnNormalizedUpper,
    normalizedLower: batchColumnNormalizedLower,
    normalizedDecimal: batchColumnNormalizedDecimal,
    normalizedEmpty: batchColumnNormalizedEmpty,
    afterWheel: batchColumnAfterWheel
  };

  checks.batchLayout = batchLayout;

}
