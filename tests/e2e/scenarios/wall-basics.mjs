import { waitForValue, evaluate, screenshot } from '../lib/cdp.mjs';
import { delay, assertCondition } from '../lib/utils.mjs';

export async function runWallBasics(context) {
  const { checks, client } = context;
  await waitForValue(client, `Boolean(document.querySelector('[data-testid="wall-canvas"]'))`, Boolean);

  await delay(750);

  checks.canvasExportable = await evaluate(
    client,
    `document.querySelector('[data-testid="wall-canvas"]')?.toDataURL('image/png').startsWith('data:image/png;base64,') ?? false`,
  );

  assertCondition(checks.canvasExportable, 'Photo wall canvas could not be exported.');

  const wallOperationGuide = await evaluate(client, `(() => {
      const card = document.querySelector('.wall-card');
      const toolbar = document.querySelector('.wall-toolbar');
      const guide = document.querySelector('[data-testid="wall-operation-guide"]');
      const map = document.querySelector('.map-stage');
      if (!(card instanceof HTMLElement)
        || !(toolbar instanceof HTMLElement)
        || !(guide instanceof HTMLElement)
        || !(map instanceof HTMLElement)) return null;
      const toolbarBounds = toolbar.getBoundingClientRect();
      const guideBounds = guide.getBoundingClientRect();
      const mapBounds = map.getBoundingClientRect();
      return {
        text: guide.textContent?.trim() ?? '',
        role: guide.getAttribute('role'),
        sharedStyle: guide.classList.contains('operation-guide'),
        guideHasAction: Boolean(guide.querySelector('button')),
        toolbarHasRestore: [...toolbar.querySelectorAll('button')]
          .some((button) => button.textContent?.trim() === '操作说明'
            || button.getAttribute('aria-label') === '显示操作说明'),
        alwaysVisibleClass: card.classList.contains('has-operation-guide'),
        guideHeight: guideBounds.height,
        toolbarGuideGap: guideBounds.top - toolbarBounds.bottom,
        guideMapGap: mapBounds.top - guideBounds.bottom,
        toolbarDivider: getComputedStyle(toolbar).borderBottomWidth,
        guideDivider: getComputedStyle(guide).borderBottomWidth
      };
    })()`);

  assertCondition(
    wallOperationGuide
    && wallOperationGuide.text.includes('单击行政区查看详情')
    && wallOperationGuide.text.includes('滚轮缩放地图')
    && wallOperationGuide.text.includes('放大后按住拖动')
    && wallOperationGuide.role === 'note'
    && wallOperationGuide.sharedStyle
    && !wallOperationGuide.guideHasAction
    && !wallOperationGuide.toolbarHasRestore
    && wallOperationGuide.alwaysVisibleClass
    && Math.abs(wallOperationGuide.guideHeight - 34) <= 1
    && Math.abs(wallOperationGuide.toolbarGuideGap) <= 1.5
    && Math.abs(wallOperationGuide.guideMapGap) <= 1.5
    && wallOperationGuide.toolbarDivider === '0px'
    && wallOperationGuide.guideDivider === '0px',
    `Photo wall operation guide did not match the persistent shared layout: ${JSON.stringify(wallOperationGuide)}`,
  );

  checks.photoWallOperationGuide = wallOperationGuide;

  await screenshot(client, '02-photo-wall.png');

  const mutation = await evaluate(
    client,
    `(async () => {
        const snapshotResult = await window.photoMap.getLibrary();
        if (!snapshotResult.ok) return { error: snapshotResult.error.userMessage };
        // Keep the later "beijing" filter intentionally disjoint from the tagged photo.
        const first = snapshotResult.value.photos.find((photo) => photo.lifecycleState === 'active' && photo.fileName === 'wuhan-yellow-crane-tower.jpg');
        if (!first) return { error: 'The Wuhan fixture is missing' };
        const created = await window.photoMap.createType({ name: '打包验收' });
        if (!created.ok) return { error: created.error.userMessage };
        const location = await window.photoMap.updateLocations({
          photoIds: [first.photoId],
          location: { provinceGb: '156420000', cityGb: '156420100' }
        });
        if (!location.ok) return { error: location.error.userMessage };
        const types = await window.photoMap.updateTypes({
          photoIds: [first.photoId],
          addTypeIds: [created.value.typeId],
          removeTypeIds: []
        });
        if (!types.ok) return { error: types.error.userMessage };
        const updated = types.value.library.photos.find((photo) => photo.photoId === first.photoId);
        return {
          photoId: first.photoId,
          fileName: first.fileName,
          typeId: created.value.typeId,
          provinceGb: updated?.location?.provinceGb,
          cityGb: updated?.location?.cityGb,
          typeApplied: updated?.typeIds.includes(created.value.typeId) ?? false
        };
      })()`,
  );

  assertCondition(
    !mutation.error && mutation.typeApplied && mutation.cityGb === '156420100',
    `Tag mutation failed: ${JSON.stringify(mutation)}`,
  );

  checks.tagMutation = mutation;

  await client.send('Page.reload', { ignoreCache: true });

  await delay(750);

  await waitForValue(client, `typeof window.photoMap?.getLibrary === 'function'`, Boolean);

  await waitForValue(client, `Boolean(document.querySelector('[data-testid="wall-canvas"]'))`, Boolean);

  const refreshedTag = await waitForValue(
    client,
    `window.photoMap.getLibrary().then((result) => result.ok ? ({
        active: result.value.photos.filter((photo) => photo.lifecycleState === 'active').length,
        tagged: result.value.photos.filter((photo) => photo.photoId === ${JSON.stringify(mutation.photoId)}
          && photo.location?.cityGb === '156420100'
          && photo.typeIds.includes(${JSON.stringify(mutation.typeId)})).length
      }) : ({ error: result.error.userMessage }))`,
    (value) => value?.active === 7 && value.tagged === 1,
  );

  checks.tagVisibleAfterRendererReload = refreshedTag;
  Object.assign(context, { mutation });
}
