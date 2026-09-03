import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MouseSimple, Pause, Play } from '@phosphor-icons/react';
import type { AdministrativeRegion as RegionOption } from '../../../shared/administrative-regions';
import type { PostcardEntryOrigin } from '../../domain';
import type { PhotoRecord, PhotoTypeTag } from '../../model';
import { AnnotationModeButton, EmptyResults } from '../../components/Shell';
import { AutoScrollState, DEFAULT_MOTION_GEOMETRY, postcardMoveDestination, clamp, PostcardMoveDestination, terminalPostcardScale, autoScrollDurationMs, isEditableTarget, normalizeWheelDelta, nextWheelGestureProgress, shouldAdvanceWheelGesture, incomingPostcardProgress, retrievalPostcardProgress, smoothstep, queuedPostcardPose, postcardMotionPose, POSTCARD_FLIGHT_HANDOFF, AUTO_SCROLL_MIN_SPEED, AUTO_SCROLL_MAX_SPEED, AUTO_SCROLL_SPEED_STEP, speedLabel, normalizeAutoScrollSpeed } from './postcard-motion';
import { PostcardCompletion } from './PostcardCompletion';
import { PostcardPreviewCard } from './PostcardPreview';
import { PostcardCard } from './PostcardEditor';

export function PostcardView(props: {
  photos: readonly PhotoRecord[];
  activeId?: string;
  provinces: readonly RegionOption[];
  cities: readonly RegionOption[];
  photoTypes: readonly PhotoTypeTag[];
  onActiveIdChange: (id: string) => void;
  onClearFilters: () => void;
  onGoBatch: () => void;
  onUpdateLocation: (ids: readonly string[], provinceCode?: string, cityCode?: string) => Promise<boolean>;
  onUpdateTypes: (ids: readonly string[], add: readonly string[], remove: readonly string[]) => Promise<boolean>;
  onUpdateNote: (id: string, note: string) => Promise<boolean>;
  onUpdateCaptureTime: (id: string, localDateTime: string) => Promise<boolean>;
  onRenamePhoto: (id: string, newFileName: string) => Promise<boolean>;
  onRequestTrash: (ids: readonly string[]) => void;
  entryOrigin?: PostcardEntryOrigin;
  onEntryAnimationComplete?: () => void;
}): React.JSX.Element {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const deckRef = useRef<HTMLDivElement | null>(null);
  const mailboxSlotRef = useRef<HTMLSpanElement | null>(null);
  const autoFrameRef = useRef<number | undefined>(undefined);
  const autoTimerRef = useRef<number | undefined>(undefined);
  const settleFrameRef = useRef<number | undefined>(undefined);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const wheelEndTimerRef = useRef<number | undefined>(undefined);
  const motionProgressRef = useRef(0);
  const lastWheelDeltaRef = useRef(0);
  const autoStateRef = useRef<AutoScrollState>('idle');
  const autoSpeedRef = useRef(1);
  const settlingRef = useRef(false);
  const [autoState, setAutoState] = useState<AutoScrollState>('idle');
  const [autoSpeed, setAutoSpeed] = useState(1);
  const [motionProgress, setMotionProgressState] = useState(0);
  const [motionDirection, setMotionDirection] = useState<-1 | 0 | 1>(0);
  const [motionGeometry, setMotionGeometry] = useState(DEFAULT_MOTION_GEOMETRY);
  const [settling, setSettling] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [deliveryComplete, setDeliveryComplete] = useState(false);
  const rawIndex = useMemo(
    () => props.photos.findIndex((photo) => photo.id === props.activeId),
    [props.activeId, props.photos],
  );
  const currentIndex = rawIndex >= 0 ? rawIndex : 0;
  const current = props.photos[currentIndex];
  const next = props.photos[currentIndex + 1];
  const afterNext = props.photos[currentIndex + 2];
  const previous = props.photos[currentIndex - 1];
  const atLastPhoto = currentIndex >= props.photos.length - 1;
  const forwardDestination = useMemo(
    () => postcardMoveDestination(props.photos, currentIndex, 1),
    [currentIndex, props.photos],
  );
  const collectionSignature = useMemo(
    () => props.photos.map((photo) => photo.id).join('\u0000'),
    [props.photos],
  );
  const previousCollectionSignatureRef = useRef(collectionSignature);
  const onEntryAnimationCompleteRef = useRef(props.onEntryAnimationComplete);

  useEffect(() => {
    onEntryAnimationCompleteRef.current = props.onEntryAnimationComplete;
  }, [props.onEntryAnimationComplete]);

  useEffect(() => {
    if (!props.entryOrigin?.viewTransition) return undefined;
    const fallback = window.setTimeout(() => onEntryAnimationCompleteRef.current?.(), 900);
    return () => window.clearTimeout(fallback);
  }, [props.entryOrigin]);

  useEffect(() => {
    if (props.entryOrigin) return;
    const workspace = workspaceRef.current;
    if (workspace && !workspace.contains(document.activeElement)) {
      workspace.focus({ preventScroll: true });
    }
  }, [props.entryOrigin]);

  const setMotionProgress = useCallback((progress: number): void => {
    const bounded = clamp(progress, -1, 1);
    motionProgressRef.current = bounded;
    setMotionProgressState(bounded);
  }, []);

  const setAutoStateValue = useCallback((state: AutoScrollState): void => {
    autoStateRef.current = state;
    setAutoState(state);
  }, []);

  const cancelSettle = useCallback((): void => {
    if (settleFrameRef.current !== undefined) window.cancelAnimationFrame(settleFrameRef.current);
    if (settleTimerRef.current !== undefined) window.clearTimeout(settleTimerRef.current);
    settleFrameRef.current = undefined;
    settleTimerRef.current = undefined;
    settlingRef.current = false;
    setSettling(false);
  }, []);

  const animateTo = useCallback((
    target: number,
    durationMs: number,
    onComplete: () => void,
  ): void => {
    cancelSettle();
    const start = motionProgressRef.current;
    const finish = (): void => {
      settleFrameRef.current = undefined;
      settleTimerRef.current = undefined;
      setMotionProgress(target);
      settlingRef.current = false;
      setSettling(false);
      onComplete();
    };

    if (Math.abs(target - start) < 0.001) {
      finish();
      return;
    }

    settlingRef.current = true;
    setSettling(true);
    if (reducedMotion) {
      settleTimerRef.current = window.setTimeout(finish, 72);
      return;
    }

    const startedAt = performance.now();
    const step = (now: number): void => {
      const elapsed = clamp((now - startedAt) / durationMs);
      const eased = 1 - (1 - elapsed) ** 3;
      setMotionProgress(start + (target - start) * eased);
      if (elapsed >= 1) {
        finish();
        return;
      }
      settleFrameRef.current = window.requestAnimationFrame(step);
    };
    settleFrameRef.current = window.requestAnimationFrame(step);
  }, [cancelSettle, reducedMotion, setMotionProgress]);

  const clearWheelGesture = useCallback((): void => {
    if (wheelEndTimerRef.current !== undefined) window.clearTimeout(wheelEndTimerRef.current);
    wheelEndTimerRef.current = undefined;
    lastWheelDeltaRef.current = 0;
  }, []);

  const completeMove = useCallback((targetId: string): void => {
    setMotionProgress(0);
    setMotionDirection(0);
    props.onActiveIdChange(targetId);
  }, [props.onActiveIdChange, setMotionProgress]);

  const completeDestination = useCallback((
    destination: PostcardMoveDestination,
  ): void => {
    if (destination.kind === 'photo') {
      completeMove(destination.id);
      return;
    }
    setDeliveryComplete(true);
    setMotionProgress(0);
    setMotionDirection(0);
    setAutoStateValue('complete');
  }, [completeMove, setAutoStateValue, setMotionProgress]);

  const settleAutoToNearest = useCallback((nextState: AutoScrollState, immediate = false): void => {
    const progress = motionProgressRef.current;
    setAutoStateValue(nextState);
    if (progress >= 0.5 && forwardDestination) {
      const complete = (): void => completeDestination(forwardDestination);
      if (immediate) {
        cancelSettle();
        complete();
      } else {
        setMotionDirection(1);
        animateTo(1, 220, complete);
      }
      return;
    }

    const restore = (): void => {
      setMotionProgress(0);
      setMotionDirection(0);
    };
    if (immediate) {
      cancelSettle();
      restore();
    } else {
      animateTo(0, 220, restore);
    }
  }, [animateTo, cancelSettle, completeDestination, forwardDestination, setAutoStateValue, setMotionProgress]);

  useEffect(() => {
    if (rawIndex < 0 && props.photos[0]) props.onActiveIdChange(props.photos[0].id);
  }, [props.activeId, props.onActiveIdChange, props.photos, rawIndex]);

  useEffect(() => {
    const collectionChanged = previousCollectionSignatureRef.current !== collectionSignature;
    previousCollectionSignatureRef.current = collectionSignature;
    if (collectionChanged) {
      cancelSettle();
      clearWheelGesture();
      setDeliveryComplete(false);
      setMotionProgress(0);
      setMotionDirection(0);
    }
    if (!current) {
      setDeliveryComplete(false);
      setAutoStateValue('idle');
      setMotionProgress(0);
      return;
    }
    if (collectionChanged && autoStateRef.current === 'running') {
      setAutoStateValue('idle');
      setMotionProgress(0);
      setMotionDirection(0);
      return;
    }
  }, [cancelSettle, clearWheelGesture, collectionSignature, current, setAutoStateValue, setMotionProgress]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const deck = deckRef.current;
    const slot = mailboxSlotRef.current;
    if (!stage || !deck || !slot) return undefined;

    const measure = (): void => {
      const stageRect = stage.getBoundingClientRect();
      const deckRect = deck.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      if (stageRect.width <= 0 || stageRect.height <= 0 || deckRect.width <= 0 || deckRect.height <= 0) return;
      const start = {
        x: deckRect.left - stageRect.left + deckRect.width / 2,
        y: deckRect.top - stageRect.top + deckRect.height / 2,
      };
      const target = {
        x: slotRect.left - stageRect.left + slotRect.width / 2,
        y: slotRect.top - stageRect.top + slotRect.height / 2,
      };
      const x = target.x - start.x;
      const y = target.y - start.y;
      const curve = clamp(Math.abs(y) * 0.14 + deckRect.height * 0.08, 32, 58);
      const horizontalEntry = clamp(Math.abs(x) * 0.18, 56, 140);
      setMotionGeometry({
        x,
        y,
        scale: terminalPostcardScale(slotRect.width, deckRect.width),
        control1: { x: x * 0.34, y: curve },
        control2: { x: x - Math.sign(x || 1) * horizontalEntry, y },
        stageWidth: stageRect.width,
        stageHeight: stageRect.height,
        start,
        target,
      });
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(deck);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [current?.id, deliveryComplete]);

  useEffect(() => {
    if (autoState !== 'running' || !current || deliveryComplete || !forwardDestination) return undefined;
    setMotionDirection(1);

    if (reducedMotion) {
      autoTimerRef.current = window.setTimeout(() => {
        if (autoStateRef.current !== 'running') return;
        completeDestination(forwardDestination);
      }, autoScrollDurationMs(autoSpeed));
      return () => {
        if (autoTimerRef.current !== undefined) window.clearTimeout(autoTimerRef.current);
        autoTimerRef.current = undefined;
      };
    }

    let previousTime = 0;
    const step = (now: number): void => {
      if (autoStateRef.current !== 'running') return;
      if (previousTime === 0) previousTime = now;
      const elapsed = Math.min(80, Math.max(0, now - previousTime));
      previousTime = now;
      const progress = Math.min(1, motionProgressRef.current + elapsed / autoScrollDurationMs(autoSpeedRef.current));
      setMotionProgress(progress);
      if (progress >= 1) {
        completeDestination(forwardDestination);
        return;
      }
      autoFrameRef.current = window.requestAnimationFrame(step);
    };

    autoFrameRef.current = window.requestAnimationFrame(step);
    return () => {
      if (autoFrameRef.current !== undefined) window.cancelAnimationFrame(autoFrameRef.current);
      autoFrameRef.current = undefined;
    };
  }, [autoSpeed, autoState, completeDestination, current?.id, deliveryComplete, forwardDestination, reducedMotion, setMotionProgress]);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.hidden && autoStateRef.current === 'running') settleAutoToNearest('paused', true);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [settleAutoToNearest]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const handleChange = (event: MediaQueryListEvent): void => {
      setReducedMotion(event.matches);
      if (event.matches && autoStateRef.current === 'running') settleAutoToNearest('paused', true);
      if (event.matches && settlingRef.current) {
        const progress = motionProgressRef.current;
        cancelSettle();
        if (progress >= 0.5 && forwardDestination) completeDestination(forwardDestination);
        else if (progress <= -0.5 && previous) completeMove(previous.id);
        else {
          setMotionProgress(0);
          setMotionDirection(0);
        }
      }
    };
    query.addEventListener?.('change', handleChange);
    return () => query.removeEventListener?.('change', handleChange);
  }, [cancelSettle, completeDestination, completeMove, forwardDestination, previous, setMotionProgress, settleAutoToNearest]);

  useEffect(() => {
    autoSpeedRef.current = autoSpeed;
  }, [autoSpeed]);

  useEffect(() => () => {
    if (autoFrameRef.current !== undefined) window.cancelAnimationFrame(autoFrameRef.current);
    if (autoTimerRef.current !== undefined) window.clearTimeout(autoTimerRef.current);
    if (settleFrameRef.current !== undefined) window.cancelAnimationFrame(settleFrameRef.current);
    if (settleTimerRef.current !== undefined) window.clearTimeout(settleTimerRef.current);
    if (wheelEndTimerRef.current !== undefined) window.clearTimeout(wheelEndTimerRef.current);
  }, []);

  function move(direction: -1 | 1): void {
    if (settlingRef.current) return;
    clearWheelGesture();
    if (autoStateRef.current === 'running') {
      settleAutoToNearest('idle');
      return;
    }
    if (autoStateRef.current === 'paused' || autoStateRef.current === 'complete') setAutoStateValue('idle');
    const destination = postcardMoveDestination(props.photos, currentIndex, direction);
    if (!destination) return;
    setMotionDirection(direction);
    animateTo(direction, 360, () => completeDestination(destination));
  }

  function handleWheel(event: React.WheelEvent<HTMLElement>): void {
    if (isEditableTarget(event.target)) return;
    if (settlingRef.current) return;
    if (autoStateRef.current === 'running') {
      settleAutoToNearest('idle');
      return;
    }
    if (autoStateRef.current === 'paused' || autoStateRef.current === 'complete') setAutoStateValue('idle');

    const normalizedDelta = normalizeWheelDelta(event.deltaY, event.deltaMode, event.currentTarget.clientHeight || window.innerHeight);
    if (Math.abs(normalizedDelta) < 2) return;
    const candidate = motionProgressRef.current + normalizedDelta / 590;
    const direction: -1 | 1 = candidate < 0 ? -1 : 1;
    const destination = postcardMoveDestination(props.photos, currentIndex, direction);
    const atBoundary = !destination;
    lastWheelDeltaRef.current = normalizedDelta;
    setMotionDirection(direction);
    setMotionProgress(nextWheelGestureProgress(motionProgressRef.current, normalizedDelta, atBoundary));

    if (wheelEndTimerRef.current !== undefined) window.clearTimeout(wheelEndTimerRef.current);
    wheelEndTimerRef.current = window.setTimeout(() => {
      wheelEndTimerRef.current = undefined;
      const progress = motionProgressRef.current;
      const finalDirection: -1 | 1 = progress < 0 ? -1 : 1;
      const finalDestination = postcardMoveDestination(props.photos, currentIndex, finalDirection);
      const boundary = !finalDestination;
      const advance = shouldAdvanceWheelGesture(progress, lastWheelDeltaRef.current, boundary);
      lastWheelDeltaRef.current = 0;
      if (advance && finalDestination) {
        setMotionDirection(finalDirection);
        animateTo(finalDirection, 360, () => completeDestination(finalDestination));
      } else {
        animateTo(0, 240, () => {
          setMotionProgress(0);
          setMotionDirection(0);
        });
      }
    }, 115);
  }

  function toggleAutoScroll(): void {
    clearWheelGesture();
    if (autoStateRef.current === 'running') {
      settleAutoToNearest('paused');
      return;
    }
    if (!current || !forwardDestination) return;
    cancelSettle();
    setMotionProgress(0);
    setMotionDirection(1);
    setAutoStateValue('running');
  }

  const autoLabel = autoState === 'running'
    ? '暂停滚动'
    : autoState === 'paused'
      ? '继续滚动'
      : atLastPhoto
        ? '投递最后一张'
        : '自动滚动';
  const durationSeconds = autoScrollDurationMs(autoSpeed) / 1_000;
  const absoluteMotionProgress = Math.abs(motionProgress);
  const incomingProgress = incomingPostcardProgress(motionProgress);
  const retrievalProgress = retrievalPostcardProgress(-motionProgress);
  const currentRetreatProgress = smoothstep(clamp(absoluteMotionProgress / 0.42));
  const currentPose: React.CSSProperties = motionProgress > 0
    ? { opacity: 0, visibility: 'hidden' }
    : motionProgress < 0
      ? {
        transform: `translate(0, ${currentRetreatProgress * 64}%) scale(${1 - currentRetreatProgress * 0.03})`,
        opacity: 1 - currentRetreatProgress * 0.32,
      }
      : {};
  const nextPose: React.CSSProperties = motionProgress >= 0
    ? {
      transform: `translate(0, ${(1 - incomingProgress) * 64}%) scale(${0.97 + incomingProgress * 0.03})`,
      opacity: 0.68 + incomingProgress * 0.32,
      zIndex: incomingProgress > 0 ? 24 : 12,
    }
    : {
      transform: 'translate(0, 64%) scale(.97)',
      opacity: Math.max(0.12, 0.68 - absoluteMotionProgress * 0.56),
      zIndex: 12,
    };
  const afterNextPose: React.CSSProperties = {
    ...queuedPostcardPose(motionProgress),
    zIndex: 10,
  };
  const previousStoredPose: React.CSSProperties = {
    ...postcardMotionPose(1, motionGeometry, false),
    visibility: 'hidden',
    zIndex: 8,
  };
  const flightPhoto = motionProgress > 0 ? current : motionProgress < 0 ? previous : undefined;
  const flightSequence = motionProgress > 0 ? currentIndex + 1 : currentIndex;
  const flightPose = motionProgress > 0
    ? postcardMotionPose(absoluteMotionProgress, motionGeometry, autoState === 'running')
    : postcardMotionPose(1 - retrievalProgress, motionGeometry, false);
  const flightLayerStyle: React.CSSProperties = {
    ...flightPose,
    zIndex: motionProgress > POSTCARD_FLIGHT_HANDOFF ? 18 : 30,
  };
  const guidePath = `M ${motionGeometry.start.x} ${motionGeometry.start.y} C ${motionGeometry.start.x + motionGeometry.control1.x} ${motionGeometry.start.y + motionGeometry.control1.y}, ${motionGeometry.start.x + motionGeometry.control2.x} ${motionGeometry.start.y + motionGeometry.control2.y}, ${motionGeometry.target.x} ${motionGeometry.target.y}`;
  const reverseGuidePath = `M ${motionGeometry.target.x} ${motionGeometry.target.y} C ${motionGeometry.start.x + motionGeometry.control2.x} ${motionGeometry.start.y + motionGeometry.control2.y}, ${motionGeometry.start.x + motionGeometry.control1.x} ${motionGeometry.start.y + motionGeometry.control1.y}, ${motionGeometry.start.x} ${motionGeometry.start.y}`;
  const movementDirection = motionProgress > 0 ? 1 : motionProgress < 0 ? -1 : motionDirection;
  const interactive = !props.entryOrigin
    && !settling
    && Math.abs(motionProgress) < 0.001
    && autoState !== 'running';
  const stageClassName = [
    'memory-stage postcard-stage',
    autoState === 'running' ? 'is-auto-scrolling is-posting' : '',
    movementDirection === 1 && motionProgress !== 0 ? 'is-posting' : '',
    movementDirection === -1 && motionProgress !== 0 ? 'is-retrieving' : '',
    motionProgress !== 0 && !settling ? 'is-gesturing' : '',
    settling ? 'is-settling' : '',
  ].filter(Boolean).join(' ');
  const usesSharedEntryTransition = props.entryOrigin?.viewTransition === true;
  if (!current) {
    return (
      <main className="workspace memory-workspace postcard-workspace" data-testid="memory-view">
        <header className="postcard-toolbar">
          <AnnotationModeButton mode="memory" onModeChange={(mode) => { if (mode === 'batch') props.onGoBatch(); }} />
        </header>
        <section className="memory-stage postcard-stage">
          <EmptyResults onClearFilters={props.onClearFilters} onGoBatch={props.onGoBatch} />
        </section>
      </main>
    );
  }

  const reviewPostcards = (): void => {
    setDeliveryComplete(false);
    setAutoStateValue('idle');
    setMotionProgress(0);
    setMotionDirection(0);
    const first = props.photos[0];
    if (first) props.onActiveIdChange(first.id);
    window.requestAnimationFrame(() => workspaceRef.current?.focus({ preventScroll: true }));
  };

  const restoreLastPostcard = (): void => {
    setDeliveryComplete(false);
    setAutoStateValue('idle');
    setMotionProgress(0);
    setMotionDirection(0);
    window.requestAnimationFrame(() => workspaceRef.current?.focus({ preventScroll: true }));
  };

  if (deliveryComplete) {
    return (
      <main
        ref={workspaceRef}
        className="workspace memory-workspace postcard-workspace is-delivery-complete"
        data-testid="memory-view"
        tabIndex={0}
        onWheel={(event) => {
          if (normalizeWheelDelta(event.deltaY, event.deltaMode, event.currentTarget.clientHeight || window.innerHeight) < -2) {
            restoreLastPostcard();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
            event.preventDefault();
            restoreLastPostcard();
          }
        }}
        aria-label={`明信片投递完成，共 ${props.photos.length} 张`}
      >
        <PostcardCompletion
          photos={props.photos}
          onReview={reviewPostcards}
          onContinue={props.onGoBatch}
        />
      </main>
    );
  }

  return (
    <main
      ref={workspaceRef}
      className={[
        'workspace memory-workspace postcard-workspace',
        usesSharedEntryTransition ? 'is-shared-batch-entry' : '',
      ].filter(Boolean).join(' ')}
      data-testid="memory-view"
      data-batch-entry={props.entryOrigin ? 'animated' : undefined}
      tabIndex={0}
      onWheel={handleWheel}
      onKeyDown={(event) => {
        if (isEditableTarget(event.target)) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
          event.preventDefault();
          move(-1);
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown') {
          event.preventDefault();
          move(1);
        }
      }}
      aria-label="批注模式明信片视图，滚轮或方向键逐张切换"
    >
      <header className="postcard-toolbar">
        <AnnotationModeButton mode="memory" onModeChange={(mode) => { if (mode === 'batch') props.onGoBatch(); }} />
        <div className="memory-hint"><MouseSimple size={17} /><span>滚轮切换照片，或使用</span><kbd>←</kbd><kbd>→</kbd></div>
      </header>

      <section
        ref={stageRef}
        className={stageClassName}
        data-testid="postcard-stage"
        data-motion-progress={motionProgress.toFixed(4)}
        data-motion-direction={movementDirection}
        onPointerDown={() => {
          if (autoStateRef.current === 'running') settleAutoToNearest('paused');
        }}
      >
        <svg
          className="postcard-delivery-guide"
          viewBox={`0 0 ${motionGeometry.stageWidth} ${motionGeometry.stageHeight}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path className="postcard-guide-forward" d={guidePath} />
          <path className="postcard-guide-reverse" d={reverseGuidePath} />
        </svg>
        <div className="postcard-mailbox" data-testid="postcard-mailbox" aria-hidden="true">
          <div className="postcard-mailbox-art-frame">
            <div className="postcard-mailbox-art" data-testid="postcard-mailbox-art" />
            <span className="postcard-mailbox-slot" data-testid="postcard-mailbox-slot" ref={mailboxSlotRef} />
          </div>
        </div>
        <div
          className="postcard-stage-controls"
          data-testid="postcard-stage-controls"
          role="group"
          aria-label="照片页码与自动滚动"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <strong className="postcard-counter" aria-live="polite">
            <span>第</span><b>{currentIndex + 1}</b><span>/ {props.photos.length} 张</span>
          </strong>
          <div className={`auto-scroll-controls ${autoState === 'running' ? 'is-running' : ''} ${autoState === 'paused' ? 'is-paused' : ''}`} aria-label="自动滚动控制">
            <button
              type="button"
              className="auto-scroll-button"
              data-testid="auto-scroll-toggle"
              aria-pressed={autoState === 'running'}
              onClick={toggleAutoScroll}
            >
              {autoState === 'running' ? <Pause size={15} weight="fill" /> : <Play size={15} weight="fill" />}
              <span>{autoLabel}</span>
            </button>
            <label className="auto-speed-control">
              <span>速度</span>
              <input
                type="range"
                min={AUTO_SCROLL_MIN_SPEED}
                max={AUTO_SCROLL_MAX_SPEED}
                step={AUTO_SCROLL_SPEED_STEP}
                value={autoSpeed}
                aria-label="自动滚动速度"
                aria-valuetext={`${speedLabel(autoSpeed)}，每张约 ${durationSeconds.toFixed(1)} 秒`}
                onChange={(event) => setAutoSpeed(normalizeAutoScrollSpeed(event.currentTarget.valueAsNumber))}
              />
              <output>{speedLabel(autoSpeed)}</output>
            </label>
          </div>
        </div>
        <div
          ref={deckRef}
          className="postcard-deck"
          onFocusCapture={() => {
            if (autoStateRef.current === 'running') settleAutoToNearest('paused');
          }}
        >
          {afterNext && (
            <PostcardPreviewCard
              key={afterNext.id}
              photo={afterNext}
              sequence={currentIndex + 3}
              provinces={props.provinces}
              cities={props.cities}
              photoTypes={props.photoTypes}
              testId="postcard-after-next"
              style={afterNextPose}
            />
          )}
          {previous && (
            <PostcardPreviewCard
              key={previous.id}
              photo={previous}
              sequence={currentIndex}
              provinces={props.provinces}
              cities={props.cities}
              photoTypes={props.photoTypes}
              testId="postcard-previous"
              style={previousStoredPose}
            />
          )}
          {next && (
            <PostcardPreviewCard
              key={next.id}
              photo={next}
              sequence={currentIndex + 2}
              provinces={props.provinces}
              cities={props.cities}
              photoTypes={props.photoTypes}
              testId="postcard-next"
              style={nextPose}
            />
          )}
          <PostcardCard
            key={current.id}
            photo={current}
            sequence={currentIndex + 1}
            provinces={props.provinces}
            cities={props.cities}
            photoTypes={props.photoTypes}
            motionStyle={currentPose}
            interactive={interactive}
            mediaActive={interactive && !props.entryOrigin}
            onUpdateLocation={props.onUpdateLocation}
            onUpdateTypes={props.onUpdateTypes}
            onUpdateNote={props.onUpdateNote}
            onUpdateCaptureTime={props.onUpdateCaptureTime}
            onRenamePhoto={props.onRenamePhoto}
            onRequestTrash={props.onRequestTrash}
          />
        </div>

        {flightPhoto && (
          <div
            className="postcard-flight-layer"
            data-testid="postcard-flight-layer"
            data-flight-direction={motionProgress > 0 ? "posting" : "retrieving"}
            style={flightLayerStyle}
            aria-hidden="true"
          >
            <PostcardPreviewCard
              key={flightPhoto.id}
              photo={flightPhoto}
              sequence={flightSequence}
              provinces={props.provinces}
              cities={props.cities}
              photoTypes={props.photoTypes}
              testId="postcard-flight"
              style={{}}
            />
          </div>
        )}

        <p className="postcard-live-region" aria-live="polite">
          {autoState === 'running' ? `正在自动滚动，速度 ${speedLabel(autoSpeed)}` : autoState === 'paused' ? '自动滚动已暂停，不会自行继续' : ''}
        </p>
      </section>
    </main>
  );
}
