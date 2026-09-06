import { assertCondition } from '../lib/utils.mjs';
import { evaluate, waitForValue, screenshot } from '../lib/cdp.mjs';
import { clickButtonInExpression, clickTestIdExpression, clickButtonExpression, clickAriaButtonExpression } from '../lib/ui.mjs';

export async function runRegionPicker(context) {
  let { checks, mutation, client } = context;
  assertCondition(
    await evaluate(client, clickButtonInExpression('.empty-results', '清空筛选')),
    'Batch empty-state clear-filter action missing.',
  );

  await waitForValue(
    client,
    `document.querySelectorAll('[data-testid="batch-grid"] [data-photo-card]').length`,
    (value) => value === 7,
  );

  assertCondition(
    await evaluate(client, clickButtonInExpression('.filter-view-segmented', '省市')),
    'Province/city filter tab missing before annotation unlocated verification.',
  );

  const annotationUnlocatedSidebar = await evaluate(client, `(() => {
      const list = document.querySelector('#location-filter-panel .region-filter-list');
      const unlocated = list?.querySelector('[data-testid="unlocated-location-filter"]');
      const countText = unlocated?.querySelector('small')?.textContent?.replaceAll(',', '').match(/\\d+/)?.[0];
      return {
        first: list?.querySelector('button') === unlocated,
        count: countText === undefined ? null : Number(countText),
        enabled: unlocated instanceof HTMLButtonElement && !unlocated.disabled,
        pressed: unlocated?.getAttribute('aria-pressed') === 'true'
      };
    })()`);

  assertCondition(
    annotationUnlocatedSidebar?.first
    && annotationUnlocatedSidebar.count === 6
    && annotationUnlocatedSidebar.enabled
    && annotationUnlocatedSidebar.pressed === false,
    `Annotation unlocated filter was not enabled with the full count: ${JSON.stringify(annotationUnlocatedSidebar)}`,
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('unlocated-location-filter')),
    'Annotation unlocated location filter button missing.',
  );

  const unlocatedSelected = await waitForValue(
    client,
    `Promise.all([
        window.photoMap.getSettings(),
        Promise.resolve(document.querySelector('[data-testid="unlocated-location-filter"]')?.getAttribute('aria-pressed'))
      ]).then(([settings, pressed]) => ({
        persisted: settings.ok ? settings.value.filters.includeUnlocated : null,
        pressed
      }))`,
    (value) => value?.persisted === true && value.pressed === 'true',
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('unlocated-location-filter')),
    'Annotation unlocated location filter could not be cleared.',
  );

  await waitForValue(
    client,
    `window.photoMap.getSettings().then((result) => result.ok ? result.value.filters.includeUnlocated : null)`,
    (value) => value === false,
  );

  assertCondition(await evaluate(client, clickButtonExpression('照片墙模式')), 'Photo wall mode button missing.');

  await waitForValue(client, `Boolean(document.querySelector('[data-testid="wall-canvas"]'))`, Boolean);

  assertCondition(
    await evaluate(client, clickButtonInExpression('[data-testid="map-level"]', '市级视图')),
    'City map level button missing for fixed-region photo verification.',
  );

  await waitForValue(
    client,
    `(() => {
        const button = document.querySelector('[data-testid="fixed-region-photos"]');
        return button instanceof HTMLButtonElement && !button.disabled;
      })()`,
    Boolean,
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('fixed-region-photos')),
    'Fixed-region photo action missing.',
  );

  await waitForValue(client, `Boolean(document.querySelector('[data-testid="fixed-photo-dialog"]'))`, Boolean);

  const fixedPickerInitial = await evaluate(client, `(() => {
      const dialog = document.querySelector('[data-testid="fixed-photo-dialog"]');
      const option = dialog?.querySelector('.fixed-photo-option');
      if (!(option instanceof HTMLButtonElement)) return null;
      option.click();
      return {
        title: dialog.querySelector('h2')?.textContent?.trim() ?? '',
        optionCount: dialog.querySelectorAll('.fixed-photo-option').length,
        isolationNotice: dialog.textContent?.includes('不会修改照片的省市地点，也不会影响批注模式') ?? false
      };
    })()`);

  assertCondition(
    fixedPickerInitial?.optionCount >= 1 && fixedPickerInitial.isolationNotice,
    `Fixed-region photo picker was incomplete: ${JSON.stringify(fixedPickerInitial)}`,
  );

  await waitForValue(
    client,
    `document.querySelector('[data-testid="fixed-photo-dialog"] .fixed-photo-option')?.getAttribute('aria-pressed')`,
    (value) => value === 'true',
  );

  await screenshot(client, '04d-fixed-region-photo-picker.png');

  assertCondition(
    await evaluate(client, clickButtonInExpression('[data-testid="fixed-photo-dialog"]', '固定 1 张照片')),
    'Fixed-region photo selection could not be saved.',
  );

  await waitForValue(client, `!document.querySelector('[data-testid="fixed-photo-dialog"]')`, Boolean);

  const fixedPickerSaved = await waitForValue(
    client,
    `document.querySelector('[data-testid="fixed-region-photos"]')?.textContent?.trim() ?? ''`,
    (value) => value.includes('管理固定照片') && value.includes('1/1'),
  );

  const locationAfterFixedDisplay = await evaluate(
    client,
    `window.photoMap.getLibrary().then((result) => {
        if (!result.ok) return { error: result.error.userMessage };
        const photo = result.value.photos.find((item) => item.photoId === ${JSON.stringify(mutation.photoId)});
        return { provinceGb: photo?.location?.provinceGb, cityGb: photo?.location?.cityGb };
      })`,
  );

  assertCondition(
    locationAfterFixedDisplay?.provinceGb === '156420000' && locationAfterFixedDisplay?.cityGb === '156420100',
    `Fixed wall display unexpectedly changed photo location: ${JSON.stringify(locationAfterFixedDisplay)}`,
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('fixed-region-photos')),
    'Saved fixed-region photo action could not be reopened.',
  );

  await waitForValue(client, `Boolean(document.querySelector('[data-testid="fixed-photo-dialog"]'))`, Boolean);

  assertCondition(
    await evaluate(client, clickButtonInExpression('[data-testid="fixed-photo-dialog"]', '清空选择')),
    'Fixed-region photo selection could not be cleared.',
  );

  assertCondition(
    await evaluate(client, clickButtonInExpression('[data-testid="fixed-photo-dialog"]', '恢复自动选片')),
    'Automatic region photo selection could not be restored.',
  );

  await waitForValue(
    client,
    `document.querySelector('[data-testid="fixed-region-photos"]')?.textContent?.trim() ?? ''`,
    (value) => value.includes('固定该区域展示照片'),
  );

  checks.fixedRegionPhotos = {
    picker: fixedPickerInitial,
    savedLabel: fixedPickerSaved,
    locationAfterFixedDisplay,
    restoredAutomaticSelection: true,
  };

  assertCondition(
    await evaluate(client, clickButtonInExpression('[data-testid="map-level"]', '省级视图')),
    'Province map level could not be restored after fixed-region photo verification.',
  );

  await waitForValue(
    client,
    `document.querySelector('[data-testid="map-level"] button.active')?.textContent?.trim() ?? null`,
    (value) => value === '省级视图',
  );

  assertCondition(
    await evaluate(client, `document.querySelector('[data-filter-tab="location"]')?.getAttribute('aria-selected') === 'true'`),
    'Province/city filter tab was not selected by default.',
  );

  const wallUnlocatedSidebar = await evaluate(client, `(() => {
      const panel = document.querySelector('#location-filter-panel');
      const list = panel?.querySelector('.region-filter-list');
      const unlocated = list?.querySelector('[data-testid="unlocated-location-filter"]');
      const firstButton = list?.querySelector('button');
      const countText = unlocated?.querySelector('small')?.textContent?.replaceAll(',', '').match(/\\d+/)?.[0];
      const panelText = panel?.textContent ?? '';
      return {
        summaryAbsent: document.querySelectorAll('.filter-summary').length === 0
          && !panelText.includes('全部照片')
          && !panelText.includes('已手动标记地点'),
        unlocatedFirst: firstButton === unlocated,
        unlocatedCount: countText === undefined ? null : Number(countText),
        unlocatedPressed: unlocated?.getAttribute('aria-pressed') === 'true',
        unlocatedDisabled: unlocated instanceof HTMLButtonElement && unlocated.disabled,
        unlocatedUnavailable: unlocated?.closest('.unlocated-filter-row')?.classList.contains('unavailable') ?? false
      };
    })()`);

  assertCondition(
    wallUnlocatedSidebar?.summaryAbsent
    && wallUnlocatedSidebar.unlocatedFirst
    && wallUnlocatedSidebar.unlocatedCount === 6
    && wallUnlocatedSidebar.unlocatedPressed === false
    && wallUnlocatedSidebar.unlocatedDisabled
    && wallUnlocatedSidebar.unlocatedUnavailable,
    `Wall unlocated sidebar item was not fixed first and unavailable: ${JSON.stringify(wallUnlocatedSidebar)}`,
  );

  checks.unlocatedSidebar = {
    annotation: { ...annotationUnlocatedSidebar, selected: unlocatedSelected },
    wall: wallUnlocatedSidebar,
  };

  assertCondition(
    await evaluate(client, clickAriaButtonExpression('展开湖北省下的城市')),
    'Hubei city disclosure button missing.',
  );

  const sidebarHierarchy = await waitForValue(
    client,
    `(() => ({
        expanded: document.querySelector('[aria-label="收起湖北省下的城市"]')?.getAttribute('aria-expanded') === 'true',
        provincePressed: [...document.querySelectorAll('.region-filter-option')]
          .some((button) => button.getAttribute('aria-pressed') === 'true'
            && button.textContent?.includes('湖北省')),
        cityVisible: [...document.querySelectorAll('.city-filter-option')]
          .some((button) => button.textContent?.includes('武汉市'))
      }))()`,
    (value) => value?.expanded === true && value.cityVisible === true,
  );

  assertCondition(
    sidebarHierarchy.provincePressed === false,
    `Expanding Hubei unexpectedly changed the location filter: ${JSON.stringify(sidebarHierarchy)}`,
  );

  checks.sidebarHierarchy = sidebarHierarchy;

  await screenshot(client, '04c-sidebar-unlocated-and-city-hierarchy.png');

}
