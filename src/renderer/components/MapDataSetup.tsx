import {
  ArrowSquareOut,
  CheckCircle,
  Database,
  FileArrowDown,
  FolderOpen,
  MapPin,
  ShieldCheck,
  SpinnerGap,
  WarningCircle,
} from '@phosphor-icons/react';
import type { MapDataStatus } from '../../shared/contracts';

export interface MapDataSetupProps {
  status: MapDataStatus;
  busy: boolean;
  onDownload: () => void;
  onImport: () => void;
}

export function MapDataSetup(props: MapDataSetupProps): React.JSX.Element {
  return (
    <main
      className={`map-data-setup${props.status.ready ? ' is-ready' : ''}`}
      data-testid="map-data-setup"
    >
      <div className="map-data-setup-content">
        <div className="map-data-setup-visual" aria-hidden="true">
          <span className="map-data-setup-file"><MapPin size={34} weight="duotone" /></span>
          <span className="map-data-setup-database"><Database size={42} weight="duotone" /></span>
          <span className="map-data-setup-download"><FileArrowDown size={24} weight="bold" /></span>
        </div>

        <p className="map-data-setup-eyebrow">照片墙所需资源</p>
        <h1>请先完成地图数据导入</h1>
        <p className="map-data-setup-copy">省份数据和城市数据都导入后，才能使用照片墙模式。</p>

        <section className="map-data-progress-card" aria-labelledby="map-data-progress-title">
          <header className="map-data-progress-header">
            <h2 id="map-data-progress-title">地图数据准备进度</h2>
            <span className="map-data-progress-count" data-testid="map-data-progress-count">
              已完成 {props.status.completed} / {props.status.total}
            </span>
          </header>
          <ul className="map-data-progress-list">
            {props.status.items.map((item) => (
              <li
                className={item.imported ? 'is-imported' : 'is-missing'}
                data-testid={`map-data-status-${item.kind}`}
                key={item.kind}
              >
                <span className="map-data-progress-state" aria-hidden="true">
                  {item.imported ? <CheckCircle size={23} weight="fill" /> : <span />}
                </span>
                <span className="map-data-progress-label">{item.label}</span>
                <strong>{item.imported ? '已导入' : '未导入'}</strong>
              </li>
            ))}
          </ul>
        </section>

        {props.status.error && (
          <div className="map-data-setup-error" role="alert" data-testid="map-data-setup-error">
            <WarningCircle size={18} weight="fill" aria-hidden="true" />
            <span>{props.status.error}</span>
          </div>
        )}

        <div className="map-data-setup-actions">
          <button
            type="button"
            className="secondary-action large"
            data-testid="map-data-download"
            onClick={props.onDownload}
          >
            <ArrowSquareOut size={19} weight="bold" aria-hidden="true" />
            天地图下载地图
          </button>
          <button
            type="button"
            className="primary-action large"
            data-testid="map-data-import"
            disabled={props.busy}
            aria-busy={props.busy}
            onClick={props.onImport}
          >
            {props.busy
              ? <SpinnerGap className="spin" size={20} aria-hidden="true" />
              : <FolderOpen size={20} weight="duotone" aria-hidden="true" />}
            {props.busy ? '正在导入…' : '导入地图数据'}
          </button>
        </div>

        <p className="map-data-setup-privacy">
          <ShieldCheck size={19} weight="fill" aria-hidden="true" />
          地图与照片数据均仅保存在本机
        </p>
      </div>
    </main>
  );
}
