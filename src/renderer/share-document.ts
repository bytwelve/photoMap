export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface SharePhotoElement {
  id: string;
  kind: 'photo';
  rect: Rect;
  aspectRatio: number;
}

export interface ShareTextElement {
  id: string;
  kind: 'text';
  text: string;
  rect: Rect;
  fontSize: number;
  compactness: number;
  color: string;
  weight: 400 | 600 | 700;
}

export interface ShareDocument {
  version: 1;
  width: number;
  height: number;
  safeInset: number;
  minimumGap: number;
  photo: SharePhotoElement;
  texts: ShareTextElement[];
}

export interface ShareDocumentRect {
  id: string;
  kind: SharePhotoElement['kind'] | ShareTextElement['kind'];
  rect: Rect;
}

export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export const SHARE_BOARD_ID = 'board';

export type ShareTextPatch = Partial<Pick<
  ShareTextElement,
  'text' | 'fontSize' | 'compactness' | 'color' | 'weight'
>>;

const SHARE_CARD_WIDTH = 1600;
const SHARE_SAFE_INSET = 64;
const SHARE_BOTTOM_INSET = 48;
const SHARE_EDITOR_HEIGHT = 260;
const SHARE_MINIMUM_GAP = 12;
const SHARE_PHOTO_WIDTH = 1472;
const DEFAULT_TEXT_X = 280;
const DEFAULT_TEXT_WIDTH = 1040;
const ADDED_TEXT_HEIGHT = 56;
const MIN_TEXT_WIDTH = 96;
const MIN_TEXT_HEIGHT = 36;
const MIN_PHOTO_WIDTH = 240;
const MIN_PHOTO_HEIGHT = 160;
const MIN_FONT_SIZE = 22;
const MAX_FONT_SIZE = 128;
const MIN_COMPACTNESS = 0.55;
const MAX_COMPACTNESS = 1.65;
const EPSILON = 1e-7;

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cloneRect(rect: Rect): Rect {
  return { ...rect };
}

function clonePhoto(photo: SharePhotoElement): SharePhotoElement {
  return { ...photo, rect: cloneRect(photo.rect) };
}

function cloneText(text: ShareTextElement): ShareTextElement {
  return { ...text, rect: cloneRect(text.rect) };
}

function rectRight(rect: Rect): number {
  return rect.x + rect.width;
}

function rectBottom(rect: Rect): number {
  return rect.y + rect.height;
}

function editableBounds(document: ShareDocument): { left: number; top: number; right: number; bottom: number } {
  return {
    left: document.safeInset,
    top: document.safeInset,
    right: document.width - document.safeInset,
    // The share-card contract intentionally reserves a 48 px bottom border,
    // independently from the 64 px top and side safe inset.
    bottom: document.height - Math.min(document.safeInset, SHARE_BOTTOM_INSET),
  };
}

function rectHasFinitePositiveSize(rect: Rect): boolean {
  return Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}

function rectIsWithinDocument(document: ShareDocument, rect: Rect): boolean {
  if (!rectHasFinitePositiveSize(rect)) return false;
  const bounds = editableBounds(document);
  return rect.x >= bounds.left - EPSILON
    && rect.y >= bounds.top - EPSILON
    && rectRight(rect) <= bounds.right + EPSILON
    && rectBottom(rect) <= bounds.bottom + EPSILON;
}

function sameRect(left: Rect, right: Rect): boolean {
  return Math.abs(left.x - right.x) <= EPSILON
    && Math.abs(left.y - right.y) <= EPSILON
    && Math.abs(left.width - right.width) <= EPSILON
    && Math.abs(left.height - right.height) <= EPSILON;
}

export function documentRects(document: ShareDocument): ShareDocumentRect[] {
  return [
    { id: document.photo.id, kind: 'photo', rect: cloneRect(document.photo.rect) },
    ...document.texts.map((text) => ({ id: text.id, kind: 'text' as const, rect: cloneRect(text.rect) })),
  ];
}

export function rectsConflict(left: Rect, right: Rect, minimumGap = 0): boolean {
  const gap = Number.isFinite(minimumGap) ? Math.max(0, minimumGap) : 0;
  const horizontallySeparated = rectRight(left) + gap <= right.x + EPSILON
    || rectRight(right) + gap <= left.x + EPSILON;
  const verticallySeparated = rectBottom(left) + gap <= right.y + EPSILON
    || rectBottom(right) + gap <= left.y + EPSILON;
  return !horizontallySeparated && !verticallySeparated;
}

