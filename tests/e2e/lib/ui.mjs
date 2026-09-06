import { evaluate } from './cdp.mjs';
import { assertCondition } from './utils.mjs';

export function clickButtonExpression(label) {
  const value = JSON.stringify(label);
  return `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === ${value});
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

export function clickButtonInExpression(selector, label) {
  const scope = JSON.stringify(selector);
  const value = JSON.stringify(label);
  return `(() => {
    const root = document.querySelector(${scope});
    const button = root && [...root.querySelectorAll('button')]
      .find((item) => item.textContent?.trim() === ${value}
        || [...item.querySelectorAll('span')].some((span) => span.textContent?.trim() === ${value}));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

export function clickAriaButtonExpression(label) {
  const value = JSON.stringify(label);
  return `(() => {
    const button = [...document.querySelectorAll('button[aria-label]')]
      .find((item) => item.getAttribute('aria-label') === ${value});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

export function clickTestIdExpression(testId) {
  const selector = JSON.stringify(`[data-testid="${testId}"]`);
  return `(() => {
    const button = document.querySelector(${selector});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

export function clickElementTestIdExpression(testId) {
  const selector = JSON.stringify(`[data-testid="${testId}"]`);
  return `(() => {
    const element = document.querySelector(${selector});
    if (!(element instanceof HTMLElement)) return false;
    element.focus();
    element.click();
    return true;
  })()`;
}

export async function clickTestIdWithMouse(client, testId) {
  const selector = JSON.stringify(`[data-testid="${testId}"]`);
  const bounds = await evaluate(client, `(() => {
    const element = document.querySelector(${selector});
    if (!(element instanceof HTMLElement) || element.matches(':disabled')) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
  assertCondition(
    bounds?.width > 0 && bounds?.height > 0,
    `Clickable control ${testId} was not visible and enabled.`,
  );
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
  return { x, y };
}

export function setAnnotationBatchModeExpression(enabled) {
  const pressed = enabled ? 'true' : 'false';
  return `(() => {
    const button = document.querySelector('[data-testid="annotation-mode-button"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    if (button.getAttribute('aria-pressed') !== ${JSON.stringify(pressed)}) button.click();
    return true;
  })()`;
}

export function setInputValueExpression(selector, value) {
  const inputSelector = JSON.stringify(selector);
  const nextValue = JSON.stringify(String(value));
  return `(() => {
    const input = document.querySelector(${inputSelector});
    const prototype = input instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : null;
    if (!prototype) return false;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, ${nextValue});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

export function batchColumnStateExpression() {
  return `(() => {
    const input = document.querySelector('[data-testid="batch-column-input"]');
    const grid = document.querySelector('[data-testid="batch-grid"]');
    const actions = document.querySelector('.batch-toolbar-actions');
    const control = input?.closest('.batch-column-control');
    const selectAll = [...document.querySelectorAll('.batch-toolbar-actions button')]
      .find((button) => button.textContent?.trim() === '全选当前结果');
    if (!(input instanceof HTMLInputElement) || !(grid instanceof HTMLElement) || !actions || !(control instanceof HTMLLabelElement) || !(selectAll instanceof HTMLButtonElement)) return null;
    const inputBounds = input.getBoundingClientRect();
    const selectAllBounds = selectAll.getBoundingClientRect();
    return {
      value: input.value,
      type: input.type,
      min: input.min,
      max: input.max,
      step: input.step,
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
      firstAction: actions.firstElementChild === control,
      controlText: control.textContent?.trim() ?? '',
      leftOfSelectAll: inputBounds.right <= selectAllBounds.left,
      focused: document.activeElement === input,
      legacyLabelVisible: document.querySelector('.batch-summary')?.textContent?.includes('每行 4 张') ?? false
    };
  })()`;
}
