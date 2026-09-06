import { evaluate } from './cdp.mjs';
import { assertCondition } from './utils.mjs';

export function exportDialogStateExpression() {
  return `(() => {
    const dialog = document.querySelector('[data-testid="export-dialog"]');
    if (!dialog) return null;
    const editor = dialog.querySelector('[data-testid="export-editor"]');
    const board = dialog.querySelector('[data-testid="export-board"]');
    const boardBackground = dialog.querySelector('[data-testid="export-board-background"]');
    const canvas = dialog.querySelector('[data-testid="export-output-canvas"]');
    const contextToolbar = dialog.querySelector('[data-testid="export-context-toolbar"]');
    const dataUrl = canvas && editor?.getAttribute('aria-busy') === 'false'
      ? canvas.toDataURL('image/png')
      : '';
    let fingerprint = 2166136261;
    for (let index = 0; index < dataUrl.length; index += 17) {
      fingerprint = Math.imul(fingerprint ^ dataUrl.charCodeAt(index), 16777619);
    }
    const numberAttribute = (element, name) => Number(element.getAttribute(name) ?? NaN);
    const items = [...dialog.querySelectorAll(
      '[data-testid="export-photo-item"], [data-testid="export-text-item"]'
    )].map((item, domIndex) => {
      const kind = item.getAttribute('data-item-kind') ?? '';
      const hitTarget = item.querySelector('.share-element-hit-target');
      const label = hitTarget?.getAttribute('aria-label') ?? '';
      return {
        id: item.getAttribute('data-item-id') ?? '',
        kind,
        selected: item.getAttribute('data-selected') === 'true',
        x: numberAttribute(item, 'data-x'),
        y: numberAttribute(item, 'data-y'),
        width: numberAttribute(item, 'data-width'),
        height: numberAttribute(item, 'data-height'),
        text: kind === 'text'
          ? (item.getAttribute('data-text') ?? label.replace(/^文字：/u, ''))
          : null,
        stackOrder: Number(item.getAttribute('data-stack-order') ?? domIndex)
      };
    });
    const input = dialog.querySelector('[data-testid="export-text-input"]');
    const colors = [...dialog.querySelectorAll('[data-testid="export-text-color"] button')].map((button) => ({
      label: button.getAttribute('aria-label') ?? '',
      pressed: button.getAttribute('aria-pressed') === 'true'
    }));
    const weights = [...dialog.querySelectorAll('[data-testid="export-text-weight"] button')].map((button) => ({
      label: button.textContent?.trim() ?? '',
      pressed: button.getAttribute('aria-pressed') === 'true'
    }));
    const boardSelected = boardBackground?.getAttribute('aria-pressed') === 'true'
      || boardBackground?.getAttribute('data-selected') === 'true'
      || board?.getAttribute('data-board-selected') === 'true';
    const selectedItem = items.find((item) => item.selected);
    const editorBounds = editor?.getBoundingClientRect();
    const toolbarBounds = contextToolbar?.getBoundingClientRect();
    const toolbarStyle = contextToolbar ? getComputedStyle(contextToolbar) : null;
    const toolbarItemId = contextToolbar?.getAttribute('data-item-id') ?? null;
    const toolbarItemKind = contextToolbar?.getAttribute('data-item-kind') ?? null;
    const logicalWidth = Number(
      board?.getAttribute('data-board-width')
        ?? board?.getAttribute('data-width')
        ?? board?.getAttribute('data-document-width')
        ?? canvas?.width
        ?? 0
    );
    const logicalHeight = Number(
      board?.getAttribute('data-board-height')
        ?? board?.getAttribute('data-height')
        ?? board?.getAttribute('data-document-height')
        ?? canvas?.height
        ?? 0
    );
    return {
      actions: [...dialog.querySelectorAll('.export-actions button')]
        .map((button) => button.textContent?.trim() ?? ''),
      hasLayerControl: Boolean(dialog.querySelector('[data-testid*="layer"]'))
        || (dialog.textContent?.includes('图层') ?? false),
      loaded: Boolean(canvas && dataUrl),
      width: logicalWidth,
      height: logicalHeight,
      renderRevision: Number(board?.getAttribute('data-render-revision') ?? 0),
      dataUrlLength: dataUrl.length,
      fingerprint: fingerprint >>> 0,
      items,
      selectedItemId: selectedItem?.id ?? (boardSelected ? 'board' : null),
      boardSelected,
      boardHandles: [...dialog.querySelectorAll('[data-testid="export-board-resize-handle"]')]
        .map((handle) => handle.getAttribute('data-handle') ?? ''),
      contextToolbar: contextToolbar ? {
        itemId: toolbarItemId,
        itemKind: toolbarItemKind,
        position: toolbarStyle?.position ?? '',
        insideEditor: Boolean(editorBounds && toolbarBounds
          && toolbarBounds.left >= editorBounds.left - 1
          && toolbarBounds.top >= editorBounds.top - 1
          && toolbarBounds.right <= editorBounds.right + 1
          && toolbarBounds.bottom <= editorBounds.bottom + 1)
      } : null,
      hasTextControls: Boolean(dialog.querySelector('[data-testid="export-text-controls"]')),
      hasPhotoControls: Boolean(dialog.querySelector('[data-testid="export-photo-controls"]')),
      deleteTextDisabled: (() => {
        const button = dialog.querySelector('[data-testid="export-delete-text"]');
        return button instanceof HTMLButtonElement ? button.disabled : null;
      })(),
      textInput: input instanceof HTMLInputElement ? input.value : null,
      colors,
      selectedColor: colors.find((color) => color.pressed)?.label ?? null,
      weights,
      selectedWeight: weights.find((weight) => weight.pressed)?.label ?? null
    };
  })()`;
}