function placementIsValid(document: ShareDocument, movingId: string, rect: Rect): boolean {
  if (!rectIsWithinDocument(document, rect)) return false;
  if (movingId === document.photo.id) return true;
  return document.texts.every((text) => (
    text.id === movingId || !rectsConflict(rect, text.rect, document.minimumGap)
  ));
}

export function isValidShareDocument(document: ShareDocument): boolean {
  if (
    document.version !== 1
    || !Number.isFinite(document.width)
    || !Number.isFinite(document.height)
    || document.width <= 0
    || document.height <= 0
    || !Number.isFinite(document.safeInset)
    || document.safeInset < 0
    || !Number.isFinite(document.minimumGap)
    || document.minimumGap < 0
  ) {
    return false;
  }

  const entries = documentRects(document);
  const ids = entries.map((entry) => entry.id);
  if (
    ids.some((id) => id.length === 0 || id === SHARE_BOARD_ID)
    || new Set(ids).size !== ids.length
  ) {
    return false;
  }
  if (entries.some((entry) => !rectIsWithinDocument(document, entry.rect))) return false;

  const photoRatio = document.photo.rect.width / document.photo.rect.height;
  if (
    !Number.isFinite(document.photo.aspectRatio)
    || document.photo.aspectRatio <= 0
    || Math.abs(photoRatio - document.photo.aspectRatio) > EPSILON * Math.max(1, document.photo.aspectRatio)
  ) {
    return false;
  }

  if (document.texts.some((text) => (
    !Number.isFinite(text.fontSize)
    || text.fontSize < MIN_FONT_SIZE - EPSILON
    || text.fontSize > MAX_FONT_SIZE + EPSILON
    || !Number.isFinite(text.compactness)
    || text.compactness < MIN_COMPACTNESS - EPSILON
    || text.compactness > MAX_COMPACTNESS + EPSILON
    || ![400, 600, 700].includes(text.weight)
    || typeof text.color !== 'string'
    || text.color.trim().length === 0
  ))) {
    return false;
  }

  for (let leftIndex = 0; leftIndex < document.texts.length; leftIndex += 1) {
    const left = document.texts[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < document.texts.length; rightIndex += 1) {
      const right = document.texts[rightIndex];
      if (right && rectsConflict(left.rect, right.rect, document.minimumGap)) return false;
    }
  }
  return true;
}

export function createDefaultShareDocument(viewportSize: { width: number; height: number }): ShareDocument {
  const viewportWidth = finitePositive(viewportSize.width, 1);
  const viewportHeight = finitePositive(viewportSize.height, 1);
  const photoHeight = Math.max(1, Math.round(SHARE_PHOTO_WIDTH * viewportHeight / viewportWidth));
  const photoBottom = SHARE_SAFE_INSET + photoHeight;
  return {
    version: 1,
    width: SHARE_CARD_WIDTH,
    height: photoBottom + SHARE_EDITOR_HEIGHT + SHARE_BOTTOM_INSET,
    safeInset: SHARE_SAFE_INSET,
    minimumGap: SHARE_MINIMUM_GAP,
    photo: {
      id: 'photo',
      kind: 'photo',
      rect: {
        x: SHARE_SAFE_INSET,
        y: SHARE_SAFE_INSET,
        width: SHARE_PHOTO_WIDTH,
        height: photoHeight,
      },
      aspectRatio: SHARE_PHOTO_WIDTH / photoHeight,
    },
    texts: [{
      id: 'text-1',
      kind: 'text',
      text: '我的照片地图',
      rect: {
        x: DEFAULT_TEXT_X,
        y: photoBottom + 28,
        width: DEFAULT_TEXT_WIDTH,
        height: 88,
      },
      fontSize: 64,
      compactness: 1,
      color: '#25211d',
      weight: 700,
    }],
  };
}

