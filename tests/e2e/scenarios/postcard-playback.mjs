import { waitForValue, evaluate, screenshot } from '../lib/cdp.mjs';
import { assertCondition } from '../lib/utils.mjs';
import { setInputValueExpression, clickTestIdWithMouse } from '../lib/ui.mjs';

export async function runPostcardPlayback(context) {
  let { checks, client, postcardBeforeWheel, postcardNote, pendingNoteWheel, forwardHandoff, postcardAfterWheel, persistedPostcardNote, storedPostcardGeometry, retrievalMidpoint } = context;
  const restoredPostcard = await waitForValue(
    client,
    `(() => {
        const card = document.querySelector('[data-testid="postcard-current"]');
        const note = card?.querySelector('[data-testid="postcard-note"]');
        return {
          currentPhotoId: card?.getAttribute('data-photo-id') ?? '',
          note: note instanceof HTMLTextAreaElement ? note.value : null
        };
      })()`,
    (value) => value?.currentPhotoId === postcardBeforeWheel.currentPhotoId && value.note === postcardNote,
  );

  const autoScrollStartTransform = await evaluate(
    client,
    `document.querySelector('[data-testid="postcard-current"]')?.style.transform ?? ''`,
  );

  assertCondition(
    await evaluate(client, setInputValueExpression('[aria-label="自动滚动速度"]', '2')),
    'Automatic postcard speed could not be set.',
  );

  // ArrowRight advances one card; the playback control starts continuous scrolling.
  await clickTestIdWithMouse(client, 'auto-scroll-toggle');

  const autoScrollInFlight = await waitForValue(
    client,
    `(() => {
        const card = document.querySelector('[data-testid="postcard-current"]');
        const flight = document.querySelector('[data-testid="postcard-flight-layer"]');
        const next = document.querySelector('[data-testid="postcard-next"]');
        const afterNext = document.querySelector('[data-testid="postcard-after-next"]');
        const button = document.querySelector('[data-testid="auto-scroll-toggle"]');
        const speed = document.querySelector('.auto-speed-control output');
        const stage = document.querySelector('[data-testid="postcard-stage"]');
        const mailbox = document.querySelector('[data-testid="postcard-mailbox"]');
        const deck = document.querySelector('.postcard-deck');
        const imageReady = (preview) => {
          const image = preview?.querySelector('img');
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
        };
        return {
          transform: flight instanceof HTMLElement ? flight.style.transform : '',
          flightDirection: flight instanceof HTMLElement ? flight.dataset.flightDirection ?? '' : '',
          currentVisibility: card instanceof HTMLElement ? getComputedStyle(card).visibility : null,
          nextPhotoId: next?.getAttribute('data-photo-id') ?? '',
          afterNextPhotoId: afterNext?.getAttribute('data-photo-id') ?? '',
          nextImageReady: imageReady(next),
          afterNextImageReady: imageReady(afterNext),
          afterNextOpacity: afterNext instanceof HTMLElement ? Number(getComputedStyle(afterNext).opacity) : null,
          buttonLabel: button?.textContent?.trim() ?? '',
          speed: speed?.textContent?.trim() ?? '',
          progress: stage instanceof HTMLElement ? Number(stage.dataset.motionProgress) : null,
          posting: stage?.classList.contains('is-auto-scrolling') === true && stage.classList.contains('is-posting'),
          mailboxZ: mailbox instanceof HTMLElement ? Number(getComputedStyle(mailbox).zIndex) : null,
          flightZ: flight instanceof HTMLElement ? Number(getComputedStyle(flight).zIndex) : null,
          deckZ: deck instanceof HTMLElement ? Number(getComputedStyle(deck).zIndex) : null,
          deckTransformStyle: deck instanceof HTMLElement ? getComputedStyle(deck).transformStyle : null,
          flightTransformStyle: flight instanceof HTMLElement ? getComputedStyle(flight).transformStyle : null
        };
      })()`,
    (value) => value?.transform.includes('translate3d')
      && value.transform !== autoScrollStartTransform
      && value.posting
      && value.progress >= 0.76
      && value.progress <= 0.9
      && value.afterNextOpacity > 0
      && value.buttonLabel === '暂停滚动'
      && value.speed === '2.0×',
    5_000,
    24,
  );

  assertCondition(
    autoScrollInFlight.currentVisibility === 'hidden'
    && autoScrollInFlight.flightDirection === 'posting'
    && autoScrollInFlight.nextPhotoId === postcardBeforeWheel.nextPhotoId
    && autoScrollInFlight.afterNextPhotoId === postcardBeforeWheel.afterNextPhotoId
    && autoScrollInFlight.nextImageReady
    && autoScrollInFlight.afterNextImageReady
    && autoScrollInFlight.mailboxZ > autoScrollInFlight.deckZ
    && autoScrollInFlight.flightZ < autoScrollInFlight.deckZ
    && autoScrollInFlight.deckTransformStyle === 'flat'
    && autoScrollInFlight.flightTransformStyle === 'flat',
    `Automatically posted postcard was not isolated behind the incoming queue and mailbox: ${JSON.stringify(autoScrollInFlight)}`,
  );

  await screenshot(client, '03b-postcard-auto-delivery-midpoint.png');

  await clickTestIdWithMouse(client, 'auto-scroll-toggle');

  const stageControlPause = await waitForValue(
    client,
    `(() => {
        const stage = document.querySelector('[data-testid="postcard-stage"]');
        const controls = stage?.querySelector('[data-testid="postcard-stage-controls"]');
        const button = controls?.querySelector('[data-testid="auto-scroll-toggle"]');
        return {
          directStageChild: controls?.parentElement === stage,
          buttonLabel: button?.textContent?.trim() ?? '',
          autoScrolling: stage?.classList.contains('is-auto-scrolling') === true,
          counter: controls?.querySelector('.postcard-counter')?.textContent?.trim() ?? ''
        };
      })()`,
    (value) => value?.buttonLabel === '继续滚动' && !value.autoScrolling,
    3_000,
    32,
  );

  assertCondition(
    stageControlPause.directStageChild && stageControlPause.counter,
    `Moved automatic scroll controls did not handle a real pointer click independently: ${JSON.stringify(stageControlPause)}`,
  );

  const postcardAfterAutoScroll = await waitForValue(
    client,
    `(() => {
        const card = document.querySelector('[data-testid="postcard-current"]');
        return {
          currentPhotoId: card?.getAttribute('data-photo-id') ?? '',
          counter: document.querySelector('.postcard-counter')?.textContent?.trim() ?? ''
        };
      })()`,
    (value) => value?.currentPhotoId && value.currentPhotoId !== postcardBeforeWheel.currentPhotoId,
    10_000,
  );

  await screenshot(client, '03-memory-view.png');

  const postcardSequenceStateExpression = `(() => {
      const view = document.querySelector('[data-testid="memory-view"]');
      const stage = view?.querySelector('[data-testid="postcard-stage"]');
      const controls = stage?.querySelector('[data-testid="postcard-stage-controls"]');
      const counter = controls?.querySelector('.postcard-counter');
      const card = view?.querySelector('[data-testid="postcard-current"]');
      const totalText = counter?.querySelector('span:last-child')?.textContent ?? '';
      return {
        currentPhotoId: card?.getAttribute('data-photo-id') ?? '',
        currentPosition: Number(counter?.querySelector('b')?.textContent ?? NaN),
        total: Number(totalText.replace('/', '').replace('张', '').trim()),
        buttonLabel: controls?.querySelector('[data-testid="auto-scroll-toggle"]')?.textContent?.trim() ?? '',
        settling: stage?.classList.contains('is-settling') === true,
        nextCount: view?.querySelectorAll('[data-testid="postcard-next"]').length ?? -1,
        afterNextCount: view?.querySelectorAll('[data-testid="postcard-after-next"]').length ?? -1
      };
    })()`;

  let postcardBeforeFinalDelivery = await evaluate(client, postcardSequenceStateExpression);

  assertCondition(
    postcardBeforeFinalDelivery.currentPhotoId
    && Number.isInteger(postcardBeforeFinalDelivery.currentPosition)
    && Number.isInteger(postcardBeforeFinalDelivery.total)
    && postcardBeforeFinalDelivery.currentPosition >= 1
    && postcardBeforeFinalDelivery.currentPosition <= postcardBeforeFinalDelivery.total,
    `Postcard sequence state was invalid before reaching the last card: ${JSON.stringify(postcardBeforeFinalDelivery)}`,
  );

  assertCondition(
    await evaluate(client, `(() => {
        const view = document.querySelector('[data-testid="memory-view"]');
        if (!(view instanceof HTMLElement)) return false;
        view.focus();
        return document.activeElement === view;
      })()`),
    'Postcard view could not receive real keyboard navigation before final delivery.',
  );

  for (
    let position = postcardBeforeFinalDelivery.currentPosition;
    position < postcardBeforeFinalDelivery.total;
    position += 1
  ) {
    const previousPhotoId = postcardBeforeFinalDelivery.currentPhotoId;
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39,
    });
    postcardBeforeFinalDelivery = await waitForValue(
      client,
      postcardSequenceStateExpression,
      (value) => value?.currentPosition === position + 1
        && value.currentPhotoId
        && value.currentPhotoId !== previousPhotoId
        && value.settling === false,
      3_000,
      24,
    );
  }

  assertCondition(
    postcardBeforeFinalDelivery.currentPosition === postcardBeforeFinalDelivery.total
    && postcardBeforeFinalDelivery.buttonLabel === '投递最后一张'
    && postcardBeforeFinalDelivery.nextCount === 0
    && postcardBeforeFinalDelivery.afterNextCount === 0,
    `The last postcard was not ready for a real delivery: ${JSON.stringify(postcardBeforeFinalDelivery)}`,
  );

  await clickTestIdWithMouse(client, 'auto-scroll-toggle');

  const finalDeliveryInFlight = await waitForValue(
    client,
    `(() => {
        const stage = document.querySelector('[data-testid="postcard-stage"]');
        const current = document.querySelector('[data-testid="postcard-current"]');
        const flightLayer = document.querySelector('[data-testid="postcard-flight-layer"]');
        const flight = flightLayer?.querySelector('[data-testid="postcard-flight"]');
        return {
          currentPhotoId: current?.getAttribute('data-photo-id') ?? '',
          flightPhotoId: flight?.getAttribute('data-photo-id') ?? '',
          progress: stage instanceof HTMLElement ? Number(stage.dataset.motionProgress) : null,
          posting: stage?.classList.contains('is-posting') === true,
          autoScrolling: stage?.classList.contains('is-auto-scrolling') === true,
          flightDirection: flightLayer?.getAttribute('data-flight-direction') ?? '',
          currentVisibility: current instanceof HTMLElement ? getComputedStyle(current).visibility : null
        };
      })()`,
    (value) => value?.posting
      && value.autoScrolling
      && value.flightDirection === 'posting'
      && value.progress >= 0.62
      && value.progress <= 0.88,
    5_000,
    24,
  );

  assertCondition(
    finalDeliveryInFlight.currentPhotoId === postcardBeforeFinalDelivery.currentPhotoId
    && finalDeliveryInFlight.flightPhotoId === postcardBeforeFinalDelivery.currentPhotoId
    && finalDeliveryInFlight.currentVisibility === 'hidden',
    `The last postcard did not use the posting flight layer: ${JSON.stringify(finalDeliveryInFlight)}`,
  );

  const postcardDeliveryComplete = await waitForValue(
    client,
    `(() => {
        const view = document.querySelector('[data-testid="memory-view"]');
        const completion = view?.querySelector('[data-testid="postcard-completion"]');
        const previews = [...(completion?.querySelectorAll('.postcard-completion-preview') ?? [])];
        const buttons = [...(completion?.querySelectorAll('button') ?? [])];
        const imageReady = (preview) => {
          const image = preview.querySelector('img');
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
        };
        return {
          title: completion?.querySelector('h1')?.textContent?.trim() ?? '',
          total: Number(completion?.querySelector('.postcard-completion-copy strong')?.textContent ?? NaN),
          viewLabel: view?.getAttribute('aria-label') ?? '',
          status: completion?.querySelector('[role="status"]')?.textContent?.trim() ?? '',
          previewCount: previews.length,
          previewPhotoIds: previews.map((preview) => preview.getAttribute('data-photo-id') ?? ''),
          previewReadyCount: previews.filter(imageReady).length,
          currentCount: view?.querySelectorAll('[data-testid="postcard-current"]').length ?? -1,
          stageCount: view?.querySelectorAll('[data-testid="postcard-stage"]').length ?? -1,
          stageControlCount: view?.querySelectorAll('[data-testid="postcard-stage-controls"]').length ?? -1,
          buttonCount: buttons.length,
          reviewLabel: completion?.querySelector('[data-testid="postcard-completion-review"]')?.textContent?.trim() ?? '',
          continueLabel: completion?.querySelector('[data-testid="postcard-completion-continue"]')?.textContent?.trim() ?? ''
        };
      })()`,
    (value) => value?.title === '投递完成，回忆已装订'
      && value.total === postcardBeforeFinalDelivery.total
      && value.previewCount === Math.min(postcardBeforeFinalDelivery.total, 2)
      && value.previewReadyCount === value.previewCount,
    5_000,
    24,
  );

  assertCondition(
    postcardDeliveryComplete.viewLabel.includes(`共 ${postcardBeforeFinalDelivery.total} 张`)
    && postcardDeliveryComplete.status.includes(`已投递 ${postcardBeforeFinalDelivery.total} 张明信片`)
    && postcardDeliveryComplete.previewCount <= 2
    && postcardDeliveryComplete.previewPhotoIds.every(Boolean)
    && new Set(postcardDeliveryComplete.previewPhotoIds).size === postcardDeliveryComplete.previewCount
    && postcardDeliveryComplete.currentCount === 0
    && postcardDeliveryComplete.stageCount === 0
    && postcardDeliveryComplete.stageControlCount === 0
    && postcardDeliveryComplete.buttonCount === 2
    && postcardDeliveryComplete.reviewLabel === '翻阅这组明信片'
    && postcardDeliveryComplete.continueLabel === '继续整理照片',
    `Postcard delivery completion page was incomplete: ${JSON.stringify(postcardDeliveryComplete)}`,
  );

  await screenshot(client, '03c-postcard-delivery-complete.png');

  await clickTestIdWithMouse(client, 'postcard-completion-review');

  const postcardReviewReturn = await waitForValue(
    client,
    `(() => {
        const view = document.querySelector('[data-testid="memory-view"]');
        const card = view?.querySelector('[data-testid="postcard-current"]');
        const controls = view?.querySelector('[data-testid="postcard-stage-controls"]');
        return {
          currentPhotoId: card?.getAttribute('data-photo-id') ?? '',
          currentPosition: Number(controls?.querySelector('.postcard-counter b')?.textContent ?? NaN),
          completionCount: view?.querySelectorAll('[data-testid="postcard-completion"]').length ?? -1,
          stageControlCount: view?.querySelectorAll('[data-testid="postcard-stage-controls"]').length ?? -1,
          batchButtonPressed: view?.querySelector('[data-testid="annotation-mode-button"]')?.getAttribute('aria-pressed') === 'true'
        };
      })()`,
    (value) => value?.currentPhotoId === postcardBeforeWheel.currentPhotoId
      && value.currentPosition === 1
      && value.completionCount === 0
      && value.stageControlCount === 1,
    5_000,
    24,
  );

  assertCondition(
    postcardReviewReturn.batchButtonPressed === false,
    `Reviewing completed postcards did not return to the first postcard: ${JSON.stringify(postcardReviewReturn)}`,
  );

  checks.memoryMode = {
    beforeWheel: postcardBeforeWheel,
    pendingNoteWheel,
    forwardHandoff,
    afterWheel: postcardAfterWheel,
    persistedPostcardNote,
    storedPostcardGeometry,
    retrievalMidpoint,
    restoredPostcard,
    autoScrollInFlight,
    stageControlPause,
    afterAutoScroll: postcardAfterAutoScroll,
    beforeFinalDelivery: postcardBeforeFinalDelivery,
    finalDeliveryInFlight,
    deliveryComplete: postcardDeliveryComplete,
    reviewReturn: postcardReviewReturn,
  };

}
