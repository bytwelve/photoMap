import {
  CaretRight,
  MapPin,
  Plus,
  ShieldCheck,
  SpinnerGap,
  WarningCircle,
} from '@phosphor-icons/react';
import { useEffect } from 'react';

import type { ScanLocationDecision } from '../../shared/contracts';

export interface ScanMetadataDialogProps {
  total: number;
  exifCount: number;
  gpsCount: number;
  resolvedLocationCount: number;
  captureTimeCount: number;
  metadataErrorCount: number;
  busy: boolean;
  pendingDecision?: ScanLocationDecision;
  onDecision: (decision: ScanLocationDecision) => void;
}

export function ScanMetadataDialog(props: ScanMetadataDialogProps): React.JSX.Element {
  const canApply = (props.resolvedLocationCount > 0 || props.captureTimeCount > 0) && !props.busy;

  useEffect(() => {
    const ignoreOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !props.busy) {
        event.preventDefault();
        props.onDecision('ignore');
      }
    };

    window.addEventListener('keydown', ignoreOnEscape);
    return () => window.removeEventListener('keydown', ignoreOnEscape);
  }, [props.busy, props.onDecision]);

  function decide(decision: ScanLocationDecision): void {
    if (props.busy) return;
    if (decision !== 'ignore' && !canApply) return;
    props.onDecision(decision);
  }

  function trailingIcon(decision: ScanLocationDecision): React.JSX.Element {
    return props.pendingDecision === decision
      ? <SpinnerGap className="spin" size={23} aria-hidden="true" />
      : <CaretRight size={24} weight="bold" aria-hidden="true" />;
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.busy) {
          props.onDecision('ignore');
        }
      }}
    >
      <section
        className="confirm-dialog scan-metadata-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scan-metadata-title"
        aria-describedby="scan-metadata-summary scan-metadata-safety"
        aria-busy={props.busy}
        data-testid="scan-metadata-dialog"
      >
        <header className="scan-metadata-header">
          <h2 id="scan-metadata-title">如何处理扫描到的照片信息？</h2>
          <p id="scan-metadata-summary" className="scan-metadata-summary">
            本次共加载 <strong data-testid="scan-metadata-total">{props.total}</strong> 张照片，
            其中 <strong data-testid="scan-metadata-exif">{props.exifCount}</strong> 张包含 EXIF、
            <strong data-testid="scan-metadata-gps">{props.gpsCount}</strong> 张包含 GPS，
            <strong data-testid="scan-metadata-resolved">{props.resolvedLocationCount}</strong> 张可匹配省市，
            <strong data-testid="scan-metadata-capture-time">{props.captureTimeCount}</strong> 张读取到拍摄时间。请选择处理方式。
          </p>
        </header>

        {props.metadataErrorCount > 0 && (
          <div className="scan-metadata-notice warning" role="status" data-testid="scan-metadata-errors">
            <WarningCircle size={18} weight="fill" aria-hidden="true" />
            <span>{props.metadataErrorCount} 张照片有部分元数据无效；可用信息仍会保留，无效部分已跳过。</span>
          </div>
        )}

        <div className="scan-metadata-actions" role="group" aria-label="GPS 地址与拍摄时间处理方式">
          <button
            type="button"
            className="scan-metadata-choice scan-metadata-choice-ignore"
            data-testid="scan-metadata-ignore"
            autoFocus
            disabled={props.busy}
            onClick={() => decide('ignore')}
          >
            <span className="scan-metadata-choice-icon" aria-hidden="true">
              <ShieldCheck size={32} weight="duotone" />
            </span>
            <span className="scan-metadata-choice-copy">
              <strong>忽略 GPS 地址与拍摄时间</strong>
              <small>不写入本次 GPS 匹配结果和拍摄时间，所有照片保持现有信息。</small>
            </span>
            <span className="scan-metadata-choice-tail">{trailingIcon('ignore')}</span>
          </button>

          <button
            type="button"
            className="scan-metadata-choice scan-metadata-choice-overwrite"
            data-testid="scan-metadata-overwrite"
            disabled={!canApply}
            onClick={() => decide('overwrite-all-resolved')}
          >
            <span className="scan-metadata-choice-icon" aria-hidden="true">
              <MapPin size={32} weight="duotone" />
            </span>
            <span className="scan-metadata-choice-copy">
              <span className="scan-metadata-choice-title">
                <strong>应用 GPS 地址与拍摄时间</strong>
                <em className="scan-metadata-badge warning">会覆盖已有地址</em>
              </span>
              <small>更新所有可匹配的 GPS 地址，并写入扫描到的拍摄时间；手动修改过的拍摄时间保持不变。</small>
            </span>
            <span className="scan-metadata-choice-tail">{trailingIcon('overwrite-all-resolved')}</span>
          </button>

          <button
            type="button"
            className="scan-metadata-choice scan-metadata-choice-fill"
            data-testid="scan-metadata-fill-unlabeled"
            disabled={!canApply}
            onClick={() => decide('fill-unlabeled-only')}
          >
            <span className="scan-metadata-choice-icon" aria-hidden="true">
              <Plus size={32} weight="bold" />
            </span>
            <span className="scan-metadata-choice-copy">
              <span className="scan-metadata-choice-title">
                <strong>仅为缺少信息的照片补充</strong>
                <em className="scan-metadata-badge recommended">推荐</em>
              </span>
              <small>分别补充缺少的 GPS 地址和拍摄时间，已有地址与手动修改过的拍摄时间保持不变。</small>
            </span>
            <span className="scan-metadata-choice-tail">{trailingIcon('fill-unlabeled-only')}</span>
          </button>
        </div>

        <p id="scan-metadata-safety" className="scan-metadata-safety">
          <ShieldCheck size={18} weight="fill" aria-hidden="true" />
          <span>没有可用 GPS 地址或拍摄时间的照片不会写入空值，也不会清除已有信息；手动修改的拍摄时间不会被扫描覆盖。元数据仅在本地读取。</span>
        </p>
      </section>
    </div>
  );
}