export function addShareText(
  document: ShareDocument,
  id: string,
): { document: ShareDocument; addedId?: string } {
  const normalizedId = id.trim();
  if (
    !normalizedId
    || normalizedId === SHARE_BOARD_ID
    || documentRects(document).some((entry) => entry.id === normalizedId)
  ) {
    return { document };
  }

  const bounds = editableBounds(document);
  const availableWidth = bounds.right - bounds.left;
  const availableHeight = bounds.bottom - bounds.top;
  const width = Math.min(DEFAULT_TEXT_WIDTH, availableWidth);
  if (width < MIN_TEXT_WIDTH || availableHeight < ADDED_TEXT_HEIGHT) return { document };

  const preferredX = clamp(DEFAULT_TEXT_X, bounds.left, bounds.right - width);
  const candidateXs = new Set<number>([
    preferredX,
    bounds.left,
    (document.width - width) / 2,
    bounds.right - width,
    ...document.texts.flatMap((text) => [
      rectRight(text.rect) + document.minimumGap,
      text.rect.x - document.minimumGap - width,
    ]),
  ]);
  const candidateYs = new Set<number>([
    ...[...document.texts].reverse().map((text) => rectBottom(text.rect) + document.minimumGap),
    rectBottom(document.photo.rect) + document.minimumGap,
    bounds.top,
    (document.height - ADDED_TEXT_HEIGHT) / 2,
    bounds.bottom - ADDED_TEXT_HEIGHT,
    ...document.texts.flatMap((text) => [
      text.rect.y - document.minimumGap - ADDED_TEXT_HEIGHT,
      rectBottom(text.rect) + document.minimumGap,
    ]),
  ]);
  for (const y of candidateYs) {
    if (y < bounds.top - EPSILON || y + ADDED_TEXT_HEIGHT > bounds.bottom + EPSILON) continue;
    for (const x of candidateXs) {
      if (x < bounds.left - EPSILON || x + width > bounds.right + EPSILON) continue;
      const rect: Rect = {
        x,
        y,
        width,
        height: ADDED_TEXT_HEIGHT,
      };
      if (!placementIsValid(document, normalizedId, rect)) continue;
      const added: ShareTextElement = {
        id: normalizedId,
        kind: 'text',
        text: '新文字',
        rect,
        fontSize: 36,
        compactness: 1,
        color: '#25211d',
        weight: 600,
      };
      return {
        document: { ...document, texts: [...document.texts.map(cloneText), added] },
        addedId: normalizedId,
      };
    }
  }
  return { document };
}

export function updateShareText(
  document: ShareDocument,
  id: string,
  patch: ShareTextPatch,
): ShareDocument {
  const index = document.texts.findIndex((text) => text.id === id);
  const current = document.texts[index];
  if (index < 0 || !current) return document;

  const next: ShareTextElement = {
    ...current,
    text: typeof patch.text === 'string' ? patch.text : current.text,
    color: typeof patch.color === 'string' && patch.color.trim().length > 0 ? patch.color : current.color,
    weight: patch.weight === 400 || patch.weight === 600 || patch.weight === 700
      ? patch.weight
      : current.weight,
    fontSize: typeof patch.fontSize === 'number' && Number.isFinite(patch.fontSize)
      ? clamp(patch.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE)
      : current.fontSize,
    compactness: typeof patch.compactness === 'number' && Number.isFinite(patch.compactness)
      ? clamp(patch.compactness, MIN_COMPACTNESS, MAX_COMPACTNESS)
      : current.compactness,
    rect: cloneRect(current.rect),
  };
  const texts = document.texts.map((text, textIndex) => textIndex === index ? next : cloneText(text));
  return { ...document, photo: clonePhoto(document.photo), texts };
}

export function removeShareText(document: ShareDocument, id: string): ShareDocument {
  if (!document.texts.some((text) => text.id === id)) return document;
  return {
    ...document,
    photo: clonePhoto(document.photo),
    texts: document.texts.filter((text) => text.id !== id).map(cloneText),
  };
}

function rectForElement(document: ShareDocument, id: string): Rect | undefined {
  if (document.photo.id === id) return document.photo.rect;
  return document.texts.find((text) => text.id === id)?.rect;
}

function replaceElementRect(document: ShareDocument, id: string, rect: Rect): ShareDocument {
  if (document.photo.id === id) {
    return {
      ...document,
      photo: { ...document.photo, rect: cloneRect(rect) },
      texts: document.texts.map(cloneText),
    };
  }
  return {
    ...document,
    photo: clonePhoto(document.photo),
    texts: document.texts.map((text) => text.id === id ? { ...text, rect: cloneRect(rect) } : cloneText(text)),
  };
}

