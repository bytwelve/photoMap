import { assertCondition, delay } from '../lib/utils.mjs';
import { evaluate, waitForValue, screenshot } from '../lib/cdp.mjs';
import { clickButtonExpression, setAnnotationBatchModeExpression } from '../lib/ui.mjs';

export async function runPostcardGestures(context) {
  let { client } = context;
  assertCondition(await evaluate(client, clickButtonExpression('批注模式')), 'Annotation mode button missing.');

  await waitForValue(client, `Boolean(document.querySelector('[data-testid="annotation-mode-button"]'))`, Boolean);

  assertCondition(
    await evaluate(client, setAnnotationBatchModeExpression(false)),
    'Annotation batch button could not open the postcard page.',
  );

  await waitForValue(
    client,
    `Boolean(document.querySelector('[data-testid="memory-view"] [data-testid="postcard-current"]'))`,
    Boolean,
  );

  await waitForValue(
    client,
    `(() => {
        const cards = [
          document.querySelector('[data-testid="postcard-next"]'),
          document.querySelector('[data-testid="postcard-after-next"]')
        ];
        return cards.every((card) => {
          const image = card?.querySelector('img');
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
        });
      })()`,
    Boolean,
  );

  const postcardBeforeWheel = await evaluate(client, `(() => {
      const view = document.querySelector('[data-testid="memory-view"]');
      const card = view?.querySelector('[data-testid="postcard-current"]');
      const nextCard = view?.querySelector('[data-testid="postcard-next"]');
      const afterNextCard = view?.querySelector('[data-testid="postcard-after-next"]');
      const note = card?.querySelector('[data-testid="postcard-note"]');
      const modeButton = view?.querySelector('[data-testid="annotation-mode-button"]');
      const stage = view?.querySelector('[data-testid="postcard-stage"]');
      const mailbox = view?.querySelector('[data-testid="postcard-mailbox"]');
      const artFrame = mailbox?.querySelector('.postcard-mailbox-art-frame');
      const art = view?.querySelector('[data-testid="postcard-mailbox-art"]');
      const slot = view?.querySelector('[data-testid="postcard-mailbox-slot"]');
      const deck = view?.querySelector('.postcard-deck');
      const guide = view?.querySelector('.postcard-guide-forward');
      const toolbar = view?.querySelector('.postcard-toolbar');
      const stageControls = stage?.querySelector('[data-testid="postcard-stage-controls"]');
      const counter = stageControls?.querySelector('.postcard-counter');
      const autoControls = stageControls?.querySelector('.auto-scroll-controls');
      const autoButton = stageControls?.querySelector('[data-testid="auto-scroll-toggle"]');
      const speedControl = stageControls?.querySelector('.auto-speed-control');
      const speedRange = stageControls?.querySelector('[aria-label="自动滚动速度"]');
      const speedOutput = speedControl?.querySelector('output');
      const rect = (element) => element instanceof Element ? element.getBoundingClientRect() : null;
      const stageRect = rect(stage);
      const mailboxRect = rect(mailbox);
      const frameRect = rect(artFrame);
      const artRect = rect(art);
      const slotRect = rect(slot);
      const deckRect = rect(deck);
      const stageControlsRect = rect(stageControls);
      const counterRect = rect(counter);
      const autoControlsRect = rect(autoControls);
      const autoButtonRect = rect(autoButton);
      const speedControlRect = rect(speedControl);
      const speedRangeRect = rect(speedRange);
      const speedOutputRect = rect(speedOutput);
      const imageReady = (preview) => {
        const image = preview?.querySelector('img');
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
      };
      let pathEndDistance = null;
      if (guide instanceof SVGGeometryElement && stageRect && slotRect) {
        const end = guide.getPointAtLength(guide.getTotalLength());
        const slotCenter = {
          x: slotRect.left - stageRect.left + slotRect.width / 2,
          y: slotRect.top - stageRect.top + slotRect.height / 2
        };
        pathEndDistance = Math.hypot(end.x - slotCenter.x, end.y - slotCenter.y);
      }
      return {
        currentPhotoId: card?.getAttribute('data-photo-id') ?? '',
        nextPhotoId: nextCard?.getAttribute('data-photo-id') ?? '',
        afterNextPhotoId: afterNextCard?.getAttribute('data-photo-id') ?? '',
        nextImageReady: imageReady(nextCard),
        afterNextImageReady: imageReady(afterNextCard),
        currentName: card?.querySelector('.postcard-basics strong')?.textContent?.trim() ?? '',
        counter: view?.querySelector('.postcard-counter')?.textContent?.trim() ?? '',
        batchButtonPressed: modeButton instanceof HTMLButtonElement ? modeButton.getAttribute('aria-pressed') === 'true' : null,
        noteMaxLength: note instanceof HTMLTextAreaElement ? note.maxLength : null,
        autoScrollAvailable: Boolean(view?.querySelector('[data-testid="auto-scroll-toggle"]')),
        navigationButtonCount: view?.querySelectorAll('.memory-arrow, button[aria-label="上一张"], button[aria-label="下一张"]').length ?? -1,
        floatingMotionStatusCount: view?.querySelectorAll('.postcard-motion-status').length ?? -1,
        stageControlsLayout: stageRect && deckRect && mailboxRect && stageControlsRect && counterRect
          && autoControlsRect && autoButtonRect && speedControlRect && speedRangeRect && speedOutputRect ? {
          compact: matchMedia('(max-width: 1320px)').matches,
          short: matchMedia('(max-height: 820px)').matches,
          stageControlCount: stage?.querySelectorAll('[data-testid="postcard-stage-controls"]').length ?? -1,
          toolbarAutoControlCount: toolbar?.querySelectorAll('.auto-scroll-controls').length ?? -1,
          directStageChild: stageControls?.parentElement === stage,
          width: stageControlsRect.width,
          height: stageControlsRect.height,
          leftAlignmentError: Math.abs(stageControlsRect.left - deckRect.left),
          deckGap: deckRect.top - stageControlsRect.bottom,
          insideStage: stageControlsRect.left >= stageRect.left
            && stageControlsRect.top >= stageRect.top
            && stageControlsRect.right <= stageRect.right
            && stageControlsRect.bottom <= stageRect.bottom,
          counterBeforeAuto: counterRect.right <= autoControlsRect.left + 1,
          verticalCenterError: Math.abs(
            (counterRect.top + counterRect.height / 2) - (autoButtonRect.top + autoButtonRect.height / 2)
          ),
          mailboxOverlap: stageControlsRect.right > mailboxRect.left
            && stageControlsRect.left < mailboxRect.right
            && stageControlsRect.bottom > mailboxRect.top
            && stageControlsRect.top < mailboxRect.bottom,
          buttonWidth: autoButtonRect.width,
          rangeWidth: speedRangeRect.width,
          outputWidth: speedOutputRect.width,
          speedControlAfterButton: speedControlRect.left >= autoButtonRect.right
        } : null,
        mailboxGeometry: stageRect && mailboxRect && frameRect && artRect && slotRect && deckRect ? {
          compact: matchMedia('(max-width: 1320px)').matches,
          heightRatio: mailboxRect.height / stageRect.height,
          aspectRatio: mailboxRect.width / mailboxRect.height,
          topRatio: (mailboxRect.top - stageRect.top) / stageRect.height,
          rightRatio: (stageRect.right - mailboxRect.right) / stageRect.width,
          frameWidthRatio: frameRect.width / mailboxRect.width,
          artHeightRatio: artRect.height / mailboxRect.height,
          artAspectRatio: artRect.width / artRect.height,
          artToMailboxWidthRatio: artRect.width / mailboxRect.width,
          slotWidthRatio: slotRect.width / frameRect.width,
          slotHeightRatio: slotRect.height / frameRect.height,
          slotLeftRatio: (slotRect.left - frameRect.left) / frameRect.width,
          slotTopRatio: (slotRect.top - frameRect.top) / frameRect.height,
          pathEndDistance,
          mailboxZ: Number(getComputedStyle(mailbox).zIndex),
          deckZ: Number(getComputedStyle(deck).zIndex),
          deckTransformStyle: getComputedStyle(deck).transformStyle,
          cardTransformStyle: card instanceof HTMLElement ? getComputedStyle(card).transformStyle : null,
          slotAfterContent: getComputedStyle(slot, '::after').content
        } : null
      };
    })()`);

  const mailboxGeometry = postcardBeforeWheel.mailboxGeometry;

  const stageControlsLayout = postcardBeforeWheel.stageControlsLayout;

  const expectedMailboxHeight = mailboxGeometry?.compact ? 0.56 : 0.68;

  const expectedMailboxTop = mailboxGeometry?.compact ? 0.198 : 0.24;

  const expectedMailboxRight = mailboxGeometry?.compact ? 0.035 : 0.08;

  assertCondition(
    postcardBeforeWheel.currentPhotoId
    && postcardBeforeWheel.nextPhotoId
    && postcardBeforeWheel.afterNextPhotoId
    && postcardBeforeWheel.nextImageReady
    && postcardBeforeWheel.afterNextImageReady
    && postcardBeforeWheel.currentName
    && postcardBeforeWheel.counter
    && postcardBeforeWheel.batchButtonPressed === false
    && postcardBeforeWheel.noteMaxLength === 60
    && postcardBeforeWheel.autoScrollAvailable
    && postcardBeforeWheel.navigationButtonCount === 0
    && postcardBeforeWheel.floatingMotionStatusCount === 0
    && stageControlsLayout
    && stageControlsLayout.stageControlCount === 1
    && stageControlsLayout.toolbarAutoControlCount === 0
    && stageControlsLayout.directStageChild
    && stageControlsLayout.insideStage
    && Math.abs(stageControlsLayout.width - (stageControlsLayout.compact ? 480 : 520)) <= 2
    && Math.abs(stageControlsLayout.height - (stageControlsLayout.short ? 46 : 56)) <= 2
    && stageControlsLayout.leftAlignmentError <= 2
    && stageControlsLayout.deckGap >= 4
    && stageControlsLayout.deckGap <= 12
    && stageControlsLayout.counterBeforeAuto
    && stageControlsLayout.verticalCenterError <= 2
    && !stageControlsLayout.mailboxOverlap
    && stageControlsLayout.buttonWidth >= 94
    && stageControlsLayout.rangeWidth >= 58
    && stageControlsLayout.outputWidth >= 46
    && stageControlsLayout.speedControlAfterButton
    && mailboxGeometry
    && Math.abs(mailboxGeometry.heightRatio - expectedMailboxHeight) <= 0.015
    && Math.abs(mailboxGeometry.aspectRatio - 0.375) <= 0.01
    && Math.abs(mailboxGeometry.topRatio - expectedMailboxTop) <= 0.015
    && Math.abs(mailboxGeometry.rightRatio - expectedMailboxRight) <= 0.015
    && Math.abs(mailboxGeometry.frameWidthRatio - 0.92) <= 0.015
    && Math.abs(mailboxGeometry.artHeightRatio - 1) <= 0.015
    && Math.abs(mailboxGeometry.artAspectRatio - (941 / 1672)) <= 0.015
    && mailboxGeometry.artToMailboxWidthRatio >= 1.45
    && Math.abs(mailboxGeometry.slotWidthRatio - 0.474) <= 0.015
    && Math.abs(mailboxGeometry.slotHeightRatio - 0.036) <= 0.008
    && Math.abs(mailboxGeometry.slotLeftRatio - 0.123) <= 0.015
    && Math.abs(mailboxGeometry.slotTopRatio - 0.094) <= 0.012
    && mailboxGeometry.pathEndDistance <= 3
    && mailboxGeometry.mailboxZ > mailboxGeometry.deckZ
    && mailboxGeometry.deckTransformStyle === 'flat'
    && mailboxGeometry.cardTransformStyle === 'flat'
    && mailboxGeometry.slotAfterContent === 'none',
    `Postcard page was not initialized before wheel: ${JSON.stringify(postcardBeforeWheel)}`,
  );

  await screenshot(client, '03-stage-controls.png');

  const postcardNote = 'E2E 明信片备注：按时间翻阅';

  assertCondition(
    await evaluate(client, `(() => {
        const note = document.querySelector('[data-testid="memory-view"] [data-testid="postcard-note"]');
        if (!(note instanceof HTMLTextAreaElement) || note.disabled) return false;
        note.focus();
        note.select();
        return document.activeElement === note;
      })()`),
    'Postcard note could not receive real keyboard input.',
  );

  await client.send('Input.insertText', { text: postcardNote });

  const pendingNoteWheel = await evaluate(client, `(async () => {
      const view = document.querySelector('[data-testid="memory-view"]');
      const note = view?.querySelector('[data-testid="postcard-note"]');
      if (!(view instanceof HTMLElement) || !(note instanceof HTMLTextAreaElement)) return null;
      const pendingDeadline = performance.now() + 320;
      let statusBeforeWheel = '';
      let pendingBeforeWheel = false;
      do {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const saveState = view.querySelector('[data-testid="postcard-current"] .postcard-save-state');
        statusBeforeWheel = saveState?.textContent?.trim() ?? '';
        pendingBeforeWheel = saveState?.classList.contains('pending') === true
          && statusBeforeWheel.includes('稍后自动保存');
      } while (!pendingBeforeWheel && performance.now() < pendingDeadline);
      const stage = view.querySelector('[data-testid="postcard-stage"]');
      const progressBeforeWheel = stage instanceof HTMLElement ? Number(stage.dataset.motionProgress) : 0;
      const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      view.dispatchEvent(wheel);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const progressAfterWheel = stage instanceof HTMLElement ? Number(stage.dataset.motionProgress) : 0;
      const flight = view.querySelector('[data-testid="postcard-flight-layer"]');
      return {
        editedValue: note.value,
        pendingBeforeWheel,
        statusBeforeWheel,
        wheelDefaultPrevented: wheel.defaultPrevented,
        wheelHandled: stage?.classList.contains('is-gesturing') === true
          && progressAfterWheel > progressBeforeWheel
          && flight?.getAttribute('data-flight-direction') === 'posting'
      };
    })()`);

  assertCondition(
    pendingNoteWheel?.editedValue === postcardNote
    && pendingNoteWheel.pendingBeforeWheel === true
    && pendingNoteWheel.wheelHandled === true,
    `Postcard note was not demonstrably pending when the same renderer task dispatched wheel: ${JSON.stringify(pendingNoteWheel)}`,
  );

  const forwardHandoff = await waitForValue(
    client,
    `(() => {
        const stage = document.querySelector('[data-testid="postcard-stage"]');
        const deck = document.querySelector('.postcard-deck');
        const current = document.querySelector('[data-testid="postcard-current"]');
        const next = document.querySelector('[data-testid="postcard-next"]');
        const afterNext = document.querySelector('[data-testid="postcard-after-next"]');
        const flight = document.querySelector('[data-testid="postcard-flight-layer"]');
        const imageReady = (preview) => {
          const image = preview?.querySelector('img');
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
        };
        if (!(stage instanceof HTMLElement) || !(deck instanceof HTMLElement)
          || !(current instanceof HTMLElement) || !(next instanceof HTMLElement)
          || !(afterNext instanceof HTMLElement) || !(flight instanceof HTMLElement)) return null;
        return {
          progress: Number(stage.dataset.motionProgress),
          settling: stage.classList.contains('is-settling'),
          currentPhotoId: current.dataset.photoId ?? '',
          nextPhotoId: next.dataset.photoId ?? '',
          afterNextPhotoId: afterNext.dataset.photoId ?? '',
          nextImageReady: imageReady(next),
          afterNextImageReady: imageReady(afterNext),
          currentVisibility: getComputedStyle(current).visibility,
          nextOpacity: Number(getComputedStyle(next).opacity),
          afterNextOpacity: Number(getComputedStyle(afterNext).opacity),
          deckZ: Number(getComputedStyle(deck).zIndex),
          flightZ: Number(getComputedStyle(flight).zIndex),
          deckTransformStyle: getComputedStyle(deck).transformStyle,
          flightTransformStyle: getComputedStyle(flight).transformStyle,
          flightDirection: flight.dataset.flightDirection ?? ''
        };
      })()`,
    (value) => value?.settling && value.progress >= 0.68 && value.progress <= 0.84,
    3_000,
    24,
  );

  assertCondition(
    forwardHandoff.currentPhotoId === postcardBeforeWheel.currentPhotoId
    && forwardHandoff.nextPhotoId === postcardBeforeWheel.nextPhotoId
    && forwardHandoff.afterNextPhotoId === postcardBeforeWheel.afterNextPhotoId
    && forwardHandoff.nextImageReady
    && forwardHandoff.afterNextImageReady
    && forwardHandoff.currentVisibility === 'hidden'
    && forwardHandoff.afterNextOpacity > 0
    && forwardHandoff.flightDirection === 'posting'
    && forwardHandoff.flightZ < forwardHandoff.deckZ
    && forwardHandoff.deckTransformStyle === 'flat'
    && forwardHandoff.flightTransformStyle === 'flat',
    `Forward postcard handoff did not preload and layer the second lookahead: ${JSON.stringify(forwardHandoff)}`,
  );

  await screenshot(client, '03aa-postcard-forward-handoff.png');

  const postcardAfterWheel = await waitForValue(
    client,
    `(() => {
        const view = document.querySelector('[data-testid="memory-view"]');
        const card = view?.querySelector('[data-testid="postcard-current"]');
        const next = view?.querySelector('[data-testid="postcard-next"]');
        const afterNext = view?.querySelector('[data-testid="postcard-after-next"]');
        const note = card?.querySelector('[data-testid="postcard-note"]');
        const modeButton = view?.querySelector('[data-testid="annotation-mode-button"]');
        return {
          currentPhotoId: card?.getAttribute('data-photo-id') ?? '',
          nextPhotoId: next?.getAttribute('data-photo-id') ?? '',
          afterNextPhotoId: afterNext?.getAttribute('data-photo-id') ?? '',
          currentName: card?.querySelector('.postcard-basics strong')?.textContent?.trim() ?? '',
          counter: view?.querySelector('.postcard-counter')?.textContent?.trim() ?? '',
          postcardCount: view?.querySelectorAll('[data-testid="postcard-current"]').length ?? 0,
          currentInert: card?.hasAttribute('inert') ?? null,
          noteDisabled: note instanceof HTMLTextAreaElement ? note.disabled : null,
          batchButtonPressed: modeButton instanceof HTMLButtonElement ? modeButton.getAttribute('aria-pressed') === 'true' : null
        };
      })()`,
    (value) => value?.currentName
      && value.currentName !== postcardBeforeWheel.currentName
      && value.counter !== postcardBeforeWheel.counter
      && value.postcardCount === 1
      && value.currentPhotoId === postcardBeforeWheel.nextPhotoId
      && value.nextPhotoId === postcardBeforeWheel.afterNextPhotoId
      && value.currentInert === false
      && value.noteDisabled === false
      && value.batchButtonPressed === false,
  );

  const persistedPostcardNote = await waitForValue(
    client,
    `window.photoMap.getLibrary().then((result) => result.ok
        ? result.value.photos.find((photo) => photo.photoId === ${JSON.stringify(postcardBeforeWheel.currentPhotoId)})?.note
        : null)`,
    (value) => value === postcardNote,
  );

  const storedPostcardGeometry = await evaluate(client, `(() => {
      const stored = document.querySelector('[data-testid="postcard-previous"]');
      const slot = document.querySelector('[data-testid="postcard-mailbox-slot"]');
      const mailbox = document.querySelector('[data-testid="postcard-mailbox"]');
      const deck = document.querySelector('.postcard-deck');
      if (!(stored instanceof HTMLElement) || !(slot instanceof HTMLElement)
        || !(mailbox instanceof HTMLElement) || !(deck instanceof HTMLElement)) return null;
      const cardRect = stored.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      return {
        centerDistance: Math.hypot(
          cardRect.left + cardRect.width / 2 - (slotRect.left + slotRect.width / 2),
          cardRect.top + cardRect.height / 2 - (slotRect.top + slotRect.height / 2)
        ),
        cardWidth: cardRect.width,
        slotWidth: slotRect.width,
        widthRatio: cardRect.width / slotRect.width,
        opacity: Number(getComputedStyle(stored).opacity),
        mailboxZ: Number(getComputedStyle(mailbox).zIndex),
        deckZ: Number(getComputedStyle(deck).zIndex)
      };
    })()`);

  assertCondition(
    storedPostcardGeometry
    && storedPostcardGeometry.centerDistance <= 4
    && storedPostcardGeometry.widthRatio <= 1.05
    && storedPostcardGeometry.opacity === 0
    && storedPostcardGeometry.mailboxZ > storedPostcardGeometry.deckZ,
    `Stored postcard did not fit completely behind the mailbox slot: ${JSON.stringify(storedPostcardGeometry)}`,
  );

  await delay(320);

  assertCondition(
    await evaluate(client, `(() => {
        const view = document.querySelector('[data-testid="memory-view"]');
        if (!(view instanceof HTMLElement)) return false;
        view.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
        return true;
      })()`),
    'Postcard view was unavailable for reverse wheel interaction.',
  );

  const retrievalMidpoint = await waitForValue(
    client,
    `(() => {
        const stage = document.querySelector('[data-testid="postcard-stage"]');
        const flight = document.querySelector('[data-testid="postcard-flight-layer"]');
        const card = flight?.querySelector('[data-testid="postcard-flight"]');
        const mailbox = document.querySelector('[data-testid="postcard-mailbox"]');
        const deck = document.querySelector('.postcard-deck');
        if (!(stage instanceof HTMLElement) || !(card instanceof HTMLElement)
          || !(flight instanceof HTMLElement) || !(mailbox instanceof HTMLElement)
          || !(deck instanceof HTMLElement)) return null;
        const progress = Number(stage.dataset.motionProgress);
        const cardRect = card.getBoundingClientRect();
        const mailboxRect = mailbox.getBoundingClientRect();
        return {
          progress,
          retrieving: stage.classList.contains('is-retrieving'),
          flightDirection: flight.dataset.flightDirection ?? '',
          flightOpacity: Number(getComputedStyle(flight).opacity),
          intersectsMailbox: cardRect.right > mailboxRect.left && cardRect.left < mailboxRect.right
            && cardRect.bottom > mailboxRect.top && cardRect.top < mailboxRect.bottom,
          mailboxZ: Number(getComputedStyle(mailbox).zIndex),
          flightZ: Number(getComputedStyle(flight).zIndex),
          deckZ: Number(getComputedStyle(deck).zIndex),
          deckTransformStyle: getComputedStyle(deck).transformStyle,
          flightTransformStyle: getComputedStyle(flight).transformStyle
        };
      })()`,
    (value) => value?.retrieving
      && value.flightDirection === 'retrieving'
      && value.progress <= -0.62
      && value.progress >= -0.88
      && value.flightOpacity > 0,
    3_000,
    24,
  );

  assertCondition(
    retrievalMidpoint.mailboxZ > retrievalMidpoint.flightZ
    && retrievalMidpoint.flightZ > retrievalMidpoint.deckZ
    && retrievalMidpoint.deckTransformStyle === 'flat'
    && retrievalMidpoint.flightTransformStyle === 'flat',
    `Retrieving postcard was not isolated above the deck and behind the mailbox: ${JSON.stringify(retrievalMidpoint)}`,
  );

  await screenshot(client, '03a-postcard-retrieval-midpoint.png');
  Object.assign(context, { postcardBeforeWheel, postcardNote, pendingNoteWheel, forwardHandoff, postcardAfterWheel, persistedPostcardNote, storedPostcardGeometry, retrievalMidpoint });
}
