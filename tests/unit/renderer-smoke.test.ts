import { readFileSync } from 'node:fs';
import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CITIES,
  PROVINCES,
  type AdministrativeRegion as RegionOption,
} from '../../src/shared/administrative-regions';
import { App } from '../../src/renderer/App';
import { BatchView } from '../../src/renderer/features/batch/BatchView';
import { ContextSidebar, FixedPhotoDialog } from '../../src/renderer/components/ContextSidebar';
import { ExportDialog } from '../../src/renderer/features/export/ExportDialog';
import { autoScrollDurationMs, incomingPostcardProgress, nextWheelGestureProgress, normalizeAutoScrollSpeed, normalizeWheelDelta, postcardMoveDestination, postcardMotionPose, queuedPostcardPose, shouldAdvanceWheelGesture, terminalPostcardScale, type PostcardMotionGeometry, uniformCurveParameter } from '../../src/renderer/features/postcard/postcard-motion';
import { isImeCompositionKey } from '../../src/renderer/features/postcard/PostcardEditor';
import { PostcardView } from '../../src/renderer/features/postcard/PostcardView';
import { PostcardCompletion } from '../../src/renderer/features/postcard/PostcardCompletion';
import { densityFromWheel, PhotoWall } from '../../src/renderer/features/photo-wall/PhotoWall';
import { EmptySource, Header } from '../../src/renderer/components/Shell';
import { FolderFilter } from '../../src/renderer/components/FolderFilter';
import { LeftSidebar } from '../../src/renderer/components/LeftSidebar';
import { MediaKindFilter } from '../../src/renderer/components/MediaKindFilter';
import type { PhotoRecord } from '../../src/renderer/model';
import { createSnapshot, renderSnapshotToDataUrl } from '../../src/renderer/map-scene/scene';
import {
  addShareText,
  createDefaultShareDocument,
  updateShareText,
} from '../../src/renderer/share-document';

const rendererStyleSource = ["base.css","postcard.css","batch.css","dialogs.css","export.css","responsive.css","scan-metadata.css"].map((name) => readFileSync(
  new URL('../../src/renderer/styles/' + name, import.meta.url), 'utf8',
)).join('\n');
const rendererIndexSource = readFileSync(
  new URL('../../src/renderer/index.html', import.meta.url),
  'utf8',
);
const forgeConfigSource = readFileSync(
  new URL('../../forge.config.ts', import.meta.url),
  'utf8',
);
const memoryViewSource = ["PostcardView.tsx","postcard-motion.ts","PostcardEditor.tsx","PostcardMedia.tsx","PostcardPreview.tsx","PostcardCompletion.tsx"].map((file) => readFileSync(
  new URL('../../src/renderer/features/postcard/' + file, import.meta.url), 'utf8',
)).join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
});

function regionOption(level: RegionOption['level'], code: string): RegionOption {
  const option = (level === 'province' ? PROVINCES : CITIES).find((region) => region.code === code);
  if (option === undefined) throw new Error(`Missing ${level} fixture ${code}`);
  return option;
}

function expectMarkupOrder(markup: string, markers: readonly string[]): void {
  const positions = markers.map((marker) => markup.indexOf(marker));
  for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
  for (let index = 1; index < positions.length; index += 1) {
    expect(positions[index - 1]!).toBeLessThan(positions[index]!);
  }
}

function findReactElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<Record<string, unknown>>;
  if (predicate(element)) return element;
  for (const child of Children.toArray((element.props as { children?: ReactNode }).children)) {
    const match = findReactElement(child, predicate);
    if (match) return match;
  }
  return undefined;
}

function postcardPreview(
  markup: string,
  testId: 'postcard-previous' | 'postcard-next' | 'postcard-after-next',
): string {
  const match = markup.match(new RegExp(`data-testid="${testId}"[\\s\\S]*?<\\/article>`, 'u'));
  expect(match, `${testId} should render a postcard article`).not.toBeNull();
  return match?.[0] ?? '';
}

