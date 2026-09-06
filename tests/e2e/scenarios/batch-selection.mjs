import { evaluate, waitForValue, screenshot } from '../lib/cdp.mjs';
import { assertCondition } from '../lib/utils.mjs';
import { clickButtonInExpression, setInputValueExpression } from '../lib/ui.mjs';

export async function runBatchSelection(context) {
  let { checks, client } = context;
  const batchClickPoint = await evaluate(client, `(() => {
      const first = document.querySelector('[data-photo-card] .photo-card-selection');
      if (!(first instanceof HTMLButtonElement)) return null;
      const bounds = first.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);

  assertCondition(batchClickPoint, 'Batch first photo card missing.');

  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: batchClickPoint.x, y: batchClickPoint.y, button: 'left', buttons: 1, clickCount: 1 });

  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: batchClickPoint.x, y: batchClickPoint.y, button: 'left', buttons: 0, clickCount: 1 });

  await waitForValue(
    client,
    `document.querySelector('[data-photo-card] .photo-card-selection')?.getAttribute('aria-pressed') ?? null`,
    (value) => value === 'true',
  );

  assertCondition(
    await evaluate(client, clickButtonInExpression('.batch-toolbar-actions', '清空已选')),
    'Batch clear-selection toolbar action missing.',
  );

  await waitForValue(
    client,
    `[...document.querySelectorAll('[data-photo-card] .photo-card-selection[aria-pressed="true"]')].length`,
    (value) => value === 0,
  );

  assertCondition(
    await evaluate(client, clickButtonInExpression('.batch-toolbar-actions', '全选当前结果')),
    'Batch select-all toolbar action missing.',
  );

  await waitForValue(
    client,
    `[...document.querySelectorAll('[data-photo-card] .photo-card-selection[aria-pressed="true"]')].length`,
    (value) => value === 7,
  );

  assertCondition(
    await evaluate(client, clickButtonInExpression('.batch-toolbar-actions', '清空已选')),
    'Batch clear-selection toolbar action disappeared after select-all.',
  );

  await waitForValue(
    client,
    `[...document.querySelectorAll('[data-photo-card] .photo-card-selection[aria-pressed="true"]')].length`,
    (value) => value === 0,
  );

  const batchDragPoints = await evaluate(client, `(() => {
      const cards = [...document.querySelectorAll('[data-photo-card]')].slice(0, 2);
      if (cards.length !== 2) return null;
      const bounds = cards.map((card) => card.getBoundingClientRect());
      return {
        start: { x: bounds[0].left + bounds[0].width / 2, y: bounds[0].top + bounds[0].height / 2 },
        end: { x: bounds[1].left + bounds[1].width / 2, y: bounds[1].top + bounds[1].height / 2 },
        ids: cards.map((card) => card.dataset.photoId)
      };
    })()`);

  assertCondition(batchDragPoints?.ids.length === 2, `Batch drag points invalid: ${JSON.stringify(batchDragPoints)}`);

  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: batchDragPoints.start.x, y: batchDragPoints.start.y, button: 'left', buttons: 1, clickCount: 1 });

  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (batchDragPoints.start.x + batchDragPoints.end.x) / 2, y: batchDragPoints.start.y, button: 'left', buttons: 1 });

  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: batchDragPoints.end.x, y: batchDragPoints.end.y, button: 'left', buttons: 1 });

  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: batchDragPoints.end.x, y: batchDragPoints.end.y, button: 'left', buttons: 0, clickCount: 1 });

  const batchDragSelection = await waitForValue(
    client,
    `(() => {
        const selected = [...document.querySelectorAll('[data-photo-card] .photo-card-selection[aria-pressed="true"]')];
        return { count: selected.length, ids: selected.map((button) => button.closest('[data-photo-card]').dataset.photoId) };
      })()`,
    (value) => value?.count === 2,
  );

  assertCondition(
    batchDragPoints.ids.every((id) => batchDragSelection.ids.includes(id)),
    `Batch drag selected unexpected cards or toggled the starting card: ${JSON.stringify({ batchDragPoints, batchDragSelection })}`,
  );

  await screenshot(client, '04b-batch-drag-selection.png');

  checks.batchSelection = { clicked: true, selectedAll: 7, drag: batchDragSelection };

  assertCondition(
    await evaluate(client, setInputValueExpression('.search-field input', '__batch_empty_state_e2e_20260824__')),
    'Search input missing for the batch empty-state check.',
  );

  const batchEmptyLayout = await waitForValue(
    client,
    `(() => {
        const toolbar = document.querySelector('.batch-toolbar');
        const helpBar = document.querySelector('[data-testid="batch-operation-guide"]');
        const stage = document.querySelector('[data-testid="batch-empty-stage"]');
        const empty = stage?.querySelector('.empty-results');
        const firstContent = empty?.firstElementChild;
        const lastContent = empty?.lastElementChild;
        const toolbarButtons = [...document.querySelectorAll('.batch-toolbar-actions button')];
        const selectAll = toolbarButtons.find((button) => button.textContent?.trim() === '全选当前结果');
        const clearSelected = toolbarButtons.find((button) => button.textContent?.trim() === '清空已选');
        if (!(toolbar instanceof HTMLElement)
          || !(helpBar instanceof HTMLElement)
          || !(stage instanceof HTMLElement)
          || !(empty instanceof HTMLElement)
          || !(firstContent instanceof Element)
          || !(lastContent instanceof Element)
          || !(selectAll instanceof HTMLButtonElement)
          || !(clearSelected instanceof HTMLButtonElement)) return null;
        const toolbarBounds = toolbar.getBoundingClientRect();
        const helpBounds = helpBar.getBoundingClientRect();
        const stageBounds = stage.getBoundingClientRect();
        const firstBounds = firstContent.getBoundingClientRect();
        const lastBounds = lastContent.getBoundingClientRect();
        return {
          resultText: document.querySelector('.batch-summary')?.textContent?.trim() ?? '',
          photoCardCount: document.querySelectorAll('[data-testid="batch-grid"] [data-photo-card]').length,
          helpText: helpBar.textContent?.trim() ?? '',
          helpHasAction: Boolean(helpBar.querySelector('button')),
          emptyText: empty.textContent?.trim() ?? '',
          actionLabels: toolbarButtons.map((button) => button.textContent?.trim() ?? ''),
          selectAllDisabled: selectAll.disabled,
          clearSelectedDisabled: clearSelected.disabled,
          stageHeight: stageBounds.height,
          contentCenterDelta: Math.abs((firstBounds.top + lastBounds.bottom) / 2 - (stageBounds.top + stageBounds.bottom) / 2),
          toolbarBeforeHelp: toolbarBounds.bottom <= helpBounds.top + 1.5,
          helpBeforeStage: helpBounds.bottom <= stageBounds.top + 1.5,
          toolbarDivider: getComputedStyle(toolbar).borderBottomWidth,
          helpDivider: getComputedStyle(helpBar).borderBottomWidth
        };
      })()`,
    (value) => value?.resultText.includes('当前结果 0 项')
      && value.resultText.includes('已选 0 项')
      && value.photoCardCount === 0
      && value.emptyText.includes('当前筛选没有照片')
      && value.emptyText.includes('清空筛选')
      && JSON.stringify(value.actionLabels) === JSON.stringify(['全选当前结果', '清空已选'])
      && value.selectAllDisabled === true
      && value.clearSelectedDisabled === true
      && value.stageHeight > 300
      && value.contentCenterDelta <= 2
      && value.toolbarBeforeHelp === true
      && value.helpBeforeStage === true
      && value.helpHasAction === false
      && value.toolbarDivider === '0px'
      && value.helpDivider === '0px',
  );

  assertCondition(
    batchEmptyLayout.helpText.includes('单击媒体切换选择')
    && !batchEmptyLayout.helpText.includes('隐藏'),
    `Batch operation help disappeared in the empty state: ${JSON.stringify(batchEmptyLayout)}`,
  );

  await waitForValue(
    client,
    `document.querySelectorAll('.toast').length`,
    (value) => value === 0,
  );

  await screenshot(client, '04c-batch-empty-state.png');

  checks.batchEmptyState = batchEmptyLayout;

}
