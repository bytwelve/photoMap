import { evaluate, screenshot, waitForValue } from '../lib/cdp.mjs';
import { clickAriaButtonExpression } from '../lib/ui.mjs';
import { assertCondition } from '../lib/utils.mjs';

export async function runImageRetry({ checks, client, mutation }) {
  const target = await evaluate(client, `(async () => {
    const result = await window.photoMap.getLibrary();
    if (!result.ok) throw new Error(result.error.userMessage);
    const photo = result.value.photos.find(item => item.photoId === ${JSON.stringify(mutation.photoId)});
    return photo ? { fileName: photo.fileName, thumbnailUrl: photo.thumbnailUrl } : null;
  })()`);
  assertCondition(target?.fileName === 'wuhan-yellow-crane-tower.jpg', 'Image recovery must use the bundled Wuhan fixture.');

  // Only the isolated packaged renderer is instrumented. No source file or
  // protocol permission changes are needed to reproduce a temporary failure.
  const injected = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const targetUrl = ${JSON.stringify(target.thumbnailUrl)};
      const NativeImage = window.Image;
      const source = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
      const trackedImages = [];
      const state = { blocked: true, attempts: 0, draws: 0 };
      function ObservedImage(...dimensions) {
        const image = new NativeImage(...dimensions);
        trackedImages.push(image);
        let requestedUrl = '';
        Object.defineProperty(image, 'src', {
          configurable: true,
          get() { return requestedUrl || source.get.call(image); },
          set(value) {
            requestedUrl = String(value);
            if (requestedUrl === targetUrl) {
              state.attempts += 1;
              if (state.blocked) {
                queueMicrotask(() => image.dispatchEvent(new Event('error')));
                return;
              }
            }
            source.set.call(image, value);
          },
        });
        return image;
      }
      Object.setPrototypeOf(ObservedImage, NativeImage);
      ObservedImage.prototype = NativeImage.prototype;
      window.Image = ObservedImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas.matches('[data-testid="wall-canvas"]')
          && args[0] instanceof HTMLImageElement && args[0].src === targetUrl) state.draws += 1;
        return nativeDrawImage.apply(this, args);
      };
      state.cleanup = () => {
        window.Image = NativeImage;
        CanvasRenderingContext2D.prototype.drawImage = nativeDrawImage;
        for (const image of trackedImages) delete image.src;
        delete window.__photoMapImageRetry;
      };
      window.__photoMapImageRetry = state;
    })()`,
  });

  const observation = `(() => {
    const state = window.__photoMapImageRetry;
    const canvas = document.querySelector('[data-testid="wall-canvas"]');
    return state && canvas ? {
      attempts: state.attempts, draws: state.draws,
      snapshotId: canvas.dataset.snapshotId,
      loading: Boolean(document.querySelector('.map-loading')),
    } : null;
  })()`;

  try {
    await client.send('Page.reload', { ignoreCache: true });
    const failed = await waitForValue(client, observation, value => value?.attempts > 0 && !value.loading);
    assertCondition(failed.draws === 0, 'The intentionally unavailable image was unexpectedly painted.');
    assertCondition(typeof failed.snapshotId === 'string' && failed.snapshotId.length > 0, 'Photo wall snapshot identity is missing.');
    const previousRunId = await evaluate(client, 'window.photoMap.getLibrary().then(r => r.ok ? r.value.scan.runId : null)');
    await evaluate(client, 'window.__photoMapImageRetry.blocked = false');
    assertCondition(await evaluate(client, clickAriaButtonExpression('增量扫描')), 'Incremental scan is unavailable for image recovery.');
    await waitForValue(client,
      'window.photoMap.getLibrary().then(r => r.ok ? r.value.scan : null)',
      value => value?.status === 'succeeded' && value.runId !== previousRunId,
      120_000,
    );
    const recovered = await waitForValue(client, observation, value => value?.draws > 0 && !value.loading);
    assertCondition(recovered.attempts > failed.attempts, 'Refreshing the library did not request the failed thumbnail again.');
    assertCondition(recovered.snapshotId === failed.snapshotId, 'Image recovery must preserve the unchanged collage layout.');
    checks.imageRetry = {
      fixture: target.fileName,
      attemptsBeforeRefresh: failed.attempts,
      attemptsAfterRefresh: recovered.attempts,
      paintedAfterRefresh: recovered.draws > 0,
      sameThumbnailUrl: true,
      sameLayoutId: true,
      rendererReloadedDuringRecovery: false,
    };
    await screenshot(client, '02b-image-retry.png');
  } finally {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier });
    await evaluate(client, 'window.__photoMapImageRetry?.cleanup()');
  }
}
