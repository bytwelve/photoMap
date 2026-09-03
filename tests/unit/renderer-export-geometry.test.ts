import { describe, expect, it } from 'vitest';

import {
  SHARE_BOARD_ID,
  addShareText,
  alignShareElement,
  clientPointToDocument,
  createDefaultShareDocument,
  documentRects,
  isValidShareDocument,
  moveShareElement,
  rectsConflict,
  removeShareText,
  resizeShareDocument,
  resizeShareElement,
  updateShareText,
  type Rect,
  type ResizeHandle,
  type ShareDocument,
  type ShareTextElement,
} from '../../src/renderer/share-document';

function right(rect: Rect): number {
  return rect.x + rect.width;
}

function bottom(rect: Rect): number {
  return rect.y + rect.height;
}

function text(document: ShareDocument, id: string): ShareTextElement {
  const result = document.texts.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing text fixture: ${id}`);
  return result;
}

describe('share document defaults and text lifecycle', () => {
  it('creates the canonical integer-pixel card near the viewport ratio with fresh nested values', () => {
    const first = createDefaultShareDocument({ width: 1200, height: 800 });
    const second = createDefaultShareDocument({ width: 1200, height: 800 });
    const photoHeight = Math.round(1472 * 800 / 1200);
    const photoBottom = 64 + photoHeight;

    expect(first).toEqual({
      version: 1,
      width: 1600,
      height: photoBottom + 260 + 48,
      safeInset: 64,
      minimumGap: 12,
      photo: {
        id: 'photo',
        kind: 'photo',
        rect: { x: 64, y: 64, width: 1472, height: photoHeight },
        aspectRatio: 1472 / photoHeight,
      },
      texts: [{
        id: 'text-1',
        kind: 'text',
        text: '我的照片地图',
        rect: { x: 280, y: photoBottom + 28, width: 1040, height: 88 },
        fontSize: 64,
        compactness: 1,
        color: '#25211d',
        weight: 700,
      }],
    });
    expect(Math.abs(first.photo.rect.width / first.photo.rect.height - 1200 / 800)).toBeLessThan(0.001);
    expect(isValidShareDocument(first)).toBe(true);

    first.photo.rect.x = 100;
    first.texts[0]!.rect.x = 400;
    first.texts[0]!.text = '已修改';
    expect(second.photo.rect.x).toBe(64);
    expect(second.texts[0]!.rect.x).toBe(280);
    expect(second.texts[0]!.text).toBe('我的照片地图');

    const copiedRects = documentRects(second);
    copiedRects[0]!.rect.x = 999;
    expect(second.photo.rect.x).toBe(64);
  });

  it('continues below existing texts first, then uses free space over the photo', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });
    const secondResult = addShareText(initial, 'text-2');
    const thirdResult = addShareText(secondResult.document, 'text-3');
    const fourthResult = addShareText(thirdResult.document, 'text-4');
    const photoBottom = bottom(initial.photo.rect);

    expect(secondResult.addedId).toBe('text-2');
    expect(thirdResult.addedId).toBe('text-3');
    expect(fourthResult.addedId).toBe('text-4');
    expect(fourthResult.document.texts).toHaveLength(4);
    expect(text(thirdResult.document, 'text-2')).toMatchObject({
      rect: { x: 280, y: photoBottom + 128, width: 1040, height: 56 },
      fontSize: 36,
    });
    expect(text(thirdResult.document, 'text-3')).toMatchObject({
      rect: { x: 280, y: photoBottom + 196, width: 1040, height: 56 },
      fontSize: 36,
    });
    expect(rectsConflict(
      text(fourthResult.document, 'text-4').rect,
      fourthResult.document.photo.rect,
    )).toBe(true);
    for (let leftIndex = 0; leftIndex < fourthResult.document.texts.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < fourthResult.document.texts.length; rightIndex += 1) {
        expect(rectsConflict(
          fourthResult.document.texts[leftIndex]!.rect,
          fourthResult.document.texts[rightIndex]!.rect,
          fourthResult.document.minimumGap,
        )).toBe(false);
      }
    }
    expect(isValidShareDocument(fourthResult.document)).toBe(true);
    expect(initial.texts).toHaveLength(1);
  });

  it('reserves the board id from content ids', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });

    expect(addShareText(initial, SHARE_BOARD_ID)).toEqual({ document: initial });
    expect(isValidShareDocument({
      ...initial,
      photo: { ...initial.photo, id: SHARE_BOARD_ID },
    })).toBe(false);
  });

  it('updates one text style in isolation and clamps style ranges', () => {
    const withSecond = addShareText(
      createDefaultShareDocument({ width: 1200, height: 800 }),
      'text-2',
    ).document;
    const untouched = structuredClone(text(withSecond, 'text-2'));
    const updated = updateShareText(withSecond, 'text-1', {
      text: '山河与足迹',
      color: '#b17a3c',
      weight: 600,
      fontSize: 900,
      compactness: 0.1,
    });

    expect(text(updated, 'text-1')).toMatchObject({
      text: '山河与足迹',
      color: '#b17a3c',
      weight: 600,
      fontSize: 128,
      compactness: 0.55,
    });
    expect(text(updated, 'text-2')).toEqual(untouched);
    expect(text(withSecond, 'text-1').text).toBe('我的照片地图');
    expect(isValidShareDocument(updated)).toBe(true);
  });

  it('removes the canonical and last text while restore still recreates the default', () => {
    const pristine = createDefaultShareDocument({ width: 1200, height: 800 });
    const withSecond = addShareText(pristine, 'text-2').document;
    const edited = moveShareElement(
      updateShareText(withSecond, 'text-1', { text: '临时标题', weight: 400 }),
      'text-1',
      100,
      20,
    );
    const withoutDefault = removeShareText(edited, 'text-1');
    const withoutTexts = removeShareText(withoutDefault, 'text-2');
    const restored = createDefaultShareDocument({ width: 1200, height: 800 });

    expect(withoutDefault.texts.map((item) => item.id)).toEqual(['text-2']);
    expect(withoutTexts.texts).toEqual([]);
    expect(isValidShareDocument(withoutTexts)).toBe(true);
    expect(removeShareText(withoutTexts, 'missing')).toBe(withoutTexts);
    expect(restored).toEqual(createDefaultShareDocument({ width: 1200, height: 800 }));
    expect(restored).not.toBe(edited);
    expect(restored).toEqual(pristine);
  });
});

describe('share document movement and collision geometry', () => {
  it('treats the configured gap as legal contact and any positive penetration as conflict', () => {
    const left = { x: 0, y: 0, width: 10, height: 10 };

    expect(rectsConflict(left, { x: 22, y: 0, width: 10, height: 10 }, 12)).toBe(false);
    expect(rectsConflict(left, { x: 21.9, y: 0, width: 10, height: 10 }, 12)).toBe(true);
    expect(rectsConflict(left, { x: 0, y: 22, width: 10, height: 10 }, 12)).toBe(false);
    expect(rectsConflict(left, { x: 0, y: 21.9, width: 10, height: 10 }, 12)).toBe(true);
  });

  it('allows photo and text overlap while continuing to reject text-to-text overlap', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });
    const photoOverText = moveShareElement(initial, initial.photo.id, 0, 100);

    expect(rectsConflict(photoOverText.photo.rect, text(photoOverText, 'text-1').rect)).toBe(true);
    expect(isValidShareDocument(photoOverText)).toBe(true);

    const withSecond = addShareText(initial, 'text-2').document;
    const overlappingTexts = structuredClone(withSecond);
    text(overlappingTexts, 'text-2').rect = { ...text(overlappingTexts, 'text-1').rect };
    expect(isValidShareDocument(overlappingTexts)).toBe(false);
  });

  it('clamps movement to every card edge without changing size or other elements', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });
    const original = text(initial, 'text-1');
    const left = moveShareElement(initial, 'text-1', -10_000, 0);
    const rightEdge = moveShareElement(initial, 'text-1', 10_000, 0);
    const bottomEdge = moveShareElement(initial, 'text-1', 0, 10_000);

    expect(text(left, 'text-1').rect.x).toBe(64);
    expect(right(text(rightEdge, 'text-1').rect)).toBeCloseTo(initial.width - initial.safeInset, 8);
    expect(bottom(text(bottomEdge, 'text-1').rect)).toBeCloseTo(initial.height - 48, 8);
    for (const result of [left, rightEdge, bottomEdge]) {
      expect(text(result, 'text-1').rect.width).toBe(original.rect.width);
      expect(text(result, 'text-1').rect.height).toBe(original.rect.height);
      expect(result.photo).toEqual(initial.photo);
      expect(isValidShareDocument(result)).toBe(true);
    }
  });

  it('uses the maximum valid point on a drag path instead of crossing another text', () => {
    const withSecond = addShareText(
      createDefaultShareDocument({ width: 1200, height: 800 }),
      'text-2',
    ).document;
    const separated = moveShareElement(withSecond, 'text-2', 0, 20);
    const collided = moveShareElement(separated, 'text-2', 0, -40);
    const first = text(collided, 'text-1');
    const second = text(collided, 'text-2');

    expect(second.rect.y).toBeCloseTo(bottom(first.rect) + collided.minimumGap, 6);
    expect(rectsConflict(first.rect, second.rect, collided.minimumGap)).toBe(false);
    expect(isValidShareDocument(collided)).toBe(true);
    expect(first).toEqual(text(withSecond, 'text-1'));
  });
});

describe('share document board-relative alignment', () => {
  it('centers the photo on either board axis without changing its size or aspect', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });
    const smaller = resizeShareElement(initial, 'photo', 'se', -320, -220);
    const moved = moveShareElement(smaller, 'photo', 180, 120);
    const horizontal = alignShareElement(moved, 'photo', 'horizontal');
    const vertical = alignShareElement(horizontal, 'photo', 'vertical');

    expect(vertical.photo.rect.x).toBeCloseTo((vertical.width - vertical.photo.rect.width) / 2, 8);
    expect(vertical.photo.rect.y).toBeCloseTo((vertical.height - vertical.photo.rect.height) / 2, 8);
    expect(vertical.photo.rect.width).toBeCloseTo(moved.photo.rect.width, 8);
    expect(vertical.photo.rect.height).toBeCloseTo(moved.photo.rect.height, 8);
    expect(vertical.photo.rect.width / vertical.photo.rect.height).toBeCloseTo(initial.photo.aspectRatio, 12);
    expect(isValidShareDocument(vertical)).toBe(true);
  });

  it('centers text over the photo and refuses an occupied text center', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });
    const moved = moveShareElement(initial, 'text-1', 100, 0);
    const horizontal = alignShareElement(moved, 'text-1', 'horizontal');
    const vertical = alignShareElement(horizontal, 'text-1', 'vertical');

    expect(text(horizontal, 'text-1').rect.x).toBeCloseTo(
      (horizontal.width - text(horizontal, 'text-1').rect.width) / 2,
      8,
    );
    expect(text(vertical, 'text-1').rect.y).toBeCloseTo(
      (vertical.height - text(vertical, 'text-1').rect.height) / 2,
      8,
    );
    expect(rectsConflict(text(vertical, 'text-1').rect, vertical.photo.rect)).toBe(true);
    expect(isValidShareDocument(vertical)).toBe(true);

    const withSecond = addShareText(vertical, 'text-2').document;
    expect(alignShareElement(withSecond, 'text-2', 'vertical')).toBe(withSecond);
  });

  it('returns the original document for a missing element or invalid alignment', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });

    expect(alignShareElement(initial, 'missing', 'horizontal')).toBe(initial);
    expect(alignShareElement(initial, 'photo', 'diagonal' as 'horizontal')).toBe(initial);
  });
});

describe('share document board resizing', () => {
  it.each([
    ['n', 0, -100, 0, 100],
    ['ne', 100, -100, 0, 100],
    ['e', 100, 0, 0, 0],
    ['se', 100, 100, 0, 0],
    ['s', 0, 100, 0, 0],
    ['sw', -100, 100, 100, 0],
    ['w', -100, 0, 100, 0],
    ['nw', -100, -100, 100, 100],
  ] as Array<[ResizeHandle, number, number, number, number]>) (
    'resizes freely from the %s board handle and translates content for north/west edges',
    (handle, dx, dy, translatedX, translatedY) => {
      const initial = createDefaultShareDocument({ width: 1200, height: 800 });
      const resized = resizeShareDocument(initial, handle, dx, dy);
      const changesWidth = handle.includes('e') || handle.includes('w');
      const changesHeight = handle.includes('n') || handle.includes('s');

      expect(resized.width).toBe(initial.width + (changesWidth ? 100 : 0));
      expect(resized.height).toBe(initial.height + (changesHeight ? 100 : 0));
      expect(resized.photo.rect.x).toBe(initial.photo.rect.x + translatedX);
      expect(resized.photo.rect.y).toBe(initial.photo.rect.y + translatedY);
      expect(text(resized, 'text-1').rect.x).toBe(text(initial, 'text-1').rect.x + translatedX);
      expect(text(resized, 'text-1').rect.y).toBe(text(initial, 'text-1').rect.y + translatedY);
      expect(isValidShareDocument(resized)).toBe(true);
    },
  );

  it('changes width and height independently instead of preserving a board ratio', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });
    const wider = resizeShareDocument(initial, 'e', 240, 900);
    const taller = resizeShareDocument(wider, 's', 900, 180);

    expect(wider.width).toBe(initial.width + 240);
    expect(wider.height).toBe(initial.height);
    expect(wider.width / wider.height).not.toBeCloseTo(initial.width / initial.height, 8);
    expect(taller.width).toBe(wider.width);
    expect(taller.height).toBe(wider.height + 180);
    expect(isValidShareDocument(taller)).toBe(true);
  });

  it('uses the maximum valid board shrink without cropping any content', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });
    const smallerPhoto = resizeShareElement(initial, 'photo', 'se', -360, -240);
    const shrunk = resizeShareDocument(smallerPhoto, 'e', -10_000, 0);

    expect(shrunk.width).toBeCloseTo(right(text(shrunk, 'text-1').rect) + shrunk.safeInset, 6);
    expect(shrunk.height).toBe(smallerPhoto.height);
    expect(shrunk.photo.rect).toEqual(smallerPhoto.photo.rect);
    expect(isValidShareDocument(shrunk)).toBe(true);

    const blockedAtRightInset = resizeShareDocument(initial, 'e', -100, 0);
    expect(blockedAtRightInset).toBe(initial);
  });

  it('keeps north/west content anchored and stops an inward drag at the safe boundary', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });
    const expanded = resizeShareDocument(initial, 'nw', -200, -200);
    const shrunk = resizeShareDocument(expanded, 'nw', 400, 400);

    expect(shrunk.width).toBeCloseTo(initial.width, 6);
    expect(shrunk.height).toBeCloseTo(initial.height, 6);
    expect(shrunk.photo.rect.x).toBeCloseTo(initial.photo.rect.x, 6);
    expect(shrunk.photo.rect.y).toBeCloseTo(initial.photo.rect.y, 6);
    expect(text(shrunk, 'text-1').rect.x).toBeCloseTo(text(initial, 'text-1').rect.x, 6);
    expect(text(shrunk, 'text-1').rect.y).toBeCloseTo(text(initial, 'text-1').rect.y, 6);
    expect(isValidShareDocument(shrunk)).toBe(true);
  });

  it('returns the original board for non-finite or empty deltas', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });

    expect(resizeShareDocument(initial, 'se', Number.NaN, 10)).toBe(initial);
    expect(resizeShareDocument(initial, 'se', 10, Number.POSITIVE_INFINITY)).toBe(initial);
    expect(resizeShareDocument(initial, 'se', 0, 0)).toBe(initial);
  });
});

describe('share document resizing', () => {
  it.each([
    ['se', -120, -80, 'nw'],
    ['sw', 120, -80, 'ne'],
    ['ne', -120, 80, 'sw'],
    ['nw', 120, 80, 'se'],
  ] as const)(
    'keeps the photo aspect and opposite anchor while resizing from %s',
    (handle, dx, dy, opposite) => {
      const initial = createDefaultShareDocument({ width: 1200, height: 800 });
      const start = initial.photo.rect;
      const resized = resizeShareElement(initial, 'photo', handle, dx, dy);
      const result = resized.photo.rect;

      expect(result.width / result.height).toBeCloseTo(initial.photo.aspectRatio, 12);
      if (opposite.includes('w')) expect(result.x).toBeCloseTo(start.x, 8);
      if (opposite.includes('e')) expect(right(result)).toBeCloseTo(right(start), 8);
      if (opposite.includes('n')) expect(result.y).toBeCloseTo(start.y, 8);
      if (opposite.includes('s')) expect(bottom(result)).toBeCloseTo(bottom(start), 8);
      expect(resized.texts).toEqual(initial.texts);
      expect(isValidShareDocument(resized)).toBe(true);
    },
  );

  it('rejects non-corner photo handles', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });

    expect(resizeShareElement(initial, 'photo', 'e', -100, 0)).toBe(initial);
    expect(resizeShareElement(initial, 'photo', 's', 0, -100)).toBe(initial);
  });

  it('maps text width and height resizing to font size and compactness relationships', () => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });
    const base = text(initial, 'text-1');
    const uniform = text(resizeShareElement(initial, 'text-1', 'se', 104, 8.8), 'text-1');
    const narrower = text(resizeShareElement(initial, 'text-1', 'e', -104, 0), 'text-1');
    const taller = text(resizeShareElement(initial, 'text-1', 's', 0, 8.8), 'text-1');
    const maximumHeightDocument = resizeShareElement(initial, 'text-1', 's', 0, 10_000);
    const maximumHeight = text(maximumHeightDocument, 'text-1');

    expect(uniform.rect.width / base.rect.width).toBeCloseTo(1.1, 8);
    expect(uniform.rect.height / base.rect.height).toBeCloseTo(1.1, 8);
    expect(uniform.fontSize).toBeCloseTo(base.fontSize * 1.1, 8);
    expect(uniform.compactness).toBeCloseTo(base.compactness, 8);

    expect(narrower.fontSize).toBe(base.fontSize);
    expect(narrower.compactness).toBeCloseTo(0.9, 8);

    expect(taller.fontSize).toBeCloseTo(base.fontSize * 1.1, 8);
    expect(taller.compactness).toBeCloseTo(1 / 1.1, 8);

    expect(maximumHeight.fontSize).toBe(128);
    expect(maximumHeight.compactness).toBe(0.55);
    expect(isValidShareDocument(maximumHeightDocument)).toBe(true);
  });

  it.each([
    ['n', 0, 4],
    ['ne', 10, 4],
    ['e', 10, 0],
    ['se', 10, 4],
    ['s', 0, 4],
    ['sw', -10, 4],
    ['w', -10, 0],
    ['nw', -10, 4],
  ] as Array<[ResizeHandle, number, number]>)('supports the %s text handle', (handle, dx, dy) => {
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });
    const resized = resizeShareElement(initial, 'text-1', handle, dx, dy);

    expect(text(resized, 'text-1').rect).not.toEqual(text(initial, 'text-1').rect);
    expect(isValidShareDocument(resized)).toBe(true);
  });
});

describe('share document preview coordinate conversion', () => {
  it('maps client corners and center into the full logical export document', () => {
    const document = createDefaultShareDocument({ width: 1200, height: 800 });
    const clientRect = { x: 100, y: 50, width: 800, height: document.height / 2 };

    expect(clientPointToDocument({ x: 100, y: 50 }, clientRect, document)).toEqual({ x: 0, y: 0 });
    expect(clientPointToDocument({
      x: 500,
      y: 50 + clientRect.height / 2,
    }, clientRect, document)).toEqual({ x: 800, y: document.height / 2 });
    expect(clientPointToDocument({
      x: 900,
      y: 50 + clientRect.height,
    }, clientRect, document)).toEqual({ x: 1600, y: document.height });
  });
});
