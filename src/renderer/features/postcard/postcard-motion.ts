import type { PhotoRecord } from '../../model';


export const AUTO_SCROLL_MIN_SPEED = 0.5;

export const AUTO_SCROLL_MAX_SPEED = 2;

export const AUTO_SCROLL_SPEED_STEP = 0.25;

export const AUTO_SCROLL_BASE_DURATION_MS = 5_200;

export type AutoScrollState = 'idle' | 'running' | 'paused' | 'complete';

export interface MotionPoint {
  x: number;
  y: number;
}

export interface PostcardMotionGeometry {
  x: number;
  y: number;
  scale: number;
  control1: MotionPoint;
  control2: MotionPoint;
  stageWidth: number;
  stageHeight: number;
  start: MotionPoint;
  target: MotionPoint;
}

export interface PostcardMotionPose {
  transform: string;
  opacity: number;
}

export type PostcardMoveDestination =
  | { kind: 'photo'; id: string }
  | { kind: 'completion' };

export const POSTCARD_INCOMING_START = 0.46;

export const POSTCARD_RETRIEVAL_START = 0.34;

export const POSTCARD_FLIGHT_HANDOFF = 0.52;

export const DEFAULT_MOTION_GEOMETRY: PostcardMotionGeometry = {
  x: 430,
  y: 26,
  scale: 0.1,
  control1: { x: 146, y: 42 },
  control2: { x: 330, y: 26 },
  stageWidth: 1_000,
  stageHeight: 600,
  start: { x: 300, y: 300 },
  target: { x: 730, y: 326 },
};

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function smoothstep(value: number): number {
  const bounded = clamp(value);
  return bounded * bounded * (3 - 2 * bounded);
}

export function cubicPoint(parameter: number, geometry: PostcardMotionGeometry): MotionPoint {
  const t = clamp(parameter);
  const inverse = 1 - t;
  return {
    x: 3 * inverse * inverse * t * geometry.control1.x
      + 3 * inverse * t * t * geometry.control2.x
      + t * t * t * geometry.x,
    y: 3 * inverse * inverse * t * geometry.control1.y
      + 3 * inverse * t * t * geometry.control2.y
      + t * t * t * geometry.y,
  };
}

export function uniformCurveParameter(progress: number, geometry: PostcardMotionGeometry): number {
  const target = clamp(progress);
  if (target === 0 || target === 1) return target;
  const samples: { parameter: number; length: number }[] = [{ parameter: 0, length: 0 }];
  let previous = cubicPoint(0, geometry);
  let total = 0;
  for (let index = 1; index <= 32; index += 1) {
    const parameter = index / 32;
    const point = cubicPoint(parameter, geometry);
    total += Math.hypot(point.x - previous.x, point.y - previous.y);
    samples.push({ parameter, length: total });
    previous = point;
  }
  if (total === 0) return target;
  const targetLength = total * target;
  const upperIndex = samples.findIndex((sample) => sample.length >= targetLength);
  const upper = samples[Math.max(1, upperIndex)]!;
  const lower = samples[Math.max(0, upperIndex - 1)]!;
  const segmentLength = upper.length - lower.length;
  const segmentProgress = segmentLength === 0 ? 0 : (targetLength - lower.length) / segmentLength;
  return lower.parameter + (upper.parameter - lower.parameter) * segmentProgress;
}

export function postcardMotionPose(
  progress: number,
  geometry: PostcardMotionGeometry,
  uniformMotion = false,
): PostcardMotionPose {
  const distance = clamp(progress);
  const parameter = uniformMotion ? uniformCurveParameter(distance, geometry) : distance;
  const point = cubicPoint(parameter, geometry);
  const fade = smoothstep(clamp((distance - 0.68) / 0.24));
  return {
    transform: `translate3d(${point.x}px, ${point.y}px, 0px) rotateX(${88 * distance}deg) rotateY(${10 * distance}deg) rotateZ(${4 * distance}deg) scale(${1 - (1 - geometry.scale) * distance})`,
    opacity: 1 - fade,
  };
}

export function incomingPostcardProgress(progress: number): number {
  return smoothstep(clamp((clamp(progress) - POSTCARD_INCOMING_START) / (1 - POSTCARD_INCOMING_START)));
}

export function queuedPostcardPose(progress: number): PostcardMotionPose {
  const incoming = incomingPostcardProgress(progress);
  return {
    transform: `translate(0, ${(2 - incoming) * 64}%) scale(${0.94 + incoming * 0.03})`,
    opacity: 0.68 * incoming,
  };
}

export function retrievalPostcardProgress(progress: number): number {
  return smoothstep(clamp((clamp(progress) - POSTCARD_RETRIEVAL_START) / (1 - POSTCARD_RETRIEVAL_START)));
}

export function normalizeWheelDelta(deltaY: number, deltaMode: number, viewportHeight: number): number {
  const multiplier = deltaMode === 1 ? 28 : deltaMode === 2 ? viewportHeight : 1;
  return deltaY * multiplier;
}

export function nextWheelGestureProgress(
  currentProgress: number,
  normalizedDelta: number,
  atBoundary: boolean,
): number {
  const regularNext = clamp(currentProgress + normalizedDelta / 590, -0.92, 0.92);
  if (!atBoundary) return regularNext;

  // When a gesture reverses across zero, consume the existing card movement
  // before applying the softer boundary resistance in the new direction.
  if (currentProgress !== 0 && Math.sign(currentProgress) !== Math.sign(regularNext)) {
    return clamp(regularNext, -0.11, 0.11);
  }
  return clamp(currentProgress + normalizedDelta / 1_800, -0.11, 0.11);
}

export function shouldAdvanceWheelGesture(
  progress: number,
  lastDelta: number,
  atBoundary: boolean,
): boolean {
  const flickContinuesProgress = progress !== 0
    && Math.sign(progress) === Math.sign(lastDelta)
    && Math.abs(lastDelta) >= 72;
  return !atBoundary && (Math.abs(progress) >= 0.28 || flickContinuesProgress);
}

export function postcardMoveDestination(
  photos: readonly Pick<PhotoRecord, 'id'>[],
  currentIndex: number,
  direction: -1 | 1,
): PostcardMoveDestination | undefined {
  const target = photos[currentIndex + direction];
  if (target) return { kind: 'photo', id: target.id };
  if (direction === 1 && currentIndex === photos.length - 1 && photos[currentIndex]) {
    return { kind: 'completion' };
  }
  return undefined;
}

export function normalizeAutoScrollSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const stepped = Math.round(value / AUTO_SCROLL_SPEED_STEP) * AUTO_SCROLL_SPEED_STEP;
  return Math.min(AUTO_SCROLL_MAX_SPEED, Math.max(AUTO_SCROLL_MIN_SPEED, stepped));
}

export function autoScrollDurationMs(speed: number): number {
  return AUTO_SCROLL_BASE_DURATION_MS / normalizeAutoScrollSpeed(speed);
}

export function terminalPostcardScale(slotWidth: number, deckWidth: number): number {
  if (!Number.isFinite(slotWidth) || !Number.isFinite(deckWidth) || deckWidth <= 0) return 0.06;
  return clamp((Math.max(0, slotWidth) / deckWidth) * 0.9, 0.06, 0.14);
}

export function speedLabel(speed: number): string {
  return `${speed.toFixed(Number.isInteger(speed) ? 1 : 2)}×`;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('textarea, input, select, [contenteditable="true"]'));
}
