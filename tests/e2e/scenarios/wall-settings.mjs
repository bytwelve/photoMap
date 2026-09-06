import { assertCondition } from '../lib/utils.mjs';
import { evaluate, waitForValue } from '../lib/cdp.mjs';
import { clickButtonInExpression, setInputValueExpression, clickTestIdExpression } from '../lib/ui.mjs';

export async function runWallSettings(context) {
  let { checks, mutation, client } = context;
  assertCondition(
    await evaluate(client, clickButtonInExpression('.region-filter-list', '湖北省')),
    'Hubei province filter button missing after tag reload.',
  );

  assertCondition(
    await evaluate(client, clickButtonInExpression('.filter-view-segmented', '类型')),
    'Type filter tab missing after tag reload.',
  );

  assertCondition(
    await evaluate(client, clickButtonInExpression('.type-list', '打包验收')),
    'Created type filter button missing after tag reload.',
  );

  assertCondition(
    await evaluate(client, setInputValueExpression('.search-field input', 'beijing')),
    'Search filter input missing.',
  );

  assertCondition(
    await evaluate(client, clickButtonInExpression('[data-testid="map-level"]', '市级视图')),
    'City map level button missing.',
  );

  await waitForValue(
    client,
    `document.querySelector('[data-testid="map-level"] button.active')?.textContent?.trim() ?? null`,
    (value) => value === '市级视图',
  );

  assertCondition(
    await evaluate(client, `(() => { const button = document.querySelector('[data-testid="photo-visibility"]'); if (!button) return false; button.click(); return true; })()`),
    'Photo visibility button missing.',
  );

  assertCondition(
    await evaluate(client, `(() => { const button = document.querySelector('[data-testid="place-name-visibility"]'); if (!button) return false; button.click(); return true; })()`),
    'Place-name visibility button missing.',
  );

  assertCondition(
    await evaluate(client, setInputValueExpression('[data-testid="map-density"]', 5)),
    'Map density control missing.',
  );

  const densityBeforeWheel = await waitForValue(
    client,
    `(() => {
        const slider = document.querySelector('[data-testid="map-density"]');
        return slider instanceof HTMLInputElement
          ? { value: slider.value, max: slider.max }
          : null;
      })()`,
    (value) => value?.value === '5' && value.max === '9',
  );

  const densityWheelEvent = await evaluate(client, `(() => {
      const slider = document.querySelector('[data-testid="map-density"]');
      if (!(slider instanceof HTMLInputElement)) return null;
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -120,
      });
      const dispatched = slider.dispatchEvent(event);
      return {
        defaultPrevented: event.defaultPrevented,
        dispatched,
      };
    })()`);

  assertCondition(
    densityWheelEvent?.defaultPrevented === true && densityWheelEvent.dispatched === false,
    `Density wheel event was not canceled: ${JSON.stringify(densityWheelEvent)}`,
  );

  const densityAfterWheel = await waitForValue(
    client,
    `document.querySelector('[data-testid="map-density"]')?.value ?? null`,
    (value) => value === '6',
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('density-best')),
    'Best density button missing.',
  );

  const densityAfterBest = await waitForValue(
    client,
    `document.querySelector('[data-testid="map-density"]')?.value ?? null`,
    (value) => value === '5',
  );

  checks.photoWallDensityControl = {
    beforeWheel: densityBeforeWheel,
    wheelDefaultPrevented: densityWheelEvent.defaultPrevented,
    afterWheel: densityAfterWheel,
    afterBest: densityAfterBest,
  };

  const zoomPoint = await evaluate(client, `(() => {
      const bounds = document.querySelector('[data-testid="wall-canvas"]')?.getBoundingClientRect();
      return bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : null;
    })()`);

  assertCondition(zoomPoint, 'Map canvas missing for wheel zoom.');

  assertCondition(
    await evaluate(client, `[...document.querySelectorAll('.map-controls, button[aria-label="放大"], button[aria-label="缩小"], button[aria-label="复位"]')].length`) === 0,
    'Photo wall unexpectedly rendered the removed zoom button group.',
  );

  const wallChrome = await evaluate(client, `(() => {
      const densityControl = document.querySelector('.density-control');
      const firstDensityItem = densityControl?.firstElementChild;
      const wallWorkspace = document.querySelector('.wall-workspace');
      const wallToolbar = wallWorkspace?.querySelector('.wall-toolbar');
      const toolbarActions = wallWorkspace?.querySelector('.wall-toolbar-actions');
      const mapStage = wallWorkspace?.querySelector('.map-stage');
      const wallCard = wallWorkspace?.querySelector('.wall-card');
      if (!(densityControl instanceof HTMLElement)
        || !(firstDensityItem instanceof HTMLElement)
        || !(wallToolbar instanceof HTMLElement)
        || !(toolbarActions instanceof HTMLElement)
        || !(mapStage instanceof HTMLElement)
        || !(wallCard instanceof HTMLElement)
        || !wallWorkspace) return null;
      const densityBounds = densityControl.getBoundingClientRect();
      const firstItemBounds = firstDensityItem.getBoundingClientRect();
      const toolbarBounds = wallToolbar.getBoundingClientRect();
      const actionsBounds = toolbarActions.getBoundingClientRect();
      const mapBounds = mapStage.getBoundingClientRect();
      const wallCardBounds = wallCard.getBoundingClientRect();
      return {
        bestMarkerPresent: Boolean(document.querySelector('.best-marker')),
        zoomReadoutPresent: Boolean(document.querySelector('.zoom-readout')),
        resultPreviewPresent: Boolean(wallWorkspace.querySelector('.thumbnail-strip')),
        inlineExportPresent: [...wallWorkspace.querySelectorAll('button')]
          .some((button) => button.textContent?.includes('导出当前视口')),
        wallTitlePresent: Boolean(wallToolbar.querySelector('.eyebrow, strong'))
          || wallToolbar.textContent?.includes('全国省份视图')
          || wallToolbar.textContent?.includes('照片墙'),
        densityInToolbar: densityControl.parentElement === wallToolbar,
        densityIsFirstToolbarItem: wallToolbar.firstElementChild === densityControl,
        densityWithinToolbar: densityBounds.top >= toolbarBounds.top
          && densityBounds.bottom <= toolbarBounds.bottom + 1,
        densityToolbarOffset: densityBounds.left - toolbarBounds.left,
        densityBeforeActions: densityBounds.right <= actionsBounds.left,
        mapBottomGap: wallCardBounds.bottom - mapBounds.bottom,
        densityStartOffset: firstItemBounds.left - densityBounds.left,
        densityJustifyContent: getComputedStyle(densityControl).justifyContent,
        densityPosition: getComputedStyle(densityControl).position
      };
    })()`);

  assertCondition(
    wallChrome
    && !wallChrome.bestMarkerPresent
    && !wallChrome.zoomReadoutPresent
    && !wallChrome.resultPreviewPresent
    && !wallChrome.inlineExportPresent
    && !wallChrome.wallTitlePresent
    && wallChrome.densityInToolbar
    && wallChrome.densityIsFirstToolbarItem
    && wallChrome.densityWithinToolbar
    && wallChrome.densityToolbarOffset >= 8
    && wallChrome.densityToolbarOffset <= 20
    && wallChrome.densityBeforeActions
    && Math.abs(wallChrome.mapBottomGap) <= 1
    && wallChrome.densityStartOffset >= 0
    && wallChrome.densityStartOffset <= 24
    && wallChrome.densityJustifyContent === 'start'
    && wallChrome.densityPosition === 'static',
    `Photo wall chrome did not match the simplified left-aligned layout: ${JSON.stringify(wallChrome)}`,
  );

  checks.photoWallChrome = wallChrome;

  await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: zoomPoint.x, y: zoomPoint.y, deltaX: 0, deltaY: -120 });

  await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: zoomPoint.x, y: zoomPoint.y, deltaX: 0, deltaY: -120 });

  await waitForValue(
    client,
    `window.photoMap.getSettings().then((result) => result.ok ? result.value : ({ error: result.error.userMessage }))`,
    (settings) => settings?.filters?.search === 'beijing'
      && settings.filters.locationCodes?.includes('156420000')
      && settings.filters.typeIds?.includes(mutation.typeId)
      && settings.map?.level === 'city'
      && settings.map.showPhotos === false
      && settings.map.showPlaceNames === false
      && settings.map.density === 5
      && settings.map.camera.zoom > 1,
    30_000,
  );

  const canvasBounds = await evaluate(
    client,
    `(() => {
        const bounds = document.querySelector('[data-testid="wall-canvas"]')?.getBoundingClientRect();
        return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
      })()`,
  );

  assertCondition(canvasBounds?.width > 200 && canvasBounds?.height > 200, `Map canvas bounds invalid: ${JSON.stringify(canvasBounds)}`);

  const startX = canvasBounds.x + canvasBounds.width * 0.5;

  const startY = canvasBounds.y + canvasBounds.height * 0.5;

  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 });

  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX + 45, y: startY + 24, button: 'left', buttons: 1 });

  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX + 90, y: startY + 48, button: 'left', buttons: 1 });

  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + 90, y: startY + 48, button: 'left', buttons: 0, clickCount: 1 });

  const mapSettings = await waitForValue(
    client,
    `window.photoMap.getSettings().then((result) => result.ok ? result.value : ({ error: result.error.userMessage }))`,
    (settings) => settings?.map?.camera?.zoom > 1
      && Math.hypot(settings.map.camera.panX, settings.map.camera.panY) > 0.0001,
    30_000,
  );

  checks.mapSettingsFromUi = mapSettings.map;

}
