import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SpinnerGap } from '@phosphor-icons/react';
import { clientPointToDocument, documentRects, moveShareElement, resizeShareElement, resizeShareDocument, SHARE_BOARD_ID, type ResizeHandle, type ShareDocument } from '../../share-document';
import { drawShareCard, loadSceneImages, type SceneImages } from '../../map-scene/scene';
import type { MapSnapshot } from '../../model';


const TEXT_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const PHOTO_HANDLES: readonly ResizeHandle[] = ['nw', 'ne', 'se', 'sw'];

const BOARD_HANDLES = TEXT_HANDLES;


interface DragState {
  itemId: string;
  mode: 'move' | 'resize-element' | 'resize-board';
  handle?: ResizeHandle;
  startClientX: number;
  startClientY: number;
  startDisplayWidth: number;
  startDisplayHeight: number;
  startDocument: ShareDocument;
}


interface ToolbarPosition {
  left: number;
  top: number;
  placement: 'above' | 'below';
}


function numberAttribute(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}


export function ShareCardEditor(props: {
  snapshot: MapSnapshot;
  shareDocument: ShareDocument;
  selectedId: string;
  onSelect: (id: string) => void;
  onChange: (document: ShareDocument) => void;
  contextControls?: ReactNode;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const documentRef = useRef(props.shareDocument);
  const onChangeRef = useRef(props.onChange);
  const [images, setImages] = useState<SceneImages>();
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const [surfaceDragOffset, setSurfaceDragOffset] = useState({ x: 0, y: 0 });
  const [fitRevision, setFitRevision] = useState(0);
  const [renderedKey, setRenderedKey] = useState('');
  const [renderRevision, setRenderRevision] = useState(0);
  const [toolbarPosition, setToolbarPosition] = useState<ToolbarPosition>();
  const previewKey = useMemo(
    () => `${props.snapshot.id}:${JSON.stringify(props.shareDocument)}`,
    [props.shareDocument, props.snapshot.id],
  );
  const items = useMemo(() => documentRects(props.shareDocument), [props.shareDocument]);
  const selectedItem = items.find((item) => item.id === props.selectedId);

  documentRef.current = props.shareDocument;
  onChangeRef.current = props.onChange;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const update = (): void => {
      if (dragRef.current?.mode === 'resize-board') return;
      const bounds = host.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const availableWidth = Math.max(1, bounds.width - 36);
      const availableHeight = Math.max(1, bounds.height - 150);
      const scale = Math.min(
        availableWidth / props.shareDocument.width,
        availableHeight / props.shareDocument.height,
      );
      const next = {
        width: Math.max(1, props.shareDocument.width * scale),
        height: Math.max(1, props.shareDocument.height * scale),
      };
      setDisplaySize((current) => (
        Math.abs(current.width - next.width) < 0.5 && Math.abs(current.height - next.height) < 0.5
          ? current
          : next
      ));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [fitRevision, props.shareDocument.height, props.shareDocument.width]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const surface = surfaceRef.current;
    const toolbar = toolbarRef.current;
    if (!host || !surface || !toolbar || !selectedItem || !props.contextControls) {
      setToolbarPosition(undefined);
      return undefined;
    }

    const update = (): void => {
      const hostBounds = host.getBoundingClientRect();
      const surfaceBounds = surface.getBoundingClientRect();
      const toolbarBounds = toolbar.getBoundingClientRect();
      if (hostBounds.width <= 0 || hostBounds.height <= 0 || surfaceBounds.width <= 0 || surfaceBounds.height <= 0) return;
      const selectedCenterX = surfaceBounds.left - hostBounds.left
        + (selectedItem.rect.x + selectedItem.rect.width / 2) * surfaceBounds.width / props.shareDocument.width;
      const selectedTop = surfaceBounds.top - hostBounds.top
        + selectedItem.rect.y * surfaceBounds.height / props.shareDocument.height;
      const selectedBottom = surfaceBounds.top - hostBounds.top
        + (selectedItem.rect.y + selectedItem.rect.height) * surfaceBounds.height / props.shareDocument.height;
      const toolbarWidth = Math.min(toolbarBounds.width, Math.max(1, hostBounds.width - 24));
      const halfWidth = toolbarWidth / 2;
      const left = Math.max(12 + halfWidth, Math.min(hostBounds.width - 12 - halfWidth, selectedCenterX));
      const toolbarLeft = left - halfWidth;
      const toolbarRight = left + halfWidth;
      const aboveTop = selectedTop - 12 - toolbarBounds.height;
      const belowTop = selectedBottom + 12;
      const overlapsOtherText = (top: number): boolean => items.some((item) => {
        if (item.kind !== 'text' || item.id === selectedItem.id) return false;
        const itemLeft = surfaceBounds.left - hostBounds.left
          + item.rect.x * surfaceBounds.width / props.shareDocument.width;
        const itemRight = surfaceBounds.left - hostBounds.left
          + (item.rect.x + item.rect.width) * surfaceBounds.width / props.shareDocument.width;
        const itemTop = surfaceBounds.top - hostBounds.top
          + item.rect.y * surfaceBounds.height / props.shareDocument.height;
        const itemBottom = surfaceBounds.top - hostBounds.top
          + (item.rect.y + item.rect.height) * surfaceBounds.height / props.shareDocument.height;
        return toolbarRight > itemLeft
          && itemRight > toolbarLeft
          && top + toolbarBounds.height > itemTop
          && itemBottom > top;
      });
      const aboveFits = aboveTop >= 12;
      const belowFits = belowTop + toolbarBounds.height <= hostBounds.height - 12;
      const aboveBlocked = overlapsOtherText(aboveTop);
      const belowBlocked = overlapsOtherText(belowTop);
      const resolvedAbove = aboveFits && !aboveBlocked
        ? true
        : !belowFits || belowBlocked;
      const next: ToolbarPosition = {
        left,
        top: resolvedAbove ? selectedTop - 12 : selectedBottom + 12,
        placement: resolvedAbove ? 'above' : 'below',
      };
      setToolbarPosition((current) => (
        current
          && Math.abs(current.left - next.left) < 0.5
          && Math.abs(current.top - next.top) < 0.5
          && current.placement === next.placement
          ? current
          : next
      ));
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    observer.observe(surface);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [
    displaySize.height,
    displaySize.width,
    props.contextControls,
    props.shareDocument.height,
    props.shareDocument.width,
    selectedItem,
  ]);

  useEffect(() => {
    let active = true;
    setImages(undefined);
    setRenderedKey('');
    void loadSceneImages(props.snapshot).then((loaded) => active && setImages(loaded));
    return () => { active = false; };
  }, [props.snapshot.id]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !images) return;
    canvas.width = props.shareDocument.width;
    canvas.height = props.shareDocument.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    drawShareCard(context, {
      snapshot: props.snapshot,
      images,
      document: props.shareDocument,
    });
    setRenderedKey(previewKey);
    setRenderRevision((current) => current + 1);
  }, [images, previewKey, props.shareDocument, props.snapshot]);

  useEffect(() => {
    const pointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      const { x: dx, y: dy } = clientPointToDocument(
        { x: event.clientX, y: event.clientY },
        { x: drag.startClientX, y: drag.startClientY, width: drag.startDisplayWidth, height: drag.startDisplayHeight },
        drag.startDocument,
      );
      const next = drag.mode === 'move'
        ? moveShareElement(drag.startDocument, drag.itemId, dx, dy)
        : drag.mode === 'resize-board'
          ? resizeShareDocument(drag.startDocument, drag.handle ?? 'se', dx, dy)
          : resizeShareElement(drag.startDocument, drag.itemId, drag.handle ?? 'se', dx, dy);
      if (drag.mode === 'resize-board') {
        const width = drag.startDisplayWidth * next.width / drag.startDocument.width;
        const height = drag.startDisplayHeight * next.height / drag.startDocument.height;
        const deltaWidth = width - drag.startDisplayWidth;
        const deltaHeight = height - drag.startDisplayHeight;
        const handle = drag.handle ?? 'se';
        setDisplaySize({ width, height });
        setSurfaceDragOffset({
          x: handle.includes('e') ? deltaWidth / 2 : handle.includes('w') ? -deltaWidth / 2 : 0,
          y: handle.includes('s') ? deltaHeight / 2 : handle.includes('n') ? -deltaHeight / 2 : 0,
        });
      }
      onChangeRef.current(next);
    };
    const pointerEnd = (): void => {
      const wasBoardResize = dragRef.current?.mode === 'resize-board';
      dragRef.current = undefined;
      if (wasBoardResize) {
        setSurfaceDragOffset({ x: 0, y: 0 });
        setFitRevision((current) => current + 1);
      }
    };
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerEnd);
    window.addEventListener('pointercancel', pointerEnd);
    window.addEventListener('blur', pointerEnd);
    return () => {
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerEnd);
      window.removeEventListener('pointercancel', pointerEnd);
      window.removeEventListener('blur', pointerEnd);
    };
  }, []);

  const beginDrag = (
    event: React.PointerEvent<HTMLElement>,
    itemId: string,
    mode: DragState['mode'],
    handle?: ResizeHandle,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const surfaceBounds = surfaceRef.current?.getBoundingClientRect();
    if (!surfaceBounds || surfaceBounds.width <= 0 || surfaceBounds.height <= 0) return;
    props.onSelect(itemId);
    dragRef.current = {
      itemId,
      mode,
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startDisplayWidth: surfaceBounds.width,
      startDisplayHeight: surfaceBounds.height,
      startDocument: documentRef.current,
    };
  };

  const moveWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, itemId: string): void => {
    const amount = event.shiftKey ? 20 : 4;
    const deltas: Partial<Record<string, [number, number]>> = {
      ArrowLeft: [-amount, 0],
      ArrowRight: [amount, 0],
      ArrowUp: [0, -amount],
      ArrowDown: [0, amount],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    props.onSelect(itemId);
    props.onChange(moveShareElement(documentRef.current, itemId, delta[0], delta[1]));
  };

  const resizeWithKeyboard = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    itemId: string,
    handle: ResizeHandle,
  ): void => {
    const amount = event.shiftKey ? 20 : 4;
    const deltas: Partial<Record<string, [number, number]>> = {
      ArrowLeft: [-amount, 0],
      ArrowRight: [amount, 0],
      ArrowUp: [0, -amount],
      ArrowDown: [0, amount],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    props.onChange(itemId === SHARE_BOARD_ID
      ? resizeShareDocument(documentRef.current, handle, delta[0], delta[1])
      : resizeShareElement(documentRef.current, itemId, handle, delta[0], delta[1]));
  };

  const ready = Boolean(
    images
    && renderedKey === previewKey
    && displaySize.width > 0
    && displaySize.height > 0,
  );
  return (
    <div
      ref={hostRef}
      className="export-preview"
      data-testid="export-editor"
      aria-busy={!ready}
    >
      <div
        ref={surfaceRef}
        className="share-card-surface"
        data-testid="export-board"
        data-board-width={numberAttribute(props.shareDocument.width)}
        data-board-height={numberAttribute(props.shareDocument.height)}
        data-board-selected={props.selectedId === SHARE_BOARD_ID}
        data-render-revision={renderRevision}
        style={{
          width: displaySize.width,
          height: displaySize.height,
          transform: `translate(${surfaceDragOffset.x}px, ${surfaceDragOffset.y}px)`,
        }}
      >
        <canvas
          ref={canvasRef}
          width={props.shareDocument.width}
          height={props.shareDocument.height}
          data-testid="export-output-canvas"
          aria-label="分享图排版预览"
        />
        <button
          type="button"
          className="share-board-hit-target"
          data-testid="export-board-background"
          aria-label="底板，选择后可拖动边框调整大小"
          aria-pressed={props.selectedId === SHARE_BOARD_ID}
          onFocus={() => props.onSelect(SHARE_BOARD_ID)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            props.onSelect(SHARE_BOARD_ID);
          }}
        />
        <div className="share-card-overlay" aria-label="分享图排版元素">
          {items.map((item) => {
            const selected = props.selectedId === item.id;
            const handles = item.kind === 'photo' ? PHOTO_HANDLES : TEXT_HANDLES;
            const textContent = item.kind === 'text'
              ? props.shareDocument.texts.find((text) => text.id === item.id)?.text ?? ''
              : '';
            const style = {
              left: `${item.rect.x / props.shareDocument.width * 100}%`,
              top: `${item.rect.y / props.shareDocument.height * 100}%`,
              width: `${item.rect.width / props.shareDocument.width * 100}%`,
              height: `${item.rect.height / props.shareDocument.height * 100}%`,
            };
            return (
              <div
                key={item.id}
                className={`share-element-box ${item.kind} ${selected ? 'selected' : ''}`}
                data-testid={item.kind === 'photo' ? 'export-photo-item' : 'export-text-item'}
                data-item-id={item.id}
                data-item-kind={item.kind}
                data-stack-order={item.kind === 'photo' ? '0' : '1'}
                data-selected={selected}
                data-x={numberAttribute(item.rect.x)}
                data-y={numberAttribute(item.rect.y)}
                data-width={numberAttribute(item.rect.width)}
                data-height={numberAttribute(item.rect.height)}
                data-text={item.kind === 'text' ? textContent : undefined}
                data-aspect-ratio={item.kind === 'photo' ? numberAttribute(props.shareDocument.photo.aspectRatio) : undefined}
                style={style}
              >
                <button
                  type="button"
                  className="share-element-hit-target"
                  aria-label={item.kind === 'photo' ? '照片，拖动调整位置' : `文字：${textContent}`}
                  aria-pressed={selected}
                  onFocus={() => props.onSelect(item.id)}
                  onKeyDown={(event) => moveWithKeyboard(event, item.id)}
                  onPointerDown={(event) => beginDrag(event, item.id, 'move')}
                />
                {selected && handles.map((handle) => (
                  <button
                    key={handle}
                    type="button"
                    className={`share-resize-handle handle-${handle}`}
                    data-testid="export-resize-handle"
                    data-handle={handle}
                    aria-label={`${item.kind === 'photo' ? '照片' : '文字'}${handle}缩放柄`}
                    onKeyDown={(event) => resizeWithKeyboard(event, item.id, handle)}
                    onPointerDown={(event) => beginDrag(event, item.id, 'resize-element', handle)}
                  />
                ))}
              </div>
            );
          })}
        </div>
        <div
          className={`share-board-frame ${props.selectedId === SHARE_BOARD_ID ? 'selected' : ''}`}
          aria-hidden={props.selectedId !== SHARE_BOARD_ID}
        >
          {props.selectedId === SHARE_BOARD_ID && BOARD_HANDLES.map((handle) => (
            <button
              key={handle}
              type="button"
              className={`share-resize-handle board-handle handle-${handle}`}
              data-testid="export-board-resize-handle"
              data-handle={handle}
              aria-label={`底板${handle}缩放柄`}
              onKeyDown={(event) => resizeWithKeyboard(event, SHARE_BOARD_ID, handle)}
              onPointerDown={(event) => beginDrag(event, SHARE_BOARD_ID, 'resize-board', handle)}
            />
          ))}
        </div>
      </div>
      {selectedItem && props.contextControls && (
        <div
          ref={toolbarRef}
          className="share-selection-toolbar"
          data-testid="export-context-toolbar"
          data-item-id={selectedItem.id}
          data-item-kind={selectedItem.kind}
          data-placement={toolbarPosition?.placement}
          role="toolbar"
          aria-label={selectedItem.kind === 'text' ? '文字编辑工具' : '照片排版工具'}
          style={toolbarPosition ? {
            left: toolbarPosition.left,
            top: toolbarPosition.top,
            transform: toolbarPosition.placement === 'above'
              ? 'translate(-50%, -100%)'
              : 'translate(-50%, 0)',
          } : { visibility: 'hidden' }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {props.contextControls}
        </div>
      )}
      {!ready && (
        <div className="export-preview-loading">
          <SpinnerGap className="spin" size={22} />
          <span>生成预览中</span>
        </div>
      )}
    </div>
  );
}
