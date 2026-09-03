import { CheckCircle, CheckSquare, CornersOut, FolderOpen, MapTrifold, Minus, Scan, SpinnerGap, Tag, WarningCircle, X } from '@phosphor-icons/react';
import type { WindowAction } from '../../shared/contracts';
import type { AppMode, OperationFeedback, ScanProgress } from '../model';

export function Header(props: {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  onWindowAction: (action: WindowAction) => void;
}): React.JSX.Element {
  const annotationActive = props.mode !== 'wall';
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><MapTrifold size={22} weight="duotone" /></span>
        <span className="brand-copy"><strong>用照片记录足迹</strong></span>
      </div>
      <nav className="mode-switch" aria-label="主模式">
        <button
          type="button"
          className={props.mode === 'wall' ? 'active' : ''}
          aria-current={props.mode === 'wall' ? 'page' : undefined}
          onClick={() => props.onModeChange('wall')}
        >
          <MapTrifold size={19} weight={props.mode === 'wall' ? 'fill' : 'regular'} />
          <span>照片墙模式</span>
        </button>
        <button
          type="button"
          className={annotationActive ? 'active' : ''}
          aria-current={annotationActive ? 'page' : undefined}
          onClick={() => props.onModeChange(annotationActive ? props.mode : 'memory')}
        >
          <Tag size={19} weight={annotationActive ? 'fill' : 'regular'} />
          <span>批注模式</span>
        </button>
      </nav>
      <div className="window-actions" aria-label="窗口操作">
        <button type="button" aria-label="最小化" onClick={() => props.onWindowAction('minimize')}><Minus size={18} /></button>
        <button type="button" aria-label="最大化或还原" onClick={() => props.onWindowAction('toggleMaximize')}><CornersOut size={17} /></button>
        <button type="button" aria-label="关闭" onClick={() => props.onWindowAction('close')}><X size={18} /></button>
      </div>
    </header>
  );
}

export function AnnotationModeButton(props: {
  mode: Exclude<AppMode, 'wall'>;
  onModeChange: (mode: Exclude<AppMode, 'wall'>) => void;
  className?: string;
}): React.JSX.Element {
  const batchEnabled = props.mode === 'batch';
  return (
    <button
      type="button"
      className={['annotation-mode-button', batchEnabled ? 'is-active' : '', props.className].filter(Boolean).join(' ')}
      data-testid="annotation-mode-button"
      aria-pressed={batchEnabled}
      onClick={() => props.onModeChange(batchEnabled ? 'memory' : 'batch')}
    >
      {batchEnabled
        ? <CheckSquare className="annotation-mode-button-icon" data-state-icon="checked" size={20} weight="regular" aria-hidden="true" />
        : <Scan className="annotation-mode-button-icon" data-state-icon="scan" size={20} weight="regular" aria-hidden="true" />}
      <span>批量修改</span>
    </button>
  );
}

export function EmptySource(props: {
  busy: boolean;
  error?: string;
  onChoose: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <main className="source-empty" data-testid="source-empty">
      <div className="source-empty-visual" aria-hidden="true">
        <span><MapTrifold size={52} weight="duotone" /></span>
        <i /><i /><i />
      </div>
      <p className="eyebrow">完全离线的照片地图</p>
      <h1>从一个照片文件夹开始</h1>
      <p className="source-empty-copy">选择本机文件夹后，我们会为常见照片、视频，以及 Apple 与安卓实况照片建立本地索引，并在本地读取照片的 EXIF 拍摄时间；省市地图数据就绪后，还会把 GPS 匹配为地址。媒体不会上传，扫描结果只会在你确认后写入本地索引。</p>
      {props.error && <div className="inline-alert error"><WarningCircle size={18} /><span>{props.error}</span></div>}
      <div className="source-empty-actions">
        <button
          className="primary-action large"
          type="button"
          data-testid="source-picker"
          onClick={props.onChoose}
          disabled={props.busy}
        >
          {props.busy ? <SpinnerGap className="spin" size={20} /> : <FolderOpen size={20} weight="duotone" />}
          {props.busy ? '正在打开…' : '选择照片文件夹'}
        </button>
        {props.error && <button type="button" className="text-action" onClick={props.onRetry}>重新载入应用</button>}
      </div>
      <div className="privacy-row">
        <span><CheckCircle size={15} weight="fill" />完全离线</span>
        <span><CheckCircle size={15} weight="fill" />EXIF / GPS / 拍摄时间仅本地读取</span>
        <span><CheckCircle size={15} weight="fill" />不改写源照片</span>
      </div>
    </main>
  );
}

export function StatusBar(props: {
  count: number;
  scan?: ScanProgress;
  version?: string;
  unitLabel?: string;
}): React.JSX.Element {
  const status = props.scan?.state;
  return (
    <footer className="status-bar">
      <span data-testid="library-photo-count">本地索引 · {props.count.toLocaleString('zh-CN')} {props.unitLabel ?? '张'}</span>
      <span className={status === 'failed' || status === 'partial' ? 'status-warning' : 'status-ok'}>
        {status === 'failed' || status === 'partial' ? <WarningCircle size={13} weight="fill" /> : <CheckCircle size={13} weight="fill" />}
        {status === 'running' ? '扫描进行中' : status === 'partial' ? '扫描部分完成' : status === 'failed' ? '扫描失败' : '本地索引就绪'}
      </span>
      <span className="status-spacer" />
      <span>完全离线</span>
      {props.version && <span>版本 {props.version}</span>}
    </footer>
  );
}

export function Toast({ feedback }: { feedback?: OperationFeedback }): React.JSX.Element | null {
  if (!feedback) return null;
  const Icon = feedback.kind === 'error' || feedback.kind === 'warning' ? WarningCircle : CheckCircle;
  return <div className={`toast ${feedback.kind}`} role="status"><Icon size={19} weight="fill" /><span>{feedback.message}</span></div>;
}

export function EmptyResults(props: { onClearFilters: () => void; onGoBatch?: () => void }): React.JSX.Element {
  return (
    <div className="empty-results">
      <MapTrifold size={36} weight="duotone" />
      <strong>当前筛选没有照片</strong>
      <span>应用不会自动放宽你的筛选条件。</span>
      <div><button type="button" className="secondary-action" onClick={props.onClearFilters}>清空筛选</button>{props.onGoBatch && <button type="button" className="text-action" onClick={props.onGoBatch}>切换到批量</button>}</div>
    </div>
  );
}
