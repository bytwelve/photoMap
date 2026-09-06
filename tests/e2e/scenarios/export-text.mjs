import { delay, assertCondition } from '../lib/utils.mjs';
import { rendererErrorEvents, evaluate, waitForValue, screenshot } from '../lib/cdp.mjs';
import { clickButtonExpression, clickTestIdExpression, setInputValueExpression, clickAriaButtonExpression, clickButtonInExpression } from '../lib/ui.mjs';
import { exportDialogStateExpression, exportLayoutIsLegal, canonicalExportEditorState, exportItem, dragExportControl, dragExportControlByDocumentDelta, exportItemsOverlap } from '../lib/export-ui.mjs';

export async function runExportText(context) {
  let { checks, client } = context;
  await delay(500);

  const rendererErrorCountBeforeExport = rendererErrorEvents(client).length;

  assertCondition(await evaluate(client, clickButtonExpression('导出分享图')), 'Export button missing.');

  const exportInitial = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.renderRevision > 0
      && value.items.filter((item) => item.kind === 'photo').length === 1
      && value.items.filter((item) => item.kind === 'text').length === 1
      && value.textInput === '我的照片地图',
  );

  assertCondition(
    JSON.stringify(exportInitial.actions) === JSON.stringify(['取消', '保存图片'])
    && exportInitial.hasLayerControl === false
    && exportInitial.width === 1600
    && exportInitial.height > 900
    && exportInitial.dataUrlLength >= 10_000
    && exportInitial.selectedItemId === 'text-1'
    && exportInitial.selectedColor === '深墨'
    && exportInitial.selectedWeight === '粗体'
    && exportInitial.colors.length === 5
    && exportInitial.weights.length === 3
    && exportInitial.hasTextControls === true
    && exportInitial.hasPhotoControls === false
    && exportInitial.deleteTextDisabled === false
    && exportInitial.contextToolbar?.itemId === 'text-1'
    && exportInitial.contextToolbar?.itemKind === 'text'
    && exportInitial.contextToolbar?.position === 'absolute'
    && exportInitial.contextToolbar?.insideEditor === true
    && exportInitial.items.find((item) => item.kind === 'photo')?.stackOrder === 0
    && exportInitial.items.find((item) => item.kind === 'text')?.stackOrder === 1
    && exportLayoutIsLegal(exportInitial),
    'Default export editor state was invalid: ' + JSON.stringify(exportInitial),
  );

  const initialExportCanonical = canonicalExportEditorState(exportInitial);

  checks.exportEditorInitial = exportInitial;

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-delete-text')),
    'Default title delete action missing.',
  );

  const exportWithoutDefaultTitle = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.renderRevision > exportInitial.renderRevision
      && value.items.filter((item) => item.kind === 'text').length === 0
      && value.selectedItemId === 'photo'
      && value.hasTextControls === false
      && value.hasPhotoControls === true
      && value.contextToolbar?.itemId === 'photo'
      && value.contextToolbar?.itemKind === 'photo',
  );

  assertCondition(
    exportLayoutIsLegal(exportWithoutDefaultTitle)
    && exportWithoutDefaultTitle.fingerprint !== exportInitial.fingerprint,
    'Deleting the default title did not produce a valid photo-only board: '
    + JSON.stringify(exportWithoutDefaultTitle),
  );

  checks.exportEditorDefaultTitleDeleted = exportWithoutDefaultTitle;

  await screenshot(client, '05-export-default-title-deleted.png');

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-reset')),
    'Export reset action missing after deleting the default title.',
  );

  await waitForValue(
    client,
    `Boolean(document.querySelector('[data-testid="export-reset-confirmation"]'))`,
    Boolean,
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-reset-confirm')),
    'Export reset confirmation missing after deleting the default title.',
  );

  const exportAfterDefaultRestore = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.renderRevision > exportWithoutDefaultTitle.renderRevision
      && value.items.filter((item) => item.kind === 'text').length === 1
      && value.selectedItemId === 'text-1'
      && value.fingerprint === exportInitial.fingerprint,
  );

  assertCondition(
    JSON.stringify(canonicalExportEditorState(exportAfterDefaultRestore))
    === JSON.stringify(initialExportCanonical),
    'Restoring after deleting the default title did not recover the canonical board.',
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-add-text')),
    'First add-text action missing.',
  );

  const exportAfterFirstAdd = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.renderRevision > exportAfterDefaultRestore.renderRevision
      && value.items.filter((item) => item.kind === 'text').length === 2
      && value.textInput === '新文字'
      && value.selectedItemId !== 'text-1',
  );

  assertCondition(
    exportLayoutIsLegal(exportAfterFirstAdd),
    'First added text produced an invalid layout: ' + JSON.stringify(exportAfterFirstAdd),
  );

  assertCondition(
    await evaluate(client, clickTestIdExpression('export-add-text')),
    'Second add-text action missing.',
  );

  const exportAfterAdd = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.renderRevision > exportAfterFirstAdd.renderRevision
      && value.items.filter((item) => item.kind === 'text').length === 3
      && value.textInput === '新文字'
      && value.selectedItemId !== exportAfterFirstAdd.selectedItemId,
  );

  assertCondition(
    exportLayoutIsLegal(exportAfterAdd)
    && exportAfterAdd.fingerprint !== exportInitial.fingerprint,
    'Multiple text creation did not redraw a valid export: ' + JSON.stringify(exportAfterAdd),
  );

  const editedTextId = exportAfterAdd.selectedItemId;

  assertCondition(
    typeof editedTextId === 'string' && exportItem(exportAfterAdd, editedTextId)?.kind === 'text',
    'Newly added text was not selected.',
  );

  assertCondition(
    await evaluate(
      client,
      setInputValueExpression('[data-testid="export-text-input"]', '2026 · 我的旅行足迹'),
    ),
    'Selected export text input missing.',
  );

  const exportAfterContent = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.textInput === '2026 · 我的旅行足迹'
      && value.selectedItemId === editedTextId
      && value.fingerprint !== exportAfterAdd.fingerprint,
  );

  assertCondition(
    await evaluate(client, clickAriaButtonExpression('暖红')),
    'Warm-red text color action missing.',
  );

  assertCondition(
    await evaluate(client, clickButtonInExpression('[data-testid="export-text-weight"]', '粗体')),
    'Bold text action missing.',
  );

  const exportStyled = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => value?.loaded
      && value.renderRevision > exportAfterContent.renderRevision
      && value.textInput === '2026 · 我的旅行足迹'
      && value.selectedColor === '暖红'
      && value.selectedWeight === '粗体'
      && value.fingerprint !== exportAfterContent.fingerprint,
  );

  assertCondition(
    exportLayoutIsLegal(exportStyled),
    'Text styling produced an invalid layout: ' + JSON.stringify(exportStyled),
  );

  const textBeforeMove = exportItem(exportStyled, editedTextId);

  assertCondition(textBeforeMove, 'Selected text geometry missing before drag.');

  await dragExportControl(client, editedTextId, undefined, 18, 0);

  const exportAfterTextMove = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => {
      const item = exportItem(value, editedTextId);
      return value?.loaded
        && value.renderRevision > exportStyled.renderRevision
        && item
        && Math.abs(item.x - textBeforeMove.x) > 1;
    },
  );

  assertCondition(
    exportLayoutIsLegal(exportAfterTextMove),
    'Text drag produced an invalid layout: ' + JSON.stringify(exportAfterTextMove),
  );

  const textBeforeWidthResize = exportItem(exportAfterTextMove, editedTextId);

  assertCondition(textBeforeWidthResize, 'Selected text geometry missing before width resize.');

  await dragExportControl(client, editedTextId, 'e', -18, 0);

  const exportAfterTextWidthResize = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => {
      const item = exportItem(value, editedTextId);
      return value?.loaded
        && value.renderRevision > exportAfterTextMove.renderRevision
        && item
        && Math.abs(item.width - textBeforeWidthResize.width) > 1;
    },
  );

  assertCondition(
    exportLayoutIsLegal(exportAfterTextWidthResize),
    'Text width resize produced an invalid layout: ' + JSON.stringify(exportAfterTextWidthResize),
  );

  const textBeforeHeightResize = exportItem(exportAfterTextWidthResize, editedTextId);

  assertCondition(textBeforeHeightResize, 'Selected text geometry missing before corner resize.');

  await dragExportControl(client, editedTextId, 'se', 0, 8);

  const exportAfterTextHeightResize = await waitForValue(
    client,
    exportDialogStateExpression(),
    (value) => {
      const item = exportItem(value, editedTextId);
      return value?.loaded
        && value.renderRevision > exportAfterTextWidthResize.renderRevision
        && item
        && Math.abs(item.height - textBeforeHeightResize.height) > 1;
    },
  );

  assertCondition(
    exportLayoutIsLegal(exportAfterTextHeightResize),
    'Text corner resize produced an invalid layout: ' + JSON.stringify(exportAfterTextHeightResize),
  );

  const editedBeforeTextCollision = exportItem(exportAfterTextHeightResize, editedTextId);

  assertCondition(editedBeforeTextCollision, 'Edited text collision fixture was missing.');

  const blockingText = exportAfterTextHeightResize.items
    .filter((item) => item.kind === 'text' && item.id !== editedTextId)
    .sort((left, right) => Math.abs(left.y - editedBeforeTextCollision.y)
      - Math.abs(right.y - editedBeforeTextCollision.y))[0];

  assertCondition(blockingText, 'Blocking text collision fixture was missing.');

  await dragExportControlByDocumentDelta(
    client,
    exportAfterTextHeightResize,
    editedTextId,
    undefined,
    blockingText.x + blockingText.width / 2 - editedBeforeTextCollision.x - editedBeforeTextCollision.width / 2,
    blockingText.y + blockingText.height / 2 - editedBeforeTextCollision.y - editedBeforeTextCollision.height / 2,
  );

  await delay(180);

  const exportAfterTextCollision = await evaluate(client, exportDialogStateExpression());

  assertCondition(
    exportLayoutIsLegal(exportAfterTextCollision)
    && !exportItemsOverlap(
      exportItem(exportAfterTextCollision, editedTextId),
      exportItem(exportAfterTextCollision, blockingText.id),
    ),
    'Text-to-text collision was not blocked: ' + JSON.stringify(exportAfterTextCollision),
  );

  let exportSingleText = exportAfterTextCollision;

  for (const removable of exportAfterTextCollision.items.filter(
    (item) => item.kind === 'text' && item.id !== editedTextId,
  )) {
    await dragExportControl(client, removable.id, undefined, 0, 0);
    await waitForValue(
      client,
      exportDialogStateExpression(),
      (value) => value?.selectedItemId === removable.id
        && value.contextToolbar?.itemId === removable.id
        && value.hasTextControls === true,
    );
    assertCondition(
      await evaluate(client, clickTestIdExpression('export-delete-text')),
      `Delete action missing for ${removable.id}.`,
    );
    exportSingleText = await waitForValue(
      client,
      exportDialogStateExpression(),
      (value) => value?.loaded
        && !value.items.some((item) => item.id === removable.id)
        && exportLayoutIsLegal(value),
    );
  }
  Object.assign(context, { rendererErrorCountBeforeExport, exportInitial, initialExportCanonical, editedTextId, exportSingleText });
}