describe('PRD-FR-001 renderer basic rendering', () => {
  it('prd_fr_010__application_starts__renders_root_component__shows_single_window_boot_shell', () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('desktop-app boot-screen');
    expect(markup).toContain('正在打开本地照片地图');
    expect(markup).toContain('用照片记录足迹');
    expect(markup).not.toContain('记录足迹 · 收藏美好');
    expect(markup).toContain('照片墙模式');
    expect(markup).toContain('批注模式');
    expect(markup).not.toContain('回忆模式');
    expect(markup).not.toContain('批量模式');
  });

  it('header__groups_annotation_views__renders_two_top_level_modes', () => {
    const wallMarkup = renderToStaticMarkup(createElement(Header, {
      mode: 'wall',
      onModeChange: vi.fn(),
      onWindowAction: vi.fn(),
    }));
    const annotationMarkup = renderToStaticMarkup(createElement(Header, {
      mode: 'memory',
      onModeChange: vi.fn(),
      onWindowAction: vi.fn(),
    }));
    const wallModeNav = wallMarkup.slice(wallMarkup.indexOf('<nav class="mode-switch"'), wallMarkup.indexOf('<div class="window-actions"'));
    const annotationModeNav = annotationMarkup.slice(annotationMarkup.indexOf('<nav class="mode-switch"'), annotationMarkup.indexOf('<div class="window-actions"'));

    expect(wallModeNav.match(/<button/g)).toHaveLength(2);
    expect(wallModeNav).toMatch(/class="active" aria-current="page"[\s\S]*?照片墙模式/u);
    expect(annotationModeNav.match(/<button/g)).toHaveLength(2);
    expect(annotationModeNav).toMatch(/class="active" aria-current="page"[\s\S]*?批注模式/u);
    expect(annotationModeNav).not.toContain('回忆模式');
    expect(annotationModeNav).not.toContain('批量模式');
  });

  it('header__from_wall__opens_annotation_in_memory_mode_by_default', () => {
    const onModeChange = vi.fn();
    const header = Header({
      mode: 'wall',
      onModeChange,
      onWindowAction: vi.fn(),
    });
    const modeSwitch = findReactElement(
      header,
      (element) => element.type === 'nav' && element.props['aria-label'] === '主模式',
    );
    const annotationButtonNode = Children.toArray(modeSwitch?.props.children as ReactNode)[1];
    const annotationButton = isValidElement(annotationButtonNode)
      ? annotationButtonNode as ReactElement<Record<string, unknown>>
      : undefined;

    expect(annotationButton).toBeDefined();
    const onClick = annotationButton?.props.onClick as (() => void) | undefined;
    expect(onClick).toBeTypeOf('function');
    onClick?.();

    expect(onModeChange).toHaveBeenCalledOnce();
    expect(onModeChange).toHaveBeenCalledWith('memory');
  });

  it('prd_fr_001__no_library_selected__renders_renderer__shows_real_empty_source_and_picker', () => {
    const markup = renderToStaticMarkup(createElement(EmptySource, {
      busy: false,
      onChoose: () => undefined,
      onRetry: () => undefined,
    }));

    expect(markup).toContain('data-testid="source-empty"');
    expect(markup).toContain('data-testid="source-picker"');
    expect(markup).toContain('选择照片文件夹');
    expect(markup).toContain('媒体不会上传');
    expect(markup).not.toContain('data-testid="wall-canvas"');
  });

  it('photo_wall__renders_main_map__moves_density_to_toolbar_and_omits_removed_chrome', () => {
    const regions = { type: 'FeatureCollection' as const, features: [] };
    const markup = renderToStaticMarkup(createElement(PhotoWall, {
      provinces: regions,
      cities: regions,
      photos: [],
      fixedPhotoSelections: new Map(),
      mapPreference: {
        level: 'province',
        showPhotos: true,
        showPlaceNames: true,
        density: 3,
        camera: { zoom: 1, panX: 0, panY: 0 },
      },
      onMapPreferenceChange: vi.fn(),
      onSelectedRegionChange: vi.fn(),
      onSnapshotChange: vi.fn(),
    }));

    expect(markup).toContain('data-testid="wall-canvas"');
    expect(markup).toContain('滚轮缩放');
    expect(markup).not.toContain('class="map-controls"');
    expect(markup).not.toContain('aria-label="地图缩放"');
    expect(markup).not.toContain('class="best-marker');
    expect(markup).not.toContain('class="zoom-readout"');
    expect(markup).not.toContain('导出当前视口');
    expect(markup).not.toContain('class="thumbnail-strip"');
    expect(markup).not.toContain('当前结果');
    expect(markup).not.toContain('<span class="eyebrow">照片墙</span>');
    expect(markup).not.toContain('全国省份视图');
    expect(markup).toContain('<div class="wall-toolbar"><div class="density-control">');
    expect(markup.match(/class="density-control"/gu)).toHaveLength(1);
    expect(markup).toContain('data-testid="map-density"');
    expect(markup).toContain('max="9"');
    expect(markup).toContain('data-testid="density-best"');
    expect(markup).toContain('>最佳</button>');
    expect(markup).toContain('data-testid="place-name-visibility"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('显示地名');
    expect(markup).toContain('data-testid="wall-operation-guide"');
    expect(markup).toContain('class="operation-guide wall-operation-guide"');
    expect(markup).toContain('role="note"');
    expect(markup).toContain('单击行政区查看详情，滚轮缩放地图，放大后按住拖动');
    expect(markup).not.toContain('aria-controls="wall-operation-guide"');
    expect(markup).not.toContain('>隐藏</button>');
    expect(markup).not.toContain('显示操作说明');
    expect(markup.indexOf('class="wall-toolbar"')).toBeLessThan(markup.indexOf('data-testid="wall-operation-guide"'));
    expect(markup.indexOf('data-testid="wall-operation-guide"')).toBeLessThan(markup.indexOf('data-testid="wall-canvas"'));
    expect(rendererStyleSource).toMatch(/\.wall-workspace\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/su);
    expect(rendererStyleSource).toMatch(/\.wall-card\.has-operation-guide \.map-stage\s*\{[^}]*inset:\s*92px 0 0;/su);
    expect(rendererStyleSource).toMatch(/\.wall-card\.has-operation-guide \.map-error\s*\{[^}]*inset:\s*92px 0 0;/su);
  });

  it('photo_wall__density_wheel__moves_one_step_and_stays_within_the_extended_range', () => {
    expect(densityFromWheel(5, -120)).toBe(6);
    expect(densityFromWheel(5, 120)).toBe(4);
    expect(densityFromWheel(1, 120)).toBe(1);
    expect(densityFromWheel(9, -120)).toBe(9);
    expect(densityFromWheel(5, 0)).toBe(5);
  });

  it('memory_view__renders_postcard_editor__omits_the_filtered_thumbnail_module', () => {
    const photos: PhotoRecord[] = [
      {
        id: 'memory-one',
        name: 'one.jpg',
        mediaUrl: 'photomap-media://photo/memory-one',
        thumbnailUrl: 'photomap-media://photo/memory-one',
        mediaKind: 'photo',
        mediaFormat: 'jpg',
        fileCreatedAtMs: new Date(2026, 7, 24, 9, 7).getTime(),
        captureTimeLocal: '2026-06-17T15:44:34',
        captureTimeOffsetMinutes: 480,
        captureTimeSource: 'metadata',
        note: '第一次看到晨雾。',
        decodeState: 'valid',
        location: {
          provinceCode: '156420000',
          provinceName: '湖北省',
          cityCode: '156420100',
          cityName: '武汉市',
        },
        types: [{ id: 'landscape', name: '风景' }],
      },
      {
        id: 'memory-two',
        name: 'two.mp4',
        mediaUrl: 'photomap-media://photo/memory-two',
        thumbnailUrl: 'photomap-media://photo/memory-two?size=thumb',
        mediaKind: 'video',
        mediaFormat: 'mp4',
        captureTimeLocal: null,
        captureTimeOffsetMinutes: null,
        captureTimeSource: null,
        decodeState: 'valid',
        types: [],
      },
    ];
    const markup = renderToStaticMarkup(createElement(PostcardView, {
      photos,
      activeId: 'memory-one',
      provinces: PROVINCES,
      cities: CITIES,
      photoTypes: [{ id: 'landscape', name: '风景' }],
      onActiveIdChange: vi.fn(),
      onClearFilters: vi.fn(),
      onGoBatch: vi.fn(),
      onUpdateLocation: vi.fn(async () => true),
      onUpdateTypes: vi.fn(async () => true),
      onUpdateNote: vi.fn(async () => true),
      onUpdateCaptureTime: vi.fn(async () => true),
      onRenamePhoto: vi.fn(async () => true),
      onRequestTrash: vi.fn(),
    }));

    const toolbarMarkup = markup.match(/<header class="postcard-toolbar">[\s\S]*?<\/header>/u)?.[0] ?? '';
    expect(markup.match(/data-testid="postcard-stage-controls"/gu)).toHaveLength(1);
    expect(markup).toContain('data-testid="postcard-stage-controls" role="group" aria-label="照片页码与自动滚动"');
    expect(markup).toContain('class="postcard-counter" aria-live="polite"><span>第</span><b>1</b><span>/ 2 张</span></strong>');
    expectMarkupOrder(markup, [
      'data-testid="postcard-stage-controls"',
      'class="postcard-counter"',
      'data-testid="auto-scroll-toggle"',
      'class="auto-speed-control"',
    ]);
    expect(toolbarMarkup).not.toContain('auto-scroll-controls');
    expect(toolbarMarkup).not.toContain('data-testid="auto-scroll-toggle"');
    expect(toolbarMarkup).not.toContain('auto-speed-control');
    expect(markup).toContain('data-testid="auto-scroll-toggle" aria-pressed="false"');
    expect(markup).toContain('aria-label="自动滚动速度" aria-valuetext="1.0×，每张约 5.2 秒"');
    expect(markup).toContain('<output>1.0×</output>');
    expect(markup).toContain('data-testid="annotation-mode-button"');
    expect(markup).toMatch(/<button[^>]*class="annotation-mode-button"[^>]*aria-pressed="false"/u);
    expect(markup).toContain('data-state-icon="scan"');
    expect(markup).not.toContain('data-state-icon="checked"');
    expect(markup).not.toContain('role="switch"');
    expect(markup).not.toContain('annotation-switch-track');
    expect(markup).toContain('data-testid="postcard-current"');
    expect(markup.match(/data-testid="postcard-file-name-row"/gu)).toHaveLength(1);
    expect(markup.match(/data-testid="postcard-rename-edit"/gu)).toHaveLength(1);
    expect(markup).toContain('文件名称');
    expect(markup).not.toContain('图片名称');
    expect(markup).toContain('aria-label="重命名 one.jpg"');
    expect(markup).toContain('title="修改完整文件名（含扩展名）"');
    expect(rendererStyleSource).toContain('.postcard-file-name-editor input');
    expect(memoryViewSource).toContain("setFileNameSaveState(nextFileName === props.photo.name ? 'saved' : 'pending')");
    expect(memoryViewSource).toContain("'文件名修改尚未确认'");
    expect(memoryViewSource).toMatch(/onKeyDown=\{\(event\) => \{\s*if \(isImeCompositionKey\(event\.nativeEvent\.isComposing, event\.keyCode\)\) return;\s*if \(event\.key === 'Enter'\)/u);
    expect(markup).not.toContain('data-testid="postcard-file-name-editor"');
    expect(markup).not.toContain('data-testid="postcard-rename-confirm"');
    expect(markup).not.toContain('data-testid="postcard-rename-cancel"');
    expect(markup.match(/data-testid="postcard-entry-media-target"/gu)).toHaveLength(1);
    expect(markup).toContain('【照片】');
    expect(markup).toContain('【视频】');
    expect(markup).toContain('src="photomap-media://photo/memory-two?size=thumb"');
    expect(markup).toContain('批注模式明信片视图');
    expect(markup).toContain('拍摄时间');
    expect(markup).toContain('data-testid="postcard-capture-time"');
    expect(markup).toContain('type="datetime-local"');
    expect(markup).toContain('step="1"');
    expect(markup).toContain('value="2026-06-17T15:44:34"');
    expect(markup).toContain('UTC+08:00');
    expect(markup).toContain('未读取到拍摄时间');
    expect(markup).not.toContain('创建时间');
    expect(markup).not.toContain('2026-08-24 09:07');
    expect(markup).toContain('data-testid="postcard-note"');
    expect(markup).toContain('maxLength="60"');
    expect(markup).toContain('第一次看到晨雾。');
    expect(markup).toContain('拍摄地点');
    expect(markup).toContain('>标签</h2>');
    expect(markup).not.toContain('当前筛选中的照片');
    expect(markup).not.toContain('class="thumbnail-strip"');
    expect(rendererStyleSource).toContain('view-transition-name: postcard-photo-expand;');
    expect(rendererStyleSource).toContain('::view-transition-group(postcard-photo-expand)');
    expect(rendererStyleSource).toMatch(/@keyframes batch-entry-scene-out\s*\{[\s\S]*?filter:\s*blur\(/u);
    expect(rendererStyleSource).toMatch(/@keyframes batch-entry-scene-in\s*\{[\s\S]*?filter:\s*blur\(/u);
    expect(rendererStyleSource).not.toContain('batch-to-postcard-expand');
    expect(rendererStyleSource).not.toContain('::view-transition-group(postcard-entry)');
    expect(rendererStyleSource).toMatch(/\.postcard-stage-controls\s*\{[^}]*position:\s*absolute;[^}]*top:\s*max\(4px,\s*calc\(var\(--postcard-deck-top\)\s*-\s*64px\)\);[^}]*left:\s*var\(--postcard-left\);/su);
    expect(rendererStyleSource).toMatch(/\.postcard-deck\s*\{[^}]*top:\s*var\(--postcard-deck-top\);[^}]*left:\s*var\(--postcard-left\);/su);
    expect(rendererStyleSource).toMatch(/\.postcard-file-name-editor\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/su);
    expect(rendererStyleSource).toMatch(/\.postcard-file-name-editor input\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/su);
  });

  it('memory_view__file_name_keyboard__ignores_ime_composition_keys', () => {
    expect(isImeCompositionKey(true, 13)).toBe(true);
    expect(isImeCompositionKey(false, 229)).toBe(true);
    expect(isImeCompositionKey(false, 13)).toBe(false);
  });

  it('memory_view__only_mounts_playable_media_for_the_current_card__uses_kind_specific_controls', () => {
    const video: PhotoRecord = {
      id: 'video-current',
      name: 'river.mp4',
      mediaUrl: 'photomap-media://photo/video-current',
      thumbnailUrl: 'photomap-media://photo/video-current?size=thumb',
      mediaKind: 'video',
      mediaFormat: 'mp4',
      captureTimeLocal: null,
      captureTimeOffsetMinutes: null,
      captureTimeSource: null,
      decodeState: 'valid',
      types: [],
    };
    const live: PhotoRecord = {
      id: 'live-next',
      name: 'motion.jpg',
      mediaUrl: 'photomap-media://photo/live-next',
      thumbnailUrl: 'photomap-media://photo/live-next?size=thumb',
      mediaKind: 'live',
      mediaFormat: 'jpg',
      captureTimeLocal: null,
      captureTimeOffsetMinutes: null,
      captureTimeSource: null,
      decodeState: 'valid',
      types: [],
    };
    const renderAt = (activeId: string, entryOrigin?: { left: number; top: number; width: number; height: number }): string => (
      renderToStaticMarkup(createElement(PostcardView, {
        photos: [video, live],
        activeId,
        provinces: PROVINCES,
        cities: CITIES,
        photoTypes: [],
        onActiveIdChange: vi.fn(),
        onClearFilters: vi.fn(),
        onGoBatch: vi.fn(),
        onUpdateLocation: vi.fn(async () => true),
        onUpdateTypes: vi.fn(async () => true),
        onUpdateNote: vi.fn(async () => true),
        onUpdateCaptureTime: vi.fn(async () => true),
        onRenamePhoto: vi.fn(async () => true),
        onRequestTrash: vi.fn(),
        entryOrigin,
      }))
    );

    const videoMarkup = renderAt(video.id);
    expect(videoMarkup.match(/<video/g)).toHaveLength(1);
    expect(videoMarkup).toContain('data-testid="postcard-playable-media"');
    expect(videoMarkup).toContain('src="photomap-media://photo/video-current"');
    expect(videoMarkup).toContain('poster="photomap-media://photo/video-current?size=thumb"');
    expect(videoMarkup).toContain('preload="metadata" autoPlay="" loop="" muted="" playsInline=""');
    expect(rendererIndexSource).toContain("media-src 'self' blob: photomap-media:");
    expect(forgeConfigSource).toContain('devContentSecurityPolicy');
    expect(forgeConfigSource).toContain("media-src 'self' blob: photomap-media:");
    expect(forgeConfigSource).toContain("img-src 'self' data: blob: photomap-media: photomap-asset:");
    expect(videoMarkup).toContain('aria-label="视频播放控制"');
    expect(videoMarkup.match(/data-testid="postcard-media-progress"/g)).toHaveLength(1);
    expect(postcardPreview(videoMarkup, 'postcard-next')).not.toContain('<video');
    expect(postcardPreview(videoMarkup, 'postcard-next')).toContain('src="photomap-media://photo/live-next"');

    const liveMarkup = renderAt(live.id);
    expect(liveMarkup.match(/<video/g)).toHaveLength(1);
    expect(liveMarkup).toContain('src="photomap-media://photo/live-next?content=motion"');
    expect(liveMarkup).toContain('aria-label="实况照片播放控制"');
    expect(liveMarkup).not.toContain('data-testid="postcard-media-progress"');
    expect(postcardPreview(liveMarkup, 'postcard-previous')).not.toContain('<video');

    const enteringMarkup = renderAt(video.id, { left: 320, top: 240, width: 180, height: 120 });
    expect(enteringMarkup).toContain('data-batch-entry="animated"');
    expect(enteringMarkup).not.toContain('preload="metadata" autoPlay=""');
    expect(enteringMarkup).toMatch(/<button[^>]*data-testid="postcard-rename-edit"[^>]*disabled=""/u);
  });

  it('memory_view__preloads_the_second_lookahead_postcard__omits_previews_at_boundaries', () => {
    const photos: PhotoRecord[] = Array.from({ length: 4 }, (_, index) => ({
      id: `memory-${index + 1}`,
      name: `${index + 1}.jpg`,
      mediaUrl: `photomap-media://photo/memory-${index + 1}`,
      thumbnailUrl: `photomap-media://photo/memory-${index + 1}`,
      mediaKind: 'photo' as const,
      mediaFormat: 'jpg' as const,
      fileCreatedAtMs: new Date(2026, 0, index + 1, 8, 30).getTime(),
      captureTimeLocal: `2025-12-${String(index + 1).padStart(2, '0')}T18:20:30`,
      captureTimeOffsetMinutes: 480,
      captureTimeSource: 'metadata' as const,
      note: `第 ${index + 1} 张的记忆`,
      decodeState: 'valid',
      location: {
        provinceCode: '156420000',
        provinceName: '湖北省',
        cityCode: '156420100',
        cityName: '武汉市',
      },
      types: [{ id: 'landscape', name: '风景' }],
    }));
    const renderAt = (activeId: string): string => renderToStaticMarkup(createElement(PostcardView, {
      photos,
      activeId,
      provinces: PROVINCES,
      cities: CITIES,
      photoTypes: [{ id: 'landscape', name: '风景' }],
      onActiveIdChange: vi.fn(),
      onClearFilters: vi.fn(),
      onGoBatch: vi.fn(),
      onUpdateLocation: vi.fn(async () => true),
      onUpdateTypes: vi.fn(async () => true),
      onUpdateNote: vi.fn(async () => true),
      onUpdateCaptureTime: vi.fn(async () => true),
      onRenamePhoto: vi.fn(async () => true),
      onRequestTrash: vi.fn(),
    }));

    const middleMarkup = renderAt('memory-2');
    expect(middleMarkup.match(/class="postcard-card/g)).toHaveLength(4);
    expect(middleMarkup).not.toContain('class="memory-arrow');
    expect(middleMarkup).toContain('data-testid="postcard-mailbox"');
    expect(middleMarkup).toContain('data-testid="postcard-mailbox-art"');
    expect(middleMarkup).toContain('data-testid="postcard-mailbox-slot"');
    for (const testId of ['postcard-previous', 'postcard-next', 'postcard-after-next'] as const) {
      const preview = postcardPreview(middleMarkup, testId);
      expect(preview).toContain('aria-hidden="true"');
      expect(preview).toContain('inert=""');
      expect(preview).toContain('class="postcard-photo"');
      expect(preview).toContain('class="postcard-basics"');
      expect(preview).toContain('class="postcard-location-editor"');
      expect(preview).toContain('class="postcard-type-editor"');
      expect(preview).toContain('class="postcard-note"');
      expect(preview).toContain('class="postcard-save-row"');
      expect(preview).toContain('disabled=""');
      expect(preview).toContain('拍摄时间');
      expect(preview).not.toContain('创建时间');
      expect(preview).not.toContain('data-testid="postcard-capture-time"');
    }
    expect(postcardPreview(middleMarkup, 'postcard-previous')).toContain('2025-12-01 18:20:30 UTC+08:00');
    expect(postcardPreview(middleMarkup, 'postcard-previous')).toContain('第 1 张的记忆');
    expect(postcardPreview(middleMarkup, 'postcard-next')).toContain('第 3 张的记忆');
    expect(postcardPreview(middleMarkup, 'postcard-after-next')).toContain('第 4 张的记忆');
    expect(postcardPreview(middleMarkup, 'postcard-after-next')).toContain('loading="eager"');
    expect(middleMarkup).not.toContain('data-testid="postcard-flight"');

    const firstMarkup = renderAt('memory-1');
    expect(firstMarkup).not.toContain('data-testid="postcard-previous"');
    expect(firstMarkup).toContain('data-testid="postcard-next"');
    expect(firstMarkup).toContain('data-testid="postcard-after-next"');
    expect(postcardPreview(firstMarkup, 'postcard-after-next')).toContain('第 3 张的记忆');
    expect(firstMarkup).not.toContain('class="memory-arrow');

    const penultimateMarkup = renderAt('memory-3');
    expect(penultimateMarkup).toContain('data-testid="postcard-previous"');
    expect(penultimateMarkup).toContain('data-testid="postcard-next"');
    expect(penultimateMarkup).not.toContain('data-testid="postcard-after-next"');

    const lastMarkup = renderAt('memory-4');
    expect(lastMarkup).toContain('data-testid="postcard-previous"');
    expect(lastMarkup).not.toContain('data-testid="postcard-next"');
    expect(lastMarkup).not.toContain('data-testid="postcard-after-next"');
    expect(lastMarkup).not.toContain('class="memory-arrow');

    expect(rendererStyleSource).toMatch(/\.postcard-deck\s*\{[^}]*z-index:\s*20;[^}]*transform-style:\s*flat;/su);
    expect(rendererStyleSource).toMatch(/\.postcard-flight-layer\s*\{[^}]*transform-style:\s*flat;[^}]*isolation:\s*isolate;/su);
    expect(rendererStyleSource).toMatch(/\.postcard-card\s*\{[^}]*transform-style:\s*flat;[^}]*isolation:\s*isolate;/su);
    expect(rendererStyleSource).not.toMatch(/\.postcard-(?:deck|card)\s*\{[^}]*transform-style:\s*preserve-3d;/su);
  });

  it('memory_view__move_destination__delivers_the_last_or_only_postcard_without_removing_other_boundaries', () => {
    const photos = [{ id: 'postcard-1' }, { id: 'postcard-2' }, { id: 'postcard-3' }];

    expect(postcardMoveDestination(photos, 1, 1)).toEqual({
      kind: 'photo',
      id: 'postcard-3',
    });
    expect(postcardMoveDestination(photos, 2, 1)).toEqual({ kind: 'completion' });
    expect(postcardMoveDestination([{ id: 'only-postcard' }], 0, 1)).toEqual({ kind: 'completion' });
    expect(postcardMoveDestination(photos, 0, -1)).toBeUndefined();
  });

  it('postcard_completion__renders_dynamic_count_last_real_previews_and_completion_actions', () => {
    const photos: PhotoRecord[] = Array.from({ length: 3 }, (_, index) => ({
      id: `completion-${index + 1}`,
      name: `completion-${index + 1}.jpg`,
      mediaUrl: `photomap-media://photo/completion-${index + 1}`,
      thumbnailUrl: `photomap-media://photo/completion-${index + 1}?size=thumb`,
      mediaKind: 'photo' as const,
      mediaFormat: 'jpg' as const,
      decodeState: 'valid' as const,
      types: [],
    }));
    const markup = renderToStaticMarkup(createElement(PostcardCompletion, {
      photos,
      onReview: vi.fn(),
      onContinue: vi.fn(),
    }));

    expect(markup).toContain('data-testid="postcard-completion"');
    expect(markup).toContain('投递完成，回忆已装订');
    expect(markup).toContain('共 <strong>3</strong> 张明信片');
    expect(markup).not.toContain('data-photo-id="completion-1"');
    expect(markup).not.toContain('src="photomap-media://photo/completion-1"');
    expect(markup).toContain('data-photo-id="completion-2"');
    expect(markup).toContain('src="photomap-media://photo/completion-2"');
    expect(markup).toContain('data-photo-id="completion-3"');
    expect(markup).toContain('src="photomap-media://photo/completion-3"');
    expect(markup.match(/class="postcard-completion-preview/g)).toHaveLength(2);
    expect(markup).toContain('data-testid="postcard-completion-review"');
    expect(markup).toContain('翻阅这组明信片');
    expect(markup).toContain('data-testid="postcard-completion-continue"');
    expect(markup).toContain('继续整理照片');
  });

  it('postcard_completion__single_postcard__renders_one_preview_without_duplication', () => {
    const onlyPhoto: PhotoRecord = {
      id: 'completion-only',
      name: 'completion-only.jpg',
      mediaUrl: 'photomap-media://photo/completion-only',
      thumbnailUrl: 'photomap-media://photo/completion-only?size=thumb',
      mediaKind: 'photo',
      mediaFormat: 'jpg',
      decodeState: 'valid',
      types: [],
    };
    const markup = renderToStaticMarkup(createElement(PostcardCompletion, {
      photos: [onlyPhoto],
      onReview: vi.fn(),
      onContinue: vi.fn(),
    }));

    expect(markup).toContain('共 <strong>1</strong> 张明信片');
    expect(markup).toContain('class="postcard-completion-spread is-single"');
    expect(markup.match(/class="postcard-completion-preview/g)).toHaveLength(1);
    expect(markup.match(/data-photo-id="completion-only"/g)).toHaveLength(1);
    expect(markup.match(/src="photomap-media:\/\/photo\/completion-only"/g)).toHaveLength(1);
  });

  it('memory_view__last_postcard__keeps_the_final_delivery_auto_action_enabled', () => {
    const lastPhoto: PhotoRecord = {
      id: 'last-postcard',
      name: 'last-postcard.jpg',
      mediaUrl: 'photomap-media://photo/last-postcard',
      thumbnailUrl: 'photomap-media://photo/last-postcard',
      mediaKind: 'photo',
      mediaFormat: 'jpg',
      decodeState: 'valid',
      types: [],
    };
    const markup = renderToStaticMarkup(createElement(PostcardView, {
      photos: [lastPhoto],
      activeId: lastPhoto.id,
      provinces: PROVINCES,
      cities: CITIES,
      photoTypes: [],
      onActiveIdChange: vi.fn(),
      onClearFilters: vi.fn(),
      onGoBatch: vi.fn(),
      onUpdateLocation: vi.fn(async () => true),
      onUpdateTypes: vi.fn(async () => true),
      onUpdateNote: vi.fn(async () => true),
      onUpdateCaptureTime: vi.fn(async () => true),
      onRenamePhoto: vi.fn(async () => true),
      onRequestTrash: vi.fn(),
    }));
    const autoButton = markup.match(
      /<button[^>]*data-testid="auto-scroll-toggle"[^>]*>[\s\S]*?<\/button>/u,
    )?.[0];

    expect(autoButton).toBeDefined();
    expect(autoButton).not.toContain('disabled');
    expect(autoButton).toContain('投递最后一张');
  });

  it('memory_view__auto_scroll_speed__uses_the_prototype_range_and_duration', () => {
    expect(normalizeAutoScrollSpeed(0.1)).toBe(0.5);
    expect(normalizeAutoScrollSpeed(1.13)).toBe(1.25);
    expect(normalizeAutoScrollSpeed(3)).toBe(2);
    expect(autoScrollDurationMs(0.5)).toBe(10_400);
    expect(autoScrollDurationMs(1)).toBe(5_200);
    expect(autoScrollDurationMs(2)).toBe(2_600);
  });

  it('memory_view__postcard_motion__follows_endpoints_and_can_uniformly_sample_the_curve', () => {
    const geometry: PostcardMotionGeometry = {
      x: 100,
      y: 0,
      scale: 0.25,
      control1: { x: 0, y: 0 },
      control2: { x: 0, y: 0 },
      stageWidth: 1_000,
      stageHeight: 600,
      start: { x: 200, y: 300 },
      target: { x: 300, y: 300 },
    };

    expect(uniformCurveParameter(-1, geometry)).toBe(0);
    expect(uniformCurveParameter(2, geometry)).toBe(1);
    expect(uniformCurveParameter(0.5, geometry)).toBeGreaterThan(0.75);
    expect(uniformCurveParameter(0.5, geometry)).toBeLessThan(0.84);
    expect(uniformCurveParameter(0.37, {
      ...geometry,
      x: 0,
      control1: { x: 0, y: 0 },
      control2: { x: 0, y: 0 },
    })).toBe(0.37);

    const start = postcardMotionPose(0, geometry);
    const finish = postcardMotionPose(1, geometry);
    expect(start).toEqual({
      transform: 'translate3d(0px, 0px, 0px) rotateX(0deg) rotateY(0deg) rotateZ(0deg) scale(1)',
      opacity: 1,
    });
    expect(finish).toEqual({
      transform: 'translate3d(100px, 0px, 0px) rotateX(88deg) rotateY(10deg) rotateZ(4deg) scale(0.25)',
      opacity: 0,
    });

    const directX = Number(postcardMotionPose(0.5, geometry).transform.match(/translate3d\(([-\d.]+)px/u)?.[1]);
    const uniformX = Number(postcardMotionPose(0.5, geometry, true).transform.match(/translate3d\(([-\d.]+)px/u)?.[1]);
    expect(directX).toBeCloseTo(12.5, 5);
    expect(uniformX).toBeCloseTo(50, 0);
    expect(terminalPostcardScale(100, 1_000)).toBeCloseTo(0.09, 5);
    expect(1_000 * terminalPostcardScale(100, 1_000)).toBeLessThanOrEqual(100);
    expect(terminalPostcardScale(1, 1_000)).toBe(0.06);
    expect(terminalPostcardScale(1_000, 1_000)).toBe(0.14);
    expect(incomingPostcardProgress(0.46)).toBe(0);
    expect(incomingPostcardProgress(0.73)).toBeCloseTo(0.5, 5);
    expect(incomingPostcardProgress(1)).toBe(1);
    expect(queuedPostcardPose(0)).toEqual({
      transform: 'translate(0, 128%) scale(0.94)',
      opacity: 0,
    });
    expect(queuedPostcardPose(1)).toEqual({
      transform: 'translate(0, 64%) scale(0.97)',
      opacity: 0.68,
    });
  });

  it('memory_view__wheel_delta__normalizes_units_and_accumulates_with_boundary_resistance', () => {
    expect(normalizeWheelDelta(12, 0, 900)).toBe(12);
    expect(normalizeWheelDelta(3, 1, 900)).toBe(84);
    expect(normalizeWheelDelta(-0.5, 2, 900)).toBe(-450);
    expect(normalizeWheelDelta(7, 99, 900)).toBe(7);

    expect(nextWheelGestureProgress(0, 59, false)).toBeCloseTo(0.1, 5);
    expect(nextWheelGestureProgress(0, -59, false)).toBeCloseTo(-0.1, 5);
    expect(nextWheelGestureProgress(0.9, 120, false)).toBe(0.92);
    expect(nextWheelGestureProgress(-0.9, -120, false)).toBe(-0.92);
    expect(nextWheelGestureProgress(0, 900, true)).toBe(0.11);
    expect(nextWheelGestureProgress(0, -900, true)).toBe(-0.11);
    expect(nextWheelGestureProgress(0.5, -400, true)).toBe(-0.11);
    expect(nextWheelGestureProgress(-0.5, 400, true)).toBe(0.11);
  });

  it('memory_view__wheel_gesture__advances_only_after_threshold_and_never_at_a_boundary', () => {
    expect(shouldAdvanceWheelGesture(0.279, 71, false)).toBe(false);
    expect(shouldAdvanceWheelGesture(0.28, 0, false)).toBe(true);
    expect(shouldAdvanceWheelGesture(-0.28, 0, false)).toBe(true);
    expect(shouldAdvanceWheelGesture(0.2, 72, false)).toBe(true);
    expect(shouldAdvanceWheelGesture(-0.2, -72, false)).toBe(true);
    expect(shouldAdvanceWheelGesture(0.2, -500, false)).toBe(false);
    expect(shouldAdvanceWheelGesture(-0.2, 500, false)).toBe(false);
    expect(shouldAdvanceWheelGesture(0, 72, false)).toBe(false);
    expect(shouldAdvanceWheelGesture(0.9, 500, true)).toBe(false);
  });

  it('annotation_filters__without_geojson__use_the_built_in_province_city_directory', () => {
    const photo: PhotoRecord = {
      id: 'wuhan-photo',
      name: 'wuhan-photo.jpg',
      mediaUrl: 'photomap-media://photo/wuhan-photo',
      thumbnailUrl: 'photomap-media://photo/wuhan-photo',
      mediaKind: 'photo',
      mediaFormat: 'jpg',
      decodeState: 'valid',
      location: {
        provinceCode: '156420000',
        provinceName: '湖北省',
        cityCode: '156420100',
        cityName: '武汉市',
      },
      types: [{ id: 'landscape', name: '风景' }],
    };
    const unlocatedPhoto: PhotoRecord = {
      id: 'unlocated-photo',
      name: 'unlocated-photo.jpg',
      mediaUrl: 'photomap-media://photo/unlocated-photo',
      thumbnailUrl: 'photomap-media://photo/unlocated-photo',
      mediaKind: 'photo',
      mediaFormat: 'jpg',
      decodeState: 'valid',
      types: [],
    };
    const markup = renderToStaticMarkup(createElement(LeftSidebar, {
      mode: 'batch',
      sourceName: 'fixture',
      sourceAvailable: true,
      photos: [photo, unlocatedPhoto],
      mediaKindPhotos: [photo, unlocatedPhoto],
      photoTypes: [{ id: 'landscape', name: '风景' }],
      provinces: PROVINCES,
      cities: CITIES,
      filters: { search: '', locationCodes: new Set<string>(), includeUnlocated: false, mediaKinds: new Set<PhotoRecord['mediaKind']>(['photo', 'video', 'live']), folderPaths: new Set<string>(), typeIds: new Set<string>() },
      onFiltersChange: vi.fn(),
      onChooseSource: vi.fn(),
      onRefresh: vi.fn(),
      onCancelScan: vi.fn(),
      onCreateType: vi.fn(async () => true),
      onOpenExport: vi.fn(),
    }));

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('>省市</button>');
    expect(markup).toContain('>文件夹</button>');
    expect(markup).toContain('>类型</button>');
    expect(markup).not.toContain('按省份');
    expect(markup).not.toContain('按城市');
    expect(markup).not.toContain('全部照片');
    expect(markup).not.toContain('已手动标记地点');
    expect(markup).toContain(`省市（${PROVINCES.length} 省 / ${CITIES.length} 市）`);
    expect(markup).toMatch(/data-testid="unlocated-location-filter"[^>]*aria-pressed="false"[\s\S]*?<span>未标记地点<\/span>[\s\S]*?<small>1<\/small>/u);
    expect(markup.match(/<button[^>]*data-testid="unlocated-location-filter"[^>]*>/u)?.[0]).not.toContain('disabled');
    expect(markup.indexOf('data-testid="unlocated-location-filter"')).toBeLessThan(markup.indexOf('>湖北省</span>'));
    expect(markup).toContain('aria-label="展开湖北省下的城市"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('>武汉市</span>');
    expect(markup).not.toContain('展开北京市下的城市');
  });

  it('left_sidebar__unlocated_stays_first_then_selected_regions_precede_regions_sorted_by_photo_count', () => {
    const locatedPhotos = (
      count: number,
      prefix: string,
      provinceCode: string,
      provinceName: string,
      cityCode: string,
      cityName: string,
    ): PhotoRecord[] => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      name: `${prefix}-${index}.jpg`,
      mediaUrl: `photomap-media://photo/${prefix}-${index}`,
      thumbnailUrl: `photomap-media://thumbnail/${prefix}-${index}`,
      mediaKind: 'photo' as const,
      mediaFormat: 'jpg' as const,
      decodeState: 'valid' as const,
      location: { provinceCode, provinceName, cityCode, cityName },
      types: [],
    }));
    const unlocatedPhotos: PhotoRecord[] = Array.from({ length: 6 }, (_, index) => ({
      id: `unlocated-${index}`,
      name: `unlocated-${index}.jpg`,
      mediaUrl: `photomap-media://photo/unlocated-${index}`,
      thumbnailUrl: `photomap-media://thumbnail/unlocated-${index}`,
      mediaKind: 'photo' as const,
      mediaFormat: 'jpg' as const,
      decodeState: 'valid',
      types: [],
    }));
    const allPhotos = [
      ...locatedPhotos(8, 'guangzhou', '156440000', '广东省', '156440100', '广州市'),
      ...locatedPhotos(3, 'wuhan', '156420000', '湖北省', '156420100', '武汉市'),
      ...locatedPhotos(1, 'shiyan', '156420000', '湖北省', '156420300', '十堰市'),
      ...locatedPhotos(1, 'yichang', '156420000', '湖北省', '156420500', '宜昌市'),
      ...locatedPhotos(2, 'xiangyang', '156420000', '湖北省', '156420600', '襄阳市'),
      ...unlocatedPhotos,
    ];
    const wallPhotos = allPhotos.filter((photo) => Boolean(photo.location?.provinceCode));
    const markup = renderToStaticMarkup(createElement(LeftSidebar, {
      mode: 'wall',
      sourceName: 'fixture',
      sourceAvailable: true,
      photos: wallPhotos,
      mediaKindPhotos: allPhotos,
      photoTypes: [],
      provinces: [regionOption('province', '156440000'), regionOption('province', '156420000')],
      cities: [
        regionOption('city', '156440100'),
        regionOption('city', '156420100'),
        regionOption('city', '156420300'),
        regionOption('city', '156420500'),
        regionOption('city', '156420600'),
      ],
      filters: {
        search: '',
        locationCodes: new Set<string>(['156420500']),
        includeUnlocated: false,
        mediaKinds: new Set<PhotoRecord['mediaKind']>(['photo', 'video', 'live']),
        folderPaths: new Set<string>(),
        typeIds: new Set<string>(),
      },
      onFiltersChange: vi.fn(),
      onChooseSource: vi.fn(),
      onRefresh: vi.fn(),
      onCancelScan: vi.fn(),
      onCreateType: vi.fn(async () => true),
      onOpenExport: vi.fn(),
    }));

    expectMarkupOrder(markup, [
      'data-testid="unlocated-location-filter"',
      '>湖北省</span>',
      '>广东省</span>',
    ]);
    expect(markup).toMatch(/class="province-filter-row unlocated-filter-row unavailable"[\s\S]*?data-testid="unlocated-location-filter"[^>]*aria-label="未标记地点，6 项，照片墙不可用"[^>]*aria-pressed="false"[^>]*disabled=""[\s\S]*?<small>6<\/small>/u);
    expect(markup).toContain('aria-label="收起湖北省下的城市"');
    expectMarkupOrder(markup, [
      '>宜昌市</span>',
      '>武汉市</span>',
      '>襄阳市</span>',
      '>十堰市</span>',
    ]);
  });

  it('direct_municipality__same_province_and_city_code__renders_one_filter_row_and_two_selected_location_options', () => {
    const shanghaiProvince = regionOption('province', '156310000');
    const shanghaiCity = regionOption('city', '156310000');
    const photo: PhotoRecord = {
      id: 'shanghai-photo',
      name: 'shanghai-photo.jpg',
      mediaUrl: 'photomap-media://photo/shanghai-photo',
      thumbnailUrl: 'photomap-media://photo/shanghai-photo',
      mediaKind: 'photo',
      mediaFormat: 'jpg',
      decodeState: 'valid',
      location: {
        provinceCode: '156310000',
        provinceName: '上海市',
        cityCode: '156310000',
        cityName: '上海市',
      },
      types: [],
    };
    const filterMarkup = renderToStaticMarkup(createElement(LeftSidebar, {
      mode: 'batch',
      sourceName: 'fixture',
      sourceAvailable: true,
      photos: [photo],
      mediaKindPhotos: [photo],
      photoTypes: [],
      provinces: [shanghaiProvince],
      cities: [shanghaiCity],
      filters: {
        search: '',
        locationCodes: new Set(['156310000']),
        includeUnlocated: false,
        mediaKinds: new Set<PhotoRecord['mediaKind']>(['photo', 'video', 'live']),
        folderPaths: new Set<string>(),
        typeIds: new Set<string>(),
      },
      onFiltersChange: vi.fn(),
      onChooseSource: vi.fn(),
      onRefresh: vi.fn(),
      onCancelScan: vi.fn(),
      onCreateType: vi.fn(async () => true),
      onOpenExport: vi.fn(),
    }));

    expect(filterMarkup).toMatch(/class="province-filter-row active"[\s\S]*?class="region-filter-option" aria-pressed="true"[\s\S]*?<span>上海市<\/span>/u);
    expect(filterMarkup.match(/>上海市<\/span>/gu)).toHaveLength(1);
    expect(filterMarkup).not.toContain('展开上海市下的城市');

    const editorMarkup = renderToStaticMarkup(createElement(ContextSidebar, {
      mode: 'memory',
      allPhotos: [photo],
      filteredPhotos: [photo],
      activePhoto: photo,
      selectedIds: new Set<string>(),
      wallFixedPhotoIds: [],
      provinces: [shanghaiProvince],
      cities: [shanghaiCity],
      photoTypes: [],
      onUpdateLocation: vi.fn(async () => true),
      onUpdateTypes: vi.fn(async () => true),
      onClearSelection: vi.fn(),
      onRequestTrash: vi.fn(),
      onOnlyRegion: vi.fn(),
      onManageRegion: vi.fn(),
      onCarouselRegion: vi.fn(),
      onWallFixedPhotosChange: vi.fn(),
    }));

    expect(editorMarkup.match(/value="156310000" selected="">上海市<\/option>/gu)).toHaveLength(2);
  });

  it('media_kind_filter__annotation_and_wall_modes__renders_multi_select_and_disables_non_photos_on_wall', () => {
    const counts = new Map([
      ['photo' as const, 8],
      ['video' as const, 3],
      ['live' as const, 2],
    ]);
    const selectedKinds = new Set(['photo', 'video', 'live'] as const);
    const annotationMarkup = renderToStaticMarkup(createElement(MediaKindFilter, {
      mode: 'batch',
      selectedKinds,
      counts,
      onToggle: vi.fn(),
    }));
    const wallMarkup = renderToStaticMarkup(createElement(MediaKindFilter, {
      mode: 'wall',
      selectedKinds,
      counts,
      onToggle: vi.fn(),
    }));

    expect(annotationMarkup).toContain('aria-label="媒体种类"');
    expect(annotationMarkup).toMatch(/data-testid="media-kind-filter-photo"[^>]*aria-pressed="true"/u);
    expect(annotationMarkup).toMatch(/data-testid="media-kind-filter-video"[^>]*aria-pressed="true"/u);
    expect(annotationMarkup).toMatch(/data-testid="media-kind-filter-live"[^>]*aria-pressed="true"/u);
    expect(annotationMarkup).not.toContain('disabled=""');
    expect(wallMarkup).toMatch(/data-testid="media-kind-filter-photo"[^>]*aria-pressed="true"/u);
    expect(wallMarkup).toMatch(/class="unavailable"[^>]*data-testid="media-kind-filter-video"[^>]*aria-pressed="false"[^>]*disabled=""/u);
    expect(wallMarkup).toMatch(/class="unavailable"[^>]*data-testid="media-kind-filter-live"[^>]*aria-pressed="false"[^>]*disabled=""/u);
  });

  it('folder_filter__renders_two_levels_with_parent_counts_and_selected_child_state', () => {
    const folderPhotos: PhotoRecord[] = [
      {
        id: 'root', name: 'root.jpg', mediaUrl: 'photomap-media://photo/root', thumbnailUrl: 'photomap-media://photo/root',
        mediaKind: 'photo', mediaFormat: 'jpg', decodeState: 'valid', types: [],
      },
      {
        id: 'direct', name: 'direct.jpg', folderPath: '旅行', mediaUrl: 'photomap-media://photo/direct', thumbnailUrl: 'photomap-media://photo/direct',
        mediaKind: 'photo', mediaFormat: 'jpg', decodeState: 'valid', types: [],
      },
      {
        id: 'wuhan-photo', name: 'wuhan.jpg', folderPath: '旅行/武汉', mediaUrl: 'photomap-media://photo/wuhan-photo', thumbnailUrl: 'photomap-media://photo/wuhan-photo',
        mediaKind: 'photo', mediaFormat: 'jpg', decodeState: 'valid', types: [],
      },
      {
        id: 'wuhan-video', name: 'clip.mp4', folderPath: '工作/武汉', mediaUrl: 'photomap-media://photo/wuhan-video', thumbnailUrl: 'photomap-media://photo/wuhan-video',
        mediaKind: 'video', mediaFormat: 'mp4', decodeState: 'valid', types: [],
      },
    ];
    const markup = renderToStaticMarkup(createElement(FolderFilter, {
      photos: folderPhotos,
      selectedPaths: new Set(['旅行/武汉']),
      onSelectedPathsChange: vi.fn(),
    }));

    expect(markup).toMatch(/data-folder-path="旅行"[^>]*aria-pressed="false"[^>]*aria-label="旅行，已选择部分子文件夹"[\s\S]*?<small>2<\/small>/u);
    expect(markup).toContain('aria-label="收起旅行下的子文件夹"');
    expect(markup).toMatch(/data-folder-path="旅行\/武汉"[^>]*aria-pressed="true"[\s\S]*?<small>1<\/small>/u);
    expect(markup).toMatch(/data-folder-path="工作"[^>]*aria-pressed="false"[\s\S]*?<small>1<\/small>/u);
    expect(markup.match(/>武汉<\/span>/gu)).toHaveLength(1);
    expect(markup).not.toContain('root.jpg');
  });

  it('folder_filter__without_indexed_subfolders__renders_an_explicit_empty_state', () => {
    const markup = renderToStaticMarkup(createElement(FolderFilter, {
      photos: [],
      selectedPaths: new Set<string>(),
      onSelectedPathsChange: vi.fn(),
    }));

    expect(markup).toContain('数据源中没有子文件夹');
  });

  it('left_sidebar__wall_mode__builds_the_folder_tree_from_all_active_media', () => {
    const folderVideo: PhotoRecord = {
      id: 'folder-video',
      name: 'clip.mp4',
      folderPath: '工作/武汉',
      mediaUrl: 'photomap-media://photo/folder-video',
      thumbnailUrl: 'photomap-media://photo/folder-video',
      mediaKind: 'video',
      mediaFormat: 'mp4',
      decodeState: 'valid',
      types: [],
    };
    const markup = renderToStaticMarkup(createElement(LeftSidebar, {
      mode: 'wall',
      sourceName: 'fixture',
      sourceAvailable: true,
      photos: [],
      mediaKindPhotos: [folderVideo],
      photoTypes: [],
      provinces: [],
      cities: [],
      filters: {
        search: '',
        locationCodes: new Set<string>(),
        includeUnlocated: false,
        mediaKinds: new Set<PhotoRecord['mediaKind']>(['photo', 'video', 'live']),
        folderPaths: new Set(['工作/武汉']),
        typeIds: new Set<string>(),
      },
      onFiltersChange: vi.fn(),
      onChooseSource: vi.fn(),
      onRefresh: vi.fn(),
      onCancelScan: vi.fn(),
      onCreateType: vi.fn(async () => true),
      onOpenExport: vi.fn(),
    }));

    expect(markup).toMatch(/id="folder-filter-tab"[^>]*class="active has-filter"[^>]*aria-selected="true"/u);
    expect(markup).toMatch(/data-folder-path="工作"[^>]*aria-pressed="false"[\s\S]*?<small>1<\/small>/u);
    expect(markup).toMatch(/data-folder-path="工作\/武汉"[^>]*aria-pressed="true"/u);
  });

  it('single_photo_editor__without_geojson__uses_built_in_location_options_and_auto_saves', () => {
    const photo: PhotoRecord = {
      id: 'changchun-photo',
      name: 'changchun-photo.jpg',
      mediaUrl: 'photomap-media://photo/changchun-photo',
      thumbnailUrl: 'photomap-media://photo/changchun-photo',
      mediaKind: 'photo',
      mediaFormat: 'jpg',
      fileCreatedAtMs: new Date(2026, 7, 24, 9, 7).getTime(),
      decodeState: 'valid',
      location: {
        provinceCode: '156220000',
        provinceName: '吉林省',
        cityCode: '156220100',
        cityName: '长春市',
      },
      types: [{ id: 'landscape', name: '风景' }],
    };
    const markup = renderToStaticMarkup(createElement(ContextSidebar, {
      mode: 'memory',
      allPhotos: [photo],
      filteredPhotos: [photo],
      activePhoto: photo,
      selectedIds: new Set<string>(),
      wallFixedPhotoIds: [],
      provinces: [regionOption('province', '156220000')],
      cities: [regionOption('city', '156220100')],
      photoTypes: [{ id: 'portrait', name: '人像' }, { id: 'landscape', name: '风景' }],
      onUpdateLocation: vi.fn(async () => true),
      onUpdateTypes: vi.fn(async () => true),
      onClearSelection: vi.fn(),
      onRequestTrash: vi.fn(),
      onOnlyRegion: vi.fn(),
      onManageRegion: vi.fn(),
      onCarouselRegion: vi.fn(),
      onWallFixedPhotosChange: vi.fn(),
    }));

    expect(markup.match(/<select/g)).toHaveLength(2);
    expect(markup).toContain('未选择');
    expect(markup).toContain('只标记到省');
    expect(markup).toContain('>吉林省</option>');
    expect(markup).toContain('>长春市</option>');
    expect(markup).toContain('人像');
    expect(markup).toContain('风景');
    expect(markup).toContain('移入 Windows 回收站');
    expect(markup).toContain('创建时间');
    expect(markup).toContain('2026-08-24 09:07');
    expect(markup).not.toContain('清除地点');
    expect(markup).not.toContain('保存地点');
    expect(markup).not.toContain('保存类型');
  });

  it('batch_editor__without_geojson__uses_the_built_in_province_directory', () => {
    const photo: PhotoRecord = {
      id: 'batch-photo',
      name: 'batch-photo.jpg',
      mediaUrl: 'photomap-media://photo/batch-photo',
      thumbnailUrl: 'photomap-media://photo/batch-photo',
      mediaKind: 'photo',
      mediaFormat: 'jpg',
      captureTimeLocal: '2026-06-17T15:44:34',
      captureTimeOffsetMinutes: 480,
      captureTimeSource: 'metadata',
      decodeState: 'valid',
      types: [],
    };
    const markup = renderToStaticMarkup(createElement(ContextSidebar, {
      mode: 'batch',
      allPhotos: [photo],
      filteredPhotos: [photo],
      selectedIds: new Set([photo.id]),
      wallFixedPhotoIds: [],
      provinces: PROVINCES,
      cities: CITIES,
      photoTypes: [],
      onUpdateLocation: vi.fn(async () => true),
      onUpdateTypes: vi.fn(async () => true),
      onClearSelection: vi.fn(),
      onRequestTrash: vi.fn(),
      onOnlyRegion: vi.fn(),
      onManageRegion: vi.fn(),
      onCarouselRegion: vi.fn(),
      onWallFixedPhotosChange: vi.fn(),
    }));
    const gridMarkup = renderToStaticMarkup(createElement(BatchView, {
      photos: [photo],
      selectedIds: new Set([photo.id]),
      onSelectedIdsChange: vi.fn(),
      onSelectionMessage: vi.fn(),
      onClearFilters: vi.fn(),
      onGoCarousel: vi.fn(),
      onOpenPostcard: vi.fn(),
    }));

    expect(markup).toContain('批量标签');
    expect(markup).toContain('>湖北省</option>');
    expect(markup).toContain('替换为该地点');
    expect(markup).not.toContain('拍摄时间');
    expect(markup).not.toContain('data-testid="postcard-capture-time"');
    expect(gridMarkup).not.toContain('拍摄时间');
    expect(gridMarkup).not.toContain('data-testid="postcard-capture-time"');
  });

  it('wall_sidebar__selected_region__offers_wall_only_fixed_photo_action', () => {
    const wallPhoto: PhotoRecord = {
      id: 'wall-photo',
      name: 'wall-photo.jpg',
      mediaUrl: 'photomap-media://photo/wall-photo',
      thumbnailUrl: 'photomap-media://photo/wall-photo',
      mediaKind: 'photo',
      mediaFormat: 'jpg',
      decodeState: 'valid',
      location: { provinceCode: '156420000', provinceName: '湖北省' },
      types: [],
    };
    const wallVideo: PhotoRecord = {
      ...wallPhoto,
      id: 'wall-video',
      name: 'wall-video.mp4',
      mediaKind: 'video',
      mediaFormat: 'mp4',
    };
    const wallLive: PhotoRecord = {
      ...wallPhoto,
      id: 'wall-live',
      name: 'wall-live.jpg',
      mediaKind: 'live',
    };
    const markup = renderToStaticMarkup(createElement(ContextSidebar, {
      mode: 'wall',
      allPhotos: [wallPhoto, wallVideo, wallLive],
      filteredPhotos: [wallPhoto, wallVideo, wallLive],
      selectedIds: new Set<string>(),
      selectedRegion: { code: '156420000', name: '湖北省', level: 'province' },
      wallFixedPhotoIds: [],
      provinces: [regionOption('province', '156420000')],
      cities: [],
      photoTypes: [],
      onUpdateLocation: vi.fn(async () => true),
      onUpdateTypes: vi.fn(async () => true),
      onClearSelection: vi.fn(),
      onRequestTrash: vi.fn(),
      onOnlyRegion: vi.fn(),
      onManageRegion: vi.fn(),
      onCarouselRegion: vi.fn(),
      onWallFixedPhotosChange: vi.fn(),
    }));

    expect(markup).toContain('data-testid="annotate-region-batch"');
    expect(markup).toContain('批注区域照片');
    expect(markup).toContain('data-testid="annotate-region-carousel"');
    expect(markup).toContain('轮播区域照片');
    expect(markup).not.toContain('批量整理该区域照片');
    expect(markup).toContain('data-testid="fixed-region-photos"');
    expect(markup).toContain('固定该区域展示照片');
    expect(markup).toContain('固定照片只改变照片墙与导出，不会修改任何照片地点');
    expect(markup).toContain('<span>照片数量</span><strong>1</strong>');
    expect(markup).not.toContain('wall-video.mp4');
    expect(markup).not.toContain('wall-live.jpg');
  });

  it('fixed_photo_dialog__renders_multiselect_contract_and_mode_isolation_notice', () => {
    const wallPhoto: PhotoRecord = {
      id: 'fixed-photo',
      name: '固定照片.jpg',
      mediaUrl: 'photomap-media://photo/fixed-photo',
      thumbnailUrl: 'photomap-media://photo/fixed-photo',
      mediaKind: 'photo',
      mediaFormat: 'jpg',
      decodeState: 'valid',
      types: [],
    };
    const markup = renderToStaticMarkup(createElement(FixedPhotoDialog, {
      region: { code: '156420000', name: '湖北省', level: 'province' },
      photos: [wallPhoto],
      displayablePhotoIds: new Set(['fixed-photo']),
      fixedPhotoIds: ['fixed-photo'],
      onSave: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('已选 1 张');
    expect(markup).toContain('不会修改照片的省市地点，也不会影响批注模式');
    expect(markup).toContain('固定 1 张照片');
  });
});

describe('PRD-FR-017 / PRD-FR-018 renderer export encoding', () => {
  it.each([
    ['image/png'],
  ] as const)(
    'prd_fr_018__%s_selected__renders_frozen_snapshot__encodes_matching_data_url',
    async (expectedMime) => {
      const toDataURL = vi.fn((mime: string) => `data:${mime};base64,AA==`);
      const context = {
        save: vi.fn(),
        restore: vi.fn(),
        setTransform: vi.fn(),
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        fillText: vi.fn(),
        measureText: vi.fn(() => ({ width: 240 })),
        beginPath: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
      const canvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => context),
        toDataURL,
      };
      class FailingImage {
        public decoding = '';
        public onload: (() => void) | null = null;
        public onerror: (() => void) | null = null;

        public set src(_value: string) {
          this.onerror?.();
        }
      }
      vi.stubGlobal('Image', FailingImage);
      vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });

      const snapshot = createSnapshot({
        level: 'province',
        viewBox: { x: -500, y: -100, width: 3000, height: 1600 },
        camera: { zoom: 1, panX: 0, panY: 0 },
        density: 3,
        showPhotos: true,
        showPlaceNames: true,
        regions: [],
        photosByRegion: new Map(),
      });
      const defaultDocument = createDefaultShareDocument({ width: 1200, height: 800 });
      const added = addShareText(defaultDocument, 'text-2').document;
      const shareDocument = updateShareText(added, 'text-2', {
        text: '2026 · 我的旅行足迹',
        color: '#9a5952',
        weight: 400,
      });
      const dataUrl = await renderSnapshotToDataUrl(snapshot, {
        currentWidth: 1200,
        currentHeight: 800,
        document: shareDocument,
      });

      expect(dataUrl).toBe(`data:${expectedMime};base64,AA==`);
      expect(canvas.width).toBe(1600);
      expect(canvas.height).toBe(1353);
      expect(context.strokeRect).toHaveBeenCalledTimes(2);
      expect(context.fillText).toHaveBeenCalledWith('我的照片地图', 0, 0);
      expect(context.fillText).toHaveBeenCalledWith('2026 · 我的旅行足迹', 0, 0);
      expect(context.fillStyle).toBe('#9a5952');
      expect(context.font).toContain('400 36px');
      expect(toDataURL).toHaveBeenCalledWith(expectedMime);
    },
  );

  it('export_dialog__opens__shows_flat_editor_controls_without_ratio_format_or_layers', () => {
    const snapshot = createSnapshot({
      level: 'province',
      viewBox: { x: -500, y: -100, width: 3000, height: 1600 },
      camera: { zoom: 1, panX: 0, panY: 0 },
      density: 3,
      showPhotos: true,
      showPlaceNames: true,
      regions: [],
      photosByRegion: new Map(),
    });
    const markup = renderToStaticMarkup(createElement(ExportDialog, {
      snapshot,
      viewportSize: { width: 1200, height: 800 },
      onClose: () => undefined,
      onSaved: () => undefined,
    }));

    expect(markup).toContain('data-testid="export-editor"');
    expect(markup).toContain('data-testid="export-board"');
    expect(markup).toContain('data-testid="export-output-canvas"');
    expect(markup).toContain('data-testid="export-photo-item"');
    expect(markup).toContain('data-testid="export-text-item"');
    expect(markup).toContain('data-testid="export-add-text"');
    expect(markup).toContain('data-testid="export-reset"');
    expect(markup).toContain('data-testid="export-context-toolbar"');
    expect(markup).toContain('data-item-id="text-1"');
    expect(markup).toContain('data-item-kind="text"');
    expect(markup).toContain('data-testid="export-text-controls"');
    expect(markup).toContain('data-testid="export-text-input"');
    expect(markup).toContain('data-testid="export-text-color"');
    expect(markup).toContain('data-testid="export-text-weight"');
    expect(markup).toContain('data-testid="export-align-horizontal"');
    expect(markup).toContain('data-testid="export-align-vertical"');
    expect(markup).toContain('data-testid="export-delete-text"');
    const deleteButton = markup.match(/<button[^>]*data-testid="export-delete-text"[^>]*>/u)?.[0];
    expect(deleteButton).toBeDefined();
    expect(deleteButton).not.toContain('disabled');
    expect(markup).toContain('value="我的照片地图"');
    expect(markup).toContain('添加文字');
    expect(markup).toContain('恢复默认');
    expect(markup).toContain('颜色');
    expect(markup).toContain('粗细');
    expect(markup).toContain('保存图片');
    expect(markup).toContain('取消');
    expect(markup).not.toContain('data-testid="export-inspector"');
    expect(markup).not.toContain('data-testid="export-photo-controls"');
    expect(markup).not.toContain('画面比例');
    expect(markup).not.toContain('文件格式');
    expect(markup).not.toContain('JPEG');
    expect(markup).not.toContain('图层');
  });
});
