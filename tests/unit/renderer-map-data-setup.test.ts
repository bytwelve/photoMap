import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { MapDataSetup } from '../../src/renderer/components/MapDataSetup';
import type { MapDataStatus } from '../../src/shared/contracts';

function status(provinceImported: boolean, cityImported: boolean, error?: string): MapDataStatus {
  const completed = Number(provinceImported) + Number(cityImported);
  return {
    items: [
      { kind: 'province', label: '省份数据', imported: provinceImported },
      { kind: 'city', label: '城市数据', imported: cityImported },
    ],
    completed,
    total: 2,
    ready: completed === 2,
    ...(error === undefined ? {} : { error }),
  };
}

function render(mapStatus: MapDataStatus, busy = false): string {
  return renderToStaticMarkup(createElement(MapDataSetup, {
    status: mapStatus,
    busy,
    onDownload: vi.fn(),
    onImport: vi.fn(),
  }));
}

describe('photo-wall map data setup static contract', () => {
  it('renders the required explanation, actions, local-only notice, and zero progress', () => {
    const markup = render(status(false, false));

    expect(markup).toContain('data-testid="map-data-setup"');
    expect(markup).toContain('请先完成地图数据导入');
    expect(markup).toContain('省份数据和城市数据都导入后，才能使用照片墙模式。');
    expect(markup).toContain('已完成 0 / 2');
    expect(markup).toContain('天地图下载地图');
    expect(markup).toContain('导入地图数据');
    expect(markup).toContain('地图与照片数据均仅保存在本机');
    expect(markup.match(/>未导入<\/strong>/gu)).toHaveLength(2);
  });

  it('renders province and city independently and preserves the supplied item order at one of two', () => {
    const markup = render(status(true, false));
    const provinceIndex = markup.indexOf('data-testid="map-data-status-province"');
    const cityIndex = markup.indexOf('data-testid="map-data-status-city"');

    expect(markup).toContain('已完成 1 / 2');
    expect(provinceIndex).toBeGreaterThanOrEqual(0);
    expect(cityIndex).toBeGreaterThan(provinceIndex);
    expect(markup.slice(provinceIndex, cityIndex)).toContain('已导入');
    expect(markup.slice(cityIndex)).toContain('未导入');
  });

  it('disables only the import action and exposes its busy state while importing', () => {
    const markup = render(status(false, true), true);
    const downloadButton = markup.match(/<button[^>]*data-testid="map-data-download"[^>]*>/u)?.[0] ?? '';
    const importButton = markup.match(/<button[^>]*data-testid="map-data-import"[^>]*>/u)?.[0] ?? '';

    expect(markup).toContain('已完成 1 / 2');
    expect(markup).toContain('正在导入…');
    expect(downloadButton).not.toContain('disabled');
    expect(importButton).toContain('disabled');
    expect(importButton).toContain('aria-busy="true"');
  });

  it('renders an optional map-data error as an alert', () => {
    const markup = render(status(false, false, '所选文件校验失败，请重新选择。'));

    expect(markup).toContain('data-testid="map-data-setup-error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('所选文件校验失败，请重新选择。');
  });
});