export function alignShareElement(
  document: ShareDocument,
  id: string,
  alignment: 'horizontal' | 'vertical',
): ShareDocument {
  const start = rectForElement(document, id);
  if (!start || (alignment !== 'horizontal' && alignment !== 'vertical')) return document;
  const target = {
    ...start,
    x: alignment === 'horizontal' ? (document.width - start.width) / 2 : start.x,
    y: alignment === 'vertical' ? (document.height - start.height) / 2 : start.y,
  };
  if (sameRect(start, target) || !placementIsValid(document, id, target)) return document;
  return replaceElementRect(document, id, target);
}

function maximumValidRect(
  candidateAt: (progress: number) => Rect,
  isValid: (candidate: Rect) => boolean,
): Rect {
  const endpoint = candidateAt(1);
  if (isValid(endpoint)) return endpoint;
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 52; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (isValid(candidateAt(middle))) lower = middle;
    else upper = middle;
  }
  return candidateAt(lower);
}

function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

function resizedShareDocumentAt(
  document: ShareDocument,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  progress: number,
): ShareDocument {
  const horizontalDelta = dx * progress;
  const verticalDelta = dy * progress;
  const fromWest = handle.includes('w');
  const fromEast = handle.includes('e');
  const fromNorth = handle.includes('n');
  const fromSouth = handle.includes('s');
  const translateX = fromWest ? -horizontalDelta : 0;
  const translateY = fromNorth ? -verticalDelta : 0;
  return {
    ...document,
    width: document.width + (fromEast ? horizontalDelta : 0) - (fromWest ? horizontalDelta : 0),
    height: document.height + (fromSouth ? verticalDelta : 0) - (fromNorth ? verticalDelta : 0),
    photo: {
      ...document.photo,
      rect: translateRect(document.photo.rect, translateX, translateY),
    },
    texts: document.texts.map((text) => ({
      ...text,
      rect: translateRect(text.rect, translateX, translateY),
    })),
  };
}

function documentHasSameGeometry(left: ShareDocument, right: ShareDocument): boolean {
  if (
    Math.abs(left.width - right.width) > EPSILON
    || Math.abs(left.height - right.height) > EPSILON
    || !sameRect(left.photo.rect, right.photo.rect)
    || left.texts.length !== right.texts.length
  ) {
    return false;
  }
  return left.texts.every((text, index) => {
    const candidate = right.texts[index];
    return candidate?.id === text.id && sameRect(text.rect, candidate.rect);
  });
}

export function resizeShareDocument(
  document: ShareDocument,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): ShareDocument {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return document;
  const candidateAt = (progress: number): ShareDocument => (
    resizedShareDocumentAt(document, handle, dx, dy, progress)
  );
  const endpoint = candidateAt(1);
  if (isValidShareDocument(endpoint)) return endpoint;

  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 52; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (isValidShareDocument(candidateAt(middle))) lower = middle;
    else upper = middle;
  }
  if (lower <= EPSILON) return document;
  const result = candidateAt(lower);
  return documentHasSameGeometry(document, result) ? document : result;
}

function clampMovedRect(document: ShareDocument, rect: Rect): Rect {
  const bounds = editableBounds(document);
  return {
    ...rect,
    x: clamp(rect.x, bounds.left, bounds.right - rect.width),
    y: clamp(rect.y, bounds.top, bounds.bottom - rect.height),
  };
}

