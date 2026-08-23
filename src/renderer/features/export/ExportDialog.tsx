import { useEffect, useRef, useState } from 'react';
import { AlignCenterHorizontalSimple, AlignCenterVerticalSimple, ArrowCounterClockwise, CheckCircle, DownloadSimple, ImageSquare, SpinnerGap, TextT, Trash, WarningCircle } from '@phosphor-icons/react';
import { errorMessage, unwrapResult } from '../../bridge';
import type { MapSnapshot } from '../../model';
import { renderSnapshotToDataUrl } from '../../map-scene/scene';
import { addShareText, alignShareElement, createDefaultShareDocument, removeShareText, SHARE_BOARD_ID, updateShareText, type ShareTextElement } from '../../share-document';
import { ShareCardEditor } from './ShareCardEditor';


type ShareTextWeight = ShareTextElement['weight'];


const TEXT_COLORS = [
  { value: '#25211d', name: '深墨' },
  { value: '#7d552b', name: '棕金' },
  { value: '#a9783d', name: '暖金' },
  { value: '#66756c', name: '灰绿' },
  { value: '#9a5952', name: '暖红' },
] as const;


const TEXT_WEIGHTS: readonly { value: ShareTextWeight; label: string }[] = [
  { value: 400, label: '常规' },
  { value: 600, label: '中等' },
  { value: 700, label: '粗体' },
];


