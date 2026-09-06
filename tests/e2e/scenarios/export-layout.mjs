import { assertCondition } from '../lib/utils.mjs';
import { exportItem, dragExportControl, exportDialogStateExpression, exportLayoutIsLegal, exportItemsOverlap, dragExportBoardControl, canonicalExportEditorState } from '../lib/export-ui.mjs';
import { waitForValue, evaluate, screenshot, rendererErrorEvents } from '../lib/cdp.mjs';
import { clickTestIdExpression, clickButtonInExpression } from '../lib/ui.mjs';

export async function runExportLayout(context) {
  let { checks, client, rendererErrorCountBeforeExport, exportInitial, initialExportCanonical, editedTextId, exportSingleText } = context;
  assertCondition(
    exportSingleText.items.filter((item) => item.kind === 'text').length === 1
    && Boolean(exportItem(exportSingleText, editedTextId)),
    'Could not isolate the edited text for center/overlap checks: ' + JSON.stringify(exportSingleText),
  );

  const photoId = exportSingleText.items.find((item) => item.kind === 'photo')?.id;

  assertCondition(typeof photoId === 'string', 'Export photo geometry missing.');

  await dragExportControl(client, photoId, undefined, 0, 0);

  const exportPhotoSelected = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.selectedItemId === photoId
      && value.hasPhotoControls === true
      && value.hasTextControls === false
      && value.contextToolbar?.itemId === photoId
      && value.contextToolbar?.itemKind === 'photo'
      && value.contextToolbar?.insideEditor === true,
  );

  const photoBeforeResize = exportItem(exportPhotoSelected, photoId);

  assertCondition(photoBeforeResize, 'Photo geometry missing before resize.');

  const photoRatioBefore = photoBeforeResize.width / photoBeforeResize.height;

  await dragExportControl(client, photoId, 'se', -30, -18);

  const exportAfterPhotoResize = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => {
      const item = exportItem(value, photoId);
      return value?.loaded
        && value.renderRevision > exportPhotoSelected.renderRevision
        && item
        && item.width < photoBeforeResize.width - 1
        && item.height < photoBeforeResize.height - 1;
    },
  );

  const photoAfterResize = exportItem(exportAfterPhotoResize, photoId);

  assertCondition(photoAfterResize, 'Photo geometry missing after resize.');

  assertCondition(
    exportLayoutIsLegal(exportAfterPhotoResize)
    && Math.abs(photoAfterResize.width / photoAfterResize.height - photoRatioBefore) < 0.01,
    'Photo resize did not preserve its aspect ratio: ' + JSON.stringify({
      before: photoBeforeResize,
      after: photoAfterResize,
    }),
  );

  await dragExportControl(client, photoId, undefined, 12, 8);

  const exportAfterPhotoMove = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => {
      const item = exportItem(value, photoId);
      return value?.loaded
        && value.renderRevision > exportAfterPhotoResize.renderRevision
        && item
        && Math.hypot(item.x - photoAfterResize.x, item.y - photoAfterResize.y) > 1;
    },
  );

  assertCondition(
    exportLayoutIsLegal(exportAfterPhotoMove),
    'Photo drag produced an invalid layout: ' + JSON.stringify(exportAfterPhotoMove),
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-align-horizontal')),
    'Photo horizontal-center action missing.',
  );

  const exportPhotoHorizontalCentered = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => {
      const item = exportItem(value, photoId);
      return value?.loaded
        && item
        && Math.abs(item.x + item.width / 2 - value.width / 2) < 0.1;
    },
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-align-vertical')),
    'Photo vertical-center action missing.',
  );

  const exportPhotoCentered = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => {
      const item = exportItem(value, photoId);
      return value?.loaded
        && value.renderRevision > exportPhotoHorizontalCentered.renderRevision
        && item
        && Math.abs(item.x + item.width / 2 - value.width / 2) < 0.1
        && Math.abs(item.y + item.height / 2 - value.height / 2) < 0.1;
    },
  );

  assertCondition(
    exportLayoutIsLegal(exportPhotoCentered),
    'Centering the photo produced an invalid layout: ' + JSON.stringify(exportPhotoCentered),
  );

  await dragExportControl(client, editedTextId, undefined, 0, 0);

  await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.selectedItemId === editedTextId
      && value.hasTextControls === true
      && value.hasPhotoControls === false
      && value.contextToolbar?.itemId === editedTextId
      && value.contextToolbar?.itemKind === 'text'
      && value.contextToolbar?.insideEditor === true,
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-align-horizontal')),
    'Text horizontal-center action missing.',
  );

  const exportTextHorizontalCentered = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => {
      const item = exportItem(value, editedTextId);
      return value?.loaded
        && item
        && Math.abs(item.x + item.width / 2 - value.width / 2) < 0.1;
    },
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-align-vertical')),
    'Text vertical-center action missing.',
  );

  const exportTextCentered = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => {
      const item = exportItem(value, editedTextId);
      return value?.loaded
        && value.renderRevision > exportTextHorizontalCentered.renderRevision
        && item
        && Math.abs(item.x + item.width / 2 - value.width / 2) < 0.1
        && Math.abs(item.y + item.height / 2 - value.height / 2) < 0.1;
    },
  );

  const centeredText = exportItem(exportTextCentered, editedTextId);

  const centeredPhoto = exportItem(exportTextCentered, photoId);

  assertCondition(
    centeredText
    && centeredPhoto
    && exportItemsOverlap(centeredText, centeredPhoto)
    && exportLayoutIsLegal(exportTextCentered),
    'Centered text did not legally overlap the bottom photo: ' + JSON.stringify(exportTextCentered),
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-add-text')),
    'Add-text action missing after centering the edited text.',
  );

  const exportWithOverlayTexts = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.items.filter((item) => item.kind === 'text').length === 2
      && value.selectedItemId !== editedTextId
      && exportLayoutIsLegal(value),
  );

  assertCondition(
    !exportItemsOverlap(
      exportItem(exportWithOverlayTexts, editedTextId),
      exportWithOverlayTexts.items.find((item) => item.kind === 'text' && item.id !== editedTextId),
    ),
    'Adding another overlay text produced a text-to-text overlap: '
    + JSON.stringify(exportWithOverlayTexts),
  );

  await dragExportBoardControl(client, undefined, 0, 0);

  const exportBoardSelected = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.selectedItemId === 'board'
      && value.boardSelected === true
      && value.contextToolbar === null
      && value.hasTextControls === false
      && value.hasPhotoControls === false
      && value.boardHandles.length === 8,
  );

  assertCondition(
    JSON.stringify([...exportBoardSelected.boardHandles].sort())
    === JSON.stringify(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']),
    'The board did not expose all eight free-resize handles: '
    + JSON.stringify(exportBoardSelected.boardHandles),
  );

  await dragExportBoardControl(client, 'e', 60, 0);

  const exportBoardWider = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.width > exportBoardSelected.width + 5
      && Math.abs(value.height - exportBoardSelected.height) < 0.1
      && exportLayoutIsLegal(value),
  );

  await dragExportBoardControl(client, 's', 0, 45);

  const exportBoardTaller = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.height > exportBoardWider.height + 5
      && Math.abs(value.width - exportBoardWider.width) < 0.1
      && exportLayoutIsLegal(value),
  );

  assertCondition(
    Math.abs(
      exportBoardTaller.width / exportBoardTaller.height
      - exportBoardSelected.width / exportBoardSelected.height,
    ) > 0.01,
    'Independent board resizing did not change the board aspect ratio.',
  );

  await dragExportBoardControl(client, 'e', -260, 0);

  const exportBoardConstrained = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.width < exportBoardTaller.width - 5
      && exportLayoutIsLegal(value),
  );

  checks.exportEditorBoardResized = exportBoardConstrained;

  await screenshot(client, '05b-export-board-resized.png');

  await dragExportControl(client, editedTextId, undefined, 0, 0);

  const exportCustomized = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.selectedItemId === editedTextId
      && value.contextToolbar?.itemId === editedTextId
      && value.hasTextControls === true
      && exportLayoutIsLegal(value),
  );

  const customizedText = exportItem(exportCustomized, editedTextId);

  const customizedPhoto = exportItem(exportCustomized, photoId);

  assertCondition(
    exportCustomized.fingerprint !== exportInitial.fingerprint
    && exportCustomized.textInput === '2026 · 我的旅行足迹'
    && exportCustomized.selectedColor === '暖红'
    && exportCustomized.selectedWeight === '粗体'
    && customizedText
    && customizedPhoto
    && exportItemsOverlap(customizedText, customizedPhoto),
    'Customized export did not retain its overlay text and style: '
    + JSON.stringify(exportCustomized),
  );

  checks.exportEditorCustomized = exportCustomized;

  await screenshot(client, '05-export-editor-custom.png');

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-reset')),
    'Export reset action missing.',
  );

  await waitForValue(
    client,
    `Boolean(document.querySelector('[data-testid="export-reset-confirmation"]'))`,
    Boolean,
  );

  await screenshot(client, '05a-export-editor-reset-confirmation.png');

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-reset-confirm')),
    'Export reset confirmation action missing.',
  );

  const exportReset = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.renderRevision > exportCustomized.renderRevision
      && value.items.filter((item) => item.kind === 'photo').length === 1
      && value.items.filter((item) => item.kind === 'text').length === 1
      && value.fingerprint === exportInitial.fingerprint,
  );

  assertCondition(
    exportLayoutIsLegal(exportReset)
    && exportReset.hasLayerControl === false
    && JSON.stringify(exportReset.actions) === JSON.stringify(['取消', '保存图片'])
    && JSON.stringify(canonicalExportEditorState(exportReset))
    === JSON.stringify(initialExportCanonical),
    'Reset did not restore the canonical export layout: ' + JSON.stringify({
      initial: initialExportCanonical,
      reset: canonicalExportEditorState(exportReset),
    }),
  );

  checks.exportEditorReset = exportReset;

  await screenshot(client, '06-export-editor-reset.png');

  assertCondition(
    await evaluate(client, clickButtonInExpression('.export-actions', '取消')),
    'Export cancel button missing.',
  );

  await waitForValue(client, `!document.querySelector('[data-testid="export-dialog"]')`, Boolean);

  checks.exportRendererErrors = rendererErrorEvents(client).slice(rendererErrorCountBeforeExport);

  assertCondition(
    checks.exportRendererErrors.length === 0,
    `Renderer errors were emitted by the export workflow: ${JSON.stringify(checks.exportRendererErrors)}`,
  );

}