export function moveShareElement(document: ShareDocument, id: string, dx: number, dy: number): ShareDocument {
  const start = rectForElement(document, id);
  if (!start || !Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return document;
  const endpoint = clampMovedRect(document, { ...start, x: start.x + dx, y: start.y + dy });
  const deltaX = endpoint.x - start.x;
  const deltaY = endpoint.y - start.y;
  const result = maximumValidRect(
    (progress) => ({ ...start, x: start.x + deltaX * progress, y: start.y + deltaY * progress }),
    (candidate) => placementIsValid(document, id, candidate),
  );
  return sameRect(start, result) ? document : replaceElementRect(document, id, result);
}

function textRectForResize(start: Rect, handle: ResizeHandle, dx: number, dy: number): Rect {
  let left = start.x;
  let right = rectRight(start);
  let top = start.y;
  let bottom = rectBottom(start);
  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.includes('n')) top += dy;
  if (handle.includes('s')) bottom += dy;
  if (handle.includes('w')) left = Math.min(left, right - MIN_TEXT_WIDTH);
  if (handle.includes('e')) right = Math.max(right, left + MIN_TEXT_WIDTH);
  if (handle.includes('n')) top = Math.min(top, bottom - MIN_TEXT_HEIGHT);
  if (handle.includes('s')) bottom = Math.max(bottom, top + MIN_TEXT_HEIGHT);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function photoRectForResize(
  start: Rect,
  handle: Extract<ResizeHandle, 'ne' | 'se' | 'sw' | 'nw'>,
  dx: number,
  dy: number,
): Rect {
  const east = handle.includes('e');
  const south = handle.includes('s');
  const horizontalSign = east ? 1 : -1;
  const verticalSign = south ? 1 : -1;
  const anchorX = east ? start.x : rectRight(start);
  const anchorY = south ? start.y : rectBottom(start);
  const baseX = horizontalSign * start.width;
  const baseY = verticalSign * start.height;
  const desiredX = baseX + dx;
  const desiredY = baseY + dy;
  const denominator = baseX * baseX + baseY * baseY;
  const projectedScale = denominator > 0 ? (desiredX * baseX + desiredY * baseY) / denominator : 1;
  const minimumScale = Math.max(MIN_PHOTO_WIDTH / start.width, MIN_PHOTO_HEIGHT / start.height);
  const scale = Math.max(minimumScale, projectedScale);
  const width = start.width * scale;
  const height = start.height * scale;
  return {
    x: east ? anchorX : anchorX - width,
    y: south ? anchorY : anchorY - height,
    width,
    height,
  };
}

function resizeTextElement(
  document: ShareDocument,
  text: ShareTextElement,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): ShareDocument {
  const start = text.rect;
  const result = maximumValidRect(
    (progress) => textRectForResize(start, handle, dx * progress, dy * progress),
    (candidate) => placementIsValid(document, text.id, candidate),
  );
  if (sameRect(start, result)) return document;
  const widthRatio = result.width / start.width;
  const heightRatio = result.height / start.height;
  const next: ShareTextElement = {
    ...text,
    rect: result,
    fontSize: clamp(text.fontSize * heightRatio, MIN_FONT_SIZE, MAX_FONT_SIZE),
    compactness: clamp(text.compactness * widthRatio / heightRatio, MIN_COMPACTNESS, MAX_COMPACTNESS),
  };
  return {
    ...document,
    photo: clonePhoto(document.photo),
    texts: document.texts.map((candidate) => candidate.id === text.id ? next : cloneText(candidate)),
  };
}

export function resizeShareElement(
  document: ShareDocument,
  id: string,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): ShareDocument {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return document;
  if (document.photo.id === id) {
    if (handle !== 'ne' && handle !== 'se' && handle !== 'sw' && handle !== 'nw') return document;
    const start = document.photo.rect;
    const result = maximumValidRect(
      (progress) => photoRectForResize(start, handle, dx * progress, dy * progress),
      (candidate) => placementIsValid(document, id, candidate),
    );
    return sameRect(start, result) ? document : replaceElementRect(document, id, result);
  }
  const text = document.texts.find((candidate) => candidate.id === id);
  return text ? resizeTextElement(document, text, handle, dx, dy) : document;
}

export function clientPointToDocument(
  clientPoint: Point,
  clientRect: Rect,
  documentSize: Pick<ShareDocument, 'width' | 'height'>,
): Point {
  if (
    !Number.isFinite(clientPoint.x)
    || !Number.isFinite(clientPoint.y)
    || !rectHasFinitePositiveSize(clientRect)
    || !Number.isFinite(documentSize.width)
    || !Number.isFinite(documentSize.height)
  ) {
    return { x: 0, y: 0 };
  }
  return {
    x: (clientPoint.x - clientRect.x) * documentSize.width / clientRect.width,
    y: (clientPoint.y - clientRect.y) * documentSize.height / clientRect.height,
  };
}