export function ExportDialog(props: {
  snapshot: MapSnapshot;
  viewportSize: { width: number; height: number };
  onClose: () => void;
  onSaved: (message: string) => void;
}): React.JSX.Element {
  const [shareDocument, setShareDocument] = useState(() => createDefaultShareDocument(props.viewportSize));
  const [selectedId, setSelectedId] = useState('text-1');
  const [status, setStatus] = useState<'ready' | 'working' | 'done' | 'error'>('ready');
  const [message, setMessage] = useState('');
  const [resetPrompt, setResetPrompt] = useState(false);
  const nextTextIdRef = useRef(2);
  const textInputRef = useRef<HTMLInputElement>(null);
  const selectedText: ShareTextElement | undefined = shareDocument.texts.find((text) => text.id === selectedId);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || status === 'working') return;
      if (resetPrompt) setResetPrompt(false);
      else props.onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [props.onClose, resetPrompt, status]);

  const announceLayoutChange = (nextMessage = ''): void => {
    setStatus('ready');
    setMessage(nextMessage);
  };

  const addText = (): void => {
    const id = `text-${nextTextIdRef.current}`;
    const result = addShareText(shareDocument, id);
    if (!result.addedId) {
      setStatus('error');
      setMessage('底板空间不足，请先缩小或移动现有内容。');
      return;
    }
    nextTextIdRef.current += 1;
    setShareDocument(result.document);
    setSelectedId(result.addedId);
    announceLayoutChange('已添加文字，可直接修改内容与样式。');
    window.requestAnimationFrame(() => {
      textInputRef.current?.focus();
      textInputRef.current?.select();
    });
  };

  const editSelectedText = (patch: Partial<Omit<ShareTextElement, 'id' | 'kind' | 'rect'>>): void => {
    if (!selectedText) return;
    setShareDocument((current) => updateShareText(current, selectedText.id, patch));
    announceLayoutChange();
  };

  const deleteSelectedText = (): void => {
    if (!selectedText) return;
    const next = removeShareText(shareDocument, selectedText.id);
    setShareDocument(next);
    setSelectedId(next.texts[0]?.id ?? next.photo.id);
    announceLayoutChange('已删除所选文字。');
    window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLButtonElement>(
        next.texts.length > 0
          ? `[data-item-id="${next.texts[0]?.id}"] .share-element-hit-target`
          : '[data-testid="export-photo-item"] .share-element-hit-target',
      );
      target?.focus();
    });
  };

  const alignSelected = (axis: 'horizontal' | 'vertical'): void => {
    if (selectedId === SHARE_BOARD_ID) return;
    const selectedRect = selectedText?.rect ?? (selectedId === shareDocument.photo.id ? shareDocument.photo.rect : undefined);
    if (!selectedRect) return;
    const target = axis === 'horizontal'
      ? (shareDocument.width - selectedRect.width) / 2
      : (shareDocument.height - selectedRect.height) / 2;
    const current = axis === 'horizontal' ? selectedRect.x : selectedRect.y;
    const next = alignShareElement(shareDocument, selectedId, axis);
    if (next === shareDocument) {
      if (Math.abs(current - target) < 0.01) announceLayoutChange(`已处于${axis === 'horizontal' ? '水平' : '垂直'}居中位置。`);
      else {
        setStatus('error');
        setMessage(selectedText
          ? '目标居中位置与其他文字重叠，请先调整文字位置。'
          : '当前底板留白不足，无法完成居中。');
      }
      return;
    }
    setShareDocument(next);
    announceLayoutChange(`已相对底板${axis === 'horizontal' ? '水平' : '垂直'}居中。`);
  };

  const restoreDefault = (): void => {
    const next = createDefaultShareDocument(props.viewportSize);
    nextTextIdRef.current = 2;
    setShareDocument(next);
    setSelectedId('text-1');
    setResetPrompt(false);
    announceLayoutChange('已恢复默认大小与摆放位置。');
  };

  async function save(): Promise<void> {
    setStatus('working');
    setMessage('正在冻结布局并生成分享图…');
    try {
      const dataUrl = await renderSnapshotToDataUrl(props.snapshot, {
        currentWidth: props.viewportSize.width,
        currentHeight: props.viewportSize.height,
        document: shareDocument,
      });
      const date = new Date().toISOString().slice(0, 10);
      const result = unwrapResult(await window.photoMap.saveExport({
        dataUrl,
        format: 'png',
        suggestedName: `照片地图-${date}.png`,
      }));
      if (result.cancelled) {
        setStatus('ready');
        setMessage('已取消保存，预览仍为你保留。');
        return;
      }
      setStatus('done');
      setMessage(result.savedPath ? `已保存到 ${result.savedPath}` : '分享图已保存');
      props.onSaved('分享图已保存，导出内容不含操作界面');
    } catch (error) {
      setStatus('error');
      setMessage(errorMessage(error));
    }
  }

  const alignmentControls = selectedId !== SHARE_BOARD_ID ? (
    <div className="export-alignment-group" role="group" aria-label="相对底板居中">
      <button
        type="button"
        data-testid="export-align-horizontal"
        aria-label="相对底板水平居中"
        title="左右居中"
        onClick={() => alignSelected('horizontal')}
      >
        <AlignCenterHorizontalSimple size={19} />
        <span>左右居中</span>
      </button>
      <button
        type="button"
        data-testid="export-align-vertical"
        aria-label="相对底板垂直居中"
        title="上下居中"
        onClick={() => alignSelected('vertical')}
      >
        <AlignCenterVerticalSimple size={19} />
        <span>上下居中</span>
      </button>
    </div>
  ) : undefined;

  const contextControls = selectedText ? (
    <div className="share-text-controls" data-testid="export-text-controls">
      <label className="export-text-field" htmlFor="export-text-content">
        <span>文字</span>
        <input
          ref={textInputRef}
          id="export-text-content"
          data-testid="export-text-input"
          type="text"
          maxLength={48}
          value={selectedText.text}
          placeholder="输入文字"
          onChange={(event) => editSelectedText({ text: event.target.value })}
        />
      </label>
      <span className="share-toolbar-divider" />
      <div className="export-format-group" data-testid="export-text-color" role="group" aria-label="文字颜色">
        <span>颜色</span>
        {TEXT_COLORS.map((color) => (
          <button
            key={color.value}
            type="button"
            className={`color-swatch ${selectedText.color === color.value ? 'active' : ''}`}
            style={{ backgroundColor: color.value }}
            aria-label={color.name}
            aria-pressed={selectedText.color === color.value}
            onClick={() => editSelectedText({ color: color.value })}
          />
        ))}
      </div>
      <span className="share-toolbar-divider" />
      <div className="export-format-group weight-group" data-testid="export-text-weight" role="group" aria-label="文字粗细">
        <span>粗细</span>
        {TEXT_WEIGHTS.map((weight) => (
          <button
            key={weight.value}
            type="button"
            className={selectedText.weight === weight.value ? 'active' : ''}
            style={{ fontWeight: weight.value }}
            aria-pressed={selectedText.weight === weight.value}
            onClick={() => editSelectedText({ weight: weight.value })}
          >
            {weight.label}
          </button>
        ))}
      </div>
      <span className="share-toolbar-divider" />
      {alignmentControls}
      <span className="share-toolbar-divider" />
      <button
        type="button"
        className="export-delete-text"
        data-testid="export-delete-text"
        onClick={deleteSelectedText}
        title="删除所选文字"
      >
        <Trash size={17} />删除
      </button>
    </div>
  ) : selectedId === shareDocument.photo.id ? (
    <div className="share-photo-controls" data-testid="export-photo-controls">
      <ImageSquare size={20} />
      <span><strong>照片</strong><small>比例已锁定</small></span>
      <span className="share-toolbar-divider" />
      {alignmentControls}
    </div>
  ) : undefined;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && status !== 'working' && props.onClose()}>
      <section className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" data-testid="export-dialog">
        <header><div><span className="eyebrow">导出分享图</span><h2 id="export-title">把这一刻保存下来</h2></div></header>
        <div className="export-toolbar" aria-label="排版工具">
          <button type="button" className="secondary-action" data-testid="export-add-text" onClick={addText}>
            <TextT size={18} />添加文字
          </button>
          <button type="button" className="secondary-action" data-testid="export-reset" onClick={() => setResetPrompt(true)}>
            <ArrowCounterClockwise size={18} />恢复默认
          </button>
          <span>点击底板、照片或文字后拖动选中框；照片保持原比例</span>
        </div>
        <div className="export-body">
          <ShareCardEditor
            snapshot={props.snapshot}
            shareDocument={shareDocument}
            selectedId={selectedId}
            onSelect={setSelectedId}
            contextControls={contextControls}
            onChange={(next) => {
              setShareDocument(next);
              announceLayoutChange();
            }}
          />
        </div>
        <footer>
          {message && <div className={`export-status ${status}`} role="status">{status === 'error' ? <WarningCircle size={18} weight="fill" /> : status === 'working' ? <SpinnerGap className="spin" size={18} /> : <CheckCircle size={18} weight="fill" />}<span>{message}</span></div>}
          <div className="export-actions"><button type="button" className="secondary-action" disabled={status === 'working'} onClick={props.onClose}>取消</button><button type="button" className="primary-action" disabled={status === 'working'} onClick={() => void save()}>{status === 'working' ? <SpinnerGap className="spin" size={17} /> : <DownloadSimple size={17} />}{status === 'working' ? '正在保存' : '保存图片'}</button></div>
        </footer>
        {resetPrompt && (
          <div className="export-reset-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setResetPrompt(false)}>
            <section className="export-reset-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="export-reset-title" data-testid="export-reset-confirmation">
              <span className="reset-icon"><ArrowCounterClockwise size={26} /></span>
              <h3 id="export-reset-title">恢复默认排版？</h3>
              <p>底板、照片和文字会恢复默认大小与位置，新增文字也会被移除。</p>
              <div>
                <button type="button" className="secondary-action" onClick={() => setResetPrompt(false)}>取消</button>
                <button type="button" className="primary-action" data-testid="export-reset-confirm" onClick={restoreDefault}>恢复默认</button>
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}


export function TrashConfirmation(props: {
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="trash-title">
        <span className="confirm-icon"><Trash size={22} weight="duotone" /></span>
        <h2 id="trash-title">将 {props.count} 项源媒体移入回收站？</h2>
        <p>源文件将移入 Windows 回收站，可尝试从回收站恢复；Apple 实况照片的静态照片与伴随视频会一起移动。应用不会永久删除，也不会清空回收站。</p>
        <div className="confirm-actions"><button type="button" className="secondary-action" disabled={props.busy} onClick={props.onCancel}>取消</button><button type="button" className="danger-action solid" disabled={props.busy} onClick={props.onConfirm}>{props.busy ? <SpinnerGap className="spin" size={17} /> : <Trash size={17} />}确认移入回收站</button></div>
      </section>
    </div>
  );
}