export function canonicalExportEditorState(state) {
  return {
    width: state.width,
    height: state.height,
    items: state.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      text: item.text,
      stackOrder: item.stackOrder,
    })),
  };
}

export function exportItemsOverlap(left, right, epsilon = 0.01) {
  if (!left || !right) return false;
  return left.x + left.width > right.x + epsilon
    && right.x + right.width > left.x + epsilon
    && left.y + left.height > right.y + epsilon
    && right.y + right.height > left.y + epsilon;
}

export function exportLayoutIsLegal(state) {
  if (
    !state
    || !Number.isFinite(state.width)
    || !Number.isFinite(state.height)
    || state.width <= 0
    || state.height <= 0
  ) {
    return false;
  }
  if (new Set(state.items.map((item) => item.id)).size !== state.items.length) return false;
  for (const item of state.items) {
    if (
      !item.id
      || (item.kind !== 'photo' && item.kind !== 'text')
      || !Number.isFinite(item.x)
      || !Number.isFinite(item.y)
      || !Number.isFinite(item.width)
      || !Number.isFinite(item.height)
      || item.width <= 0
      || item.height <= 0
      || item.x < -0.01
      || item.y < -0.01
      || item.x + item.width > state.width + 0.01
      || item.y + item.height > state.height + 0.01
    ) {
      return false;
    }
  }
  const texts = state.items.filter((item) => item.kind === 'text');
  for (let leftIndex = 0; leftIndex < texts.length; leftIndex += 1) {
    const left = texts[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < texts.length; rightIndex += 1) {
      const right = texts[rightIndex];
      if (exportItemsOverlap(left, right)) return false;
    }
  }
  return state.items.filter((item) => item.selected).length <= 1;
}

export function exportItem(state, itemId) {
  return state?.items?.find((item) => item.id === itemId);
}

export function exportControlBoundsExpression(itemId, handle) {
  const id = JSON.stringify(itemId);
  const requestedHandle = handle === undefined ? 'null' : JSON.stringify(handle);
  return `(() => {
    const item = [...document.querySelectorAll(
      '[data-testid="export-photo-item"], [data-testid="export-text-item"]'
    )].find((candidate) => candidate.getAttribute('data-item-id') === ${id});
    if (!(item instanceof HTMLElement)) return null;
    const requestedHandle = ${requestedHandle};
    const target = requestedHandle === null
      ? item.querySelector('.share-element-hit-target')
      : [...item.querySelectorAll('[data-testid="export-resize-handle"]')]
        .find((candidate) => candidate.getAttribute('data-handle') === requestedHandle);
    if (!(target instanceof HTMLElement)) return null;
    const bounds = target.getBoundingClientRect();
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
  })()`;
}

export function exportBoardControlBoundsExpression(handle) {
  const requestedHandle = handle === undefined ? 'null' : JSON.stringify(handle);
  return `(() => {
    const requestedHandle = ${requestedHandle};
    const target = requestedHandle === null
      ? document.querySelector('[data-testid="export-board-background"]')
      : [...document.querySelectorAll('[data-testid="export-board-resize-handle"]')]
        .find((candidate) => candidate.getAttribute('data-handle') === requestedHandle);
    if (!(target instanceof HTMLElement)) return null;
    const bounds = target.getBoundingClientRect();
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
  })()`;
}

export async function dragExportControl(client, itemId, handle, deltaX, deltaY) {
  const bounds = await evaluate(client, exportControlBoundsExpression(itemId, handle));
  assertCondition(
    bounds?.width > 0 && bounds?.height > 0,
    `Export editor control missing for ${itemId}${handle ? ` handle ${handle}` : ''}.`,
  );
  const startX = bounds.x + bounds.width / 2;
  const startY = bounds.y + bounds.height / 2;
  const endX = startX + deltaX;
  const endY = startY + deltaY;
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startX,
    y: startY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  const steps = deltaX === 0 && deltaY === 0 ? 0 : 6;
  for (let step = 1; step <= steps; step += 1) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + deltaX * step / steps,
      y: startY + deltaY * step / steps,
      button: 'left',
      buttons: 1,
    });
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endX,
    y: endY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  return { startX, startY, endX, endY };
}

export async function dragExportControlByDocumentDelta(client, state, itemId, handle, deltaX, deltaY) {
  const boardBounds = await evaluate(
    client,
    `(() => {
      const bounds = document.querySelector('[data-testid="export-board"]')?.getBoundingClientRect();
      return bounds ? { width: bounds.width, height: bounds.height } : null;
    })()`,
  );
  assertCondition(
    boardBounds?.width > 0 && boardBounds?.height > 0,
    'Export board bounds missing for document-space drag.',
  );
  return dragExportControl(
    client,
    itemId,
    handle,
    deltaX * boardBounds.width / state.width,
    deltaY * boardBounds.height / state.height,
  );
}

export async function dragExportBoardControl(client, handle, deltaX, deltaY) {
  const bounds = await evaluate(client, exportBoardControlBoundsExpression(handle));
  assertCondition(
    bounds?.width > 0 && bounds?.height > 0,
    `Export board ${handle ?? 'background'} control missing.`,
  );
  const startX = handle === undefined ? bounds.x + 5 : bounds.x + bounds.width / 2;
  const startY = handle === undefined ? bounds.y + 5 : bounds.y + bounds.height / 2;
  const endX = startX + deltaX;
  const endY = startY + deltaY;
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startX,
    y: startY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  const steps = deltaX === 0 && deltaY === 0 ? 0 : 8;
  for (let step = 1; step <= steps; step += 1) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + deltaX * step / steps,
      y: startY + deltaY * step / steps,
      button: 'left',
      buttons: 1,
    });
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endX,
    y: endY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  return { startX, startY, endX, endY };
}
