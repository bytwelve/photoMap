import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ArrowUpRight, Check, FileImage, Info, WarningCircle } from '@phosphor-icons/react';
import { DEFAULT_BATCH_COLUMN_COUNT, hasReachedBatchDragThreshold, mediaKindLabel, MAX_BATCH_COLUMN_COUNT, MIN_BATCH_COLUMN_COUNT, normalizeBatchColumnCount, selectionBoundsFromPoints, selectionBoundsIntersect } from '../../domain';
import type { PhotoRecord } from '../../model';
import type { PostcardEntryOrigin, SelectionBounds, SelectionPoint } from '../../domain';
import { AnnotationModeButton, EmptyResults } from '../../components/Shell';


interface SelectionGesture {
  pointerId: number;
  start: SelectionPoint;
  dragging: boolean;
}


export function BatchView(props: {
  photos: readonly PhotoRecord[];
  selectedIds: ReadonlySet<string>;
  onSelectedIdsChange: (ids: Set<string>) => void;
  onSelectionMessage: (message: string) => void;
  onClearFilters: () => void;
  onGoCarousel: () => void;
  onOpenPostcard: (id: string, origin?: PostcardEntryOrigin) => void;
  onPostcardEntrySettled?: () => void;
}): React.JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null);
  const selectionGestureRef = useRef<SelectionGesture | undefined>(undefined);
  const suppressPointerClickRef = useRef(false);
  const discardColumnDraftOnBlurRef = useRef(false);
  const [selectionRect, setSelectionRect] = useState<SelectionBounds>();
  const [columnCount, setColumnCount] = useState(DEFAULT_BATCH_COLUMN_COUNT);
  const [columnInput, setColumnInput] = useState(String(DEFAULT_BATCH_COLUMN_COUNT));

  function updateColumnInput(value: string, valueAsNumber: number): void {
    setColumnInput(value);
    if (
      Number.isInteger(valueAsNumber)
      && valueAsNumber >= MIN_BATCH_COLUMN_COUNT
      && valueAsNumber <= MAX_BATCH_COLUMN_COUNT
    ) {
      setColumnCount(valueAsNumber);
    }
  }

  function commitColumnInput(): void {
    if (discardColumnDraftOnBlurRef.current) {
      discardColumnDraftOnBlurRef.current = false;
      setColumnInput(String(columnCount));
      return;
    }
    const next = normalizeBatchColumnCount(columnInput, columnCount);
    setColumnCount(next);
    setColumnInput(String(next));
  }

  function togglePhoto(id: string): void {
    const next = new Set(props.selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.onSelectedIdsChange(next);
  }

  function contentPoint(event: React.PointerEvent<HTMLDivElement>): SelectionPoint {
    const grid = gridRef.current;
    if (!grid) return { x: 0, y: 0 };
    const bounds = grid.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left + grid.scrollLeft,
      y: event.clientY - bounds.top + grid.scrollTop,
    };
  }

  function startSelection(event: React.PointerEvent<HTMLDivElement>): void {
    if (!event.isPrimary || event.button !== 0 || selectionGestureRef.current) return;
    selectionGestureRef.current = {
      pointerId: event.pointerId,
      start: contentPoint(event),
      dragging: false,
    };
  }

  function moveSelection(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = selectionGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = contentPoint(event);
    if (!gesture.dragging) {
      if (!hasReachedBatchDragThreshold(gesture.start, point)) return;
      gesture.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    setSelectionRect(selectionBoundsFromPoints(gesture.start, point));
  }

  function finishSelection(event: React.PointerEvent<HTMLDivElement>): void {
    const grid = gridRef.current;
    const gesture = selectionGestureRef.current;
    if (!grid || !gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    selectionGestureRef.current = undefined;
    setSelectionRect(undefined);
    if (gesture.dragging) {
      event.preventDefault();
      const rect = selectionBoundsFromPoints(gesture.start, contentPoint(event));
      const next = new Set(props.selectedIds);
      grid.querySelectorAll<HTMLElement>('[data-photo-card]').forEach((card) => {
        const cardBounds: SelectionBounds = {
          x: card.offsetLeft,
          y: card.offsetTop,
          width: card.offsetWidth,
          height: card.offsetHeight,
        };
        if (selectionBoundsIntersect(rect, cardBounds)) next.add(String(card.dataset.photoId));
      });
      props.onSelectedIdsChange(next);
      props.onSelectionMessage(`框选完成，当前共选择 ${next.size} 项`);
      suppressPointerClickRef.current = true;
      window.setTimeout(() => {
        suppressPointerClickRef.current = false;
      }, 0);
    }
  }

  function cancelSelection(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = selectionGestureRef.current;
    if (gesture && gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    selectionGestureRef.current = undefined;
    setSelectionRect(undefined);
  }

  function leaveSelection(event: React.PointerEvent<HTMLDivElement>): void {
    const gesture = selectionGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.dragging) return;
    selectionGestureRef.current = undefined;
  }

  return (
    <main className="workspace batch-workspace" data-testid="batch-view">
      <section className="batch-card">
        <div className="batch-toolbar">
          <div className="batch-toolbar-leading">
            <AnnotationModeButton mode="batch" onModeChange={(mode) => { if (mode === 'memory') props.onGoCarousel(); }} />
            <div className="batch-summary" aria-live="polite">
              <span>当前结果 {props.photos.length.toLocaleString('zh-CN')} 项</span>
              <strong>已选 {props.selectedIds.size.toLocaleString('zh-CN')} 项</strong>
            </div>
          </div>
          <div className="batch-toolbar-actions">
            <label className="batch-column-control">
              <span>每行</span>
              <input
                type="number"
                className="batch-column-input"
                data-testid="batch-column-input"
                aria-label="每行照片数量"
                title="每行照片数量（2–10）"
                min={MIN_BATCH_COLUMN_COUNT}
                max={MAX_BATCH_COLUMN_COUNT}
                step={1}
                value={columnInput}
                onChange={(event) => updateColumnInput(event.currentTarget.value, event.currentTarget.valueAsNumber)}
                onBlur={commitColumnInput}
                onWheel={(event) => {
                  if (document.activeElement !== event.currentTarget) return;
                  discardColumnDraftOnBlurRef.current = true;
                  event.currentTarget.blur();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              <span>张</span>
            </label>
            <button
              type="button"
              disabled={props.photos.length === 0}
              onClick={() => props.onSelectedIdsChange(new Set(props.photos.map((photo) => photo.id)))}
            >
              全选当前结果
            </button>
            <button type="button" disabled={props.selectedIds.size === 0} onClick={() => props.onSelectedIdsChange(new Set())}>清空已选</button>
          </div>
        </div>
        <div
          className="operation-guide batch-operation-guide"
          data-testid="batch-operation-guide"
          role="note"
        >
          <Info size={17} aria-hidden="true" />
          <span>单击媒体切换选择，右下角打开明信片，按住拖动可框选多项</span>
        </div>
        {props.photos.length === 0 ? (
          <div className="batch-empty-stage" data-testid="batch-empty-stage">
            <EmptyResults onClearFilters={props.onClearFilters} />
          </div>
        ) : (
          <div
            ref={gridRef}
            className={selectionRect ? 'photo-grid drag-selecting' : 'photo-grid'}
            data-testid="batch-grid"
            style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
            onPointerDown={startSelection}
            onPointerMove={moveSelection}
            onPointerUp={finishSelection}
            onPointerCancel={cancelSelection}
            onPointerLeave={leaveSelection}
            onLostPointerCapture={cancelSelection}
          >
            {props.photos.map((photo) => {
              const selected = props.selectedIds.has(photo.id);
              return (
                <article
                  key={photo.id}
                  data-photo-card
                  data-photo-id={photo.id}
                  className={selected ? 'photo-card selected' : 'photo-card'}
                >
                  <button
                    type="button"
                    className="photo-card-selection"
                    aria-pressed={selected}
                    aria-label={`${photo.name}，${mediaKindLabel(photo.mediaKind)}，单击切换选择`}
                    onClick={(event) => {
                      if (suppressPointerClickRef.current) {
                        suppressPointerClickRef.current = false;
                        event.preventDefault();
                        return;
                      }
                      togglePhoto(photo.id);
                    }}
                  >
                    {photo.decodeState === 'valid'
                      ? <img src={photo.thumbnailUrl} alt={photo.name} draggable={false} />
                      : <span className="photo-error"><FileImage size={24} /><small>{photo.decodeMessage}</small></span>}
                  </button>
                  <span className={`media-kind-badge media-kind-${photo.mediaKind}`} data-testid="media-kind-badge">
                    {mediaKindLabel(photo.mediaKind)}
                  </span>
                  <span className="photo-check">{selected && <Check size={14} weight="bold" />}</span>
                  <span className="photo-title">{photo.location?.cityName ?? photo.location?.provinceName ?? '地点未标注'}</span>
                  {photo.decodeState !== 'valid' && <WarningCircle className="photo-warning" size={15} weight="fill" />}
                  <button
                    type="button"
                    className="photo-postcard-entry"
                    data-testid="photo-postcard-entry"
                    aria-label={`在明信片模式中打开 ${photo.name}`}
                    title="在明信片模式中打开"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      const card = event.currentTarget.closest<HTMLElement>('[data-photo-card]');
                      const sourceMedia = card?.querySelector<HTMLElement>('.photo-card-selection');
                      if (!sourceMedia) return;
                      const bounds = sourceMedia.getBoundingClientRect();
                      const origin: PostcardEntryOrigin = {
                        left: bounds.left,
                        top: bounds.top,
                        width: bounds.width,
                        height: bounds.height,
                      };
                      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
                      if (!document.startViewTransition || reduceMotion) {
                        props.onOpenPostcard(photo.id);
                        return;
                      }

                      const transitionRoot = document.documentElement;
                      sourceMedia.style.viewTransitionName = 'postcard-photo-expand';
                      transitionRoot.classList.add('is-postcard-photo-transition');
                      const clearTransitionState = (): void => {
                        sourceMedia.style.viewTransitionName = '';
                        transitionRoot.classList.remove('is-postcard-photo-transition');
                        props.onPostcardEntrySettled?.();
                      };
                      try {
                        const transition = document.startViewTransition(() => {
                          flushSync(() => props.onOpenPostcard(photo.id, { ...origin, viewTransition: true }));
                        });
                        void transition.finished.then(clearTransitionState, clearTransitionState);
                      } catch {
                        sourceMedia.style.viewTransitionName = '';
                        transitionRoot.classList.remove('is-postcard-photo-transition');
                        props.onOpenPostcard(photo.id);
                      }
                    }}
                  >
                    <ArrowUpRight size={15} weight="bold" aria-hidden="true" />
                  </button>
                </article>
              );
            })}
            {selectionRect && (
              <span className="selection-box" style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.width, height: selectionRect.height }} />
            )}
          </div>
        )}
      </section>
    </main>
  );
}
