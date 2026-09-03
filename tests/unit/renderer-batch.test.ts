import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { BatchView } from '../../src/renderer/features/batch/BatchView';
import {
  hasReachedBatchDragThreshold,
  normalizeBatchColumnCount,
  selectionBoundsFromPoints,
  selectionBoundsIntersect,
} from '../../src/renderer/domain';
import type { PhotoRecord } from '../../src/renderer/model';

const photo: PhotoRecord = {
  id: 'photo-1',
  name: 'photo-1.jpg',
  mediaUrl: 'photomap-media://photo/photo-1',
  thumbnailUrl: 'photomap-media://photo/photo-1',
  mediaKind: 'photo',
  mediaFormat: 'jpg',
  decodeState: 'valid',
  width: 1536,
  height: 1024,
  types: [],
};

describe('PRD-FR-020 merged batch selection controls', () => {
  it('renders the result summary, actions, and selection help in the requested order', () => {
    const markup = renderToStaticMarkup(createElement(BatchView, {
      photos: [photo],
      selectedIds: new Set<string>([photo.id]),
      onSelectedIdsChange: vi.fn(),
      onSelectionMessage: vi.fn(),
      onClearFilters: vi.fn(),
      onGoCarousel: vi.fn(),
      onOpenPostcard: vi.fn(),
    }));

    expect(markup).toContain('data-testid="annotation-mode-button"');
    expect(markup).toMatch(/<button[^>]*class="annotation-mode-button is-active"[^>]*aria-pressed="true"/u);
    expect(markup).toContain('data-state-icon="checked"');
    expect(markup).not.toContain('data-state-icon="scan"');
    expect(markup).not.toContain('role="switch"');
    expect(markup).not.toContain('aria-checked');
    expect(markup).not.toContain('annotation-switch-track');
    expect(markup).toContain('批量修改');
    expect(markup).toContain('当前结果 1 项');
    expect(markup).toContain('已选 1 项');
    expect(markup).toContain('单击媒体切换选择，右下角打开明信片，按住拖动可框选多项');
    expect(markup).toContain('data-testid="batch-operation-guide"');
    expect(markup).toContain('role="note"');
    expect(markup).not.toContain('>隐藏</button>');
    expect(markup).not.toContain('显示提示');
    expect(markup).toContain('class="batch-column-control"');
    expect(markup).toContain('每行');
    expect(markup).toContain('张');
    expect(markup).toContain('type="number"');
    expect(markup).toContain('aria-label="每行照片数量"');
    expect(markup).toContain('min="2"');
    expect(markup).toContain('max="10"');
    expect(markup).toContain('step="1"');
    expect(markup).toContain('value="4"');
    expect(markup.indexOf('当前结果 1 项')).toBeLessThan(markup.indexOf('data-testid="batch-column-input"'));
    expect(markup.indexOf('data-testid="batch-column-input"')).toBeLessThan(markup.indexOf('全选当前结果'));
    expect(markup.indexOf('全选当前结果')).toBeLessThan(markup.indexOf('单击媒体切换选择'));
    expect(markup).toContain('全选当前结果');
    expect(markup).toContain('清空已选');
    expect(markup.match(/class="photo-card-selection"/g)).toHaveLength(1);
    expect(markup.match(/data-testid="photo-postcard-entry"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="在明信片模式中打开 photo-1.jpg"');
    expect(markup).not.toContain('data-testid="postcard-file-name-row"');
    expect(markup).not.toContain('data-testid="postcard-rename-edit"');
    expect(markup).not.toContain('data-testid="postcard-file-name-editor"');
    expect(markup).not.toContain('data-testid="postcard-rename-');
    expect(markup).toMatch(/<article[^>]*data-photo-id="photo-1"[\s\S]*?<button[^>]*class="photo-card-selection"[\s\S]*?<\/button>[\s\S]*?<button[^>]*class="photo-postcard-entry"/u);
    expect(markup).not.toContain('滚轮');
    expect(markup).not.toContain('拖动框选中');
    expect(markup).not.toContain('每行 4 张');
    expect(markup).not.toContain('共 1 张照片');
    expect(markup).toContain('grid-template-columns:repeat(4, minmax(0, 1fr))');
  });

  it('keeps both top bars and centers empty results in the remaining content stage', () => {
    const markup = renderToStaticMarkup(createElement(BatchView, {
      photos: [],
      selectedIds: new Set<string>(),
      onSelectedIdsChange: vi.fn(),
      onSelectionMessage: vi.fn(),
      onClearFilters: vi.fn(),
      onGoCarousel: vi.fn(),
      onOpenPostcard: vi.fn(),
    }));

    expect(markup).toContain('data-testid="batch-view"');
    expect(markup).toContain('class="batch-toolbar"');
    expect(markup).toContain('class="operation-guide batch-operation-guide"');
    expect(markup).toContain('data-testid="batch-empty-stage"');
    expect(markup).toContain('当前结果 0 项');
    expect(markup).toContain('已选 0 项');
    expect(markup).toContain('全选当前结果');
    expect(markup).toContain('清空已选');
    expect(markup).toContain('当前筛选没有照片');
    expect(markup).toContain('清空筛选');
    expect(markup.indexOf('class="batch-toolbar"')).toBeLessThan(markup.indexOf('data-testid="batch-operation-guide"'));
    expect(markup.indexOf('data-testid="batch-operation-guide"')).toBeLessThan(markup.indexOf('data-testid="batch-empty-stage"'));
    expect(markup.indexOf('data-testid="batch-empty-stage"')).toBeLessThan(markup.indexOf('当前筛选没有照片'));
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).not.toContain('data-testid="batch-grid"');
  });

  it('prd_ac_010__renders_an_intrinsic_media_badge_for_photo_video_and_live_cards', () => {
    const video = { ...photo, id: 'video-1', name: 'video.mp4', mediaKind: 'video' as const, mediaFormat: 'mp4' as const };
    const live = { ...photo, id: 'live-1', name: 'motion.jpg', mediaKind: 'live' as const };
    const markup = renderToStaticMarkup(createElement(BatchView, {
      photos: [photo, video, live],
      selectedIds: new Set<string>(),
      onSelectedIdsChange: vi.fn(),
      onSelectionMessage: vi.fn(),
      onClearFilters: vi.fn(),
      onGoCarousel: vi.fn(),
      onOpenPostcard: vi.fn(),
    }));

    expect(markup.match(/data-testid="media-kind-badge"/g)).toHaveLength(3);
    expect(markup.match(/data-testid="photo-postcard-entry"/g)).toHaveLength(3);
    expect(markup).toContain('【照片】');
    expect(markup).toContain('【视频】');
    expect(markup).toContain('【实况】');
  });

  it('normalizes manual column input to the supported integer range', () => {
    expect(normalizeBatchColumnCount(2)).toBe(2);
    expect(normalizeBatchColumnCount(10)).toBe(10);
    expect(normalizeBatchColumnCount(1)).toBe(2);
    expect(normalizeBatchColumnCount(11)).toBe(10);
    expect(normalizeBatchColumnCount('6.6')).toBe(7);
    expect(normalizeBatchColumnCount('', 6)).toBe(6);
    expect(normalizeBatchColumnCount('not-a-number', 5)).toBe(5);
  });

  it('enters drag selection only after the four-pixel movement threshold', () => {
    const start = { x: 20, y: 30 };

    expect(hasReachedBatchDragThreshold(start, { x: 23.9, y: 30 })).toBe(false);
    expect(hasReachedBatchDragThreshold(start, { x: 24, y: 30 })).toBe(true);
    expect(hasReachedBatchDragThreshold(start, { x: 23, y: 33 })).toBe(true);
  });

  it('normalizes reverse drags and includes cards touching the selection boundary', () => {
    const selection = selectionBoundsFromPoints({ x: 30, y: 40 }, { x: 10, y: 15 });

    expect(selection).toEqual({ x: 10, y: 15, width: 20, height: 25 });
    expect(selectionBoundsIntersect(selection, { x: 30, y: 20, width: 10, height: 10 })).toBe(true);
    expect(selectionBoundsIntersect(selection, { x: 30.1, y: 20, width: 10, height: 10 })).toBe(false);
  });
});
