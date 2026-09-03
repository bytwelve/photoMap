import { Check } from '@phosphor-icons/react';
import { MEDIA_KINDS } from '../../shared/contracts';
import type { AppMode, MediaKind } from '../model';

const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  photo: '照片',
  video: '视频',
  live: '实况',
};

export function MediaKindFilter(props: {
  mode: AppMode;
  selectedKinds: ReadonlySet<MediaKind>;
  counts: ReadonlyMap<MediaKind, number>;
  onToggle: (mediaKind: MediaKind) => void;
}): React.JSX.Element {
  return (
    <div className="media-kind-filter-list" role="group" aria-label="媒体种类">
      {MEDIA_KINDS.map((mediaKind) => {
        const unavailable = props.mode === 'wall' && mediaKind !== 'photo';
        const active = !unavailable && props.selectedKinds.has(mediaKind);
        const label = MEDIA_KIND_LABELS[mediaKind];
        const count = props.counts.get(mediaKind) ?? 0;
        return (
          <button
            type="button"
            className={`${active ? 'active' : ''}${unavailable ? ' unavailable' : ''}`.trim()}
            data-testid={`media-kind-filter-${mediaKind}`}
            aria-label={`${label}，${count} 项${unavailable ? '，照片墙不可用' : ''}`}
            aria-pressed={active}
            disabled={unavailable}
            onClick={() => props.onToggle(mediaKind)}
            key={mediaKind}
          >
            <span className="media-kind-check" aria-hidden="true">{active ? <Check size={12} weight="bold" /> : null}</span>
            <span>{label}</span>
            <small>{count}</small>
          </button>
        );
      })}
    </div>
  );
}
